/**
 * dsh-commands —— 把由 ai-kit 提供的 git-kit / handoff / disk-cleanup 技能工作流以 dsh 原生命令方式接入（可扩展其他命令）。
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
 * - 本模块自包含：不读取任何仓库内文件、无路径耦合、不依赖
 *   @deepseek-ai/* 运行时 import（消息对象手工构造为官方 createUserMessage 的
 *   契约形状：role/source/content/id 全齐）。改 skill 无需重启；
 *   改本文件（含 COMMANDS 表）需重启 dsh web。
 * - 例外：`handoff` 的 SKILL.md 标了 `disable-model-invocation`（只允许用户手动调用），
 *   dsh 会把它移出模型可见的技能目录、且 skill 工具直接拒绝加载；所以这条命令置
 *   `readFallback: true`，注入文本里带「直接 read 技能文件」的兜底路径。
 *
 * 分支 key 词汇表（与各 SKILL.md 决策树对齐）：
 *   git-kit: commit-push / commit-message / branch / pr-create / pr-merge / tag / release / slim / star-classify
 *   handoff: print
 *   disk-cleanup: cleanup
 *
 * 可选字段：
 * - `noInput`：无参数时的专门指引（默认注入「按分支流程默认处理」）。`/cleanup` 用它把
 *   技能第 0 步的「先给编号选项、不执行任何脚本」带进注入文本，见 COMMANDS 内注释。
 * - `confirm`：有参数时需要用户决策的事项（默认是分支名 / PR·MR 编号等 git 语境）。
 *
 * 两类命令：
 * - 委托型（COMMANDS）：薄意图 → 注入 user 消息 → agent 加载对应 skill 执行，逻辑唯一真源在技能里。
 * - 本地执行型（LOCAL_COMMANDS）：只有 /skill-init —— 它维护的是**技能本身**，判定与副作用都要确定性，
 *   所以在 handler 内直接执行（实现在 skill-setup.js），不过 agent；依赖的技能集合仍从 COMMANDS 推导，
 *   不维护第二份清单。`--update` 走同一条命令的强制更新分支，不再单独注册 /skill-update。
 *   命令面没有进度通道（只有 command/run + command/done 两个事件），所以「过程」走 dsh 后台任务
 *   （job-progress.js）：作业行实时显示阶段、面板里是流式输出、可两击停止，且不触发模型回合。
 *
 * 任意来源的技能安装不在命令面：dsh 会扫 `~/.agents/skills`，`npx skills add … -g -a universal -y`
 * 就够了，交给用户或 agent 直接执行（见 README）。插件只负责自己依赖的三个技能。
 */

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { confirmSkillOperation } from "./confirm.js";
import { runInJob } from "./job-progress.js";
import { skillPaths } from "./skill-paths.js";
import { planSkillOperation, referencedSkills, resolveSkillSource, runSkillInit, runSkillUpdate } from "./skill-setup.js";

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
		// handoff 的 SKILL.md 标了 disable-model-invocation（只允许用户手动调用），
		// dsh 会把它移出模型可见目录且 skill 工具拒绝加载 —— 本命令是它的唯一入口，
		// 故注入文本要带上「直接 read 技能文件」的兜底（见 buildInstruction）。
		readFallback: true
	},
	{
		name: "cleanup",
		skill: "disk-cleanup",
		branch: "cleanup",
		hint: "[清理范围]",
		description:
			"磁盘空间回收与本地数据瘦身（macOS 为主）：先只读测量并给出带实测大小的清单，由你勾选清理项后只清所选；用户数据只报告不代删",
		// 技能的 SKILL.md 第 0 步规定：没有文字说明时先给编号选项、不执行任何脚本。
		// 通用语「按分支流程默认处理」会诱导模型直接开跑，这里换成明确指引。
		noInput:
			"用户未附加说明：按 SKILL.md 第 0 步先给出编号选项（只看占用 / 选勾清理 / 只处理本地数据库 / 取消），等用户选择后再继续；不要执行任何脚本，也不要替用户选默认项。",
		confirm: "清理范围 / 清理项编码"
	}
];

