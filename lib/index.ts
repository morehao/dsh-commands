/**
 * dsh-commands —— 把由 agent-skills 提供的 git-kit / handoff / disk-cleanup 技能工作流以 dsh 原生命令方式接入（可扩展其他命令）。
 *
 * 架构（命令 = 意图表，单一真源在对应 skill）：
 * - 逻辑与「意图路由」的唯一真源是对应 skill：`skills/git-kit`、`skills/handoff` 与
 *   `skills/disk-cleanup`（各自 SKILL.md 的意图决策树 + references/ + scripts/）。本插件不复制逻辑，
 *   只声明「命令 → skill 分支」的映射表（COMMANDS），是 dsh 斜杠侧的一条薄入口，
 *   与 opencode 的 `commands-opencode/*`、自然语言触发互为入口。
 * - 每条命令注册到 ctx.commands（CommandDefinition：name/description/input.hint/
 *   recordInput/handler），出现在 dsh 斜杠菜单；handler 校验必填输入后构造一条 user
 *   消息，经 invocation.agent.followup() 注入当前会话，让 agent 按对应 skill 的分支执行。
 * - 统一 recordInput:false：用户输入已逐字写进下面注入的那条 user 消息（会话日志的
 *   真实事件），若再让 command/run 记一份 args 就是同一 payload 落两份日志。按 dsh
 *   官方指引（命令自身的权威事件已承载 payload 时置 false 以免重复）统一关掉。
 *   注：斜杠菜单行的描述文本由 Host 原样透传到浏览器，dsh 只本地化它自己的一方差
 *   命令（HOST_DESCRIPTION_KEYS），第三方命令描述不参与 i18n —— 故这里的 description
 *   直接写中文，是有意为之。
 * - 本模块自包含：不读取任何仓库内文件、无路径耦合、不含
 *   `@deepseek-ai/*` 顶层静态 import（消息优先用官方 `@deepseek-ai/dsh-llm` 的
 *   `createUserMessage`，`apply()` 里可选加载，失败回退本地契约实现 role/source/content/id 全齐）。
 *   改 skill 无需重启；改本文件（含 COMMANDS 表）需重启 dsh web。
 * - 例外（历史兼容）：`handoff` 的 SKILL.md 在 2026-10-25 之前标了 `disable-model-invocation`
 *   （只允许用户手动调用），dsh 会把它移出模型可见的技能目录、且 skill 工具直接拒绝加载；
 *   上游已移除该标记（agent-skills #51），这条命令仍保留 `readFallback: true`，让装了旧版
 *   技能目录的机器还能靠「直接 read 技能文件」跑通。新装环境不会走到这条兜底。
 *
 * 分支 key 词汇表（与各 SKILL.md 决策树对齐）：
 *   git-kit: commit-push / commit-message / branch / pr-create / pr-merge / tag / checkout-tag / release / slim / star-classify
 *   handoff: print
 *   disk-cleanup: cleanup
 *
 * 可选字段：
 * - `noInput`：无参数时的专门指引（默认注入「按分支流程默认处理」）。`/cleanup` 用它把
 *   技能第 0 步的「先给编号选项、不执行任何脚本」带进注入文本，见 COMMANDS 内注释。
 * - `confirm`：有参数时需要用户决策的事项（默认是分支名 / PR·MR 编号等 git 语境）。
 *
 * 三类命令：
 * - 委托型（COMMANDS）：薄意图 → 注入 user 消息 → agent 加载对应 skill 执行，逻辑唯一真源在技能里。
 * - 维护型委托（/skill-init）：注入一条 user 消息让 agent 调用 `skill_init` 工具；工具内部走
 *   observe → plan → confirm → apply → verify，进度/停止/确认都由 dsh 原生提供。依赖的技能集合
 *   仍从 COMMANDS 推导，不维护第二份清单。无 tools / 无 agent 时回退到 `runSkillInit` /
 *   `runSkillUpdate`（skill-setup.js），保证旧宿主不丢功能。
 * - 维护型本地执行（/plugin-update）：只读检查本插件自身的 npm 最新版，不注入消息、不写盘；
 *   不在一键更新自己（remove+install 会重载插件，命令卡可能丢失），需要更新时给手动命令。
 *
 * 任意来源的技能安装不在命令面：dsh 会扫 `~/.agents/skills`，`npx skills add … -g -a universal -y`
 * 就够了，交给用户或 agent 直接执行（见 README）。插件只负责自己依赖的三个技能。
 */

