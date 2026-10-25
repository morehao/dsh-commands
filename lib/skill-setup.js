/**
 * 技能依赖自举（/skill-init 与 `/skill-init --update`）。
 *
 * 为什么需要这一层：
 * - 本插件的委托型命令是「意图表 → 委托对应 skill」，但 dsh **不从 node_modules 扫技能**，
 *   技能必须落在 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）或 canonical `~/.agents/skills`
 *   下才会进入模型目录。
 * - 官方 `skills` CLI（`npx skills`，vercel-labs/skills）支持 80+ agent，**没有 dsh**，
 *   所以它只能把技能取到 canonical 位置（`-a universal -g` → `~/.agents/skills/<name>`），
 *   「放进 dsh 技能根」这一步必须由我们建软链。
 *
 * 关键约束（均已核对上游实现，改动前请重读）：
 * - `add` 必须显式 `-a universal`：不带 `-a` 且未检测到任何 agent 时，`-y` 会装到**全部**
 *   agent 目录（100+ 个）。`skills update` 内部就是这么 spawn 的，所以我们不用 `update`。
 * - `-a universal -g` 走特例，直接落在 canonical `~/.agents/skills/<name>`，不会额外建
 *   `~/.config/agents/skills` 链接。
 * - `add` 只有拷贝语义（`link` 模式仅 `experimental_sync` 用），canonical 是拷贝而不是
 *   指向源码的软链 —— 想同步上游就再跑一次 `/skill-init --update`。
 * - 备份绝不能放进 `skills/` 里：该目录下任何含 `SKILL.md` 的子目录都会被当成技能扫到，
 *   与同名技能冲突。故这里不做"改名为备份"，只替换软链、真实目录一律拒绝覆盖。
 *
 * 本文件只做"检查 / 安装 / 软链 / 校验"，不复制任何 skill 逻辑。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as FS_CONST } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, symlink, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import {
	cacheCloneTimeoutMs,
	cacheFetchTimeoutMs,
	cacheStatus,
	cachedSkillHash,
	ensureSourceCache,
	parseAddResult,
	resolveCacheDir,
	rewriteLockSource,
} from "./skill-cache.js";
import { spawnCollect } from "./proc.js";
import { resolveCanonicalSkillsDir, resolveDshHome, resolveLockPath, skillPaths } from "./skill-paths.js";
import { backendOf, backendWarning, consoleStatePath, resolveOwnership } from "./skills-console.js";
import { stripAnsi, tail } from "./text.js";

// 兼容旧的导入路径：路径实现已移到 skill-paths.js，这里继续转发。
export { resolveCanonicalSkillsDir, resolveDshHome };

const require = createRequire(import.meta.url);

/** 技能来源仓（由 agent-skills 提供）。 */
export const SKILL_SOURCE = "morehao/agent-skills";
/** npx 回退用的 CLI 标识：不锁版本，跟随 npm `latest`；依赖可用时优先直接调用已安装版本。 */
export const DEFAULT_SKILLS_CLI = "skills";

/**
 * `/skill-init`（含 `--update`）使用的来源：默认是上游 GitHub 仓，
 * `DSH_COMMANDS_SKILL_SOURCE` 可换成可达镜像或本地目录（GitHub 不通时的逃生口）。
 */
export function resolveSkillSource(env = process.env) {
	const raw = env.DSH_COMMANDS_SKILL_SOURCE?.trim();
	return raw && raw.length > 0 ? raw : SKILL_SOURCE;
}
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * 连通性预检的超时：GitHub 443 不通时 `git clone` 自身要等 75s 才报错，
 * 外层硬超时更是 120s —— 用户看到的就是"回车后没反应"。预检用 8s 快速失败。
 */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const ABORT_GRACE_MS = 2_000;
const TAIL_LINES = 15;
/** 单行与整段回执的字符上限：clack 的 spinner 会把整次克隆压成一行，必须截断。 */
const MAX_TAIL_LINE_CHARS = 240;
const MAX_TAIL_CHARS = 1_200;

/** 命令依赖的技能集合（`skill` 省略即 git-kit），去重后保持声明顺序。 */
export function referencedSkills(commands) {
	const names = [];
	for (const def of commands) {
		const skill = def.skill ?? "git-kit";
		if (!names.includes(skill)) names.push(skill);
	}
	return names;
}

const exists = (p) =>
	access(p, FS_CONST.F_OK).then(
		() => true,
		() => false,
	);

const safeRealpath = (p) =>
	realpath(p).then(
		(v) => v,
		() => undefined,
	);

/** lstat：不跟随软链，用来区分"软链"与"真实目录/文件"。 */
const lstatOrNull = (p) =>
	lstat(p).then(
		(entry) => entry,
		() => undefined,
	);

/**
 * 判定 `<dshHome>/skills/<name>` 的现状。
 * - missing：不存在
 * - managed：realpath 指向 canonical 且 SKILL.md 可读（skills CLI 托管）→ 跳过
 * - unmanaged：存在但不托管（本地 clone 软链、悬空软链、真实目录…）→ 软链替换、真实目录拒绝
 */
async function inspectSkill(name, { dshSkillsDir, canonicalSkillsDir }) {
	const linkPath = join(dshSkillsDir, name);
	const entry = await lstatOrNull(linkPath);
	if (entry === undefined) {
		return { name, linkPath, state: "missing", target: undefined, isSymlink: false, isDirectory: false };
	}
	const target = await safeRealpath(linkPath);
	const canonical = await safeRealpath(join(canonicalSkillsDir, name));
	const isSymlink = entry.isSymbolicLink();
	const isDirectory = !isSymlink && entry.isDirectory();
	const readable = await exists(join(linkPath, "SKILL.md"));
	if (readable && target !== undefined && canonical !== undefined && target === canonical) {
		return { name, linkPath, state: "managed", target, isSymlink, isDirectory };
	}
	// 其余都是"不由 CLI 托管"：本地 clone 软链、悬空软链、真实目录、半装目录。
	return { name, linkPath, state: "unmanaged", target, isSymlink, isDirectory };
}

/** 在 PATH 里找可执行文件（含 Windows 扩展名）。 */
async function findOnPath(bin, env) {
	const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
	const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, bin + ext);
			if (await exists(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * 用登录 shell 反查可执行文件：GUI 启动的宿主即便已经注入过登录 shell 环境，
 * 仍可能因为 fnm/nvm 的 per-shell 路径而找不到 npx，这里做一次兜底。
 */
function findViaLoginShell(bin, env) {
	const shell = env.SHELL?.trim() || "/bin/zsh";
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let child;
		try {
			child = spawn(shell, ["-ilc", `command -v ${bin}`], {
				env,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			done(undefined);
			return;
		}
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", () => done(undefined));
		child.on("close", () => {
			const line = out.trim().split("\n").pop()?.trim();
			done(line !== undefined && line.startsWith("/") ? line : undefined);
		});
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// 忽略：只是兜底探测
			}
			done(undefined);
		}, 10_000).unref?.();
	});
}

/**
 * 优先用插件依赖里的 `skills`（安装时解析到的版本），而不是每次 `npx -y` 现解析/下载：
 * - 同一套 CLI、同一套 `~/.agents/skills` + `.skill-lock.json`，其他 agent 仍可直接 `npx skills`；
 * - 省掉 npx 每次约 2-3s 的启动开销（真机实测）；
 * - 没安装依赖（例如源码目录直接跑）时回退 npx，行为不变。
 */
async function resolveBundledCli() {
	try {
		const pkgPath = require.resolve("skills/package.json");
		const cliPath = join(dirname(pkgPath), "bin", "cli.mjs");
		if (!(await exists(cliPath))) return undefined;
		const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
		return { path: cliPath, label: `skills@${typeof pkg.version === "string" ? pkg.version : "bundled"}` };
	} catch {
		return undefined;
	}
}

/**
 * CLI 覆盖变量。新名是 `DSH_COMMANDS_SKILL_CLI_OVERRIDE`（完全替换命令本体）；
 * 旧名 `DSH_COMMANDS_SKILL_CLI` 保留一个版本作为 fallback，避免已配置的用户失效。
 */
function cliOverride(env) {
	return env.DSH_COMMANDS_SKILL_CLI_OVERRIDE?.trim() || env.DSH_COMMANDS_SKILL_CLI?.trim() || "";
}

/**
 * npx 回退包 spec。新名 `DSH_COMMANDS_SKILL_NPX_SPEC`；旧名 `DSH_COMMANDS_SKILLS_CLI`
 * 只差一个字母、极易配错，保留 fallback 但文档标 deprecated。
 */
function npxSpec(env) {
	return env.DSH_COMMANDS_SKILL_NPX_SPEC?.trim() || env.DSH_COMMANDS_SKILLS_CLI?.trim() || "";
}

/**
 * 解析 `skills` CLI 的调用方式。
 * `DSH_COMMANDS_SKILL_CLI_OVERRIDE` 可完全替换命令（测试桩 / 自定义安装方式），
 * 此时视为"可执行文件 + 固定前缀"，不再追加 npx 参数，也不启用 `--json`。
 */