/**
 * 本地执行型命令：维护「命令所依赖的技能」本身，不委托 agent。
 * 依赖集合从 COMMANDS 推导（`skill ?? "git-kit"` 去重），所以增删委托型命令后这里自动跟进。
 *
 * 只有一个命令、两个模式：
 * - `/skill-init` 检查并按需安装/修复软链（有变更先确认）；
 * - `/skill-init --update [技能名...]` 强制更新上游（显式更新，不弹确认）。
 */
export const LOCAL_COMMANDS = [
	{
		name: "skill-init",
		hint: "[--update [技能名...]] [--yes]",
		description:
			"检查并安装插件依赖的技能（git-kit / handoff / disk-cleanup），有变更时先确认（--yes 跳过）；--update 强制更新到上游最新（可指定技能名）",
		label: (_input, plan) =>
			plan?.kind === "skill-update"
				? `更新技能：${(plan?.targets ?? []).join("、") || "（按默认范围）"}`
				: `检查依赖技能（${(plan?.targets ?? []).join("、") || "插件依赖"}）`,
		plan: (commands, input, options) =>
			planSkillOperation(options.update === true ? "skill-update" : "skill-init", commands, input, options),
		// options: { signal, env, update }；init 不使用 input，update 把它当技能名过滤。
		run: (commands, input, options) =>
			options.update === true ? runSkillUpdate(commands, input, options) : runSkillInit(commands, options)
	}
];

/** 本插件依赖的技能集合（/skill-init 与外部脚本共用同一真源）。 */
export const REQUIRED_SKILLS = Object.freeze(referencedSkills(COMMANDS));

/** 构造一条 user 消息（形态与官方 createUserMessage 一致，source 必填，全深冻结）。 */
function userMessage(text) {
	return Object.freeze({
		role: "user",
		// dsh 的 Message 契约要求 source 字段（读 message.source.kind），缺失会在 agent 回合崩溃。
		source: Object.freeze({ kind: "user" }),
		content: Object.freeze([Object.freeze({ type: "text", text })]),
		id: randomUUID()
	});
}

/**
 * 构造一条「执行报告」消息：交给 agent 复核，同一条消息也是会话里的一行 notice。
 *
 * 为什么必须发：命令卡与回执只落在**对话流**上，而 dsh 的会话 blank 状态**只由
 * `turn/start` 解除**（`applySessionListMetadata`：`blank = state.blank && event.type !== "turn/start"`），
 * 命令事件、`inject()` 的 notice 都不算。所以在新建会话里跑 `/skill-init`，不唤醒一轮
 * 就必然什么都看不到。
 *
 * 为什么让它复核：命令本体在 handler 里已经确定性跑完，agent 只做「读结论 → 回报」，
 * 顺带能指出真实目录遮蔽、上游可更新等需要人处理的事。代价是一次小模型调用，值得。
 *
 * 消息用 `form: "notice"`：既能唤醒一轮，又在对话流里渲染成一行 notice 而不是一张
 * 用户气泡（渲染分支见 ui-chat 的 `ContextInjectionRow`，summary 是折叠态那一行）。
 */
function reportMessage(summary, text) {
	return Object.freeze({
		role: "user",
		source: Object.freeze({ kind: "dsh-commands", form: "notice", summary }),
		content: Object.freeze([Object.freeze({ type: "text", text })]),
		id: randomUUID()
	});
}

/** 交给 agent 的复核指令：约束死，避免它顺手重跑命令或改文件。 */
const REVIEW_INSTRUCTION = [
	"以上是命令本体刚跑完的确定性结果，不需要你再执行或重跑。",
	"请复核：① 结论是否正常；② 有没有需要用户处理的事项（如真实目录遮蔽了托管版本、上游有可更新的技能）。",
	"只输出 2–3 行中文结论；不要调用任何工具，不要修改文件。"
].join("\n");