import { access } from "node:fs/promises";
import { join } from "node:path";

import { skillRoots } from "./skill-paths.js";
import { referencedSkills, resolveSkillSource, runSkillInit, runSkillUpdate } from "./skill-setup.js";
import { createSkillInitTool } from "./tool-skill-init.js";
import { createNoticeMessage, createUserMessage as userMessage, makeSkillInitHandler, setUserMessageFactory } from "./skill-command.js";
import { resolveConsoleApi } from "./console-api.js";
import { PLUGIN_META, createPluginUpdater, readPluginState, writePluginState } from "./plugin-update.js";
import { formatCheck, makePluginUpdateHandler } from "./plugin-update-command.js";
import { createPluginUpdateTool } from "./tool-plugin-update.js";

export const name = "dsh-commands";
export const inject = ["commands"];

/**
 * 命令意图表。每条 = 一行声明：注册元数据 + 对应 skill 的分支 key。
 * `branch` 必须与对应 SKILL.md 决策树的分支 key 一致；`skill` 省略时默认 git-kit。
 */
export const COMMANDS = [
	{
		name: "git-message",
		branch: "commit-message",
		hint: "<中文描述>",
		required: true,
		description: "将中文描述转换为 Conventional Commits 格式的 commit message（纯生成，不提交）"
	},
	{
		name: "git-commit-push",
		branch: "commit-push",
		description: "基于代码变更生成 commit message 并自动提交推送到远端；稳定分支（主干/集成分支、发布/稳定/维护分支、版本线分支）时自动创建分支"
	},
	{
		name: "git-branch",
		branch: "branch",
		hint: "<中文描述>",
		required: true,
		description: "基于中文描述生成候选分支名，选择后从基准分支创建并切换"
	},
	{
		name: "git-pr-create",
		branch: "pr-create",
		hint: "[目标分支]",
		description: "基于代码差异向目标仓库创建或更新 PR/MR（自动识别 gh/glab）"
	},
	{
		name: "git-pr-merge",
		branch: "pr-merge",
		hint: "[PR/MR 编号]",
		description: "按编号合并 PR/MR（自动识别 gh/glab），删除原分支（head 为稳定分支时保留），切回主干并更新代码"
	},
	{
		name: "git-release",
		branch: "release",
		hint: "[版本号或tag]",
		description:
			"pr-merge 之后的发布段：在已合并的稳定分支上打 tag → 默认创建 GitHub/GitLab Release → 按仓库探测跟踪后效（流水 / 产物）并出校验回执；tag 注记与 Release body 共用同一份变更说明（中文摘要 + 折叠原文，推送前确认并冻结）；版本源由读仓库判定，不假定清单格式（只打标签用 /git-tag）"
	},
	{
		name: "git-tag",
		branch: "tag",
		hint: "[tag名或分支名]",
		description: "查看最新 tag 与来源分支，选择分支与版本号，构建注记 tag（变更说明：中文摘要 + 折叠原文）并推送到远端"
	},
	{
		name: "git-checkout-tag",
		branch: "checkout-tag",
		hint: "[tag名]",
		description:
			"切换到当前仓库的最新 tag（按版本号取最高，非 semver 退化为最近创建）；只切不改，默认切到 detached HEAD，要基于该 tag 继续开发才另建分支"
	},
	{
		name: "git-slim",
		branch: "slim",
		hint: "[保留天数]",
		description: "将当前 git 仓库瘦身为浅克隆，默认保留最近 30 天历史，保留本地未提交改动"
	},
	{
		name: "git-star-classify",
		branch: "star-classify",
		description: "拉取并分类你自己的 GitHub star 仓库，输出按大类分组的中文 Markdown 清单"
	},
	{
		name: "handoff",
		skill: "handoff",
		branch: "print",
		hint: "[任务范围]",
		description: "把当前会话的任务状态压缩成一段可粘贴的续跑提示（只打印，不落盘）",
		// handoff 在 2026-10-25 之前标了 disable-model-invocation（只允许用户手动调用），
		// dsh 会把它移出模型可见目录且 skill 工具拒绝加载；上游已移除该标记（agent-skills #51），
		// 但旧版技能目录仍可能存在 —— 保留 read 兜底，新装环境走正常的 skill 工具加载。
		readFallback: true
	},
	{
		name: "cleanup",
		skill: "disk-cleanup",
		branch: "cleanup",
		hint: "[清理范围]",
		description:
			"磁盘空间回收与本地数据瘦身（macOS 为主）：先只读测量（可列最大占用）给出目录总量 / 本次可删量双口径清单，由你勾选后 dry-run 复核、只清所选；sudo 项交你终端，用户数据只报告不代删",
		// 技能的 SKILL.md 第 0 步规定：没有文字说明时先给编号选项、不执行任何脚本。
		// 通用语「按分支流程默认处理」会诱导模型直接开跑，这里换成明确指引。
		noInput:
			"用户未附加说明：按 SKILL.md 第 0 步先给出编号选项（只看占用 / 选勾清理 / 只处理本地数据库 / 取消），等用户选择后再继续；不要执行任何脚本，也不要替用户选默认项。",
		confirm: "清理范围 / 清理项编码（--only）"
	}
];