async function resolveCli(env) {
	const override = cliOverride(env);
	if (override.length > 0) {
		return { command: override, argsPrefix: [], label: override, supportsJson: false, isOverride: true };
	}
	// 显式设置 DSH_COMMANDS_SKILL_NPX_SPEC 时尊重用户选择，走 npx 指定版本；
	// 未设置才优先用依赖里的已安装版本（省 npx 启动）。
	const specOverride = npxSpec(env);
	if (specOverride.length === 0) {
		const bundled = await resolveBundledCli();
		if (bundled !== undefined) {
			return {
				command: process.execPath,
				argsPrefix: [bundled.path],
				label: bundled.label,
				supportsJson: true,
				isOverride: false,
			};
		}
	}
	const spec = specOverride || DEFAULT_SKILLS_CLI;
	const npx = (await findOnPath("npx", env)) ?? (await findViaLoginShell("npx", env));
	if (npx === undefined) {
		throw new Error(
			"找不到 npx（PATH 与登录 shell 反查都没有）。请确认已安装 Node.js 22.20+ 且 npx 在 PATH 中，" +
				`或手工执行：npx -y ${spec} add ${resolveSkillSource(env)} --skill <技能名> -g -a universal -y`,
		);
	}
	return {
		command: npx,
		argsPrefix: ["-y", spec],
		label: `npx -y ${spec}`,
		supportsJson: true,
		isOverride: false,
	};
}

/**
 * 文本清洗与尾部截断在 `lib/text.js`；这里只保留命令侧的上限常量。
 * `\r` 必须当行分隔符：否则整次克隆的上千帧会拼成一行，尾部只会带进噪声。
 */
const cliTail = (text, lines = TAIL_LINES) =>
	tail(text, {
		lines,
		maxLineChars: MAX_TAIL_LINE_CHARS,
		maxChars: MAX_TAIL_CHARS,
		foldSpinner: true,
		stripDecorations: true,
		stripBoxEdges: true,
	});

