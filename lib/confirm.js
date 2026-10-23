/**
 * `/skill-init`、`/skill-install` 的交互确认：在真正产生副作用之前，用
 * dsh 的 `ctx.userQuestions` 把「将要做什么」摊给用户，让用户选「继续执行 / 取消」。
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

const CONTINUE = "继续执行";
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

/** 生成一条可读的确认问题；不依赖具体命令的安装实现。 */
export function confirmationRequest(def, plan) {
	const pending = plan.pending ?? [];
	const pendingNames = pending.map((state) => state.name);
	const changed = plan.freshness?.changed ?? [];
	const cacheCheck = plan.freshness?.cacheSource === true && plan.freshness?.fresh !== true;
	const blocked = pending.filter((state) => blockedState(state));
	const installAll = def.name === "skill-install" && (plan.requested?.length ?? 0) === 0;
	const details = [];

	if (installAll) {
		details.push(`来源：${plan.source}`);
		details.push("将安装该来源发现的所有技能，并链入 dsh");
	} else {
		if (pendingNames.length > 0) details.push(`将安装/修复：${namesLine(pendingNames)}`);
		if (changed.length > 0) details.push(`上游有变化，将重装：${namesLine(changed)}`);
		if (pendingNames.length === 0 && changed.length === 0 && cacheCheck) {
			details.push(`上游缓存已过期，将联网检查：${namesLine(plan.targets ?? [])}`);
		}
		if (blocked.length > 0) {
			details.push(
				`其中 ${namesLine(blocked.map((state) => state.name))} 是真实目录/文件：只会跳过链入、不会删除；来源仍会安装到 canonical`,
			);
		}
		if (plan.source !== undefined) details.push(`来源：${plan.source}`);
		if (details.length === 0) details.push(`将检查并处理：${namesLine(plan.targets ?? [])}`);
	}

	const action = installAll
		? `安装来源 ${plan.source} 发现的所有技能，并软链进 dsh`
		: "执行上述技能维护操作";
	return {
		header: "确认技能操作",
		question: `${action}，继续执行？`,
		detail: `${details.join("\n")}\n执行过程会显示在会话头部的「作业」里，可随时停止。`,
		options: [
			{ label: CONTINUE, description: "在后台作业中执行，可随时停止" },
			{ label: CANCEL, description: "不执行任何变更" },
		],
	};
}

/**
 * 在副作用之前询问用户。
 *
 * @returns {{action: "proceed"|"cancel", note?: string}}
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
	if (selected === CANCEL) return { action: "cancel" };
	if (selected === CONTINUE) return { action: "proceed" };
	if (/^(继续|执行|yes|y|ok)/iu.test(custom)) return { action: "proceed" };
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