/**
 * 维护型委托：`/skill-init` 自己就是安装器，handler 只解析参数并把请求交给 `skill_init` 工具。
 * 依赖集合从 COMMANDS 推导（`skill ?? "git-kit"` 去重），增删委托型命令后自动跟进。
 */
const SKILL_INIT_DEF = Object.freeze({
	name: "skill-init",
	hint: "[--update [技能名...]] [--yes]",
	description:
		"检查并安装插件依赖的技能（git-kit、handoff、disk-cleanup）；缺失的安装、契约校验；init 有写盘时先确认（--yes 跳过），--update 为显式更新"
});

/**
 * 维护型委托：`/plugin-update` 检查并更新本插件自身（经 `plugin_update` 工具；确认/进度/结果
 * 都由 dsh 原生问答与作业提供）。与 `/skill-init`（改技能）区分：这里更新的是插件包本身。
 */
const PLUGIN_UPDATE_DEF = Object.freeze({
	name: "plugin-update",
	hint: "[--apply] [--yes]",
	description: "检查并更新本插件自身到 npm 最新版（默认只检查；--apply 先确认再更新，完成后需重启 DSH 生效）"
});

/** 本插件依赖的技能集合（/skill-init 与外部脚本共用同一真源）。 */
export const REQUIRED_SKILLS = Object.freeze(referencedSkills(COMMANDS));

/**
 * 构造注入当前会话的指令：告知用户请求，并把执行交给对应 skill 的对应分支。
 * 分支的完整流程（references/ 与 scripts/）由 agent 加载 skill 后自行读取，
 * 这里不复制任何逻辑，只做意图指路。
 */
function buildInstruction(def, input) {
	const skill = def.skill ?? "git-kit";
	// 有专门的无参数语义时不能再说「按默认处理」—— `/cleanup` 的默认是"先问再动"。
	const emptyRequest = def.noInput === undefined ? "（未附加说明，按分支流程默认处理）" : "（未附加说明）";
	const lines = [
		`【dsh 命令 /${def.name}】`,
		`用户请求：${input.length > 0 ? input : emptyRequest}`,
		"",
		`请用 skill 工具加载 ${skill}，将本次请求视为 ${def.branch} 分支并按该分支的完整流程执行。`
	];
	if (input.length === 0 && def.noInput !== undefined) {
		lines.push(def.noInput);
	} else {
		lines.push(
			`如需用户决策（${def.confirm ?? "候选分支名 / PR·MR 编号 / tag 版本号 / 交接范围等"}），先向用户确认再继续。`,
		);
	}
	if (def.readFallback === true) {
		lines.push(
			'若 skill 工具报 "not available for model invocation"（技能被标为仅用户可调用；旧版 handoff 会这样），' +
				`改用 read 工具读取技能文件：优先 \`$DSH_HOME/skills/${skill}/SKILL.md\`（dsh 软链层，DSH_HOME 通常为 ~/.dsh），` +
				`不存在时读本源 \`~/.agents/skills/${skill}/SKILL.md\`，需要时再读同目录下的 references/。`
		);
	}
	return lines.join("\n");
}

