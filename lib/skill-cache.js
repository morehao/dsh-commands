/**
 * 技能来源的本地缓存。
 *
 * 目标：仍然用官方 `skills` CLI 的 `add`（标准 `~/.agents/skills` + `.skill-lock.json`），
 * 但把「每次安装都重新 git clone 整个来源仓」换成：
 *
 *   首次：git clone --depth 1 到 $DSH_HOME/cache/skills-sources/<hash>
 *   之后：git fetch --depth 1 更新（默认 10 分钟内直接跳过网络）
 *   安装：skills add <本地缓存目录>，CLI 只做文件拷贝
 *
 * 这样 dsh 侧快，其他 agent 仍然可以直接 `npx skills add/update`；安装结果和上游 CLI
 * 写出的完全同构。唯一需要补偿的是：以本地路径安装时，CLI 会把 lock 的 source 写成
 * 本地路径，这里在安装后把 lock 的 source/sourceUrl/skillPath/skillFolderHash 回写成
 * 远端来源，避免其他 agent 把它当成「本地技能」而无法 update。
 */
import { createHash } from "node:crypto";
import { constants as FS_CONST } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { spawnCollect } from "./proc.js";
import { tail } from "./text.js";

const CACHE_ROOT = ["cache", "skills-sources"];
const CACHE_META_SUFFIX = ".meta.json";
const DEFAULT_CLONE_TIMEOUT_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 120_000;

const exists = (p) =>
	access(p, FS_CONST.F_OK).then(
		() => true,
		() => false,
	);