/**
 * 把本次结论交给会话：默认 `followup()` 唤醒一轮复核（结果可见 + 会复核），
 * `DSH_COMMANDS_SKILL_NOTIFY=notice` 可降级为零 token 的 `inject()`（只记录不回话）。
 * 返回值表示是否成功交给会话；失败时静默跳过，不影响命令回执。
 */
function reportOutcome(agent, { summary, report, wake }) {
	const text = `${report}\n\n${wake ? REVIEW_INSTRUCTION : ""}`.trim();
	const message = reportMessage(summary, text);
	try {
		if (wake && typeof agent?.followup === "function") {
			agent.followup(message);
			return "wake";
		}
		if (typeof agent?.inject === "function") {
			agent.inject(message);
			return "notice";
		}
	} catch {
		return "failed";
	}
	return "skipped";
}

/** 交给模型的报告上限：回执里已含明细，过长的部分截断，避免挤占上下文。 */
const MAX_REPORT_CHARS = 1_400;

/** 是否唤醒一轮让 agent 复核；`DSH_COMMANDS_SKILL_NOTIFY=notice` 关闭（只 inject）。 */
function shouldWake(env = process.env) {
	const mode = env.DSH_COMMANDS_SKILL_NOTIFY?.trim().toLowerCase();
	return mode !== "notice";
}

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
			'若 skill 工具报 "not available for model invocation"（该技能标了 disable-model-invocation，只能由用户手动调用），' +
				`改用 read 工具读取 \`$DSH_HOME/skills/${skill}/SKILL.md\`（DSH_HOME 通常为 ~/.dsh），` +
				"需要时再读同目录下的 references/。"
		);
	}
	return lines.join("\n");
}

/**
 * 命令所依赖的技能是否已经落在 dsh 会扫描的全局技能根里。
 * 只看 `$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` 与 canonical `~/.agents/skills`：
 * 项目级手工技能不归本插件管，也不该因为一个项目里没有就拦掉全局可用的命令。
 */
