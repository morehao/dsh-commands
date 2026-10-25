/**
 * `/skill-init` / `skill_init` 的确认请求与决策（P1a 过渡版）。
 *
 * - 旧命令 `/skill-init` 走 `lib/confirm.js`（薄适配，保持旧签名与旧文案）；
 * - P2 的 `skill_init` 工具直接调用 `confirmSkillPlan()`：
 *   - `yes=true` → 直接执行；
 *   - 无 `userQuestions` / 无活 agent → 返回 `{ action: "plan" }`，工具只回 plan、零写入
 *     （headless 的 B2 语义）；
 *   - 用户取消 / 问题卡被关闭 / 空选择 → `{ action: "cancel" }`。
 *
 * P1a 保持旧语义：`changed`（plan 已知的上游更新）仍计入待确认范围；P1b 再改为只读 warn。
 */

const CONTINUE_ALL = "处理全部";
const CONTINUE_MISSING = "只补缺失";
const CANCEL = "取消";
const QUESTION_ID = "confirm-skill-init";
export const PASS_THROUGH_NOTE = "确认：当前会话不支持交互确认，已直接执行。";

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

/**
 * 这次是否有需要用户确认的副作用（只有确定要写盘才算）。
 *
 * P1b：`pending`（缺失/待修复）或 `relink`（控制台管理的链修复）才算；
 * `changed` 只读 warn，不触发确认。缓存过期只触发只读检查，也不算副作用。
 */
export function needsConfirmation(plan) {
	if (plan === undefined || plan.skipReason !== undefined) return false;
	// `--update` 走强制更新分支，显式更新不打断。
	if (plan.kind === "skill-update") return false;
	if (plan.confirm !== undefined) return plan.confirm.needs === true;
	const pending = plan.pending ?? [];
	const relinks = (plan.actions ?? []).filter((action) => action.type === "relink");
	return pending.length > 0 || relinks.length > 0;
}

/** 单个技能的现状 → 用户能一眼看懂的状态与动作。 */
function stateLine(state, changed) {
	const willChange = changed.has(state.name);
	if (state.state === "managed") {
		return {
			icon: willChange ? "ℹ" : "✓",
			status: willChange ? "已安装 · 上游有更新" : "已安装",
			action: "保持不变"
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

/** 按本次 plan 生成问题、说明和选项；不依赖具体安装实现。 */
export function confirmationRequest(plan) {
	const pending = plan.pending ?? [];
	const changed = plan.freshness?.changed ?? [];
	const changedSet = new Set(changed);
	const states = plan.states ?? pending;
	const missing = pending.filter((state) => state.state === "missing");
	const blocked = pending.filter((state) => blockedState(state));
	const details = ["技能现状："];

	const shown = states.length > 0 ? states : pending;
	for (const state of shown) {
		const line = stateLine(state, changedSet);
		details.push(`${line.icon} ${state.name} — ${line.status}${line.action === "保持不变" ? "" : ` → ${line.action}`}`);
	}
	if (shown.length === 0) details.push(`将处理：${namesLine(plan.targets ?? [])}`);
	if (changed.length > 0) details.push(`上游有更新（本次不安装）：${namesLine(changed)}；要更新请运行 /skill-init --update`);
	if (blocked.length > 0) {
		details.push(`注意：${namesLine(blocked.map((state) => state.name))} 是真实目录/文件，只会保留，不会删除或覆盖。`);
	}
	if (plan.source !== undefined) details.push(`来源：${plan.source}`);
	details.push("执行过程会显示在会话头部「作业」里，可随时停止。");

	let question;
	if (pending.length > 0) question = `处理这 ${pending.length} 个技能？`;
	else question = `处理这 ${(plan.targets ?? []).length} 个技能？`;

	// 只有 pending 才会问；changed-only 已在 needsConfirmation 里短路（只 warn）。
	const options = [];
	if (pending.length > 0) {
		options.push({
			label: CONTINUE_ALL,
			description: `安装/修复全部 ${pending.length} 项${changed.length > 0 ? `（${changed.length} 个上游更新本次不动）` : ""}`
		});
		if (missing.length > 0) {
			options.push({ label: CONTINUE_MISSING, description: `只装缺失的 ${missing.length} 个，已有条目不动` });
		}
	} else {
		options.push({ label: CONTINUE_ALL, description: "处理本次计划中的技能" });
	}
	options.push({ label: CANCEL, description: "不执行任何变更" });

	return {
		header: "检查依赖技能",
		question,
		detail: details.join("\n"),
		options
	};
}

/** 选项 label → run 阶段使用的 choice；取消单独返回。 */
function choiceOf(label) {
	if (label === CANCEL) return "cancel";
	if (label === CONTINUE_MISSING) return "missing";
	if (label === CONTINUE_ALL) return "all";
	return undefined;
}

/**
 * 在副作用之前询问用户（新 API，P2 工具使用）。
 *
 * @returns {Promise<
 *   | { action: "proceed", choice?: "all" | "missing", note?: string }
 *   | { action: "cancel" }
 *   | { action: "plan", note?: string }
 * >}
 */
export async function confirmSkillPlan({
	userQuestions,
	agent,
	plan,
	signal,
	yes = false,
	detail,
	onError = "proceed"
} = {}) {
	if (yes === true) return { action: "proceed", choice: "all" };
	if (!needsConfirmation(plan)) return { action: "proceed" };
	if (!usable(userQuestions) || agent === undefined || agent === null) {
		return { action: "plan", note: "当前会话没有可用的确认通道；只返回计划，未写盘。" };
	}

	const request = confirmationRequest(plan);
	let answer;
	try {
		answer = await userQuestions.ask({
			questions: [
				{
					id: QUESTION_ID,
					header: request.header,
					question: request.question,
					detail: detail ?? request.detail,
					options: request.options
				}
			],
			agent,
			...(signal === undefined ? {} : { signal })
		});
	} catch (error) {
		const code = error?.code ?? error?.name;
		if (code === "ASK_CANCELLED" || code === "ASK_ABORTED") return { action: "cancel" };
		if (code === "NO_PROVIDER" || code === "CALLER_NOT_LIVE" || code === "DELEGATED_CALLER") {
			return { action: "plan", note: "当前会话不支持交互确认；只返回计划，未写盘。" };
		}
		// 工具默认不执行：确认通道异常时零写，让用户重试；旧命令保持 pass-through。
		if (onError === "plan") {
			return { action: "plan", note: `确认：交互不可用（${firstLine(error)}）；只返回计划，未写盘。` };
		}
		return {
			action: "proceed",
			note: `确认：交互不可用（${firstLine(error)}），已直接执行。`
		};
	}

	const item = answer?.answers?.find((entry) => entry.id === QUESTION_ID);
	const selected = item?.selected?.[0];
	const custom = item?.custom?.trim() ?? "";
	if (selected !== undefined) {
		const choice = choiceOf(selected);
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
