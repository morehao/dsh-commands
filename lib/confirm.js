/**
 * `/skill-init`、`/skill-install` 的交互确认：在真正产生副作用之前，用
 * dsh 的 `ctx.userQuestions` 把「将要做什么」摊给用户，让用户选「处理全部 / 只补缺失 / 取消」。
 *
 * 为什么放在命令 handler 里而不是交给 agent：
 * - 安装/更新必须保持确定性，不能交给模型自由发挥；
 * - `ctx.userQuestions` 是 UI 侧的问答通道，不触发模型回合，适合这种「确认后直接执行」。
 *
 * 约束：
 * - 只有 `plan` 判定确实有变更（或需要联网检查）时才问；无事可做直接出结论。
 * - `/skill-update` 是用户显式要求更新，不问；`--yes` 由 handler 解析后完全跳过确认。
 * - 没有 userQuestions、没有活 agent、或被委派到子 agent 时**不能阻塞命令**：降级为直接执行，
 *   并在回执里留一行说明。`ASK_CANCELLED` 才是用户真的取消。
 */

import { resolveSkillSource } from "./skill-setup.js";

const CONTINUE_ALL = "处理全部";
const CONTINUE_MISSING = "只补缺失";
const INSTALL_ALL = "全部安装";
const INSTALL_NAMED = "安装";
const UPDATE_ALL = "更新";
const CHECK_UPSTREAM = "联网检查";
const CANCEL = "取消";
const DEFAULT_SOURCE = "使用默认来源";
const PASS_THROUGH_NOTE = "确认：当前会话不支持交互确认，已直接执行。";

const usable = (userQuestions) => typeof userQuestions?.ask === "function";

const firstLine = (error) => {
	const message = error instanceof Error ? error.message : String(error);
	return message.split("\n")[0]?.trim() ?? "";
};

/** 把名称列表压成一行；太长时只报数量，避免问题卡被撑爆。 */
function namesLine(names, max = 8) {
	if (names.length <= max) return names.join("、");
	return `${names.slice(0, max).join("、")} 等 ${names.length} 个`;
}

/** 真实目录/文件不可替换；只有软链（含非托管软链）才能被 linkSkill 替换。 */
const replaceable = (state) => state.isSymlink || state.state === "missing";
const blockedState = (state) => !replaceable(state);

/** 该命令这次是否有需要用户确认的副作用。 */
export function needsConfirmation(def, plan) {
	if (plan === undefined || plan.skipReason !== undefined) return false;
	if (def.name === "skill-update") return false;
	if (def.name !== "skill-init" && def.name !== "skill-install") return false;
	if (def.name === "skill-install") {
		if (plan.source === undefined) return false;
		// 装「整个来源」是明显的大动作，先问一次。
		if ((plan.requested?.length ?? 0) === 0) return true;
	}
	const pending = plan.pending ?? [];
	const changed = plan.freshness?.changed ?? [];
	const cacheCheck = plan.freshness?.cacheSource === true && plan.freshness?.fresh !== true;
	// 真实目录/文件虽然不会替换链接，但来源仍会被装进 canonical，仍是副作用，所以同样确认。
	return pending.length > 0 || changed.length > 0 || cacheCheck;
}

/** 单个技能的现状 → 用户能一眼看懂的状态与动作。 */
function stateLine(state, changed) {
	const willChange = changed.has(state.name);
	if (state.state === "managed") {
		return {
			icon: willChange ? "↻" : "✓",
			status: willChange ? "已安装 · 上游有更新" : "已安装",
			action: willChange ? "将重装" : "保持不变",
		};
	}
	if (state.state === "missing") {
		return { icon: "✗", status: "未安装", action: "将安装" };
	}
	if (state.isDirectory === true) {
		return { icon: "!", status: "真实目录", action: "保留，不链入" };
	}
	if (state.isSymlink === true) {
		return { icon: "↻", status: "非托管软链", action: "将重建" };
	}
	return { icon: "!", status: "已存在文件", action: "保留，不链入" };
}

