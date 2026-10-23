/**
 * 技能依赖自举（/skill-init、/skill-update）。
 *
 * 为什么需要这一层：
 * - 本插件 10 条命令是「意图表 → 委托对应 skill」，但 dsh **不从 node_modules 扫技能**，
 *   技能必须落在 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）下才会进入模型目录。
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
 *   指向源码的软链 —— 想同步上游就再跑一次 `/skill-update`。
 * - 备份绝不能放进 `skills/` 里：该目录下任何含 `SKILL.md` 的子目录都会被当成技能扫到，
 *   与同名技能冲突。故这里不做"改名为备份"，只替换软链、真实目录一律拒绝覆盖。
 *
 * 本文件只做"检查 / 安装 / 软链 / 校验"，不复制任何 skill 逻辑。
 */
import { spawn } from "node:child_process";
import { constants as FS_CONST } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, symlink, unlink } from "node:fs/promises";
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
import { stripAnsi, tail } from "./text.js";

// 兼容旧的导入路径：路径实现已移到 skill-paths.js，这里继续转发。
export { resolveCanonicalSkillsDir, resolveDshHome };

const require = createRequire(import.meta.url);

/** 技能来源仓（由 ai-kit 提供）。 */
export const SKILL_SOURCE = "morehao/ai-kit";
/** npx 回退用的 CLI 标识：不锁版本，跟随 npm `latest`；依赖可用时优先直接调用已安装版本。 */
export const DEFAULT_SKILLS_CLI = "skills";