/**
 * 命令所依赖的技能是否已经落在 dsh 会扫描的全局技能根里（文件探测，作为目录不可用时的回退）。
 * 顺序由 `skillRoots()` 统一给出（`$DSH_HOME/skills` → `$DSH_AGENTS_HOME/skills` → 本源
 * `~/.agents/skills`）：项目级手工技能不归本插件管，也不该因为一个项目里没有就拦掉全局可用的命令。
 * 契约校验脚本共用同一份顺序，别再各自拼路径。
 */
async function skillInstalledByFs(skill, env = process.env) {
	for (const root of skillRoots(env)) {
		try {
			await access(join(root, skill, "SKILL.md"));
			return true;
		} catch (error) {
			// 只有"确实不存在"才算缺失；权限等异常按已安装放行，避免误拦委托。
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return true;
		}
	}
	return false;
}

/**
 * 技能可用性：优先问 DSH 技能目录（权威、已校验），目录不可用时回退文件探测。
 *
 * `ctx.get("skills").list({ cwd })` 返回已校验的技能候选（`{ name, invocation: { modelInvocable, userInvocable } }`），
 * 能正确反映 frontmatter 非法 / `disable-model-invocation` 等被过滤的情况；只查文件存在会误判。
 *
 * @returns {Promise<{ installed: boolean, modelInvocable: boolean, from: "registry" | "fs" }>}
 */
async function resolveSkillAvailability(ctx, skill) {
	const registry = typeof ctx?.get === "function" ? ctx.get("skills") : undefined;
	if (registry && typeof registry.list === "function") {
		try {
			const catalog = await registry.list({ cwd: process.cwd() });
			const list = Array.isArray(catalog) ? catalog : catalog?.skills;
			if (Array.isArray(list)) {
				const entry = list.find((item) => item?.name === skill);
				if (entry !== undefined) {
					return { installed: true, modelInvocable: entry.invocation?.modelInvocable !== false, from: "registry" };
				}
				// 目录可用且明确没有该技能：这是权威的“未安装”。
				return { installed: false, modelInvocable: false, from: "registry" };
			}
		} catch {
			// 目录不可用（无 provider / 读取失败）：退回文件探测。
		}
	}
	return { installed: await skillInstalledByFs(skill), modelInvocable: true, from: "fs" };
}

/** console 停用 / 仅手动 时的不可用文案（不改文件探测，只提前解释原因）。 */
function consoleUnavailableText(skill, mode) {
	return (
		{
			off: "技能在技能控制台已停用，请在控制台启用后重试。",
			hidden: "技能在技能控制台已「完全停用」，请在控制台恢复。",
			manual: "技能在控制台设为「仅手动」；本命令需要模型加载技能，请在控制台切换为「自动」。"
		}[mode] ?? `技能 ${skill} 在技能控制台当前不可用，请打开控制台检查。`
	);
}

/** 缺技能时不注入委托，直接给一条可执行的修复路径。 */
function missingSkillText(def, skill) {
	const source = resolveSkillSource(process.env);
	return [
		`技能 ${skill} 未安装，/${def.name} 暂时无法执行。`,
		"先运行 /skill-init 安装插件依赖技能；也可以手工执行：",
		`  npx -y skills add ${source} --skill ${skill} -g -a universal -y`,
		"不要省略 -a universal：缺少它时可能把技能装到本机所有 agent 目录。"
	].join("\n");
}