async function skillInstalled(skill, env = process.env) {
	const paths = skillPaths(env);
	for (const root of [paths.dshSkillsDir, join(paths.agentsHome, "skills"), paths.canonicalSkillsDir]) {
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

function makeHandler(def) {
	return async (invocation) => {
		const input = invocation.rawInput.trim();
		if (def.required && input.length === 0) {
			return { kind: "error", text: `Usage: /${def.name} ${def.hint}\n例如：/${def.name} 修复登录超时` };
		}
		const skill = def.skill ?? "git-kit";
		if (!(await skillInstalled(skill))) {
			return { kind: "error", text: missingSkillText(def, skill) };
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

/** 结果里那行"过程去哪看"：有作业给 id，无事可做就说清为什么没有过程，降级说清原因。 */
function progressNote(outcome) {
	if (outcome.job !== undefined) {
		return `过程：作业 ${outcome.job.id}（会话头部「作业」可展开看完整输出，进行中可两击停止）`;
	}
	if (outcome.skippedReason !== undefined) {
		return `过程：本次没有变更，未创建后台任务（${outcome.skippedReason}）`;
	}
	return `过程：未启用后台任务（${outcome.fallbackReason ?? "jobs 服务不可用"}），只保留本次回执`;
}

/**
 * 本地命令的 flag：`--yes` 跳过确认，`--update` 切到强制更新。
 * 只认独立 token，避免误伤技能名。
 */
function parseLocalInput(raw) {
	const tokens = raw.split(/\s+/).filter((token) => token.length > 0);
	return {
		yes: tokens.includes("--yes"),
		update: tokens.includes("--update"),
		input: tokens.filter((token) => token !== "--yes" && token !== "--update").join(" ")
	};
}

/** 用户主动取消：不是失败，也不产生任何副作用。 */
function cancelledResult(def) {
	return { kind: "success", text: `已取消 /${def.name}，未做任何变更。` };
}

/** 本包的 npm 名（web client half 在 boot graph 里的行 id）。 */
const CLIENT_PACKAGE = "@morehao/dsh-commands";

/**
 * web client half 是否已进入当前页面的 boot graph。
 *
 * 为什么必须查：客户端模块表在 dsh 启动时构建，**运行中新装/升级的包不会自动进表**
 * （host half 会被 hmr 热加载，client half 不会）。此时自绘命令卡、完成提示、未读点全部
 * 不存在，用户只看到 dsh 的通用命令行，回执再正确也等于"没有任何反馈"。
 * 这是真实发生过的静默失败（desktop host 09:19 启动、插件 14:23 才装），所以回执要自证。
 */
function clientHalfState(ctx) {
	const modules = typeof ctx.get === "function" ? ctx.get("clientModules") : undefined;
	if (modules === undefined || modules === null || typeof modules.graph !== "function") return "unknown";
	try {
		const entries = modules.graph()?.entries;
		if (!Array.isArray(entries)) return "unknown";
		return entries.some((entry) => entry?.id === CLIENT_PACKAGE) ? "loaded" : "missing";
	} catch {
		return "unknown";
	}
}

/** 客户端半状态的回执行：不加载时必须给出下一步，否则用户只能猜。 */
function clientNote(state) {
	if (state === "missing") {
		return `客户端：命令卡未加载（dsh 启动后新装的包不进 boot graph，重启 dsh 后生效；Settings → Plugins 可看同步状态）`;
	}
	if (state === "unknown") return "客户端：命令卡状态未知（clientModules 服务不可用）";
	return "客户端：命令卡已加载（web）";
}

/**
 * 回执排版：首行结论 + 第二行「过程去哪看」+ 明细。
 *
 * 命令卡片默认只显示一行摘要，所以「过程」不能像 0.1.13 那样放在最后一行；
 * 有作业时在首行补一个短标记，让折叠状态下也知道去「作业」看。
 * 「本次没问你」「客户端卡没加载」也标在首行：用户不该靠"有没有弹问题"或
 * "有没有看到卡"来推断发生了什么。
 */
function formatLocalText(outcome, note, { unconfirmed = false, client = "unknown" } = {}) {
	const text = typeof outcome.value === "string" ? outcome.value.trim() : "";
	const [first = "", ...rest] = text.split("\n");
	const tags = [];
	if (outcome.job !== undefined) tags.push("后台作业");
	else if (outcome.fallbackReason !== undefined) tags.push("未启用后台作业");
	if (unconfirmed) tags.push("未确认");
	if (client === "missing") tags.push("客户端未加载");
	const tag = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
	const summary = first.length > 0 ? `${first}${tag}` : first;
	return [summary, progressNote(outcome), clientNote(client), ...rest, note ?? ""]
		.filter((line) => line.length > 0)
		.join("\n");
}

/**
 * 本地执行型 handler：直接执行并返回结果文本。
 *
 * 执行前会先 plan，再按需通过 `ctx.userQuestions` 让用户确认（不触发模型回合）；
 * 执行中走 dsh 后台任务（见 lib/job-progress.js）；`ctx.jobs` 缺失或无控制器时自动降级，
 * 语义不变。`--yes` 跳过确认；`--update` 走强制更新且不打断。
 */
function makeLocalHandler(def, ctx) {
	return async (invocation) => {
		const { yes, update, input } = parseLocalInput(invocation.rawInput.trim());
		// 先读客户端状态：哪怕命令早期返回（取消/失败），结论也要能解释"为什么没卡"。
		const client = clientHalfState(ctx);
		/**
		 * 每条出口都把结论交给会话：命令卡只活在对话流里，而 blank 会话只由 `turn/start`
		 * 解除，所以默认 `followup()` 唤醒一轮让 agent 复核（结果可见 + 会复核）；
		 * 取消这类"你刚刚点了取消"的出口只 `inject()`，不打扰模型。
		 */
		const finish = (result, { wake = shouldWake() } = {}) => {
			const text = String(result?.text ?? "").trim();
			const [first = ""] = text.split("\n");
			const report = MAX_REPORT_CHARS < text.length ? `${text.slice(0, MAX_REPORT_CHARS)}\n…（回执已截断）` : text;
			const lines = [`/${def.name}：${report}`];
			if (client !== "loaded") lines.push(clientNote(client));
			reportOutcome(invocation.agent, {
				summary: `/${def.name} ${result?.kind === "error" ? "失败" : "完成"}：${first.slice(0, 80)}`,
				report: lines.join("\n"),
				wake
			});
			return result;
		};
		if (input.length > 0 && !update) {
			return finish({
				kind: "error",
				text: `Usage: /${def.name} ${def.hint}\n例如：/${def.name} --update git-kit`
			});
		}
		const options = { env: process.env, signal: invocation.signal, update };
		const userQuestions = typeof ctx.get === "function" ? ctx.get("userQuestions") : undefined;
		try {
			let note;
			let unconfirmed = false;
			let choice = "all";

			// plan 只做本地廉价判定：算出要不要建作业、处理哪些技能、是否已最新。
			// 一次算清后交给 run 执行，避免 handler 与流程各判定一遍。
			const plan = await def.plan(COMMANDS, input, options);
			// `--update` 是用户显式要求更新，不打断。
			if (!yes && !update) {
				const decision = await confirmSkillOperation({
					userQuestions,
					agent: invocation.agent,
					def,
					plan,
					signal: invocation.signal
				});
				note = decision.note;
				// 有副作用但没能问成（无问答 UI / 无活 agent / 被委派）：回执首行标「未确认」。
				unconfirmed = decision.note !== undefined;
				if (decision.action === "cancel") return finish(cancelledResult(def), { wake: false });
				if (decision.choice !== undefined) choice = decision.choice;
			}

			const outcome = await runInJob({
				jobs: typeof ctx.get === "function" ? ctx.get("jobs") : undefined,
				owner: invocation.agent?.session?.id,
				kind: def.name,
				label: def.label(input, plan),
				signal: invocation.signal,
				// 无事可做时不建作业（否则头部会闪一个零输出的空作业行），见 skill-setup.js。
				skip: plan.skipReason,
				work: (reporter, registerCancel) =>
					def.run(COMMANDS, input, { ...options, plan, reporter, registerCancel, choice })
			});
			if (outcome.killed === true) {
				return finish({
					kind: "error",
					text:
						`/${def.name} 已停止（作业 ${outcome.job?.id ?? "?"}）。` +
						"未完成的步骤可在会话头部「作业」里展开查看已保留的输出。"
				});
			}
			if (outcome.error !== undefined) {
				const original = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
				throw outcome.job === undefined
					? original
					: new Error(`${original.message}\n过程：作业 ${outcome.job.id}（输出已保留，可在「作业」面板查看）`);
			}
			return finish({ kind: "success", text: formatLocalText(outcome, note, { unconfirmed, client }) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return finish({ kind: "error", text: `/${def.name} 失败：${briefError(message)}` });
		}
	};
}

export function apply(ctx) {
	ctx.effect(function* () {
		for (const def of COMMANDS) {
			yield ctx.commands.register({
				name: def.name,
				description: def.description,
				...(def.hint === undefined ? {} : { input: { hint: def.hint } }),
				// 输入已随注入的 user 消息入日志，不再让 command/run 重复记一份 args。
				recordInput: false,
				handler: makeHandler(def)
			});
		}
		for (const def of LOCAL_COMMANDS) {
			yield ctx.commands.register({
				name: def.name,
				description: def.description,
				...(def.hint === undefined ? {} : { input: { hint: def.hint } }),
				// 本地命令的输入只是可选的技能名与 flag，本身没有别的权威事件承载 payload。
				recordInput: true,
				handler: makeLocalHandler(def, ctx)
			});
		}
	}, "dsh-commands lifecycle");
}