/** 来源 URL 的缓存键：不求可读，只求稳定、无路径分隔符。 */
export function cacheKey(url) {
	return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function resolveCacheDir(dshHome, url) {
	return join(dshHome, ...CACHE_ROOT, cacheKey(url));
}

export function cacheTtlMs(env = process.env) {
	const text = env.DSH_COMMANDS_SKILL_CACHE_TTL_MS?.trim();
	if (!text) return DEFAULT_TTL_MS;
	const raw = Number(text);
	return Number.isFinite(raw) ? raw : DEFAULT_TTL_MS;
}

/** 外层硬超时；与 skill-setup.js 的 DEFAULT_TIMEOUT_MS 保持一致。 */
function outerTimeoutMs(env = process.env) {
	const raw = Number(env.DSH_COMMANDS_SKILL_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/**
 * 缓存 git 操作的超时由外层硬超时派生，少两个环境变量：
 * - clone 必须早于外层失败，才能让 CLI/用户看到 "Clone timed out" 的诊断；
 * - fetch 更短，避免一个卡住的增量更新拖满整个命令。
 */
export function cacheCloneTimeoutMs(env = process.env) {
	return Math.min(60_000, Math.max(30_000, outerTimeoutMs(env) - 30_000));
}

export function cacheFetchTimeoutMs(env = process.env) {
	return Math.min(20_000, Math.max(5_000, Math.floor(outerTimeoutMs(env) / 4)));
}

/**
 * 本地缓存状态（不联网）：
 * - `exists`：有 `.git`
 * - `fresh`：TTL 内（`ttl<0` 视为永远 fresh；`ttl=0` 视为永远不 fresh）
 * - `ageMs`：距上次 clone/fetch 的毫秒数
 *
 * `/skill-init`（含 `--update`）用它决定要不要建后台作业去 fetch：fresh 且 lock hash
 * 一致时才能直接判定「无变更」，否则必须进入作业检查上游。
 */
export async function cacheStatus(cacheDir, env = process.env) {
	const ttlMs = cacheTtlMs(env);
	if (!(await exists(join(cacheDir, ".git")))) {
		return { exists: false, fresh: false, ttlMs, ageMs: undefined, meta: undefined };
	}
	const meta = await readMeta(cacheDir);
	const fetchedAt = typeof meta?.fetchedAt === "number" ? meta.fetchedAt : Date.parse(String(meta?.fetchedAt ?? ""));
	const ageMs = Number.isFinite(fetchedAt) ? Math.max(0, Date.now() - fetchedAt) : undefined;
	const fresh = ttlMs < 0 ? true : ttlMs === 0 ? false : ageMs !== undefined && ageMs < ttlMs;
	return { exists: true, fresh, ttlMs, ageMs, meta };
}

/** 缓存里某个技能的 git tree hash（与 lock 的 `skillFolderHash` 同构）；找不到返回 undefined。 */
export async function cachedSkillHash(cacheDir, name, env = process.env) {
	const located = await locateSkill(cacheDir, name);
	if (located === undefined) return undefined;
	return treeHash(cacheDir, located.rel, env);
}

/** git 自身的快速失败参数：GitHub 443 黑洞时别等 75s 的 TCP 超时。 */
function gitEnv(env) {
	return {
		...env,
		...(env.GIT_TERMINAL_PROMPT?.trim() ? {} : { GIT_TERMINAL_PROMPT: "0" }),
		...(env.GIT_HTTP_LOW_SPEED_LIMIT?.trim() ? {} : { GIT_HTTP_LOW_SPEED_LIMIT: "1000" }),
		...(env.GIT_HTTP_LOW_SPEED_TIME?.trim() ? {} : { GIT_HTTP_LOW_SPEED_TIME: "10" }),
		...(env.GIT_OPTIONAL_LOCKS?.trim() ? {} : { GIT_OPTIONAL_LOCKS: "0" }),
	};
}

/** 执行 git，返回合并输出；timeout / abort / 输出上限由 spawnCollect 统一处理。 */
async function runGit(args, { cwd, env, signal, timeoutMs }) {
	if (signal?.aborted === true) {
		return { code: null, signal: "SIGTERM", output: "", timedOut: false, aborted: true };
	}
	const result = await spawnCollect({
		command: "git",
		args,
		cwd,
		env: gitEnv(env),
		signal,
		timeoutMs,
		maxOutputChars: MAX_OUTPUT_CHARS,
	});
	return {
		code: result.code,
		signal: result.signal,
		output: result.output,
		timedOut: result.timedOut,
		aborted: result.aborted,
	};
}

function metaPath(cacheDir) {
	return `${cacheDir}${CACHE_META_SUFFIX}`;
}

async function readMeta(cacheDir) {
	try {
		const parsed = JSON.parse(await readFile(metaPath(cacheDir), "utf8"));
		return parsed !== null && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function writeMeta(cacheDir, meta) {
	await mkdir(dirname(cacheDir), { recursive: true });
	await writeFile(metaPath(cacheDir), `${JSON.stringify(meta, null, 2)}\n`);
}

async function revParse(cacheDir, env = process.env) {
	const result = await runGit(["-C", cacheDir, "rev-parse", "HEAD"], {
		env,
		timeoutMs: 10_000,
	});
	return result.code === 0 ? result.output.trim().split("\n").pop() : undefined;
}

function cacheActionError(action, url, result, timeoutMs) {
	const detail = tail(result.output, { lines: 8, foldSpinner: false, stripDecorations: false, stripBoxEdges: false });
	const how = result.timedOut
		? `超过 ${Math.round(timeoutMs / 1000)}s 未完成（已终止）`
		: result.signal
			? `被信号 ${result.signal} 终止`
			: `退出码 ${result.code}`;
	return `${action}本地缓存失败（${url}，${how}）${detail ? `：\n${detail}` : ""}`;
}

/**
 * 确保来源仓在本地有一份浅克隆。
 *
 * - 没有缓存 → clone（只发生一次）
 * - 有缓存且 `refresh=true` 或 TTL 过期 → fetch + reset
 * - fetch 失败且 `allowStale=true` → 继续用旧缓存（安装不因上游抖动失败）
 * - `ttlMs < 0` → 永不自动刷新（离线模式）；`ttlMs === 0` → 每次都刷新
 */
export async function ensureSourceCache({
	cacheDir,
	url,
	env = process.env,
	reporter,
	signal,
	refresh = false,
	allowStale = true,
	cloneTimeoutMs = cacheCloneTimeoutMs(env),
	fetchTimeoutMs = cacheFetchTimeoutMs(env),
	ttlMs = cacheTtlMs(env),
} = {}) {
	const hasGit = await exists(join(cacheDir, ".git"));
	const meta = await readMeta(cacheDir);

	if (!hasGit) {
		if (await exists(cacheDir)) {
			// 缓存目录是我们自己的命名空间；半截 clone 或损坏目录可以直接重建。
			await rm(cacheDir, { recursive: true, force: true });
		}
		await mkdir(dirname(cacheDir), { recursive: true });
		reporter?.progress?.(`首次克隆 ${url} → 本地缓存（之后不再整仓克隆）`);
		const result = await runGit(["clone", "--depth", "1", "--single-branch", "--", url, cacheDir], {
			cwd: dirname(cacheDir),
			env,
			signal,
			timeoutMs: cloneTimeoutMs,
		});
		if (result.code !== 0) {
			await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
			throw new Error(cacheActionError("建立", url, result, cloneTimeoutMs));
		}
		const commit = await revParse(cacheDir, env);
		const now = Date.now();
		await writeMeta(cacheDir, { url, commit, fetchedAt: now });
		return { cacheDir, commit, fetchedAt: now, first: true, fresh: true, stale: false, fetched: true };
	}

	let commit = await revParse(cacheDir, env);
	const age = Date.now() - (Number.isFinite(meta?.fetchedAt) ? meta.fetchedAt : 0);
	// ttl < 0 = 离线模式：有缓存就一直用，绝不自动 fetch；ttl = 0 = 每次都刷新。
	if (!refresh && ttlMs < 0) {
		return { cacheDir, commit, fetchedAt: meta?.fetchedAt ?? 0, first: false, fresh: true, stale: false, fetched: false };
	}
	if (!refresh && ttlMs >= 0 && age >= 0 && age < ttlMs) {
		return { cacheDir, commit, fetchedAt: meta?.fetchedAt ?? 0, first: false, fresh: true, stale: false, fetched: false };
	}

	reporter?.progress?.(`更新本地缓存 ${url}`);
	const fetched = await runGit(["-C", cacheDir, "fetch", "--depth", "1", "origin"], {
		cwd: cacheDir,
		env,
		signal,
		timeoutMs: fetchTimeoutMs,
	});
	if (fetched.code === 0) {
		const reset = await runGit(["-C", cacheDir, "reset", "--hard", "FETCH_HEAD"], {
			cwd: cacheDir,
			env,
			signal,
			timeoutMs: 10_000,
		});
		if (reset.code !== 0) {
			throw new Error(cacheActionError("更新", url, reset, 10_000));
		}
		await runGit(["-C", cacheDir, "clean", "-fdx"], { cwd: cacheDir, env, signal, timeoutMs: 10_000 });
		commit = await revParse(cacheDir, env);
		const now = Date.now();
		await writeMeta(cacheDir, { url, commit, fetchedAt: now });
		return { cacheDir, commit, fetchedAt: now, first: false, fresh: true, stale: false, fetched: true };
	}

	if (allowStale) {
		const when = Number.isFinite(meta?.fetchedAt) ? new Date(meta.fetchedAt).toISOString() : "未知时间";
		reporter?.progress?.(`缓存更新失败，继续使用 ${String(commit).slice(0, 7)}（上次 ${when}）`);
		return {
			cacheDir,
			commit,
			fetchedAt: meta?.fetchedAt ?? 0,
			first: false,
			fresh: false,
			stale: true,
			fetched: false,
			error: cacheActionError("更新", url, fetched, fetchTimeoutMs),
		};
	}
	throw new Error(cacheActionError("更新", url, fetched, fetchTimeoutMs));
}

/** 安装结果 JSON（`skills add --json`）→ 数组；CLI 偶尔会在 JSON 前后打提示。 */
export function parseAddResult(stdout) {
	const text = String(stdout ?? "").trim();
	if (text.length === 0) return undefined;
	const candidates = [text];
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// 继续尝试下一个候选
		}
	}
	return undefined;
}

/** 读 SKILL.md 的 frontmatter name（只认简单 `name: xxx`，不引入 YAML 依赖）。 */
async function frontmatterName(skillFile) {
	try {
		const raw = (await readFile(skillFile, "utf8")).slice(0, 4_000);
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
		if (!match) return undefined;
		const name = match[1].match(/^name:\s*(.+?)\s*$/mu)?.[1];
		return name?.replace(/^["']|["']$/g, "");
	} catch {
		return undefined;
	}
}

async function findSkillDirs(dir, depth = 0) {
	if (depth > 4) return [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const child = join(dir, entry.name);
		if (await exists(join(child, "SKILL.md"))) found.push(child);
		found.push(...(await findSkillDirs(child, depth + 1)));
	}
	return found;
}

async function locateSkill(cacheDir, name) {
	if (typeof name !== "string" || name.length === 0 || /[\\/]/u.test(name) || name === "." || name === "..") return undefined;
	const direct = join(cacheDir, "skills", name);
	if (await exists(join(direct, "SKILL.md"))) {
		return { dir: direct, rel: relative(cacheDir, direct) };
	}
	for (const dir of await findSkillDirs(cacheDir)) {
		if ((await frontmatterName(join(dir, "SKILL.md"))) === name) {
			return { dir, rel: relative(cacheDir, dir) };
		}
	}
	return undefined;
}

async function treeHash(cacheDir, relDir, env = process.env) {
	// Git 的 tree path 必须用 `/`，Windows 的 path.join 会给出 `\\`。
	const gitPath = relDir.split(/[\\/]/u).join("/");
	const result = await runGit(["-C", cacheDir, "rev-parse", "--verify", `HEAD:${gitPath}`], {
		env,
		timeoutMs: 10_000,
	});
	if (result.code !== 0) return undefined;
	const hash = result.output.trim().split("\n").pop();
	return /^[0-9a-f]{40}$/iu.test(hash) ? hash.toLowerCase() : undefined;
}

async function readLock(lockPath) {
	try {
		const parsed = JSON.parse(await readFile(lockPath, "utf8"));
		if (parsed === null || typeof parsed !== "object") throw new Error("lock 不是对象");
		parsed.skills ??= {};
		parsed.dismissed ??= {};
		parsed.version ??= 3;
		return parsed;
	} catch (error) {
		if (error?.code === "ENOENT") return { version: 3, skills: {}, dismissed: {} };
		throw error;
	}
}

async function writeLock(lockPath, lock) {
	const tmp = `${lockPath}.tmp-${process.pid}-${Date.now()}`;
	await mkdir(dirname(lockPath), { recursive: true });
	await writeFile(tmp, `${JSON.stringify(lock, null, 2)}\n`);
	await rename(tmp, lockPath);
}

/**
 * 把「本地路径安装」写出的 lock 条目回写成远端来源。
 *
 * 为什么必须做：其他 agent 执行 `npx skills update` 时依赖 lock 的 source/sourceType；
 * 留成 `/path/to/cache` 会被当成 local skill，无法再按仓更新。
 */
export async function rewriteLockSource({
	env = process.env,
	lockPath,
	cacheDir,
	commit,
	source,
	sourceUrl,
	sourceType,
	names = [],
	installed = [],
} = {}) {
	const targets = [...new Set([...names, ...installed.map((entry) => entry?.name).filter(Boolean)])];
	if (targets.length === 0) return { updated: [] };
	let lock;
	try {
		lock = await readLock(lockPath);
	} catch (error) {
		throw new Error(`读取 ${lockPath} 失败：${error instanceof Error ? error.message : String(error)}`);
	}
	const updated = [];
	for (const name of targets) {
		const located = await locateSkill(cacheDir, name);
		if (located === undefined) continue;
		const jsonEntry = installed.find((entry) => entry?.name === name);
		const existing = lock.skills[name];
		const entry = existing !== null && typeof existing === "object" ? existing : {};
		const hash = await treeHash(cacheDir, located.rel, env);
		entry.source = source;
		entry.sourceType = sourceType;
		entry.sourceUrl = sourceUrl;
		entry.skillPath = `${located.rel.split(/[\\/]/u).join("/")}/SKILL.md`;
		if (hash !== undefined) entry.skillFolderHash = hash;
		else if (typeof jsonEntry?.hash === "string") entry.skillFolderHash = jsonEntry.hash;
		entry.updatedAt = new Date().toISOString();
		if (typeof entry.installedAt !== "string") entry.installedAt = entry.updatedAt;
		lock.skills[name] = entry;
		updated.push(name);
	}
	if (updated.length > 0) await writeLock(lockPath, lock);
	return { updated };
}