function makeHandler(def, ctx) {
	return async (invocation) => {
		const input = invocation.rawInput.trim();
		if (def.required && input.length === 0) {
			return { kind: "error", text: `Usage: /${def.name} ${def.hint}\n例如：/${def.name} 修复登录超时` };
		}
		const skill = def.skill ?? "git-kit";
		// console 预检：控制台把该技能设为 停用/完全停用/仅手动 时直接给出原因。
		// 包/服务不可用（未安装 console 包 / 状态不可读）时静默跳过，退回文件探测，不受影响。
		try {
			const { api } = await resolveConsoleApi({ env: process.env });
			const list = await api.list({ names: [skill] });
			const record = Array.isArray(list) ? list.find((item) => item?.name === skill) : undefined;
			if (record && record.mode !== "auto") {
				return { kind: "error", text: consoleUnavailableText(skill, record.mode) };
			}
		} catch {
			// 控制台包缺失 / 状态不可读：不阻断委托，交给下面的文件探测与技能目录判断。
		}
		const availability = await resolveSkillAvailability(ctx, skill);
		if (!availability.installed) {
			return { kind: "error", text: missingSkillText(def, skill) };
		}
		// 技能存在但模型不可调用（disable-model-invocation）：readFallback 除外。
		if (availability.from === "registry" && availability.modelInvocable === false && def.readFallback !== true) {
			return {
				kind: "error",
				text: `技能 ${skill} 当前不可由模型调用（disable-model-invocation / 非 user 可见），/${def.name} 需要模型加载技能才能执行。请检查技能版本或改用手动调用。`
			};
		}
		const instruction = buildInstruction(def, input);
		try {
			invocation.agent.followup(userMessage(instruction));
		} catch (error) {
			return {
				kind: "error",
				text: `已生成委托指令，但无法交给当前会话执行：${error instanceof Error ? error.message : String(error)}`
			};
		}
		return { kind: "success", text: `已按 ${skill} ${def.branch} 分支委托执行 /${def.name}，agent 将按流程继续。` };
	};
}

const MAX_ERROR_LINES = 20;
/** 命令卡片的硬上限：行数之外再按字符兜底（CLI 的 spinner 曾把回执撑到 88 KB）。 */
const MAX_ERROR_CHARS = 2_000;

/** 把任意长度的错误裁成卡片可读的摘要（行 + 字符双上限）。 */
function briefError(message) {
	const lines = message.split("\n");
	let brief =
		lines.length > MAX_ERROR_LINES
			? `${lines.slice(0, MAX_ERROR_LINES).join("\n")}\n…（其余 ${lines.length - MAX_ERROR_LINES} 行已省略）`
			: message;
	if (brief.length > MAX_ERROR_CHARS) {
		const omitted = brief.length - MAX_ERROR_CHARS;
		brief = `${brief.slice(0, MAX_ERROR_CHARS)}\n…（其余 ${omitted} 字符已省略）`;
	}
	return brief;
}

/**
 * 向活跃 agent 注入一条 notice；没有活跃 agent 时等下一个 agent 创建再补发**一次**。
 * 返回是否已投递。
 *
 * `agent/created` 监听必须在补发成功后立即注销：否则同一进程里之后每个新建会话都会
 * 再收到同一条「已更新」提示（0.4.0 的重复提示就源于监听没有一次性）。
 */
function deliverNotice(ctx, text, home) {
	const agents = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
	const build = () => createNoticeMessage(text);
	const live = typeof agents?.roots === "function" ? agents.roots() : typeof agents?.list === "function" ? agents.list() : [];
	for (const agent of live) {
		try {
			if (typeof agent?.inject === "function") {
				agent.inject(build());
				return true;
			}
		} catch {
			// 单个 agent 注入失败不影响其它
		}
	}
	let fired = false;
	let off: (() => void) | undefined;
	// ctx.on 在宿主里返回退订函数（个别实现是 { dispose }），两种都接住。
	const track = (subscription: any) => {
		if (typeof subscription === "function") off = subscription;
		else if (subscription && typeof subscription.dispose === "function") off = () => subscription.dispose();
		else off = undefined;
	};
	const stopListening = () => {
		const dispose = off;
		off = undefined;
		try {
			dispose?.();
		} catch {
			// 注销失败不影响已投递结果
		}
	};
	const onCreated = async ({ agent }: any = {}) => {
		if (fired || typeof agent?.inject !== "function") return;
		try {
			agent.inject(build());
		} catch {
			// 注入失败：保留监听，等下一个 agent 重试
			return;
		}
		fired = true;
		stopListening();
		try {
			await writePluginState(
				process.env,
				{
					...(await readPluginState(process.env, home)),
					lastSeenVersion: PLUGIN_META.version,
					pendingVersion: null
				},
				home
			);
		} catch {
			// 状态写失败不影响已经投递的提示
		}
	};
	try {
		if (typeof ctx.effect === "function" && typeof ctx.on === "function") {
			ctx.effect(() => {
				track(ctx.on("agent/created", onCreated));
				const inner = off;
				return () => {
					off = undefined;
					try {
						inner?.();
					} catch {
						// 忽略
					}
				};
			}, "dsh-commands:version-notice");
		} else if (typeof ctx.on === "function") {
			track(ctx.on("agent/created", onCreated));
		}
	} catch {
		// 宿主不支持事件订阅：仅保留 state，下次启动重试
	}
	return false;
}