/**
 * `/skill-init`、`/skill-update` 使用的来源：默认是上游 GitHub 仓，
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
		"也可以改用可达镜像或本地目录：/skill-install <来源> git-kit handoff，" +
		"或把 DSH_COMMANDS_SKILL_SOURCE 指向镜像/本地目录后再跑 /skill-init。"
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
const OPERATION_LABEL = { "skill-init": "初始化", "skill-install": "安装", "skill-update": "更新" };

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
		"· 或改用可达镜像/本地目录：/skill-install <来源> <技能名>；" +
		"/skill-init 可先 export DSH_COMMANDS_SKILL_SOURCE=<镜像或本地路径>\n" +
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

/** 列目录（不存在即空），用于比对安装前后 canonical 里多了哪些技能。 */
async function listSkillsDir(dir) {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * 归一化来源标识，用来把用户输入与 lock 里的 `source` / `sourceUrl` 对上：
 * `morehao/ai-kit` == `https://github.com/morehao/ai-kit.git` == `git@github.com:morehao/ai-kit.git`。
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

/** 从 lock 里找出属于该来源的技能名（拿不到就返回空数组，由调用方回退到目录 diff）。 */
async function lockedNamesForSource(source, env = process.env) {
	const wanted = normalizeSource(source, env);
	if (wanted.length === 0) return [];
	const names = [];
	for (const [name, entry] of Object.entries(await lockEntries(env))) {
		if (lockEntryFromSource(entry, wanted, env)) names.push(name);
	}
	return names;
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
	// 软链的删除只影响这条链接本身：它指向的目录（例如你的本地 ai-kit clone）一字不动。
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

/** 把 ensureLinks 的结果渲染成一行；`newVerb` 用来区分 /skill-init（新装）与 /skill-install（已安装）。 */
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

async function inspectAll(names, paths) {
	const states = [];
	for (const name of names) states.push(await inspectSkill(name, paths));
	return states;
}

function emptyPlan(kind, paths) {
	return {
		kind,
		paths,
		source: undefined,
		requested: [],
		targets: [],
		states: [],
		pending: [],
		managed: [],
		allManaged: false,
		allLocked: false,
		locked: [],
		freshness: { ...EMPTY_FRESHNESS },
		skipReason: undefined,
		contract: false,
	};
}

/**
 * 一次算出「这次要不要建作业 / 要处理哪些技能 / 新鲜度如何」。
 *
 * 纯本地：不联网、不写盘。三条 `runSkill*` 与命令 handler 共用同一份结果，
 * 避免命令 handler 与 `run*` 各算一遍（并各写一套 skip 文案）。
 *
 * 返回字段：
 * - `states/pending/managed`：inspectSkill 结果；
 * - `freshness`：`{ cacheSource, target, status, fresh, changed }`，只有可能 no-op 时才做本地 hash 比对；
 * - `skipReason`：有值 = 不必建作业（工作仍会以无 reporter 方式跑一遍，保证幂等修复）。
 */
export async function planSkillOperation(kind, commands, rawInput = "", { env = process.env } = {}) {
	const paths = skillPaths(env);
	const base = emptyPlan(kind, paths);
	const tokens = String(rawInput ?? "").split(/\s+/).filter((token) => token.length > 0);
	const all = referencedSkills(commands);

	if (kind === "skill-install") {
		const source = tokens[0];
		const requested = tokens.slice(1);
		const states = await inspectAll(requested, paths);
		const managed = states.filter((state) => state.state === "managed");
		const pending = states.filter((state) => state.state !== "managed");
		const allManaged = requested.length > 0 && managed.length === requested.length;
		const locked =
			source === undefined || requested.length === 0 ? [] : await lockedNamesForSource(source, env);
		const allLocked = requested.length > 0 && requested.every((name) => locked.includes(name));
		const cacheSource = source !== undefined && usesSourceCache(source, env);
		const freshness =
			cacheSource && allManaged && allLocked
				? await assessFreshness(source, requested, { env, paths })
				: { ...EMPTY_FRESHNESS, cacheSource };

		let skipReason;
		if (requested.length > 0 && allManaged && allLocked) {
			if (!cacheSource) skipReason = "已由 skills CLI 托管，未调用安装";
			else if (freshness.fresh && (freshness.changed?.length ?? 0) === 0) {
				skipReason = "缓存 TTL 内，无需检查上游";
			}
		}
		return { ...base, source, requested, targets: requested, states, pending, managed, allManaged, allLocked, locked, freshness, skipReason };
	}

	if (kind === "skill-init") {
		const targets = all;
		const states = await inspectAll(targets, paths);
		const pending = states.filter((state) => state.state !== "managed");
		const managed = states.filter((state) => state.state === "managed");
		const source = resolveSkillSource(env);
		const cacheSource = usesSourceCache(source, env);
		const freshness =
			pending.length === 0 && cacheSource
				? await assessFreshness(source, targets, { env, paths })
				: { ...EMPTY_FRESHNESS, cacheSource };

		let skipReason;
		if (pending.length === 0) {
			if (!cacheSource) skipReason = "已全部托管，无需安装";
			else if (freshness.fresh && (freshness.changed?.length ?? 0) === 0) {
				skipReason = "缓存 TTL 内，无需检查上游";
			}
		}
		return {
			...base,
			source,
			targets,
			states,
			pending,
			managed,
			allManaged: pending.length === 0,
			freshness,
			skipReason,
			contract: true,
		};
	}

	if (kind === "skill-update") {
		const requested = tokens;
		const targets = requested.length > 0 ? requested.filter((name) => all.includes(name)) : all;
		const states = await inspectAll(targets, paths);
		const managed = states.filter((state) => state.state === "managed");
		const source = resolveSkillSource(env);
		const skipReason =
			targets.length === 0
				? "没有可处理的技能"
				: managed.length === 0
					? "没有由 skills CLI 托管的技能"
					: undefined;
		return {
			...base,
			source,
			requested,
			targets,
			states,
			pending: states.filter((state) => state.state !== "managed"),
			managed,
			allManaged: managed.length === targets.length && targets.length > 0,
			freshness: { ...EMPTY_FRESHNESS, cacheSource: usesSourceCache(source, env) },
			skipReason,
		};
	}

	throw new Error(`未知技能命令：${kind}`);
}

/**
 * 按 COMMANDS 的分支契约校验当前技能目录（与 scripts/check-skill-contract.mjs 同规则，
 * 区别是这里只报不失败 —— 契约漂移不该让 init 整体失败）。
 */
async function contractReport(commands, dshSkillsDir) {
	const failures = [];
	for (const def of commands) {
		const skill = def.skill ?? "git-kit";
		const skillDir = join(dshSkillsDir, skill);
		if (!(await exists(join(skillDir, "SKILL.md")))) {
			failures.push(`${skill} 缺失（/${def.name} 无法执行）`);
			continue;
		}
		if (await exists(join(skillDir, "references"))) {
			const ref = join(skillDir, "references", `${def.branch}.md`);
			if (!(await exists(ref))) failures.push(`${skill}#${def.branch} 缺 references/${def.branch}.md（/${def.name}）`);
		}
	}
	return failures;
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

/** 回执里说明缓存多久前检查过，避免把「TTL 内没联网」误解成「刚查过上游」。 */
function cacheAgeNote(cache) {
	const fetchedAt = typeof cache?.fetchedAt === "number" ? cache.fetchedAt : undefined;
	if (fetchedAt === undefined || fetchedAt <= 0) return "";
	const minutes = Math.max(0, Math.round((Date.now() - fetchedAt) / 60_000));
	return minutes < 1 ? "，缓存刚更新" : `，缓存 ${minutes} 分钟前`;
}

/**
 * 检查指定技能在缓存/上游是否变化。
 *
 * - `ensureSourceCache` 遵守 TTL（默认 10 分钟）；TTL 过期才 fetch，`/skill-update` 会 refresh。
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
		throw new Error(`${message}\n缓存位于 ${target.cacheDir}；安装类命令会回退旧缓存，/skill-update 不会。${networkHint(message)}`.trim());
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
			throw new Error(`${message}\n缓存位于 ${cacheDir}；安装类命令会回退旧缓存，/skill-update 不会。${networkHint(message)}`.trim());
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
	const installedNames = parsed?.map((entry) => entry?.name).filter((name) => typeof name === "string") ?? names;
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
 * 已托管但缓存 TTL 过期时仍会检查上游，有变化才重装。存在但不由 CLI 托管时**替换软链**为
 * 托管链路（真实目录拒绝覆盖）。
 */
export async function runSkillInit(commands, { signal, env = process.env, reporter, registerCancel, plan } = {}) {
	const startedAt = Date.now();
	const state = plan ?? (await planSkillOperation("skill-init", commands, "", { env }));
	const { dshSkillsDir, canonicalSkillsDir } = state.paths;
	const skills = state.targets;
	const cacheSource = state.freshness.cacheSource;
	// plan 已经判定过「是否无事可做」；这里只执行，不再重复 inspect / 比对 hash。
	const needsWork = state.skipReason === undefined;

	reporter?.progress?.(`检查依赖技能（${skills.join("、")}）`);
	const release = needsWork ? beginSkillOperation("skill-init", env) : undefined;
	let cache;
	let toInstall = state.pending.map((item) => item.name);
	let checkError;
	try {
		if (cacheSource && needsWork) {
			try {
				const check = await checkSourceSkills(state.source, skills, { env, reporter, signal, allowStale: true });
				cache = check.cache;
				toInstall = [...new Set([...toInstall, ...check.changed])];
			} catch (error) {
				// 已经安装好的机器不应该因为暂时连不上上游就跑失败；缺失/损坏仍必须报错。
				if (state.pending.length > 0) throw error;
				checkError = error;
			}
		}
		if (toInstall.length > 0) {
			const outcome = await installFromSource(state.source, toInstall, {
				env,
				reporter,
				signal,
				registerCancel,
				refresh: false,
				allowStale: true,
				verb: "安装",
				prefetchedCache: cache,
			});
			cache = outcome.cache;
		}

		// 真实目录/文件不可回滚，不替用户删（ensureLinks 内按单项失败处理，其余技能继续）
		reporter?.progress?.("链入 dsh 技能目录");
		// 没装任何东西时 canonical 未变，直接复用 plan 的 inspect 结果；装过就必须重新看。
		const results = await ensureLinks(skills, state.paths, reporter, toInstall.length === 0 ? state.states : undefined);
		const lines = results.map((result) => describeLink(result, { newVerb: "新装" }));

		reporter?.progress?.("校验命令分支契约");
		const failures = await contractReport(commands, dshSkillsDir);
		const nothingDone = toInstall.length === 0 && allSettled(results) && failures.length === 0;
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
				? `✓ 已是最新 · ${elapsedSince(startedAt)}`
				: problemCount > 0
					? `⚠ 已完成，但有 ${problemCount} 项需处理 · ${elapsedSince(startedAt)}`
					: `✅ 已完成：${linkedCount > 0 ? `${linkedCount} 项变更` : `已处理 ${toInstall.length} 个技能`} · ${elapsedSince(startedAt)}`;
		const meta =
			checkError !== undefined
				? `技能：${skills.join("、")}；${errorLine(checkError)}；/skill-update 重试`
				: `技能：${skills.join("、")}${describeCache(cache)}`;
		const shadowNote =
			refused.length > 0
				? `\n遮蔽提示：${refused.join("、")} 在 ${dshSkillsDir} 是真实目录（rank 400），会遮蔽 ${canonicalSkillsDir} 里的托管版本；移走后重跑 /skill-init。`
				: "";
		const contractLine =
			failures.length === 0
				? `契约：${commands.length} 条命令的分支文件齐全。技能目录被实时监听，无需重启 dsh。`
				: `契约问题（${failures.length}）：\n${failures.map((f) => `· ${f}`).join("\n")}\n技能目录被实时监听，无需重启 dsh；契约问题请对照 ai-kit 的技能版本。`;
		const footer = `${contractLine}${shadowNote}`;

		const text = [header, meta, ...lines.filter((l) => l.length > 0), footer].filter((l) => l.length > 0).join("\n");
		// 作业结算后作业行仍保留最后一条 progress：让用户回头看一眼就知道结论。
		reporter?.progress?.(`完成：${header}`);
		return text;
	} finally {
		release?.();
	}
}

/**
 * `/skill-install`：安装**任意来源**的技能（不限本插件依赖），并软链进 dsh 技能根。
 *
 * 语法：`/skill-install <来源> [技能名...]`
 * - 来源可以是 `owner/repo`、git/HTTPS URL 或本地路径（与 `npx skills add` 的来源语法一致）。
 * - 不写技能名 → 装该来源发现的全部技能（CLI 在 `-y` 下自动全选）。
 * - 用 `-a universal` 固定落 canonical `~/.agents/skills`，绝不波及其它 agent 目录。
 *
 * 装完怎么知道该给谁建软链？四路取并集：
 *   1) 用户显式写的技能名；
 *   2) 安装前后 canonical 目录的差集（覆盖"装全部"的情况）；
 *   3) lock 里 source 与该来源匹配的技能（覆盖"早已在 canonical、但没建过软链"的情况）；
 *   4) `skills add --json` 返回的技能。
 */
export async function runSkillInstall(commands, rawInput, { signal, env = process.env, reporter, registerCancel, plan } = {}) {
	const startedAt = Date.now();
	const tokens = rawInput.split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) {
		throw new Error(
			"缺少来源。用法：/skill-install <来源> [技能名...]\n" +
				"例：/skill-install morehao/ai-kit tech-design\n" +
				"例（装该来源全部技能）：/skill-install vercel-labs/agent-skills",
		);
	}
	const state = plan ?? (await planSkillOperation("skill-install", commands, rawInput, { env }));
	const source = state.source;
	const requested = state.requested;
	const { canonicalSkillsDir } = state.paths;

	// 安装 ≠ 更新，但「已安装」不等于「已最新」：
	// - 缓存 TTL 内且 lock 的 tree hash 与缓存一致 → 已是最新，0 网络；
	// - TTL 过期/无缓存 → 进作业检查上游；有变化才重装，没变化回执写「已是最新」。
	if (requested.length > 0 && state.allManaged && state.allLocked) {
		if (!state.freshness.cacheSource) {
			return `✓ 无需操作 · ${requested.join("、")}（已由 ${source} 托管；需要更新请用 /skill-update）· ${elapsedSince(startedAt)}`;
		}
		if (state.freshness.fresh && (state.freshness.changed?.length ?? 0) === 0) {
			return `✓ 已是最新 · ${requested.join("、")}（缓存 TTL 内且与 lock 一致；/skill-update 强制检查上游）· ${elapsedSince(startedAt)}`;
		}
	}

	const release = beginSkillOperation("skill-install", env);

	try {
		reporter?.progress?.(`解析来源 ${source}`);
		let check;
		let toInstall = requested;
		if (state.freshness.cacheSource && requested.length > 0) {
			try {
				check = await checkSourceSkills(source, requested, { env, reporter, signal, allowStale: true });
			} catch (error) {
				// 已托管时把「检查上游」当尽力而为：cache 缺失/网络暂不可用不把安装本身判失败。
				if (!state.allManaged || !state.allLocked) throw error;
				const results = await ensureLinks(requested, state.paths, reporter);
				const text = [
					`⚠ 已安装，但上游检查失败 · ${elapsedSince(startedAt)}`,
					`技能：${requested.join("、")}；${errorLine(error)}；/skill-update 重试`,
					...results.map((item) => describeLink(item, { newVerb: "已安装" })),
				]
					.filter((line) => line.length > 0)
					.join("\n");
				reporter?.progress?.(`完成：${text.split("\n")[0]}`);
				return text;
			}
			toInstall = check.changed;
			if (toInstall.length === 0) {
				// 内容已最新，但 dsh 软链可能缺失/被替换：这里仍要补链，不能直接返回。
				const results = await ensureLinks(requested, state.paths, reporter, state.states);
				const text = [
					`✓ 已是最新 · ${elapsedSince(startedAt)}`,
					`技能：${requested.join("、")}；来源 ${source}${cacheAgeNote(check.cache)}${describeCache(check.cache)}`,
					...results.map((item) => describeLink(item, { newVerb: "已安装" })),
					check.cache?.stale === true
						? "上游暂不可达，本次使用旧缓存（未确认最新）；/skill-update 会重新 fetch。"
						: check.cache?.fetched === true
							? "已检查上游，内容与 lock 一致。"
							: "缓存 TTL 内未访问上游；/skill-update 会强制 fetch。",
				]
					.filter((line) => line.length > 0)
					.join("\n");
				reporter?.progress?.(`完成：${text.split("\n")[0]}`);
				return text;
			}
		}
		const before = new Set(await listSkillsDir(canonicalSkillsDir));
		const outcome = await installFromSource(source, toInstall, {
			env,
			reporter,
			signal,
			registerCancel,
			refresh: false,
			allowStale: true,
			verb: "安装",
			prefetchedCache: check?.cache,
		});

		const after = await listSkillsDir(canonicalSkillsDir);
		const added = after.filter((name) => !before.has(name));
		const locked = await lockedNamesForSource(source, env);
		const names = [...new Set([...requested, ...locked, ...added, ...(outcome.names ?? [])])].sort();

		if (names.length === 0) {
			reporter?.progress?.("没有发现可链入的技能");
			const text = [
				`⚠ CLI 报告成功，但没发现可链入的技能 · ${elapsedSince(startedAt)}`,
				`来源：${source}；检查 ${canonicalSkillsDir} 是否包含 <name>/SKILL.md，或显式指定技能名：/skill-install ${source} <技能名>`,
			]
				.filter((line) => line.length > 0)
				.join("\n");
			reporter?.progress?.(`完成：${text.split("\n")[0]}`);
			return text;
		}

		reporter?.progress?.(`链入 dsh 技能目录（${names.length} 个）`);
		const results = await ensureLinks(names, state.paths, reporter);
		const updated = check !== undefined && check.changed.length > 0;
		const linkedCount = results.filter(
			(result) => result.kind === "linked-new" || result.kind === "linked-replaced",
		).length;
		const problemCount = results.filter(
			(result) => result.kind === "refused" || result.kind === "no-canonical",
		).length;
		const installHeader =
			allSettled(results) && !updated
				? `✓ 已是最新 · ${elapsedSince(startedAt)}`
				: problemCount > 0
					? `⚠ 已安装，但有 ${problemCount} 项需处理 · ${elapsedSince(startedAt)}`
					: `✅ 已安装：${linkedCount > 0 ? `${linkedCount} 个技能` : `${names.length} 个技能（已托管）`} · ${elapsedSince(startedAt)}`;
		const text = [
			installHeader,
			`来源：${source} · 技能：${names.join("、")}${describeCache(outcome.cache)}`,
			...results.map((item) => describeLink(item, { newVerb: "已安装" })),
			"技能目录被实时监听，无需重启 dsh；插件依赖的那几个技能用 /skill-init 与 /skill-update 维护。",
		]
			.filter((line) => line.length > 0)
			.join("\n");
		reporter?.progress?.(`完成：${installHeader}`);
		return text;
	} finally {
		release();
	}
}

/**
 * `/skill-update`：对（指定或全部）关联技能做幂等重装（`add … -g -a universal -y`）。
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
	const state = plan ?? (await planSkillOperation("skill-update", commands, rawInput, { env }));
	const targets = state.targets;
	const managed = state.managed;
	const lines = [];

	if (managed.length === 0) {
		return [
			`✓ 无需更新：${targets.join("、")} 都不由 skills CLI 托管。`,
			"先执行 /skill-init 把它们切换为托管链路（只会替换软链，不动真实目录）。",
		].join("\n");
	}

	const release = beginSkillOperation("skill-update", env);
	let cache;
	try {
		const outcome = await installFromSource(state.source, managed.map((item) => item.name), {
			env,
			reporter,
			signal,
			registerCancel,
			refresh: true,
			allowStale: false,
			verb: "更新",
		});
		cache = outcome.cache;

		reporter?.progress?.("校验软链仍可解析");
		for (const item of managed) {
			const readable = await exists(join(item.linkPath, "SKILL.md"));
			if (!readable) {
				// canonical 目录被整体替换时软链应仍可解析；这里兜住异常情况
				try {
					const linked = await linkSkill(item.name, state.paths);
					lines.push(`↻ ${item.name}：软链失效，已重建 → ${linked.canonical}`);
				} catch (error) {
					lines.push(`✗ ${item.name}：软链重建失败（${error instanceof Error ? error.message : String(error)}）`);
				}
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
	} finally {
		release();
	}
}
