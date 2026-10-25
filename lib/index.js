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
 * - 维护型委托（/skill-init）：注入一条 user 消息让 agent 调用 `skill_init` 工具；工具内部走
 *   observe → plan → confirm → apply → verify，进度/停止/确认都由 dsh 原生提供。依赖的技能集合
 *   仍从 COMMANDS 推导，不维护第二份清单。无 tools / 无 agent 时回退到 `runSkillInit` /
 *   `runSkillUpdate`（skill-setup.js），保证旧宿主不丢功能。
 *
 * 任意来源的技能安装不在命令面：dsh 会扫 `~/.agents/skills`，`npx skills add … -g -a universal -y`
 * 就够了，交给用户或 agent 直接执行（见 README）。插件只负责自己依赖的三个技能。
 */

import { access } from "node:fs/promises";
import { join } from "node:path";

import { skillPaths } from "./skill-paths.js";
import { referencedSkills, resolveSkillSource, runSkillInit, runSkillUpdate } from "./skill-setup.js";
import { createSkillInitTool } from "./tool-skill-init.js";
import { createUserMessage as userMessage, makeSkillInitHandler } from "./skill-command.js";

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
 * 维护型委托：`/skill-init` 自己就是安装器，handler 只解析参数并把请求交给 `skill_init` 工具。
 * 依赖集合从 COMMANDS 推导（`skill ?? "git-kit"` 去重），增删委托型命令后自动跟进。
 */
const SKILL_INIT_DEF = Object.freeze({
	name: "skill-init",
	hint: "[--update [技能名...]] [--yes]",
	description:
		"检查并安装插件依赖的技能（git-kit、handoff、disk-cleanup）；缺失的安装、链缺失的修复、契约校验；init 有写盘时先确认（--yes 跳过），--update 为显式更新"
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

export async function apply(ctx) {
	// 工具注册在命令注册之后完成；handler 必须是惰性判断，否则启动时永远读到 false。
	let toolReady = false;
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
	const skillInitDef = SKILL_INIT_DEF;

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
		// 维护型委托：/skill-init 自己就是安装器，不再做技能预检，也不在本地执行。
		yield ctx.commands.register({
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
	}, "dsh-commands lifecycle");

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
}
