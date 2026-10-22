/**
 * dsh-commands —— 把由 ai-kit 提供的 git-kit / handoff 技能工作流以 dsh 原生命令方式接入（可扩展其他命令）。
 *
 * 架构（命令 = 意图表，单一真源在对应 skill）：
 * - 逻辑与「意图路由」的唯一真源是对应 skill：`skills/git-kit` 与 `skills/handoff`
 *   （各自 SKILL.md 的意图决策树 + references/ + scripts/）。本插件不复制逻辑，
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
 */

import { randomUUID } from "node:crypto";

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
		description: "pr-merge 之后的发布段：在已合并的稳定分支上打 tag → 默认创建 GitHub/GitLab Release → 跟踪其他后效并逐项校验（只打标签用 /git-tag）"
	},
	{
		name: "git-tag",
		branch: "tag",
		hint: "[tag名或分支名]",
		description: "查看最新 tag 与来源分支，选择分支与版本号，构建注记 tag 并推送到远端"
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
	}
];

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
 * 构造注入当前会话的指令：告知用户请求，并把执行交给对应 skill 的对应分支。
 * 分支的完整流程（references/ 与 scripts/）由 agent 加载 skill 后自行读取，
 * 这里不复制任何逻辑，只做意图指路。
 */
function buildInstruction(def, input) {
	const skill = def.skill ?? "git-kit";
	const lines = [
		`【dsh 命令 /${def.name}】`,
		`用户请求：${input.length > 0 ? input : "（未附加说明，按分支流程默认处理）"}`,
		"",
		`请用 skill 工具加载 ${skill}，将本次请求视为 ${def.branch} 分支并按该分支的完整流程执行。`,
		"如需用户决策（候选分支名 / PR·MR 编号 / tag 版本号 / 交接范围等），先向用户确认再继续。"
	];
	if (def.readFallback === true) {
		lines.push(
			'若 skill 工具报 "not available for model invocation"（该技能标了 disable-model-invocation，只能由用户手动调用），' +
				`改用 read 工具读取 \`$DSH_HOME/skills/${skill}/SKILL.md\`（DSH_HOME 通常为 ~/.dsh），` +
				"需要时再读同目录下的 references/。"
		);
	}
	return lines.join("\n");
}

function makeHandler(def) {
	return (invocation) => {
		const input = invocation.rawInput.trim();
		if (def.required && input.length === 0) {
			return { kind: "error", text: `Usage: /${def.name} ${def.hint}\n例如：/${def.name} 修复登录超时` };
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
		const skill = def.skill ?? "git-kit";
		return { kind: "success", text: `已按 ${skill} ${def.branch} 分支委托执行 /${def.name}，agent 将按流程继续。` };
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
	}, "dsh-commands lifecycle");
}