/**
 * 启动时对比版本：更新后首次加载新代码时，向会话补一条「已更新」提示。
 * 尽力而为：失败静默，不阻塞插件加载。首次运行不写盘，等第一个 agent 出现时记基线，
 * 避免在无会话（含离线冒烟）时碰真实 `$DSH_HOME`。
 */
async function announcePluginUpdate(ctx, home) {
	try {
		const state = await readPluginState(process.env, home);
		const current = PLUGIN_META.version;
		if (!current) return;
		const hasState = typeof state.lastSeenVersion === "string" || typeof state.pendingVersion === "string";
		if (!hasState) {
			registerVersionBaseline(ctx, current, home);
			return;
		}
		const last = typeof state.lastSeenVersion === "string" ? state.lastSeenVersion : null;
		const pending = typeof state.pendingVersion === "string" ? state.pendingVersion : null;
		let text: string | null = null;
		if (pending !== null && pending === current && last !== current) text = `dsh-commands 已更新到 v${current}。`;
		else if (last !== null && last !== current) text = `dsh-commands 已更新：v${last} → v${current}。`;
		if (text === null) {
			await writePluginState(process.env, { ...state, lastSeenVersion: current, pendingVersion: null }, home);
			return;
		}
		const delivered = deliverNotice(ctx, text, home);
		if (delivered) {
			await writePluginState(process.env, { ...state, lastSeenVersion: current, pendingVersion: null }, home);
		}
		// 未投递：保留 state（lastSeen 仍是旧版），下次启动或下一个 agent 创建时重试
	} catch {
		// 启动提示失败不影响插件
	}
}

/** 首次运行：在第一个 agent 出现时写入基线版本（不主动写盘、不打扰）。 */
function registerVersionBaseline(ctx, current, home) {
	const writeBaseline = async () => {
		try {
			const state = await readPluginState(process.env, home);
			if (typeof state.lastSeenVersion === "string" || typeof state.pendingVersion === "string") return;
			await writePluginState(process.env, { lastSeenVersion: current }, home);
		} catch {
			// 忽略
		}
	};
	try {
		if (typeof ctx.effect === "function" && typeof ctx.on === "function") {
			ctx.effect(() => ctx.on("agent/created", () => void writeBaseline()), "dsh-commands:version-baseline");
		}
	} catch {
		// 宿主不支持事件订阅：不记基线，下次运行再试
	}
}

