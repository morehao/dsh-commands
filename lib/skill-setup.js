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
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** 技能来源仓（由 ai-kit 提供）。 */
export const SKILL_SOURCE = "morehao/ai-kit";
/** 固定 CLI 版本，避免上游 breaking 直接把命令打挂；可用环境变量覆盖。 */
export const DEFAULT_SKILLS_CLI = "skills@1.7.4";

/**
 * `/skill-init`、`/skill-update` 使用的来源：默认是上游 GitHub 仓，
 * `DSH_COMMANDS_SKILL_SOURCE` 可换成可达镜像或本地目录（GitHub 不通时的逃生口）。
 */
export function resolveSkillSource(env = process.env) {
	const raw = env.DSH_COMMANDS_SKILL_SOURCE?.trim();
	return raw && raw.length > 0 ? raw : SKILL_SOURCE;
}
const DEFAULT_TIMEOUT_MS = 300_000;
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
 * 解析 `skills` CLI 的调用方式。
 * `DSH_COMMANDS_SKILL_CLI` 可完全替换命令（测试桩 / 自定义安装方式），
 * 此时视为"可执行文件 + 固定前缀"，不再追加 npx 参数。
 */
async function resolveCli(env) {
	const override = env.DSH_COMMANDS_SKILL_CLI?.trim();
	if (override && override.length > 0) {
		return { command: override, argsPrefix: [], label: override };
	}
	const spec = env.DSH_COMMANDS_SKILLS_CLI?.trim() || DEFAULT_SKILLS_CLI;
	const npx = (await findOnPath("npx", env)) ?? (await findViaLoginShell("npx", env));
	if (npx === undefined) {
		throw new Error(
			"找不到 npx（PATH 与登录 shell 反查都没有）。请确认已安装 Node.js 22.20+ 且 npx 在 PATH 中，" +
				`或手工执行：npx -y ${spec} add ${resolveSkillSource(env)} --skill <技能名> -g -a universal -y`,
		);
	}
	return { command: npx, argsPrefix: ["-y", spec], label: `npx -y ${spec}` };
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
		const key = line.replace(SPINNER_TAIL, "");
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

function timeoutMs(env) {
	const raw = Number(env.DSH_COMMANDS_SKILL_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** 上游 `skills` CLI 自己的克隆超时；让它在我们的硬超时之前触发。 */
const CLONE_TIMEOUT_ENV = "SKILLS_CLONE_TIMEOUT_MS";
const CLONE_TIMEOUT_MARGIN_MS = 30_000;

/**
 * 子进程环境。
 *
 * `SKILLS_CLONE_TIMEOUT_MS` 必须比外层的 `DSH_COMMANDS_SKILL_TIMEOUT_MS` 更早：
 * 两者默认都是 300s，外层定时器会先把子进程 SIGKILL 掉，CLI 自己那条
 * 「Clone timed out after 300s … 可传本地路径」的诊断就永远拿不到
 * （真机复现：命令卡片显示 `退出码 SIGKILL`，真正有用的建议被截掉）。
 */
function cliEnv(env) {
	const cloneTimeout = Math.max(30_000, timeoutMs(env) - CLONE_TIMEOUT_MARGIN_MS);
	return {
		...env,
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		CI: "1",
		TERM: "dumb",
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
function runCli(invocation, args, { env, signal, reporter, registerCancel }) {
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
		const collect = (chunk, channel) => {
			const text = String(chunk);
			output += text;
			// 防御：CLI 万一刷屏也不无限增长
			if (output.length > 200_000) output = output.slice(-100_000);
			// 作业面板是纯文本终端（不解析 ANSI），所以旁路前先去色，否则面板里全是 `[38;5;250m` 之类转义码。
			reporter?.write?.(stripAnsi(text), channel);
		};
		child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
		child.stderr.on("data", (chunk) => collect(chunk, "stderr"));

		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
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

/**
 * 组装 `add` 参数。`names` 为空时不传 `--skill`（CLI 在 `-y` 下会装该来源发现的所有技能）。
 * `-a universal` 必填：否则未检测到 agent 时会把技能装到全部 agent 目录；`-y` 全非交互。
 */
function buildAddArgs(names, source = SKILL_SOURCE) {
	const args = ["add", source];
	for (const name of names) args.push("--skill", name);
	args.push("-g", "-a", "universal", "-y");
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
 * 只服务 `/skill-init` 与 `/skill-update` —— 它们常常一步实事都不干，此时建作业只会在
 * 会话头部闪一个零输出的空作业行；`/skill-install` 总要调 CLI，永远建作业。
 */
export async function jobSkipReason(name, commands, rawInput, { env = process.env } = {}) {
	if (name !== "skill-init" && name !== "skill-update") return undefined;
	const dshSkillsDir = join(resolveDshHome(env), "skills");
	const canonicalSkillsDir = resolveCanonicalSkillsDir();
	const all = referencedSkills(commands);
	const requested = rawInput.split(/\s+/).filter((token) => token.length > 0);
	const targets = name === "skill-init" ? all : requested.length > 0 ? requested.filter((n) => all.includes(n)) : all;
	if (targets.length === 0) return "没有可处理的技能";
	const states = [];
	for (const target of targets) states.push(await inspectSkill(target, { dshSkillsDir, canonicalSkillsDir }));
	if (name === "skill-init") {
		const pending = states.filter((state) => state.state !== "managed").map((state) => state.name);
		return pending.length === 0 ? `${targets.join("、")} 均已托管，没有需要安装或修复的技能` : undefined;
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

/**
 * `/skill-init`：检查命令依赖的技能，缺则用 `npx skills` 全局安装并软链进 dsh 技能根，
 * 已托管则跳过；存在但不由 CLI 托管时**替换软链**为托管链路（真实目录拒绝覆盖）。
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
	if (pending.length > 0) {
		const invocation = await resolveCli(env);
		const names = pending.map((s) => s.name);
		const source = resolveSkillSource(env);
		reporter?.progress?.(`安装 ${names.join("、")}（${invocation.label} add ${source}）`);
		const result = await runCli(invocation, buildAddArgs(names, source), { env, signal, reporter, registerCancel });
		if (result.code !== 0) {
			throw new Error(
				`${invocation.label} 安装失败（退出码 ${result.code ?? result.signal}）：\n${tail(result.output)}${networkHint(result.output)}`,
			);
		}
	}

	// 真实目录/文件不可回滚，不替用户删（ensureLinks 内按单项失败处理，其余技能继续）
	reporter?.progress?.("链入 dsh 技能目录");
	const results = await ensureLinks(skills, { dshSkillsDir, canonicalSkillsDir }, reporter);
	const lines = results.map((result) => describeLink(result, { newVerb: "新装" }));

	reporter?.progress?.("校验命令分支契约");
	const failures = await contractReport(commands, dshSkillsDir);
	const header = allSettled(results) && failures.length === 0
		? `✓ 无需操作：${skills.join("、")} 均已托管 · ${elapsedSince(startedAt)}`
		: `技能依赖检查 · ${skills.join("、")} · ${elapsedSince(startedAt)}`;
	const footer =
		failures.length === 0
			? `契约：${commands.length} 条命令的分支文件齐全。技能目录被实时监听，无需重启 dsh。`
			: `契约问题（${failures.length}）：\n${failures.map((f) => `· ${f}`).join("\n")}\n技能目录被实时监听，无需重启 dsh；契约问题请对照 ai-kit 的技能版本。`;

	return [header, ...lines.filter((l) => l.length > 0), footer].filter((l) => l.length > 0).join("\n");
}

/**
 * `/skill-install`：安装**任意来源**的技能（不限本插件依赖），并软链进 dsh 技能根。
 *
 * 语法：`/skill-install <来源> [技能名...]`
 * - 来源可以是 `owner/repo`、git/HTTPS URL 或本地路径（与 `npx skills add` 的来源语法一致）。
 * - 不写技能名 → 装该来源发现的全部技能（CLI 在 `-y` 下自动全选）。
 * - 用 `-a universal` 固定落 canonical `~/.agents/skills`，绝不波及其它 agent 目录。
 *
 * 装完怎么知道该给谁建软链？三路取并集：
 *   1) 用户显式写的技能名；
 *   2) 安装前后 canonical 目录的差集（覆盖"装全部"的情况）；
 *   3) lock 里 source 与该来源匹配的技能（覆盖"早已在 canonical、但没建过软链"的情况）。
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

	reporter?.progress?.(`解析来源 ${source}`);
	const invocation = await resolveCli(env);
	const before = new Set(await listSkillsDir(canonicalSkillsDir));
	reporter?.progress?.(
		requested.length > 0 ? `安装 ${requested.join("、")}（${invocation.label} add）` : `安装 ${source} 的全部技能（${invocation.label} add）`,
	);
	const result = await runCli(invocation, buildAddArgs(requested, source), { env, signal, reporter, registerCancel });
	if (result.code !== 0) {
		throw new Error(
			`${invocation.label} 安装失败（退出码 ${result.code ?? result.signal}）：\n${tail(result.output)}${networkHint(result.output)}`,
		);
	}

	const after = await listSkillsDir(canonicalSkillsDir);
	const added = after.filter((name) => !before.has(name));
	const locked = await lockedNamesForSource(source, env);
	const names = [...new Set([...requested, ...locked, ...added])].sort();

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
	const installHeader =
		allSettled(results)
			? `✓ 无需操作：${source} 的 ${names.length} 个技能均已托管 · ${elapsedSince(startedAt)}`
			: `技能安装 · 来源 ${source} · ${names.join("、")} · ${elapsedSince(startedAt)}`;
	return [
		installHeader,
		...results.map((item) => describeLink(item, { newVerb: "已安装" })),
		"技能目录被实时监听，无需重启 dsh；插件依赖的那几个技能用 /skill-init 与 /skill-update 维护。",
	]
		.filter((line) => line.length > 0)
		.join("\n");
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

	const invocation = await resolveCli(env);
	const source = resolveSkillSource(env);
	reporter?.progress?.(`重装到上游最新：${managed.map((s) => s.name).join("、")}（${invocation.label} add ${source}）`);
	const result = await runCli(invocation, buildAddArgs(managed.map((s) => s.name), source), {
		env,
		signal,
		reporter,
		registerCancel,
	});
	if (result.code !== 0) {
		throw new Error(
			`${invocation.label} 更新失败（退出码 ${result.code ?? result.signal}）：\n${tail(result.output)}${networkHint(result.output)}`,
		);
	}

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
		`技能更新 · ${managed.map((s) => s.name).join("、")} · ${elapsedSince(startedAt)}`,
		...lines,
		"技能目录被实时监听，无需重启 dsh。",
	]
		.filter((l) => l.length > 0)
		.join("\n");
}