/** 按命令生成问题、说明和选项；不依赖具体安装实现。 */
export function confirmationRequest(def, plan) {
	const pending = plan.pending ?? [];
	const changed = plan.freshness?.changed ?? [];
	const changedSet = new Set(changed);
	const states = plan.states ?? pending;
	const missing = pending.filter((state) => state.state === "missing");
	const blocked = pending.filter((state) => blockedState(state));
	const cacheCheck = plan.freshness?.cacheSource === true && plan.freshness?.fresh !== true;
	const installAll = def.name === "skill-install" && (plan.requested?.length ?? 0) === 0;
	const requested = plan.requested ?? [];
	const details = [];

	if (installAll) {
		details.push(`来源：${plan.source}`);
		details.push("将安装该来源发现的所有技能，并链入 dsh 技能目录。");
	} else {
		details.push("技能现状：");
		const shown = states.length > 0 ? states : pending;
		for (const state of shown) {
			const line = stateLine(state, changedSet);
			details.push(`${line.icon} ${state.name} — ${line.status}${line.action === "保持不变" ? "" : ` → ${line.action}`}`);
		}
		if (shown.length === 0) details.push(`将处理：${namesLine(plan.targets ?? [])}`);
		if (changed.length > 0) details.push(`上游有更新：${namesLine(changed)}`);
		if (blocked.length > 0) {
			details.push(`注意：${namesLine(blocked.map((state) => state.name))} 是真实目录/文件，只会保留，不会删除或覆盖。`);
		}
		if (plan.source !== undefined) details.push(`来源：${plan.source}`);
	}
	if (cacheCheck && !installAll) {
		details.push("上游缓存已过期；选「处理全部」会联网检查，选「只补缺失」只装缺失项。");
	}
	details.push("执行过程会显示在命令卡和会话头部「作业」里，可随时停止。");

	let question;
	if (installAll) {
		question = `安装来源「${plan.source}」的全部技能？`;
	} else if (def.name === "skill-init") {
		if (pending.length > 0) question = `处理这 ${pending.length} 个技能？`;
		else if (changed.length > 0) question = `上游有 ${changed.length} 个技能更新，重装？`;
		else if (cacheCheck) question = "上游缓存已过期，联网检查？";
		else question = `处理这 ${(plan.targets ?? []).length} 个技能？`;
	} else if (def.name === "skill-install") {
		question = `安装这 ${requested.length} 个技能？`;
	} else {
		question = `更新这 ${(plan.targets ?? []).length} 个技能？`;
	}

	const options = [];
	if (installAll) {
		options.push({ label: INSTALL_ALL, description: "安装来源发现的所有技能，并链入 dsh" });
		if (plan.freshness?.cacheSource === true) {
			options.push({ label: CONTINUE_MISSING, description: "先列出来源技能，只装 dsh 里还没有的" });
		}
	} else if (def.name === "skill-init" && pending.length > 0) {
		options.push({
			label: CONTINUE_ALL,
			description: `安装/修复全部 ${pending.length} 项${changed.length > 0 ? `，并重装 ${changed.length} 个有更新的` : ""}`,
		});
		if (missing.length > 0) {
			options.push({ label: CONTINUE_MISSING, description: `只装缺失的 ${missing.length} 个，已有条目不动` });
		}
	} else if (def.name === "skill-init" && changed.length > 0) {
		options.push({ label: CONTINUE_ALL, description: `重装 ${changed.length} 个有更新的技能` });
	} else if (def.name === "skill-init" && cacheCheck) {
		options.push({ label: CHECK_UPSTREAM, description: "联网检查；没有变化就不重装" });
	} else if (def.name === "skill-install") {
		options.push({ label: INSTALL_NAMED, description: "缺失的安装；已托管的检查上游后按需重装" });
	} else {
		options.push({ label: UPDATE_ALL, description: "强制检查上游并重装" });
	}
	options.push({ label: CANCEL, description: "不执行任何变更" });

	return {
		header: installAll ? "安装技能" : def.name === "skill-init" ? "检查依赖技能" : def.name === "skill-update" ? "更新技能" : "安装技能",
		question,
		detail: details.join("\n"),
		options,
	};
}

/** 选项 label → run 阶段使用的 choice；取消单独返回。 */
function choiceOf(def, label) {
	if (label === CANCEL) return "cancel";
	if (label === CONTINUE_MISSING) return "missing";
	if (
		label === CONTINUE_ALL ||
		label === INSTALL_ALL ||
		label === INSTALL_NAMED ||
		label === UPDATE_ALL ||
		label === CHECK_UPSTREAM
	) {
		return "all";
	}
	return undefined;
}

