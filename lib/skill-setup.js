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

export function resolveDshHome(env = process.env) {
	const raw = env.DSH_HOME?.trim();
	return raw && raw.length > 0 ? raw : join(homedir(), ".dsh");
}

/** `skills` CLI 的 canonical 全局技能目录（`-g -a universal` 的落点）。 */
export function resolveCanonicalSkillsDir(home = homedir()) {
	return join(home, ".agents", "skills");
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
 * 解析 `skills` CLI 的调用方式。
 * `DSH_COMMANDS_SKILL_CLI` 可完全替换命令（测试桩 / 自定义安装方式），
 * 此时视为"可执行文件 + 固定前缀"，不再追加 npx 参数，也不启用 `--json`。
 */
async function resolveCli(env) {
	const override = env.DSH_COMMANDS_SKILL_CLI?.trim();
	if (override && override.length > 0) {
		return { command: override, argsPrefix: [], label: override, supportsJson: false, isOverride: true };
	}
	// 显式设置 DSH_COMMANDS_SKILLS_CLI 时尊重用户选择，走 npx 指定版本；
	// 未设置才优先用依赖里的已安装版本（省 npx 启动）。
	const specOverride = env.DSH_COMMANDS_SKILLS_CLI?.trim();
	if (specOverride === undefined || specOverride.length === 0) {
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

const stripAnsi = (text) =>
	// CSI/OSC 序列 + clack 的行内重绘控制符
	text
		.replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

/** 表格/框线的左右边框：`│ → ~/.agents/skills/x  │` 去掉边缘后才是正文。 */
const BOX_EDGE = /^[\s│┃|]+|[\s│┃]+$/gu;

/**
 * 只剩装饰（框线、分隔线、ASCII 大标题的块字符）的行：整行丢掉。
 * `skills` CLI 启动时会打一块用 █ ╔ ═ 拼的 logo，在命令卡片里只是噪声。
 */
const DECORATION_ONLY = /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝═║█▀▄▌▐░▒▓|\-+_=~*<>]+$/u;

/**
 * 进度重绘的尾缀：clack 的 spinner 每次重绘都会追加 `.`/`…`/`·`，
 * 于是同一句话在输出里会变成 `Cloning…` / `Cloning….` / `Cloning…..`。
 * 折叠连续行时先把尾缀抹平，否则 dedupe 一个都命中不了。
 */
const SPINNER_TAIL = /[\s.…·]+$/u;

/**
 * 进度帧的头部：clack 的 spinner 还会轮换字形（`◒`/`◐`/`◓`/`◑`、braille、`-`/`|`）。
 * 只抹尾缀救不了这种情况：每一帧的 key 都因字形不同而唯一，几百帧会挤掉真正的错误。
 * 这里只在计算 dedupe key 时抹掉头部字形，输出行本身保持原样。
 */
const SPINNER_LEAD = /^[\s]*(?:[◐◓◑◒◜◝◞◟◴◵◶◷]|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|[|/\\-])\s*/u;

/**
 * 剥掉 ANSI 与 CLI 的装饰线，并把 spinner 的 `\r` 重绘折叠掉。
 * clack 的表格框线（`╭──╮` / `│ … │`）与反复刷新的进度帧在命令卡片里只是噪声 ——
 * 完整输出留在后台任务面板里（`lib/job-progress.js`），回执只留人话。
 *
 * `\r` 必须当行分隔符：否则整次克隆的上千帧会拼成一行，`tail(-15)` 会把它原样带进
 * 失败回执（真机复现：88 KB 的命令卡片，实体错误只有最后两行）。
 */
function tail(text, lines = TAIL_LINES) {
	const kept = [];
	let previousKey;
	for (const raw of stripAnsi(text).split(/\r\n|\r|\n/)) {
		const line = raw.replace(BOX_EDGE, "").trimEnd();
		if (line.length === 0 || DECORATION_ONLY.test(line)) continue;
		const key = line.replace(SPINNER_LEAD, "").replace(SPINNER_TAIL, "");
		if (key === previousKey) continue;
		previousKey = key;
		kept.push(line.length > MAX_TAIL_LINE_CHARS ? `${line.slice(0, MAX_TAIL_LINE_CHARS)}…` : line);
	}
	const selected = kept.slice(-lines);
	// 字符预算从尾部往前算：宁可少几行，也不能让命令卡片被几百 KB 的进度帧撑爆。
	const out = [];
	let budget = MAX_TAIL_CHARS;
	for (let i = selected.length - 1; i >= 0; i -= 1) {
		const line = selected[i];
		if (line.length + 1 > budget) {
			if (out.length === 0) out.push(`${line.slice(0, Math.max(0, budget - 1))}…`);
			break;
		}
		out.unshift(line);
		budget -= line.length + 1;
	}
	return out.join("\n");
}

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
export function probeSourceReachability(source, { env = process.env, signal } = {}) {
	const url = probeUrlForSource(source);
	const limit = probeTimeoutMs(env);
	if (url === undefined || limit === 0 || signal?.aborted === true) return Promise.resolve({ status: "skipped" });

	return new Promise((resolve) => {
		const startedAt = Date.now();
		let output = "";
		let child;
		try {
			child = spawn("git", ["ls-remote", "--heads", "--", url], {
				cwd: homedir(),
				env: { ...env, GIT_TERMINAL_PROMPT: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			resolve({ status: "skipped" });
			return;
		}
		let settled = false;
		let timer;
		const done = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...value, url, elapsedMs: Date.now() - startedAt });
		};
		const onAbort = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				// 已经退出
			}
			done({ status: "skipped" });
		};
		const collect = (chunk) => {
			output += String(chunk);
			if (output.length > 20_000) output = output.slice(-10_000);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", () => done({ status: "skipped" }));
		child.on("close", (code) => {
			if (code === 0) {
				done({ status: "ok" });
				return;
			}
			const text = stripAnsi(output);
			if (PROBE_NETWORK_FAILURE.test(text)) done({ status: "unreachable", timedOut: false, output: tail(text, 3) });
			else done({ status: "inconclusive", output: tail(text, 3) });
		});
		timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// 已经退出
			}
			done({ status: "unreachable", timedOut: true, output: "" });
		}, limit);
		if (signal?.aborted === true) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
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
	if (env.DSH_COMMANDS_SKILL_CLI?.trim()) return;
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
function runCli(invocation, args, { env, signal, reporter, registerCancel, forwardStdout = true }) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new Error("命令已取消"));
			return;
		}
		let child;
		try {
			child = spawn(invocation.command, [...invocation.argsPrefix, ...args], {
				cwd: homedir(),
				env: cliEnv(env),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			reject(error);
			return;
		}
		let output = "";
		let stdout = "";
		let stderr = "";
		const collect = (chunk, channel) => {
			const text = String(chunk);
			output += text;
			if (channel === "stdout") stdout += text;
			else stderr += text;
			// 防御：CLI 万一刷屏也不无限增长
			if (output.length > 200_000) output = output.slice(-100_000);
			if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
			if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
			// 作业面板是纯文本终端（不解析 ANSI），所以旁路前先去色，否则面板里全是 `[38;5;250m` 之类转义码。
			// `--json` 时 stdout 是机器可读数组，不往面板里灌；stderr 的阶段/摘要仍然展示。
			if (channel !== "stdout" || forwardStdout) reporter?.write?.(stripAnsi(text), channel);
		};
		child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
		child.stderr.on("data", (chunk) => collect(chunk, "stderr"));

		let settled = false;
		let timedOut = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...value, timedOut, stdout, stderr });
		};
		const hardKill = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				// 进程可能已退出
			}
		};
		const onAbort = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// 进程可能已退出
			}
			setTimeout(hardKill, ABORT_GRACE_MS).unref?.();
		};
		registerCancel?.(onAbort);
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			onAbort();
			hardKill();
		}, timeoutMs(env));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code, signalName) => finish({ code, signal: signalName, output }));
	});
}