/** 网络不可达的失败：CLI 的原始输出里通常带这些字样（git clone 的报错）。 */
const NETWORK_FAILURE =
	/(couldn'?t connect|failed to connect|could not resolve|connection timed out|network is unreachable|temporary failure in name resolution)/i;

/**
 * 给"连不上来源"的失败补一条可操作的提示。
 * 这类失败在 GitHub 不可达的网络上必然发生，且和"技能没装"长得不一样 ——
 * 不提示代理/镜像，用户只会看到一屏克隆进度然后以为命令没跑。
 */
function networkHint(output) {
	if (!NETWORK_FAILURE.test(output)) return "";
	return (
		"\n网络提示：连不上来源仓库（默认 GitHub）。这不是技能缺失，而是本机到仓库的 443 不通。" +
		"可先给 git/npm 配代理（如 git config --global http.proxy …、export HTTPS_PROXY=…）后重启 dsh 重试；" +
		"也可以改用可达镜像或本地目录：把 DSH_COMMANDS_SKILL_SOURCE 指向镜像/本地目录后再跑 /skill-init，" +
		"或手工执行 npx -y skills add <来源> --skill git-kit handoff -g -a universal -y。"
	);
}

/** 回执头部的耗时（一位小数秒）：长命令没有别的过程证据，至少让人知道花了多久。 */
const elapsedSince = (startedAt) => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const errorLine = (error) => (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim() ?? "";

/**
 * 同一 `DSH_HOME` 下同时只允许一个会写 canonical/软链的技能操作。
 *
 * 真机复现：`/skill-init` 看起来没反应，用户再按一次回车 → 两个 `skills add`
 * 同时克隆同一个仓库，互相拖慢且都更容易超时。第二次直接拒绝，比并行硬扛更好。
 * 这是进程内锁：dsh web 单进程执行命令，够用；跨进程场景由 skills CLI 自己的 lock 兜底。
 */
const ACTIVE_OPERATIONS = new Map();
const OPERATION_LABEL = { "skill-init": "初始化", "skill-update": "更新" };

function beginSkillOperation(kind, env) {
	// canonical 目录是跨 DSH_HOME 共享的写入目标，锁键必须带上它。
	const key = `${resolveDshHome(env)}|${resolveCanonicalSkillsDir()}`;
	const current = ACTIVE_OPERATIONS.get(key);
	if (current !== undefined) {
		const elapsed = elapsedSince(current.startedAt);
		throw new Error(
			`已有技能${OPERATION_LABEL[current.kind] ?? current.kind}任务正在进行（${current.kind}，已 ${elapsed}），` +
				"为避免重复克隆/覆盖，本次不再执行。请等它结束，或在会话头部「作业」里展开并停止它。",
		);
	}
	const token = { kind, startedAt: Date.now() };
	ACTIVE_OPERATIONS.set(key, token);
	return () => {
		if (ACTIVE_OPERATIONS.get(key) === token) ACTIVE_OPERATIONS.delete(key);
	};
}

function timeoutMs(env) {
	const raw = Number(env.DSH_COMMANDS_SKILL_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function probeTimeoutMs(env) {
	const raw = Number(env.DSH_COMMANDS_SKILL_PROBE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PROBE_TIMEOUT_MS;
}

/** 本地目录来源没有网络可探，直接放过。 */
const isLocalSource = (source) => /^(?:~|\/|\.{1,2}(?:\/|$))/u.test(source.trim());

/**
 * 把用户写的来源归一成 `git ls-remote` 能用的 URL。
 * - `owner/repo` → GitHub HTTPS（与 `skills add` 的默认解析一致）
 * - `git+https://…` → 去掉 `git+`
 * - 已经是 git/HTTPS/SSH URL → 原样
 */
export function probeUrlForSource(source) {
	const value = source.trim().replace(/^git\+/, "");
	if (value.length === 0 || isLocalSource(value)) return undefined;
	if (/^[^\s/:]+\/[^\s/:]+$/u.test(value)) return `https://github.com/${value.replace(/\.git$/i, "")}.git`;
	if (/^(?:https?|git|ssh):\/\//iu.test(value) || /^[^\s/@]+@[^\s/:]+:/u.test(value)) return value;
	return undefined;
}

/** 预检失败里哪些是"网络根本不通"（而不是认证/仓库不存在）。 */
const PROBE_NETWORK_FAILURE =
	/(couldn'?t connect|failed to connect|could not resolve|connection timed out|operation timed out|timed out|network is unreachable|no route to host|temporary failure in name resolution|connection refused|connection reset)/i;

/**
 * 在真正 `git clone` 之前做一次轻量连通性预检。
 *
 * 为什么必须有：GitHub 443 不通时，`git clone` 要等 75s（TCP 超时），`skills add`
 * 再等到外层硬超时（旧版 300s）才报错；用户看到的就是命令卡片转圈、五分钟没有输出。
 * 预检只跑 `git ls-remote --heads`，8s 内拿不到结果就杀，给出可操作提示。
 *
 * 只在"明确网络不通"时提前失败；认证失败、仓库不存在等交给上游 CLI ——
 * 它还有 `gh`/SSH 等回退路径，预检不该替它下结论。
 */
export async function probeSourceReachability(source, { env = process.env, signal } = {}) {
	const url = probeUrlForSource(source);
	const limit = probeTimeoutMs(env);
	if (url === undefined || limit === 0 || signal?.aborted === true) return { status: "skipped" };

	const startedAt = Date.now();
	const result = await spawnCollect({
		command: "git",
		args: ["ls-remote", "--heads", "--", url],
		cwd: homedir(),
		env: { ...env, GIT_TERMINAL_PROMPT: "0" },
		signal,
		timeoutMs: limit,
		maxOutputChars: 20_000,
	});
	const elapsedMs = Date.now() - startedAt;
	if (result.aborted === true) return { status: "skipped", url, elapsedMs };
	if (result.timedOut === true) return { status: "unreachable", timedOut: true, output: "", url, elapsedMs };
	if (result.error !== undefined) return { status: "skipped", url, elapsedMs };
	if (result.code === 0) return { status: "ok", url, elapsedMs };
	const text = stripAnsi(result.output);
	return PROBE_NETWORK_FAILURE.test(text)
		? { status: "unreachable", timedOut: false, output: cliTail(text, 3), url, elapsedMs }
		: { status: "inconclusive", output: cliTail(text, 3), url, elapsedMs };
}

/** 预检判定的网络不通 → 一条用户能照做的错误（而不是等两分钟看 SIGKILL）。 */
function unreachableSourceError(source, probe, env) {
	const url = probe.url ?? source;
	const took = `${((probe.elapsedMs ?? 0) / 1000).toFixed(1)}s`;
	const how = probe.timedOut
		? `超过 ${Math.round(probeTimeoutMs(env) / 1000)}s 没有连上`
		: `git ls-remote 失败（${took}）`;
	return (
		`连不上技能来源 ${url}（${how}）。这不是技能缺失，而是本机到源码仓的 git 网络不通。\n` +
		"可以先：\n" +
		"· 给 git 配代理后重试：git config --global http.proxy http://127.0.0.1:7890（端口按实际代理改）\n" +
		"· 或改用可达镜像/本地目录：export DSH_COMMANDS_SKILL_SOURCE=<镜像或本地路径> 后重跑 /skill-init，" +
		"或手工 npx -y skills add <来源> --skill <技能名> -g -a universal -y\n" +
		"· 网络只是慢时可调大预检超时：DSH_COMMANDS_SKILL_PROBE_MS=30000（毫秒）\n" +
		"· 已装好的技能不受影响，只是本次安装/更新没有执行。" +
		(probe.output ? `\n诊断：${probe.output}` : "")
	);
}

/** 需要联网时才预检；测试桩/自定义 CLI 跳过（它可能根本不联网）。 */
async function requireReachableSource(source, { env, reporter, signal }) {
	if (cliOverride(env)) return;
	const url = probeUrlForSource(source);
	if (url === undefined) return;
	if (probeTimeoutMs(env) === 0) return;
	reporter?.progress?.(`检查来源连通性：${url}`);
	const probe = await probeSourceReachability(source, { env, signal });
	if (probe.status === "unreachable") throw new Error(unreachableSourceError(source, probe, env));
	if (probe.status === "ok") reporter?.progress?.(`来源可达：${url}`);
}

/** 上游 `skills` CLI 自己的克隆超时；让它在我们的硬超时之前触发。 */
const CLONE_TIMEOUT_ENV = "SKILLS_CLONE_TIMEOUT_MS";
const CLONE_TIMEOUT_MARGIN_MS = 30_000;

/**
 * 子进程环境。
 *
 * `SKILLS_CLONE_TIMEOUT_MS` 必须比外层的 `DSH_COMMANDS_SKILL_TIMEOUT_MS` 更早：
 * 外层定时器会先把子进程 SIGKILL 掉，CLI 自己那条
 * 「Clone timed out after Ns … 可传本地路径」的诊断就永远拿不到
 * （真机复现：命令卡片显示 `退出码 SIGKILL`，真正有用的建议被截掉）。
 *
 * `GIT_TERMINAL_PROMPT=0`：非交互命令里绝不能弹凭据提示 —— 弹了就是无限期挂起，
 * 比克隆超时更难排查。
 */
function cliEnv(env) {
	const cloneTimeout = Math.max(30_000, timeoutMs(env) - CLONE_TIMEOUT_MARGIN_MS);
	return {
		...env,
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		CI: "1",
		TERM: "dumb",
		...(env.GIT_TERMINAL_PROMPT?.trim() ? {} : { GIT_TERMINAL_PROMPT: "0" }),
		...(env.GIT_HTTP_LOW_SPEED_LIMIT?.trim() ? {} : { GIT_HTTP_LOW_SPEED_LIMIT: "1000" }),
		...(env.GIT_HTTP_LOW_SPEED_TIME?.trim() ? {} : { GIT_HTTP_LOW_SPEED_TIME: "10" }),
		...(env[CLONE_TIMEOUT_ENV]?.trim() ? {} : { [CLONE_TIMEOUT_ENV]: String(cloneTimeout) }),
	};
}

/**
 * 执行 CLI（argv 直传、不经 shell），返回退出码与合并输出。
 *
 * `reporter`（可选，见 lib/job-progress.js）把同一份 stdout/stderr 旁路给后台任务面板：
 * 回执只用本地收集的 `output`，面板看到的是流式的原始输出。
 * `registerCancel`（可选）把"用户停止作业 / 命令被取消"接到同一个终止动作上。
 */
async function runCli(invocation, args, { env, signal, reporter, registerCancel, forwardStdout = true }) {
	if (signal?.aborted === true) throw new Error("命令已取消");
	const result = await spawnCollect({
		command: invocation.command,
		args: [...invocation.argsPrefix, ...args],
		cwd: homedir(),
		env: cliEnv(env),
		signal,
		timeoutMs: timeoutMs(env),
		abortGraceMs: ABORT_GRACE_MS,
		maxOutputChars: 200_000,
		collectStdout: true,
		onData(text, channel) {
			// 作业面板是纯文本终端（不解析 ANSI），旁路前先去色，否则面板里全是 `[38;5;250m` 之类转义码。
			// `--json` 时 stdout 是机器可读数组，不往面板里灌；stderr 的阶段/摘要仍然展示。
			if (channel !== "stdout" || forwardStdout) reporter?.write?.(stripAnsi(text), channel);
		},
		onCancelReady: registerCancel,
	});
	if (result.error !== undefined) throw result.error;
	return result;
}

/** CLI 失败原因的稳定措辞：超时 / 被信号杀 / 普通退出码。 */
function describeCliFailure(invocation, verb, result, env) {
	const detail = `\n${cliTail(result.output)}${networkHint(result.output)}`;
	if (result.timedOut === true) {
		return `${invocation.label} ${verb}超时（超过 ${Math.round(timeoutMs(env) / 1000)}s，已强制终止）：${detail}`;
	}
	if (result.signal !== null && result.signal !== undefined) {
		return `${invocation.label} ${verb}被信号 ${result.signal} 终止：${detail}`;
	}
	return `${invocation.label} ${verb}失败（退出码 ${result.code}）：${detail}`;
}

/**
 * 组装 `add` 参数。`names` 为空时不传 `--skill`（CLI 在 `-y` 下会装该来源发现的所有技能）。
 * `-a universal` 必填：否则未检测到 agent 时会把技能装到全部 agent 目录；`-y` 全非交互。
 */
function buildAddArgs(names, source = SKILL_SOURCE, { json = false } = {}) {
	const args = ["add", source];
	for (const name of names) args.push("--skill", name);
	args.push("-g", "-a", "universal", "-y");
	if (json) args.push("--json");
	return args;
}

/**
 * 归一化来源标识，用来把用户输入与 lock 里的 `source` / `sourceUrl` 对上：
 * `morehao/agent-skills` == `https://github.com/morehao/agent-skills.git` == `git@github.com:morehao/agent-skills.git`。
 */
function normalizeSource(raw, env = process.env) {
	const value = raw.trim();
	if (value.length === 0) return "";
	if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~")) {
		const expanded = value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
		return `local:${resolve(expanded)}`;
	}
	return value
		.replace(/^git\+/, "")
		.replace(/^git@([^:]+):/, "$1/")
		.replace(/^https?:\/\//, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/** lock 条目是否属于该来源（`source` 与 `sourceUrl` 任一匹配即可）。 */
function lockEntryFromSource(entry, wanted, env = process.env) {
	if (entry === null || typeof entry !== "object") return false;
	return [entry.source, entry.sourceUrl]
		.filter((value) => typeof value === "string")
		.some((value) => normalizeSource(value, env) === wanted);
}

/**
 * 删除可安全重建的旧条目：**只接受软链**（含悬空软链）。
 * 真实目录/真实文件一律拒绝 —— 删掉就不可恢复，不能替用户做这个决定。
 */
async function removeReplacable(linkPath) {
	const entry = await lstatOrNull(linkPath);
	if (entry === undefined) return;
	if (!entry.isSymbolicLink()) {
		throw new Error(
			`${linkPath} 是真实${entry.isDirectory() ? "目录" : "文件"}（不是软链），拒绝覆盖；` +
				"请自行移走后重跑",
		);
	}
	// 软链的删除只影响这条链接本身：它指向的目录（例如你的本地 agent-skills clone）一字不动。
	await unlink(linkPath);
}

/** 建立 `<dshHome>/skills/<name>` → canonical 的软链（旧软链会被替换）。 */
async function linkSkill(name, { dshSkillsDir, canonicalSkillsDir }) {
	const canonical = join(canonicalSkillsDir, name);
	const linkPath = join(dshSkillsDir, name);
	await mkdir(dshSkillsDir, { recursive: true });
	await removeReplacable(linkPath);
	try {
		await symlink(canonical, linkPath, "dir");
	} catch (error) {
		throw new Error(
			`软链失败（${linkPath} → ${canonical}）：${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { linkPath, canonical };
}

/**
 * 批量确保一组技能在 dsh 技能根里可用：托管则跳过、软链则替换、真实目录则拒绝。
 * 返回结构化结果，由各命令自己措辞（init 说"新装"、install 说"已安装"）。
 * `reporter` 让后台任务行逐个技能刷新阶段文案（降级时是 no-op）。
 */
async function ensureLinks(names, ctx, reporter, knownStates) {
	const known = new Map((knownStates ?? []).map((state) => [state.name, state]));
	const results = [];
	for (const name of names) {
		const state = known.get(name) ?? (await inspectSkill(name, ctx));
		if (state.state === "managed") {
			reporter?.progress?.(`${name}：已托管，跳过`);
			results.push({ name, kind: "skip", state });
			continue;
		}
		const canonicalPath = join(ctx.canonicalSkillsDir, name);
		if (!(await exists(join(canonicalPath, "SKILL.md")))) {
			reporter?.progress?.(`${name}：canonical 缺 SKILL.md`);
			results.push({ name, kind: "no-canonical", state, canonicalPath });
			continue;
		}
		reporter?.progress?.(`链入 dsh：${name}`);
		try {
			const linked = await linkSkill(name, ctx);
			results.push({
				name,
				kind: state.state === "missing" ? "linked-new" : "linked-replaced",
				state,
				linked,
				canonicalPath,
			});
		} catch (error) {
			results.push({
				name,
				kind: "refused",
				state,
				canonicalPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}

/** 把 ensureLinks 的结果渲染成一行；`newVerb` 描述写入动作（默认「新装」）。 */
function describeLink(result, { newVerb = "新装" } = {}) {
	switch (result.kind) {
		case "skip":
			return `= ${result.name}：已托管，跳过`;
		case "linked-new":
			return `✓ ${result.name}：${newVerb} → ${result.linked.canonical}（已软链 ${result.linked.linkPath}）`;
		case "linked-replaced":
			return `↻ ${result.name}：已替换为托管软链（原指向 ${result.state.target ?? "无法解析的软链"}）`;
		case "no-canonical":
			return `✗ ${result.name}：${result.canonicalPath} 缺 SKILL.md（上游可能改名、移除了该技能，或来源里没有它）`;
		default:
			return `✗ ${result.name}：${result.error}`;
	}
}

/**
 * 一组 ensureLinks 结果是否"什么都没发生"：全是托管跳过，没有新装/替换/拒绝/缺 canonical。
 * 用来把回执首行换成结论式（`✓ 无需操作：…`），一眼能看出这次没干活。
 */
function allSettled(results) {
	return results.every((result) => result.kind === "skip");
}

const EMPTY_FRESHNESS = Object.freeze({
	cacheSource: false,
	target: undefined,
	status: undefined,
	fresh: false,
	changed: undefined,
});

/** 命令依赖的分支契约 → 需要存在的文件（与 `scripts/check-skill-contract.mjs` 同规则）。 */
export function requirements(commands) {
	return commands.map((def) => ({
		skill: def.skill ?? "git-kit",
		branch: def.branch,
		command: def.name,
		file: join("references", `${def.branch}.md`)
	}));
}

/** 链状态 → 设计里的 link.kind。 */
function linkKindOf(state) {
	if (state.state === "missing") return "missing";
	if (state.state === "managed") return "managed";
	if (state.isSymlink) return state.target === undefined ? "dangling" : "foreign";
	return state.isDirectory ? "real-dir" : "real-file";
}

const consoleRecordFor = (name, state) => state?.installs?.find((entry) => entry.name === name) ?? null;

async function digestOf(path) {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch {
		return undefined;
	}
}

/** 一个技能在某个目录下的契约文件是否齐全（SKILL.md + 该分支的 references 文件）。 */
async function skillFilesAt(dir, req) {
	if (!(await exists(join(dir, "SKILL.md")))) return false;
	if (!(await exists(join(dir, "references")))) return true;
	return exists(join(dir, req.file));
}

/**
 * 只读观测（设计 B2）：一次算出每个技能的控制台记录、canonical、链状态、契约位置。
 *
 * - 只读、不联网；缓存新鲜度只在"全部已托管"时才做本地 hash 比对（与旧 plan 同条件）。
 * - `console` 由调用方注入 `{ present, state }`；P1a 的旧命令路径不注入（视作 console 不存在），
 *   行为与今天等价；P2/P3a 再传入 `detectConsole()` / `readConsoleState()` 的结果。
 * - 控制台记录只在 console 存在时参与所有权判定；console 不存在时残留记录只产生 warning。
 */
export async function observeSkills(env = process.env, commands, { console: consoleHint } = {}) {
	const paths = skillPaths(env);
	const names = referencedSkills(commands);
	const backend = backendOf(env);
	const consolePresent = consoleHint?.present === true;
	const consoleState = consoleHint?.state ?? null;
	const source = resolveSkillSource(env);
	const cacheSource = usesSourceCache(source, env);
	const lock = await lockEntries(env);
	const skills = [];
	for (const name of names) {
		const state = await inspectSkill(name, paths);
		const canonicalPath = join(paths.canonicalSkillsDir, name);
		const canonicalSkillMd = await exists(join(canonicalPath, "SKILL.md"));
		const canonicalReal = await safeRealpath(canonicalPath);
		const linkReadable = await exists(join(paths.dshSkillsDir, name, "SKILL.md"));
		const linkReal = linkReadable ? await safeRealpath(join(paths.dshSkillsDir, name)) : undefined;
		const effectiveDir = linkReadable
			? (linkReal ?? join(paths.dshSkillsDir, name))
			: (canonicalReal ?? canonicalPath);
		const shadowed =
			linkReadable && canonicalReal !== undefined && linkReal !== undefined && linkReal !== canonicalReal;
		skills.push({
			name,
			canonical: { ok: canonicalSkillMd, path: canonicalPath, skillMd: canonicalSkillMd, files: null },
			link: { kind: linkKindOf(state), target: state.target },
			lock: lock[name] ?? null,
			console: { present: consolePresent, record: consoleRecordFor(name, consoleState) },
			effectiveDir,
			shadowed,
			// 旧投影：ensureLinks / confirm / 既有 smoke 仍按这组字段工作。
			state: state.state,
			linkPath: state.linkPath,
			target: state.target,
			isSymlink: state.isSymlink,
			isDirectory: state.isDirectory
		});
	}
	const pending = skills.filter((skill) => skill.state !== "managed");
	const freshness =
		pending.length === 0 && cacheSource
			? await assessFreshness(source, names, { env, paths })
			: { ...EMPTY_FRESHNESS, cacheSource };
	const cache = {
		cacheSource,
		hasCache: freshness.status?.exists === true,
		ageMs: Number.isFinite(freshness.status?.ageMs) ? freshness.status.ageMs : null,
		commit: typeof freshness.status?.meta?.commit === "string" ? freshness.status.meta.commit : null,
		stale: freshness.status?.exists === true && freshness.status?.fresh === false,
		// 旧投影（plan.freshness / checkSourceSkills 的判据）
		target: freshness.target,
		status: freshness.status,
		fresh: freshness.fresh,
		changed: freshness.changed
	};
	const warnings = [];
	const backendNote = backendWarning(env);
	if (backendNote.length > 0) warnings.push(backendNote);
	if (consolePresent !== true && (consoleState?.installs?.length ?? 0) > 0) {
		warnings.push("检测到技能控制台的残留记录，但控制台未安装/未启用；本次按 CLI 管理，记录可能过期。");
	}
	if (backend === "cli" && consolePresent === true && (consoleState?.installs?.length ?? 0) > 0) {
		warnings.push("已强制 CLI 后端：忽略控制台记录，控制台记账可能过期。");
	}
	return {
		version: 1,
		backend,
		consolePresent,
		consoleState,
		consoleStatePath: consoleState?.path ?? consoleStatePath(env),
		consoleStateDigest: consoleState ? await digestOf(consoleState.path) : undefined,
		source,
		paths,
		cache,
		requirements: requirements(commands),
		residualConsoleRecords: consolePresent !== true && (consoleState?.installs?.length ?? 0) > 0,
		warnings,
		skills
	};
}

/** 同一个技能的所有权（带缓存，避免 plan 里对每个技能反复查记录）。 */
function ownershipIn(snapshot) {
	const cache = new Map();
	return (name) => {
		if (!cache.has(name)) {
			cache.set(
				name,
				resolveOwnership(name, {
					backend: snapshot.backend,
					consolePresent: snapshot.consolePresent,
					state: snapshot.consoleState
				})
			);
		}
		return cache.get(name);
	};
}

/**
 * 纯函数计划（设计 B3）：同一快照 → 深相等的 actions，顺序固定为 `REQUIRED_SKILLS`。
 *
 * P1a 保留旧语义：`pending`（非 managed）与 plan 已知的 `freshness.changed` 都生成 `install`。
 * 控制台管理 / blocked / relink 的判定已按 A4/A9 实现，但旧命令路径在 P1a 不注入 console。
 */
export function planOperation(mode, { names } = {}, snapshot) {
	if (mode !== "init" && mode !== "update" && mode !== "check") {
		throw new Error(`未知技能模式：${mode}`);
	}
	const all = snapshot.skills.map((skill) => skill.name);
	const requested = (Array.isArray(names) ? names : []).filter((name) => all.includes(name));
	// `names` 对所有 mode 都收窄范围（旧命令 init 不带 names，行为不变）。
	const targets = requested.length > 0 ? requested : all;
	const changed = new Set(snapshot.cache?.changed ?? []);
	const own = ownershipIn(snapshot);
	const actions = [];
	const warnings = [...(snapshot.warnings ?? [])];
	const byName = new Map(snapshot.skills.map((skill) => [skill.name, skill]));

	for (const name of targets) {
		const skill = byName.get(name);
		const ownership = own(name);
		if (ownership.blocked === true) {
			actions.push({ type: "blocked", name, writes: false, detail: ownership.reason, reason: ownership.reason });
			continue;
		}
		if (ownership.owner === "console") {
			if (ownership.mode === "off") {
				actions.push({ type: "delegate", name, writes: false, detail: "控制台已停用", reason: "console-off" });
				continue;
			}
			if (skill.canonical?.ok !== true) {
				actions.push({
					type: "blocked",
					name,
					writes: false,
					detail: "控制台管理，canonical 缺失，请先在控制台处理",
					reason: "console-canonical-missing"
				});
				continue;
			}
			if (mode === "update") {
				actions.push({ type: "delegate", name, writes: false, detail: "由控制台管理，请在控制台更新", reason: "console-managed" });
				continue;
			}
			if (mode === "check") {
				actions.push({ type: "skip", name, writes: false, detail: "由控制台管理，仅校验", reason: "console-managed" });
				continue;
			}
			if (skill.link.kind === "missing" || skill.link.kind === "dangling") {
				actions.push({ type: "relink", name, writes: true, detail: "控制台已启用，重建软链", reason: "console-relink" });
			} else if (skill.link.kind === "managed") {
				actions.push({ type: "delegate", name, writes: false, detail: "由控制台管理", reason: "console-managed" });
			} else {
				actions.push({
					type: "delegate",
					name,
					writes: false,
					detail: "控制台管理的技能链接指向别处，未改写",
					reason: "console-shadow"
				});
				warnings.push(`${name}：DSH 链指向控制台 canonical 之外，控制台的 on 未生效`);
			}
			continue;
		}

		// owner === "self"：沿用旧的 init/update/check 语义。
		const kind = skill.link.kind;
		if (mode === "init") {
			if (kind === "managed") {
				if (changed.has(name)) {
					// P1b：上游更新只警告，不写盘；重装是 `--update` 的显式动作。
					actions.push({
						type: "warn",
						name,
						writes: false,
						detail: "上游有更新，本次未安装（运行 /skill-init --update 更新）",
						reason: "changed"
					});
				} else {
					actions.push({ type: "skip", name, writes: false, detail: "已托管，跳过", reason: "managed" });
				}
				continue;
			}
			const detail =
				kind === "missing"
					? "未安装，将安装"
					: kind === "dangling"
						? "非托管软链（悬空），将安装并重建"
						: kind === "foreign"
							? "非托管软链，将替换为托管链"
							: "真实目录/文件：安装 canonical，链接保留不改写";
			actions.push({ type: "install", name, writes: true, detail, reason: kind });
			continue;
		}
		if (mode === "update") {
			if (kind === "managed") actions.push({ type: "update", name, writes: true, detail: "更新到上游最新", reason: "managed" });
			else if (kind === "missing") {
				actions.push({ type: "skip", name, writes: false, detail: "未安装，跳过（先执行 /skill-init）", reason: "missing" });
			} else {
				actions.push({ type: "skip", name, writes: false, detail: "不由 skills CLI 托管，跳过（先执行 /skill-init）", reason: "unmanaged" });
			}
			continue;
		}
		if (kind === "managed") actions.push({ type: "skip", name, writes: false, detail: "已托管", reason: "managed" });
		else if (kind === "missing") actions.push({ type: "warn", name, writes: false, detail: "未安装", reason: "missing" });
		else actions.push({ type: "warn", name, writes: false, detail: "非托管", reason: "unmanaged" });
	}

	const installs = actions.filter((action) => action.type === "install");
	const updates = actions.filter((action) => action.type === "update");
	const relinks = actions.filter((action) => action.type === "relink");
	const blockedActions = actions.filter((action) => action.type === "blocked");
	const delegates = actions.filter((action) => action.type === "delegate");
	const confirm = {
		installs: installs.length,
		updates: updates.length,
		relinks: relinks.length,
		blocked: blockedActions.length,
		delegated: delegates.length,
		needs: installs.length + relinks.length > 0
	};

	const legacyStates = targets.map((name) => {
		const skill = byName.get(name);
		return {
			name,
			linkPath: skill.linkPath,
			state: skill.state,
			target: skill.target,
			isSymlink: skill.isSymlink,
			isDirectory: skill.isDirectory
		};
	});
	const pending = legacyStates.filter((state) => state.state !== "managed" && own(state.name).owner === "self");
	const managed = legacyStates.filter((state) => state.state === "managed" && own(state.name).owner === "self");
	const allManaged = mode === "update" ? managed.length === targets.length && targets.length > 0 : pending.length === 0;
	const observedCache = snapshot.cache ?? {};
	const freshness = {
		cacheSource: observedCache.cacheSource === true,
		target: observedCache.target,
		status: observedCache.status,
		fresh: observedCache.fresh === true,
		changed: observedCache.changed
	};

	let skipReason;
	if (mode === "init") {
		// 只读结论（skip/warn）不建作业；delegate/blocked 仍要执行（零写）以便给出处理指引。
		const passive = actions.length > 0 && actions.every((action) => action.type === "skip" || action.type === "warn");
		if (pending.length === 0 && passive) {
			if (!freshness.cacheSource) skipReason = "已全部托管，无需安装";
			else if (freshness.fresh) skipReason = "10 分钟内已检查过上游，本次不重复联网";
		}
	} else if (mode === "update") {
		skipReason =
			targets.length === 0
				? "没有可处理的技能"
				: managed.length === 0
					? "没有由 skills CLI 托管的技能"
					: undefined;
	}

	return {
		mode,
		paths: snapshot.paths,
		source: snapshot.source,
		observed: snapshot,
		actions,
		confirm,
		warnings,
		// 内部字段：回退路径 runSkillInit/runSkillUpdate 与离线冒烟仍使用
		kind: mode === "update" ? "skill-update" : mode === "check" ? "skill-check" : "skill-init",
		requested,
		targets,
		states: legacyStates,
		pending,
		managed,
		allManaged,
		freshness,
		skipReason,
		contract: mode === "init",
		requirements: snapshot.requirements ?? []
	};
}

/**
 * 按 COMMANDS 的分支契约校验技能目录（与 scripts/check-skill-contract.mjs 同规则，
 * 区别是这里只报不失败 —— 契约漂移不该让 init 整体失败）。
 *
 * 检查对象：控制台管理的技能读 canonical；其余读 effectiveDir（DSH 实际会加载的目录）。
 */
export async function checkContract(plan, commands) {
	const failures = [];
	const observed = plan.observed;
	const skills = new Map((observed?.skills ?? []).map((skill) => [skill.name, skill]));
	const own = observed === undefined ? () => ({ owner: "self", mode: null, blocked: false }) : ownershipIn(observed);
	const reqs = plan.requirements ?? requirements(commands ?? []);
	for (const req of reqs) {
		const skill = skills.get(req.skill);
		const ownership = own(req.skill);
		if (ownership.owner === "console" && ownership.mode === "off") continue;
		const managedByConsole = ownership.owner === "console" && ownership.blocked !== true;
		const dir = managedByConsole ? skill?.canonical?.path : skill?.effectiveDir;
		if (dir === undefined) {
			failures.push(`${req.skill} 缺失（/${req.command} 无法执行）`);
			continue;
		}
		if (!(await exists(join(dir, "SKILL.md")))) {
			failures.push(
				managedByConsole
					? "控制台管理，canonical 缺失，请先在控制台处理"
					: `${req.skill} 缺失（/${req.command} 无法执行）`
			);
			continue;
		}
		if (await exists(join(dir, "references"))) {
			if (!(await exists(join(dir, req.file)))) {
				failures.push(
					managedByConsole
						? "控制台里的技能版本不满足本插件命令契约；请在控制台更新，或切 cli 后 /skill-init --update"
						: `${req.skill}#${req.branch} 缺 ${req.file}（/${req.command}）`
				);
			}
		}
	}
	return failures;
}

/** 环境在确认后、执行前发生了变化（文件刚出现/链被改指向/canonical 被删）。 */
export class EnvironmentChangedError extends Error {
	constructor(message = "环境已变化，请重新运行 /skill-init") {
		super(message);
		this.name = "EnvironmentChangedError";
		this.code = "ENVIRONMENT_CHANGED";
	}
}

/** 从 plan 的契约需求反推命令列表，供写前指纹重新 observe 使用。 */
function commandsOfPlan(plan) {
	return (plan.requirements ?? []).map((req) => ({ name: req.command, skill: req.skill, branch: req.branch }));
}

/** plan → 写 action：新 plan 自带 actions，不再从 pending/freshness 反推。 */
function actionsOfPlan(plan) {
	return Array.isArray(plan.actions) ? plan.actions : [];
}

/** action 对应的链状态（新快照优先，旧 plan 用 states 投影）。 */
function linkKindFrom(plan, name) {
	const observed = plan.observed?.skills?.find((skill) => skill.name === name);
	if (observed !== undefined) return observed.link.kind;
	const state = (plan.states ?? []).find((entry) => entry.name === name);
	if (state === undefined) return undefined;
	if (state.state === "missing") return "missing";
	if (state.state === "managed") return "managed";
	if (state.isSymlink) return state.target === undefined ? "dangling" : "foreign";
	return state.isDirectory ? "real-dir" : "real-file";
}

/** 写前指纹：确认后若链/canonical 与 plan 不一致，整次中止（不做"尽量写"）。 */
async function assertEnvironmentUnchanged(plan, { env }) {
	if (plan.observed === undefined) return;
	const writes = (plan.actions ?? []).filter((action) => action.writes === true && action.type !== "update");
	if (writes.length === 0) return;
	const after = await observeSkills(env, commandsOfPlan(plan), {
		console: { present: plan.observed.consolePresent, state: plan.observed.consoleState }
	});
	for (const action of writes) {
		const before = plan.observed.skills.find((skill) => skill.name === action.name);
		const now = after.skills.find((skill) => skill.name === action.name);
		if (before === undefined || now === undefined) continue;
		if (linkKindFrom(plan, action.name) !== now.link.kind || before.canonical.ok !== now.canonical.ok) {
			throw new EnvironmentChangedError(
				`环境已变化（${action.name} 的链或 canonical 状态在确认后改变），请重新运行 /skill-init`
			);
		}
	}
}

/**
 * 只读检查上游（设计 B5）：保留旧 `checkSourceSkills`/`assessFreshness` 语义，不写盘。
 * 返回 `{ cache, changed, error }`；调用方决定"连不上时是否失败"。
 */
export async function probeUpstream(plan, { env = process.env, reporter, signal } = {}) {
	const names = plan.targets ?? plan.observed?.skills?.map((skill) => skill.name) ?? [];
	const cacheSource = plan.freshness?.cacheSource === true;
	if (!cacheSource || names.length === 0) return { cache: undefined, changed: [] };
	try {
		const check = await checkSourceSkills(plan.source, names, { env, reporter, signal, allowStale: true });
		return { cache: check.cache, changed: check.changed ?? [] };
	} catch (error) {
		return { cache: undefined, changed: [], error };
	}
}

/**
 * 执行 plan（设计 B4）：install/update 各合并一次 CLI，relink 合并一次 ensureLinks；
 * delegate/blocked/skip/warn 零写。锁、`-a universal -y`、lock 来源回写与逐项失败语义沿用旧实现。
 *
 * `probe` 由 `probeUpstream` 提供（cache 用于避免二次联网）；apply 本身不发起上游检查。
 */
export async function applyPlan(plan, { env = process.env, reporter, signal, registerCancel, choice = "all", probe, commands } = {}) {
	const mode = plan.mode ?? (plan.kind === "skill-update" ? "update" : "init");
	const missingOnly = choice === "missing";
	const actions = actionsOfPlan(plan);
	const installs = actions.filter((action) => action.type === "install");
	const updates = actions.filter((action) => action.type === "update");
	const relinks = actions.filter((action) => action.type === "relink");
	const kindOf = (name) => linkKindFrom(plan, name);
	const missing = (plan.pending ?? []).filter((state) => state.state === "missing").map((state) => state.name);
	const toInstall = (missingOnly ? installs.filter((action) => kindOf(action.name) === "missing") : installs).map(
		(action) => action.name
	);
	const targets = missingOnly ? missing : (plan.targets ?? []);
	const needsWork = missingOnly ? missing.length > 0 : plan.skipReason === undefined;
	const release = needsWork ? beginSkillOperation(mode === "update" ? "skill-update" : "skill-init", env) : undefined;
	let cache = probe?.cache;
	let installOutcome;
	let linkResults = [];
	let updated = [];
	let failures = [];
	try {
		if (mode === "init") await assertEnvironmentUnchanged(plan, { env });
		if (mode === "update") {
			const names = updates.map((action) => action.name);
			if (names.length > 0) {
				installOutcome = await installFromSource(plan.source, names, {
					env,
					reporter,
					signal,
					registerCancel,
					refresh: true,
					allowStale: false,
					verb: "更新"
				});
				cache = installOutcome.cache;
				reporter?.progress?.("校验软链仍可解析");
				for (const name of names) {
					const state = (plan.states ?? []).find((entry) => entry.name === name);
					const linkPath = state?.linkPath ?? join(plan.paths.dshSkillsDir, name);
					const readable = await exists(join(linkPath, "SKILL.md"));
					if (readable) {
						updated.push({ name, target: state?.target });
						continue;
					}
					try {
						const linked = await linkSkill(name, plan.paths);
						updated.push({ name, target: state?.target, rebuilt: true, canonical: linked.canonical });
					} catch (error) {
						updated.push({ name, target: state?.target, error: error instanceof Error ? error.message : String(error) });
					}
				}
			}
			return { mode, toInstall: [], updated, linkResults: [], failures, cache, installOutcome, needsWork };
		}

		if (toInstall.length > 0) {
			installOutcome = await installFromSource(plan.source, toInstall, {
				env,
				reporter,
				signal,
				registerCancel,
				refresh: false,
				allowStale: true,
				verb: "安装",
				prefetchedCache: cache
			});
			cache = installOutcome.cache;
		}

		// 真实目录/文件不可回滚，不替用户删（ensureLinks 内按单项失败处理，其余技能继续）。
		reporter?.progress?.("链入 dsh 技能目录");
		// 无控制台的旧路径沿用"对全部 targets 收敛"（保留「已托管，跳过」明细）；
		// 控制台存在时只处理 install/relink，避免改写控制台声明为别处/真实目录的链。
		const linkNames =
			plan.observed?.consolePresent === true ? [...new Set([...toInstall, ...relinks.map((action) => action.name)])] : targets;
		let linkStates;
		if (missingOnly) linkStates = (plan.states ?? []).filter((state) => linkNames.includes(state.name));
		else if (toInstall.length === 0) linkStates = plan.states;
		if (linkNames.length > 0) linkResults = await ensureLinks(linkNames, plan.paths, reporter, linkStates);

		reporter?.progress?.("校验命令分支契约");
		failures = await checkContract(plan, commands);
		return { mode, toInstall, updated, linkResults, failures, cache, installOutcome, needsWork };
	} finally {
		release?.();
	}
}

/**
 * 校验执行结果（设计 B5）：canonical 可读、relink 后链正确、console state 字节未变、契约文件存在。
 *
 * @returns {{canonical: string, links: string, state: "unchanged"|"changed", problems: string[]}}
 */
export async function verifyPlan(plan, { env = process.env, snapshotAfter, commands } = {}) {
	const after =
		snapshotAfter ??
		(commands === undefined
			? undefined
			: await observeSkills(env, commands, {
					console: { present: plan.observed?.consolePresent === true, state: plan.observed?.consoleState ?? null }
				}));
	const problems = [];
	if (after === undefined) {
		return { canonical: "?/?", links: "?/?", state: "unchanged", problems: ["缺少执行后的快照，无法校验"] };
	}
	const afterByName = new Map(after.skills.map((skill) => [skill.name, skill]));
	const actions = actionsOfPlan(plan);
	const verifyNames = [...new Set(actions.filter((action) => ["install", "update", "relink"].includes(action.type)).map((action) => action.name))];
	const canonicalOk = verifyNames.filter((name) => afterByName.get(name)?.canonical?.ok === true).length;
	if (canonicalOk < verifyNames.length) {
		for (const name of verifyNames) {
			if (afterByName.get(name)?.canonical?.ok !== true) problems.push(`${name}：canonical 不可读`);
		}
	}
	const linkNames = actions
		.filter((action) => action.type === "install" || action.type === "relink")
		.map((action) => action.name)
		.filter((name) => !["real-dir", "real-file"].includes(linkKindFrom(plan, name)));
	const linksOk = [...new Set(linkNames)].filter((name) => afterByName.get(name)?.link?.kind === "managed").length;
	if (linksOk < new Set(linkNames).size) {
		for (const name of new Set(linkNames)) {
			if (afterByName.get(name)?.link?.kind !== "managed") problems.push(`${name}：链未指向 canonical`);
		}
	}
	let state = "unchanged";
	if (plan.observed?.consoleStateDigest !== undefined) {
		const digest = await digestOf(plan.observed.consoleStatePath);
		if (digest !== plan.observed.consoleStateDigest) {
			state = "changed";
			problems.push("控制台状态在本次执行期间被修改");
		}
	}
	return {
		canonical: `${canonicalOk}/${verifyNames.length}`,
		links: `${linksOk}/${new Set(linkNames).size}`,
		state,
		problems
	};
}

/** 把来源归一成稳定的 clone URL：同一个 GitHub 仓的 https/owner-repo 写法共用一个缓存。 */
function canonicalGitUrl(source) {
	const url = probeUrlForSource(source);
	if (url === undefined) return undefined;
	const github = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(url);
	return github === null ? url : `https://github.com/${github[1]}/${github[2]}.git`;
}

/** 回写 lock 时用的远端身份；非 GitHub 来源保留原 URL，至少不留下 local 路径。 */
function canonicalSource(source, url) {
	const github =
		/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(url) ??
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(url) ??
		/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(url);
	if (github !== null) {
		// 私有仓常用 SSH：lock 里保留 SSH URL，其他 agent 的 update 才不需要重新配 HTTPS 凭据。
		const ssh = /^(?:git@|ssh:\/\/)/iu.test(url);
		return {
			source: `${github[1]}/${github[2]}`,
			sourceUrl: ssh ? url : `https://github.com/${github[1]}/${github[2]}.git`,
			sourceType: "github",
		};
	}
	return { source: source.trim(), sourceUrl: url, sourceType: "git" };
}

function describeCache(cache) {
	if (cache === undefined) return "";
	const commit = typeof cache.commit === "string" ? cache.commit.slice(0, 7) : "?";
	return ` · 缓存 ${commit}${cache.fetched === true ? "（已检查上游）" : ""}${cache.stale === true ? "（离线，未确认上游）" : ""}`;
}

/** 这个来源是否会走本地 git 缓存；测试桩/本地路径不缓存。 */
function usesSourceCache(source, env = process.env) {
	return canonicalGitUrl(source) !== undefined && cliOverride(env).length === 0;
}

function sourceCacheTarget(source, env = process.env) {
	const url = canonicalGitUrl(source);
	return url === undefined ? undefined : { url, cacheDir: resolveCacheDir(resolveDshHome(env), url) };
}

async function lockEntries(env = process.env) {
	try {
		const parsed = JSON.parse(await readFile(resolveLockPath(env), "utf8"));
		const skills = parsed?.skills;
		return skills !== null && typeof skills === "object" && !Array.isArray(skills) ? skills : {};
	} catch {
		return {};
	}
}

/**
 * 比较 lock 的 tree hash 与本地缓存：返回"内容已变/缓存里找不到"的技能名。
 * 纯本地，不访问网络；缓存目录不存在时由调用方先 ensureSourceCache。
 */
async function changedAgainstLock(source, names, cacheDir, { env = process.env } = {}) {
	const lock = await lockEntries(env);
	const wanted = normalizeSource(source, env);
	const changed = [];
	for (const name of names) {
		const entry = lock[name];
		const hash = lockEntryFromSource(entry, wanted, env) ? await cachedSkillHash(cacheDir, name, env) : undefined;
		if (typeof hash !== "string" || entry?.skillFolderHash !== hash) changed.push(name);
	}
	return changed;
}

/**
 * 本地新鲜度判定（不联网）：缓存是否存在/在 TTL 内，以及 lock 与缓存是否一致。
 * - `cacheSource: false` → 这个来源不走缓存（测试桩/本地路径），调用方按目录状态处理；
 * - `fresh: false` → 无缓存或 TTL 过期，调用方应建作业 fetch 上游；
 * - `changed` 只在 `fresh: true` 时才有意义。
 */
async function assessFreshness(source, names, { env = process.env, paths = skillPaths(env) } = {}) {
	const cacheSource = usesSourceCache(source, env);
	const empty = { cacheSource, target: undefined, status: undefined, fresh: false, changed: undefined };
	if (!cacheSource || names.length === 0) return empty;
	const target = sourceCacheTarget(source, env);
	if (target === undefined) return empty;
	const status = await cacheStatus(target.cacheDir, env);
	if (!status.exists || !status.fresh) return { ...empty, target, status };
	const changed = await changedAgainstLock(source, names, target.cacheDir, { env });
	return { cacheSource, target, status, fresh: true, changed };
}

/**
 * 检查指定技能在缓存/上游是否变化。
 *
 * - `ensureSourceCache` 遵守 TTL（默认 10 分钟）；TTL 过期才 fetch，`/skill-init --update` 会 refresh。
 * - 返回 `changed`：lock 的 `skillFolderHash` 与缓存 git tree hash 不一致（或缓存里没有该技能）。
 * - `cache.stale` 表示 fetch 失败、本次用的是旧缓存；调用方会在回执里标注。
 */
async function checkSourceSkills(source, names, { env = process.env, reporter, signal, allowStale = true } = {}) {
	if (!usesSourceCache(source, env) || names.length === 0) return { cache: undefined, changed: [...names] };
	const target = sourceCacheTarget(source, env);
	if (target === undefined) return { cache: undefined, changed: [...names] };
	if (!(await exists(join(target.cacheDir, ".git")))) {
		await requireReachableSource(source, { env, reporter, signal });
	}
	reporter?.progress?.(`检查技能是否最新（${names.join("、")}）`);
	let cache;
	try {
		cache = await ensureSourceCache({
			cacheDir: target.cacheDir,
			url: target.url,
			env,
			reporter,
			signal,
			refresh: false,
			allowStale,
			cloneTimeoutMs: Math.min(cacheCloneTimeoutMs(env), timeoutMs(env)),
			fetchTimeoutMs: Math.min(cacheFetchTimeoutMs(env), timeoutMs(env)),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${message}\n缓存位于 ${target.cacheDir}；init 会回退旧缓存，/skill-init --update 不会。${networkHint(message)}`.trim());
	}
	const changed = await changedAgainstLock(source, names, target.cacheDir, { env });
	return { cache, changed };
}

/**
 * 安装入口：默认走「本地缓存 + skills CLI」；测试桩/自定义 CLI 保持原样直调。
 *
 * 本地路径来源不缓存（CLI 直接读目录，已经是毫秒级）；远端来源首次 clone、之后 fetch，
 * 再把 `skills add <缓存目录>` 的 lock 来源回写成远端，保证其他 agent 仍能 `npx skills update`。
 */
async function installFromSource(source, names, { env, reporter, signal, registerCancel, refresh = false, allowStale = true, verb = "安装", prefetchedCache } = {}) {
	const invocation = await resolveCli(env);
	const url = canonicalGitUrl(source);
	const useCache = invocation.isOverride !== true && url !== undefined;

	if (!useCache) {
		if (invocation.isOverride !== true) await requireReachableSource(source, { env, reporter, signal });
		reporter?.progress?.(
			names.length > 0 ? `${verb} ${names.join("、")}（${invocation.label} add）` : `${verb} ${source} 的全部技能（${invocation.label} add）`,
		);
		const result = await runCli(invocation, buildAddArgs(names, source, { json: invocation.supportsJson }), {
			env,
			signal,
			reporter,
			registerCancel,
			forwardStdout: !invocation.supportsJson,
		});
		if (result.code !== 0) throw new Error(describeCliFailure(invocation, verb, result, env));
		const parsed = invocation.supportsJson ? parseAddResult(result.stdout) : undefined;
		return {
			invocation,
			result,
			cache: undefined,
			parsed,
			names: parsed?.map((entry) => entry?.name).filter((name) => typeof name === "string") ?? names,
		};
	}

	const cacheDir = prefetchedCache?.cacheDir ?? resolveCacheDir(resolveDshHome(env), url);
	let cache = prefetchedCache;
	if (cache === undefined) {
		if (!(await exists(join(cacheDir, ".git")))) {
			// 首次 clone 前仍做一次快速预检：GitHub 443 黑洞时 8s 给建议，而不是等 60s 的 git 超时。
			await requireReachableSource(source, { env, reporter, signal });
		}
		try {
			cache = await ensureSourceCache({
				cacheDir,
				url,
				env,
				reporter,
				signal,
				refresh,
				allowStale,
				cloneTimeoutMs: Math.min(cacheCloneTimeoutMs(env), timeoutMs(env)),
				fetchTimeoutMs: Math.min(cacheFetchTimeoutMs(env), timeoutMs(env)),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${message}\n缓存位于 ${cacheDir}；init 会回退旧缓存，/skill-init --update 不会。${networkHint(message)}`.trim());
		}
	}

	reporter?.progress?.(
		names.length > 0
			? `从本地缓存${verb} ${names.join("、")}（${invocation.label} add）`
			: `从本地缓存${verb} ${source} 的全部技能（${invocation.label} add）`,
	);
	const result = await runCli(invocation, buildAddArgs(names, cacheDir, { json: invocation.supportsJson }), {
		env,
		signal,
		reporter,
		registerCancel,
		forwardStdout: !invocation.supportsJson,
	});
	if (result.code !== 0) throw new Error(describeCliFailure(invocation, verb, result, env));

	const parsed = invocation.supportsJson ? parseAddResult(result.stdout) : undefined;
	const installedNames =
		parsed?.map((entry) => entry?.name).filter((name) => typeof name === "string") ?? names;
	let lockWarning;
	try {
		await rewriteLockSource({
			lockPath: resolveLockPath(env),
			cacheDir,
			commit: cache.commit,
			env,
			...canonicalSource(source, url),
			names: installedNames,
			installed: parsed ?? [],
		});
	} catch (error) {
		lockWarning = error instanceof Error ? error.message : String(error);
		reporter?.progress?.(`lock 来源回写失败（不影响已安装文件）：${lockWarning}`);
	}
	return { invocation, result, cache, parsed, names: installedNames, lockWarning };
}


/**
 * `/skill-init`：检查命令依赖的技能，缺则用 `skills` CLI 从本地缓存安装并软链进 dsh 技能根；
 * 已托管但缓存 TTL 过期时仍会检查上游，但**发现更新的只报告、不重装**（重装走
 * `/skill-init --update`）。存在但不由 CLI 托管时**替换软链**为托管链路（真实目录拒绝覆盖）。
 *
 * 为什么运行时发现的更新只报告：安装/重装是覆盖写，必须发生在用户确认之后；而确认在
 * 建作业之前完成。把写盘范围锁死在 plan 能证明的范围（缺失/待修复 + plan 已知的上游更新）
 * 之后，规则才是一句话——**`/skill-init` 只在确定要写盘时问你**。
 */
export async function runSkillInit(commands, { signal, env = process.env, reporter, registerCancel, plan, choice = "all" } = {}) {
	const startedAt = Date.now();
	const state = plan ?? planOperation("init", {}, await observeSkills(env, commands));
	const { dshSkillsDir, canonicalSkillsDir } = state.paths;
	const skills = state.targets;
	const cacheSource = state.freshness.cacheSource;
	// 「只补缺失」跳过上游检查与已有条目，只处理 state=missing；默认仍走完整检查。
	const missingOnly = choice === "missing";
	const missing = state.pending.filter((item) => item.state === "missing").map((item) => item.name);
	const needsWork = missingOnly ? missing.length > 0 : state.skipReason === undefined;

	reporter?.progress?.(missingOnly ? `补装缺失技能（${missing.join("、")}）` : `检查依赖技能（${skills.join("、")}）`);

	// 运行时联网检查只读：在锁外完成，失败不阻断已安装的机器（缺失/损坏仍必须报错）。
	let probe;
	let checkError;
	if (cacheSource && needsWork && !missingOnly) {
		probe = await probeUpstream(state, { env, reporter, signal });
		checkError = probe.error;
		if (checkError !== undefined && state.pending.length > 0) throw checkError;
	}

	const outcome = await applyPlan(state, {
		env,
		reporter,
		signal,
		registerCancel,
		choice,
		probe,
		commands
	});
	const cache = outcome.cache;
	// plan 已知的 changed + 运行时联网检查发现的更新：都只报告，不动盘。
	const upstreamNewer = [...new Set([...(state.freshness?.changed ?? []), ...(probe?.changed ?? [])])].filter(
		(name) => !outcome.toInstall.includes(name)
	);
	const results = outcome.linkResults;
	const lines = results.map((result) => describeLink(result, { newVerb: "新装" }));
	const failures = outcome.failures ?? [];
	const nothingDone = outcome.toInstall.length === 0 && allSettled(results) && failures.length === 0;
	const refused = results.filter((result) => result.kind === "refused").map((result) => result.name);
	const linkedCount = results.filter(
		(result) => result.kind === "linked-new" || result.kind === "linked-replaced",
	).length;
	const problemCount =
		results.filter((result) => result.kind === "refused" || result.kind === "no-canonical").length +
		failures.length;
	const header = checkError !== undefined
		? `⚠ 已安装，但上游检查失败 · ${elapsedSince(startedAt)}`
		: nothingDone
			? upstreamNewer.length > 0
				? `ℹ 无变更，上游有 ${upstreamNewer.length} 项更新 · ${elapsedSince(startedAt)}`
				: `✓ 无变更 · ${elapsedSince(startedAt)}`
			: problemCount > 0
				? `⚠ 已完成，但有 ${problemCount} 项需处理 · ${elapsedSince(startedAt)}`
				: `✅ 已完成：${linkedCount > 0 ? `${linkedCount} 项变更` : `已处理 ${outcome.toInstall.length} 个技能`} · ${elapsedSince(startedAt)}`;
	const meta =
		checkError !== undefined
			? `技能：${skills.join("、")}；${errorLine(checkError)}；/skill-init --update 重试`
			: `技能：${skills.join("、")}${missingOnly ? "（只补缺失）" : ""}${describeCache(cache)}`;
	// 只报告、不写盘的上游更新：必须给出下一步，否则用户会以为"检查过了就等于更新了"。
	const newerLine =
		upstreamNewer.length > 0
			? `上游更新：${upstreamNewer.join("、")}（本次未安装；运行 /skill-init --update 更新）`
			: "";
	const shadowNote =
		refused.length > 0
			? `\n遮蔽提示：${refused.join("、")} 在 ${dshSkillsDir} 是真实目录（rank 400），会遮蔽 ${canonicalSkillsDir} 里的托管版本；移走后重跑 /skill-init。`
			: "";
	const contractLine =
		failures.length === 0
			? `契约：${commands.length} 条命令的分支文件齐全。技能目录被实时监听，无需重启 dsh。`
			: `契约问题（${failures.length}）：\n${failures.map((f) => `· ${f}`).join("\n")}\n技能目录被实时监听，无需重启 dsh；契约问题请对照 agent-skills 的技能版本。`;
	const footer = `${contractLine}${shadowNote}`;

	const text = [header, meta, newerLine, ...lines.filter((l) => l.length > 0), footer]
		.filter((l) => l.length > 0)
		.join("\n");
	// 作业结算后作业行仍保留最后一条 progress：让用户回头看一眼就知道结论。
	reporter?.progress?.(`完成：${header}`);
	return text;
}

/**
 * `/skill-init --update`：对（指定或全部）关联技能做幂等重装（`add … -g -a universal -y`）。
 * 不用 `skills update`：它内部 spawn 的 `add` 不带 `-a`，会把链接撒到其它 agent 目录，
 * 未检测到 agent 时甚至会装到全部 agent。
 */
export async function runSkillUpdate(commands, rawInput, { signal, env = process.env, reporter, registerCancel, plan } = {}) {
	const startedAt = Date.now();
	const all = referencedSkills(commands);
	const requested = rawInput.split(/\s+/).filter((token) => token.length > 0);
	const unknown = requested.filter((name) => !all.includes(name));
	if (unknown.length > 0) {
		throw new Error(`未知技能：${unknown.join("、")}。本插件依赖：${all.join("、")}`);
	}
	const names = String(rawInput ?? "").split(/\s+/).filter((token) => token.length > 0);
	const state = plan ?? planOperation("update", { names }, await observeSkills(env, commands));
	const managed = state.managed;
	const lines = [];

	if (managed.length === 0) {
		return [
			`✓ 无需更新：${state.targets.join("、")} 都不由 skills CLI 托管。`,
			"先执行 /skill-init 把它们切换为托管链路（只会替换软链，不动真实目录）。",
		].join("\n");
	}

	const outcome = await applyPlan(state, { env, reporter, signal, registerCancel, commands });
	const cache = outcome.cache;
	const updatedByName = new Map(outcome.updated.map((entry) => [entry.name, entry]));
	for (const item of managed) {
		const updated = updatedByName.get(item.name);
		if (updated?.error !== undefined) {
			lines.push(`✗ ${item.name}：软链重建失败（${updated.error}）`);
			continue;
		}
		if (updated?.rebuilt === true) {
			// canonical 目录被整体替换时软链应仍可解析；这里兜住异常情况
			lines.push(`↻ ${item.name}：软链失效，已重建 → ${updated.canonical}`);
			continue;
		}
		lines.push(`✓ ${item.name}：已更新到最新（${item.target}）`);
	}

	for (const item of state.states) {
		if (item.state === "managed") continue;
		lines.push(
			item.state === "missing"
				? `· ${item.name}：未安装，跳过（先执行 /skill-init）`
				: `· ${item.name}：不由 skills CLI 托管（${item.isDirectory ? "真实目录" : (item.target ?? "未知条目")}），跳过（先执行 /skill-init）`,
		);
	}

	const failed = lines.filter((line) => line.startsWith("✗")).length;
	const skipped = lines.filter((line) => line.startsWith("·")).length;
	const header =
		failed > 0
			? `⚠ 已更新 ${managed.length} 个技能，但有 ${failed} 项失败 · ${elapsedSince(startedAt)}`
			: `✅ 已更新：${managed.length} 个技能${skipped > 0 ? `（${skipped} 项跳过）` : ""} · ${elapsedSince(startedAt)}`;
	const text = [
		header,
		`技能：${managed.map((item) => item.name).join("、")}${describeCache(cache)}`,
		...lines,
		"技能目录被实时监听，无需重启 dsh。",
	]
		.filter((l) => l.length > 0)
		.join("\n");
	reporter?.progress?.(`完成：${header}`);
	return text;
}