/**
 * 在副作用之前询问用户。
 *
 * @returns {{action: "proceed"|"cancel", choice?: "all"|"missing", note?: string}}
 */
export async function confirmSkillOperation({ userQuestions, agent, def, plan, signal }) {
	if (!needsConfirmation(def, plan)) return { action: "proceed" };
	if (!usable(userQuestions) || agent === undefined || agent === null) {
		return { action: "proceed", note: PASS_THROUGH_NOTE };
	}

	const request = confirmationRequest(def, plan);
	let answer;
	try {
		answer = await userQuestions.ask({
			questions: [
				{
					id: "confirm-skill-operation",
					header: request.header,
					question: request.question,
					detail: request.detail,
					options: request.options,
				},
			],
			agent,
			...(signal === undefined ? {} : { signal }),
		});
	} catch (error) {
		const code = error?.code ?? error?.name;
		if (code === "ASK_CANCELLED" || code === "ASK_ABORTED") return { action: "cancel" };
		if (code === "NO_PROVIDER" || code === "CALLER_NOT_LIVE" || code === "DELEGATED_CALLER") {
			return { action: "proceed", note: PASS_THROUGH_NOTE };
		}
		return {
			action: "proceed",
			note: `确认：交互不可用（${firstLine(error)}），已直接执行。`,
		};
	}

	const item = answer?.answers?.find((entry) => entry.id === "confirm-skill-operation");
	const selected = item?.selected?.[0];
	const custom = item?.custom?.trim() ?? "";
	if (selected !== undefined) {
		const choice = choiceOf(def, selected);
		if (choice === "cancel") return { action: "cancel" };
		if (choice !== undefined) return { action: "proceed", choice };
	}
	if (custom.length > 0) {
		if (/^(取消|cancel|no|n)/iu.test(custom)) return { action: "cancel" };
		if (/(缺失|missing|只补)/iu.test(custom)) return { action: "proceed", choice: "missing" };
		if (/^(继续|执行|处理|全部|安装|重装|更新|联网|yes|y|ok)/iu.test(custom)) {
			return { action: "proceed", choice: "all" };
		}
		return { action: "cancel" };
	}
	// 跳过/关闭问题卡按取消处理：没有明确同意就不产生副作用。
	return { action: "cancel" };
}

/**
 * `/skill-install` 没有来源时，先问来源。
 *
 * @returns {{action: "proceed"|"cancel", source?: string, note?: string}}
 */
export async function askInstallSource({ userQuestions, agent, signal, env = process.env }) {
	const defaultSource = resolveSkillSource(env);
	if (!usable(userQuestions) || agent === undefined || agent === null) {
		// 保持旧行为：交给 runSkillInstall 报「缺少来源」并给用法示例。
		return { action: "proceed", note: PASS_THROUGH_NOTE };
	}

	let answer;
	try {
		answer = await userQuestions.ask({
			questions: [
				{
					id: "skill-install-source",
					header: "安装来源",
					question: "要安装哪个来源的技能？",
					detail:
						`可直接输入 owner/repo、git URL 或本地路径；留空/取消不会安装。\n` +
						`默认来源来自 DSH_COMMANDS_SKILL_SOURCE：${defaultSource}`,
					options: [
						{ label: DEFAULT_SOURCE, description: defaultSource },
						{ label: CANCEL, description: "不安装任何技能" },
					],
				},
			],
			agent,
			...(signal === undefined ? {} : { signal }),
		});
	} catch (error) {
		const code = error?.code ?? error?.name;
		if (code === "ASK_CANCELLED" || code === "ASK_ABORTED") return { action: "cancel" };
		if (code === "NO_PROVIDER" || code === "CALLER_NOT_LIVE" || code === "DELEGATED_CALLER") {
			return { action: "proceed", note: PASS_THROUGH_NOTE };
		}
		return {
			action: "proceed",
			note: `确认：交互不可用（${firstLine(error)}），已按原参数继续。`,
		};
	}

	const item = answer?.answers?.find((entry) => entry.id === "skill-install-source");
	const selected = item?.selected?.[0];
	const custom = item?.custom?.trim() ?? "";
	if (custom.length > 0) return { action: "proceed", source: custom };
	if (selected === DEFAULT_SOURCE) return { action: "proceed", source: defaultSource };
	if (selected === CANCEL) return { action: "cancel" };
	return { action: "cancel" };
}