/** CLI 失败原因的稳定措辞：超时 / 被信号杀 / 普通退出码。 */
function describeCliFailure(invocation, verb, result, env) {
	const detail = `\n${tail(result.output)}${networkHint(result.output)}`;
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

/** `skills` CLI 的全局 lock 文件路径（与上游 getSkillLockPath 一致）。 */
function resolveLockPath(env = process.env) {
	const stateHome = env.XDG_STATE_HOME?.trim();
	return stateHome && stateHome.length > 0
		? join(stateHome, "skills", ".skill-lock.json")
		: join(homedir(), ".agents", ".skill-lock.json");
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

/** 从 lock 里找出属于该来源的技能名（拿不到就返回空数组，由调用方回退到目录 diff）。 */
async function lockedNamesForSource(source, env = process.env) {
	try {
		const raw = await readFile(resolveLockPath(env), "utf8");
		const parsed = JSON.parse(raw);
		const wanted = normalizeSource(source, env);
		if (wanted.length === 0) return [];
		const names = [];
		for (const [name, entry] of Object.entries(parsed?.skills ?? {})) {
			if (entry === null || typeof entry !== "object") continue;
			const candidates = [entry.source, entry.sourceUrl].filter((v) => typeof v === "string");
			if (candidates.some((v) => normalizeSource(v, env) === wanted)) names.push(name);
		}
		return names;
	} catch {
		return [];
	}
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
async function ensureLinks(names, ctx, reporter) {
	const results = [];
	for (const name of names) {
		const state = await inspectSkill(name, ctx);
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

/**
 * 命令是否"无事可做"：返回理由字符串表示不必建后台任务（否则返回 undefined）。
 * 只服务 `/skill-init`、`/skill-install` 与 `/skill-update`。注意「已安装」不等于「已最新」：
 * 只有缓存 TTL 内且 lock hash 与缓存一致才跳过；TTL 过期要建作业 fetch 上游。
 */
export async function jobSkipReason(name, commands, rawInput, { env = process.env } = {}) {
	const dshSkillsDir = join(resolveDshHome(env), "skills");
	const canonicalSkillsDir = resolveCanonicalSkillsDir();
	const all = referencedSkills(commands);
	const rawTokens = rawInput.split(/\s+/).filter((token) => token.length > 0);

	// /skill-install 显式指定的技能都已托管：只有「缓存 TTL 内 + lock hash 与缓存一致」
	// 才可以直接判定最新；TTL 过期/无缓存时必须建作业去 fetch，不能盲目 no-op。
	if (name === "skill-install") {
		const requested = rawTokens.slice(1);
		if (rawTokens.length < 2 || requested.length === 0) return undefined;
		const source = rawTokens[0];
		const states = [];
		for (const target of requested) states.push(await inspectSkill(target, { dshSkillsDir, canonicalSkillsDir }));
		const locked = new Set(await lockedNamesForSource(source, env));
		if (!states.every((state) => state.state === "managed") || !requested.every((name) => locked.has(name))) return undefined;
		if (!usesSourceCache(source, env)) {
			return `${requested.join("、")} 已由 ${source} 托管，无需重新安装（需要更新请用 /skill-update）`;
		}
		return (await cacheUpToDate(source, requested, env))
			? `${requested.join("、")} 已是最新（缓存 TTL 内且与 lock 一致；/skill-update 强制检查上游）`
			: undefined;
	}
	if (name !== "skill-init" && name !== "skill-update") return undefined;
	const requested = rawTokens;
	const targets = name === "skill-init" ? all : requested.length > 0 ? requested.filter((n) => all.includes(n)) : all;
	if (targets.length === 0) return "没有可处理的技能";
	const states = [];
	for (const target of targets) states.push(await inspectSkill(target, { dshSkillsDir, canonicalSkillsDir }));
	if (name === "skill-init") {
		const pending = states.filter((state) => state.state !== "managed").map((state) => state.name);
		if (pending.length > 0) return undefined;
		const source = resolveSkillSource(env);
		if (!usesSourceCache(source, env)) return `${targets.join("、")} 均已托管，没有需要安装或修复的技能`;
		return (await cacheUpToDate(source, targets, env))
			? `${targets.join("、")} 已是最新（缓存 TTL 内且与 lock 一致；/skill-update 强制检查上游）`
			: undefined;
	}
	const managed = states.filter((state) => state.state === "managed").map((state) => state.name);
	return managed.length === 0 ? `${targets.join("、")} 都不由 skills CLI 托管，没有可更新的技能` : undefined;
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
	return canonicalGitUrl(source) !== undefined && !(env.DSH_COMMANDS_SKILL_CLI?.trim());
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
 * 本地即可判定的「是否已是最新」：缓存 TTL 内 + lock 的 git tree hash 与缓存一致。
 * 不访问网络；TTL 过期时返回 false，让调用方进入作业 fetch 上游。
 */
async function cacheUpToDate(source, names, env = process.env) {
	if (!usesSourceCache(source, env) || names.length === 0) return false;
	const target = sourceCacheTarget(source, env);
	if (target === undefined) return false;
	const status = await cacheStatus(target.cacheDir, env);
	if (!status.exists || !status.fresh) return false;
	const lock = await lockEntries(env);
	const wanted = normalizeSource(source, env);
	for (const name of names) {
		const entry = lock[name];
		if (entry === null || typeof entry !== "object") return false;
		const fromSource = [entry.source, entry.sourceUrl]
			.filter((value) => typeof value === "string")
			.some((value) => normalizeSource(value, env) === wanted);
		if (!fromSource) return false;
		const hash = await cachedSkillHash(target.cacheDir, name, env);
		if (typeof hash !== "string" || entry.skillFolderHash !== hash) return false;
	}
	return true;
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
	const lock = await lockEntries(env);
	const wanted = normalizeSource(source, env);
	const changed = [];
	for (const name of names) {
		const entry = lock[name];
		const fromSource =
			entry !== null &&
			typeof entry === "object" &&
			[entry.source, entry.sourceUrl]
				.filter((value) => typeof value === "string")
				.some((value) => normalizeSource(value, env) === wanted);
		const hash = fromSource ? await cachedSkillHash(target.cacheDir, name, env) : undefined;
		if (typeof hash !== "string" || entry.skillFolderHash !== hash) changed.push(name);
	}
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
export async function runSkillInit(commands, { signal, env = process.env, reporter, registerCancel } = {}) {
	const startedAt = Date.now();
	const skills = referencedSkills(commands);
	const dshHome = resolveDshHome(env);
	const dshSkillsDir = join(dshHome, "skills");
	const canonicalSkillsDir = resolveCanonicalSkillsDir();

	reporter?.progress?.(`检查依赖技能（${skills.join("、")}）`);
	const states = [];
	for (const name of skills) states.push(await inspectSkill(name, { dshSkillsDir, canonicalSkillsDir }));

	const pending = states.filter((s) => s.state !== "managed");
	const source = resolveSkillSource(env);
	const cacheSource = usesSourceCache(source, env);
	// 有缺失，或缓存 TTL 过期/hash 不一致时才需要建作业；否则不联网直接判「已是最新」。
	const needsWork = pending.length > 0 || (cacheSource && !(await cacheUpToDate(source, skills, env)));
	const release = needsWork ? beginSkillOperation("skill-init", env) : undefined;
	let cache;
	let toInstall = pending.map((s) => s.name);
	let checkError;
	try {
		if (cacheSource && needsWork) {
			try {
				const check = await checkSourceSkills(source, skills, { env, reporter, signal, allowStale: true });
				cache = check.cache;
				toInstall = [...new Set([...toInstall, ...check.changed])];
			} catch (error) {
				// 已经安装好的机器不应该因为暂时连不上上游就跑失败；缺失/损坏仍必须报错。
				if (pending.length > 0) throw error;
				checkError = error;
			}
		}
		if (toInstall.length > 0) {
			const outcome = await installFromSource(source, toInstall, {
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
		const results = await ensureLinks(skills, { dshSkillsDir, canonicalSkillsDir }, reporter);
		const lines = results.map((result) => describeLink(result, { newVerb: "新装" }));

		reporter?.progress?.("校验命令分支契约");
		const failures = await contractReport(commands, dshSkillsDir);
		const nothingDone = toInstall.length === 0 && allSettled(results) && failures.length === 0;
		const header = checkError !== undefined
			? `! 已安装：${skills.join("、")}；上游检查失败（${errorLine(checkError)}；/skill-update 重试）· ${elapsedSince(startedAt)}`
			: nothingDone
				? `✓ 已是最新：${skills.join("、")} · ${elapsedSince(startedAt)}${describeCache(cache)}`
				: `技能依赖检查 · ${skills.join("、")} · ${elapsedSince(startedAt)}${describeCache(cache)}`;
		const footer =
			failures.length === 0
				? `契约：${commands.length} 条命令的分支文件齐全。技能目录被实时监听，无需重启 dsh。`
				: `契约问题（${failures.length}）：\n${failures.map((f) => `· ${f}`).join("\n")}\n技能目录被实时监听，无需重启 dsh；契约问题请对照 ai-kit 的技能版本。`;

		return [header, ...lines.filter((l) => l.length > 0), footer].filter((l) => l.length > 0).join("\n");
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
export async function runSkillInstall(_commands, rawInput, { signal, env = process.env, reporter, registerCancel } = {}) {
	const startedAt = Date.now();
	const tokens = rawInput.split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) {
		throw new Error(
			"缺少来源。用法：/skill-install <来源> [技能名...]\n" +
				"例：/skill-install morehao/ai-kit tech-design\n" +
				"例（装该来源全部技能）：/skill-install vercel-labs/agent-skills",
		);
	}
	const [source, ...requested] = tokens;

	const dshHome = resolveDshHome(env);
	const dshSkillsDir = join(dshHome, "skills");
	const canonicalSkillsDir = resolveCanonicalSkillsDir();

	// 安装 ≠ 更新，但「已安装」不等于「已最新」：
	// - 缓存 TTL 内且 lock 的 tree hash 与缓存一致 → 已是最新，0 网络；
	// - TTL 过期/无缓存 → 进作业检查上游；有变化才重装，没变化回执写「已是最新」。
	let requestedManaged = false;
	let requestedLocked = false;
	if (requested.length > 0) {
		const states = [];
		for (const name of requested) states.push(await inspectSkill(name, { dshSkillsDir, canonicalSkillsDir }));
		requestedManaged = states.every((state) => state.state === "managed");
		const locked = new Set(await lockedNamesForSource(source, env));
		requestedLocked = requested.every((name) => locked.has(name));
		if (requestedManaged && requestedLocked) {
			if (!usesSourceCache(source, env)) {
				return `✓ 无需操作：${requested.join("、")} 已由 ${source} 托管，未调用 skills CLI（需要更新请用 /skill-update）· ${elapsedSince(startedAt)}`;
			}
			if (await cacheUpToDate(source, requested, env)) {
				return `✓ 已是最新：${requested.join("、")}（缓存 TTL 内且与 lock 一致；/skill-update 强制检查上游）· ${elapsedSince(startedAt)}`;
			}
		}
	}

	const release = beginSkillOperation("skill-install", env);

	try {
		reporter?.progress?.(`解析来源 ${source}`);
		let check;
		let toInstall = requested;
		if (usesSourceCache(source, env) && requested.length > 0) {
			try {
				check = await checkSourceSkills(source, requested, { env, reporter, signal, allowStale: true });
			} catch (error) {
				// 已托管时把「检查上游」当尽力而为：cache 缺失/网络暂不可用不把安装本身判失败。
				if (!requestedManaged || !requestedLocked) throw error;
				const results = await ensureLinks(requested, { dshSkillsDir, canonicalSkillsDir }, reporter);
				return [
					`! 已安装：${requested.join("、")} 已由 ${source} 托管，但无法检查上游（${errorLine(error)}；/skill-update 重试）· ${elapsedSince(startedAt)}`,
					...results.map((item) => describeLink(item, { newVerb: "已安装" })),
				]
					.filter((line) => line.length > 0)
					.join("\n");
			}
			toInstall = check.changed;
			if (toInstall.length === 0) {
				// 内容已最新，但 dsh 软链可能缺失/被替换：这里仍要补链，不能直接返回。
				const results = await ensureLinks(requested, { dshSkillsDir, canonicalSkillsDir }, reporter);
				return [
					`✓ 已是最新：${requested.join("、")}（${source}${cacheAgeNote(check.cache)}）· ${elapsedSince(startedAt)}${describeCache(check.cache)}`,
					...results.map((item) => describeLink(item, { newVerb: "已安装" })),
					check.cache?.stale === true
						? "上游暂不可达，本次使用旧缓存（未确认最新）；/skill-update 会重新 fetch。"
						: check.cache?.fetched === true
							? "已检查上游，内容与 lock 一致。"
							: "缓存 TTL 内未访问上游；/skill-update 会强制 fetch。",
				]
					.filter((line) => line.length > 0)
					.join("\n");
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
			return [
				`CLI 报告成功，但没在 ${canonicalSkillsDir} 里发现任何技能（${elapsedSince(startedAt)}）。`,
				`检查来源 "${source}" 是否包含 <name>/SKILL.md，或显式指定技能名：/skill-install ${source} <技能名>`,
			]
				.filter((line) => line.length > 0)
				.join("\n");
		}

		reporter?.progress?.(`链入 dsh 技能目录（${names.length} 个）`);
		const results = await ensureLinks(names, { dshSkillsDir, canonicalSkillsDir }, reporter);
		const updated = check !== undefined && check.changed.length > 0;
		const installHeader =
			allSettled(results) && !updated
				? `✓ 已是最新：${source} 的 ${names.length} 个技能均已托管 · ${elapsedSince(startedAt)}${describeCache(outcome.cache)}`
				: `技能安装 · 来源 ${source} · ${names.join("、")} · ${elapsedSince(startedAt)}${describeCache(outcome.cache)}`;
		return [
			installHeader,
			...results.map((item) => describeLink(item, { newVerb: "已安装" })),
			"技能目录被实时监听，无需重启 dsh；插件依赖的那几个技能用 /skill-init 与 /skill-update 维护。",
		]
			.filter((line) => line.length > 0)
			.join("\n");
	} finally {
		release();
	}
}

/**
 * `/skill-update`：对（指定或全部）关联技能做幂等重装（`add … -g -a universal -y`）。
 * 不用 `skills update`：它内部 spawn 的 `add` 不带 `-a`，会把链接撒到其它 agent 目录，
 * 未检测到 agent 时甚至会装到全部 agent。
 */
export async function runSkillUpdate(commands, rawInput, { signal, env = process.env, reporter, registerCancel } = {}) {
	const startedAt = Date.now();
	const all = referencedSkills(commands);
	const requested = rawInput.split(/\s+/).filter((token) => token.length > 0);
	const unknown = requested.filter((name) => !all.includes(name));
	if (unknown.length > 0) {
		throw new Error(`未知技能：${unknown.join("、")}。本插件依赖：${all.join("、")}`);
	}
	const targets = requested.length > 0 ? requested : all;

	const dshHome = resolveDshHome(env);
	const dshSkillsDir = join(dshHome, "skills");
	const canonicalSkillsDir = resolveCanonicalSkillsDir();

	const states = [];
	for (const name of targets) states.push(await inspectSkill(name, { dshSkillsDir, canonicalSkillsDir }));
	const managed = states.filter((s) => s.state === "managed");
	const lines = [];

	if (managed.length === 0) {
		return [
			`没有可更新的技能：${targets.join("、")} 都不由 skills CLI 托管。`,
			"先执行 /skill-init 把它们切换为托管链路（只会替换软链，不动真实目录）。",
		].join("\n");
	}

	const source = resolveSkillSource(env);
	const release = beginSkillOperation("skill-update", env);
	let cache;
	try {
		const outcome = await installFromSource(source, managed.map((s) => s.name), {
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
		for (const state of managed) {
			const readable = await exists(join(state.linkPath, "SKILL.md"));
			if (!readable) {
				// canonical 目录被整体替换时软链应仍可解析；这里兜住异常情况
				try {
					const linked = await linkSkill(state.name, { dshSkillsDir, canonicalSkillsDir });
					lines.push(`↻ ${state.name}：软链失效，已重建 → ${linked.canonical}`);
				} catch (error) {
					lines.push(`✗ ${state.name}：软链重建失败（${error instanceof Error ? error.message : String(error)}）`);
				}
				continue;
			}
			lines.push(`✓ ${state.name}：已更新到最新（${state.target}）`);
		}

		for (const state of states) {
			if (state.state === "managed") continue;
			lines.push(
				state.state === "missing"
					? `· ${state.name}：未安装，跳过（先执行 /skill-init）`
					: `· ${state.name}：不由 skills CLI 托管（${state.isDirectory ? "真实目录" : (state.target ?? "未知条目")}），跳过（先执行 /skill-init）`,
			);
		}

		return [
			`技能更新 · ${managed.map((s) => s.name).join("、")} · ${elapsedSince(startedAt)}${describeCache(cache)}`,
			...lines,
			"技能目录被实时监听，无需重启 dsh。",
		]
			.filter((l) => l.length > 0)
			.join("\n");
	} finally {
		release();
	}
}