export async function apply(ctx) {
	// 官方消息构造：DSH 环境优先（@deepseek-ai/dsh-llm 可选加载），离线/旧宿主回退本地契约实现。
	try {
		const mod = await import("@deepseek-ai/dsh-llm");
		if (typeof mod.createUserMessage === "function") setUserMessageFactory(mod.createUserMessage);
	} catch {
		// 无 @deepseek-ai/dsh-llm（离线冒烟 / 非 DSH 宿主）：保持本地实现
	}
	// 工具注册在命令注册之后完成；handler 必须是惰性判断，否则启动时永远读到 false。
	let toolReady = false;
	let pluginUpdateToolReady = false;
	const fallbackSkillInit = async (parsed, invocation) => {
		try {
			const text =
				parsed.mode === "update"
					? await runSkillUpdate(COMMANDS, parsed.names.join(" "), { signal: invocation.signal })
					: await runSkillInit(COMMANDS, { signal: invocation.signal });
			return { kind: "success", text };
		} catch (error) {
			return { kind: "error", text: briefError(error instanceof Error ? error.message : String(error)) };
		}
	};
	// 无 tools / 无 agent 时的本地回退：只做只读检查，不安装。
	const fallbackPluginUpdate = async (parsed) => {
		try {
			const result = await pluginUpdater.check();
			return { kind: "success", text: formatCheck(result, { mode: parsed.mode }) };
		} catch (error) {
			return { kind: "error", text: briefError(error instanceof Error ? error.message : String(error)) };
		}
	};
	const skillInitDef = SKILL_INIT_DEF;

	// 只读自更新检查器：`ctx.get` 惰性取，注册时不读服务；缓存跨多次调用复用。
	const pluginUpdater = createPluginUpdater({
		getPluginManager: () => (typeof ctx.get === "function" ? ctx.get("pluginManager") : undefined),
		getProfileName: () => {
			const profile = typeof ctx.get === "function" ? ctx.get("profileContext") : undefined;
			return typeof profile?.name === "string" ? profile.name : null;
		},
		// 优先走 `pnpm view`（继承 profile 的镜像/私源/token），拿不到再回退 fetch。
		getProfile: () => (typeof ctx.get === "function" ? ctx.get("profileContext") : undefined)
	});

	// 命令注册：`register()` 内部已是 `layers.effect(this.ctx, …)`，绑定调用方 fiber，卸载自动注销。
	for (const def of COMMANDS) {
		await ctx.commands.register({
			definitionId: `dsh-commands:${def.name}`,
			name: def.name,
			description: def.description,
			...(def.hint === undefined ? {} : { input: { hint: def.hint } }),
			// 输入已随注入的 user 消息入日志，不再让 command/run 重复记一份 args。
			recordInput: false,
			handler: makeHandler(def, ctx)
		});
	}
	// 维护型委托：/skill-init 自己就是安装器，不再做技能预检，也不在本地执行。
	await ctx.commands.register({
		definitionId: "dsh-commands:skill-init",
		name: skillInitDef.name,
		description: skillInitDef.description,
		input: { hint: skillInitDef.hint ?? "[--update [技能名...]] [--yes]" },
		// 输入已随注入消息入日志；回退路径没有注入，但仍是同一次用户输入。
		recordInput: false,
		handler: makeSkillInitHandler({
			def: skillInitDef,
			toolReady: () => toolReady,
			fallback: fallbackSkillInit
		})
	});
	// 维护型委托：/plugin-update 检查并更新本插件自身（经 plugin_update 工具）。
	await ctx.commands.register({
		definitionId: "dsh-commands:plugin-update",
		name: PLUGIN_UPDATE_DEF.name,
		description: PLUGIN_UPDATE_DEF.description,
		...(PLUGIN_UPDATE_DEF.hint ? { input: { hint: PLUGIN_UPDATE_DEF.hint } } : {}),
		recordInput: false,
		handler: makePluginUpdateHandler({
			toolReady: () => pluginUpdateToolReady,
			fallback: fallbackPluginUpdate
		})
	});

	// 启动时若检测到版本变化（更新后重启），向活跃会话补一条 notice；无可发对象时静默。
	// 状态文件优先用宿主 profileContext.home，与 DSH 解析一致。
	const profileHome = typeof ctx.get === "function" ? ctx.get("profileContext")?.home : undefined;
	void announcePluginUpdate(ctx, typeof profileHome === "string" ? profileHome : undefined);

	// 工具注册是**可选增强**：旧版 dsh 没有 tools 服务、或宿主没装 `@deepseek-ai/dsh-tools` 时
	// 跳过注册，`/skill-init` 继续走本地执行回退。动态 import 只发生在这里，避免顶层依赖宿主包。
	const tools = typeof ctx.get === "function" ? ctx.get("tools") : undefined;
	if (typeof tools?.register !== "function") return;
	let defineTool;
	try {
		({ defineTool } = await import("@deepseek-ai/dsh-tools"));
	} catch {
		return;
	}
	if (typeof defineTool !== "function") return;
	try {
		tools.register(
			defineTool(
				createSkillInitTool({
					commands: COMMANDS,
					services: {
						// P0 实测：userQuestions 在 apply 阶段是 undefined，必须在 execute 时解析。
						userQuestions: () => ctx.get("userQuestions"),
						jobs: () => ctx.get("jobs")
					}
				})
			)
		);
		toolReady = true;
	} catch {
		// 工具定义/注册失败不应影响命令：保留本地回退。
	}
	try {
		tools.register(
			defineTool(
				createPluginUpdateTool({
					services: {
						pluginManager: () => ctx.get("pluginManager"),
						userQuestions: () => ctx.get("userQuestions"),
						jobs: () => ctx.get("jobs"),
						profileContext: () => ctx.get("profileContext")
					}
				})
			)
		);
		pluginUpdateToolReady = true;
	} catch {
		// 同上：注册失败只回退到本地只读检查。
	}
}
