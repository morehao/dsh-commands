/**
 * `/skill-init` 的旧确认入口（过渡适配器）。
 *
 * 真正的确认逻辑已移到 `lib/skill-confirm.js`（P2 的 `skill_init` 工具直接调用新 API）。
 * 这里只保留旧签名，供 `lib/index.js` 与既有 smoke 使用；P3b 删除本文件。
 */
import {
	PASS_THROUGH_NOTE,
	confirmSkillPlan,
	confirmationRequest as buildConfirmationRequest,
	needsConfirmation as planNeedsConfirmation
} from "./skill-confirm.js";

/** 该命令这次是否有需要用户确认的副作用（旧签名：带 `def`）。 */
export function needsConfirmation(def, plan) {
	if (def?.name !== "skill-init") return false;
	return planNeedsConfirmation(plan);
}

/** 按本次 plan 生成问题、说明和选项（旧签名：带 `def`，实现不依赖它）。 */
export function confirmationRequest(def, plan) {
	return buildConfirmationRequest(plan);
}

/**
 * 在副作用之前询问用户（旧签名）。
 *
 * 新 API 的 `{ action: "plan" }`（无问答通道）映射回旧行为：直接执行并留一行说明；
 * 真正取消（`ASK_CANCELLED`/空选择）仍是 `action: "cancel"`。
 *
 * @returns {{action: "proceed"|"cancel", choice?: "all"|"missing", note?: string}}
 */
export async function confirmSkillOperation({ userQuestions, agent, def, plan, signal }) {
	if (!needsConfirmation(def, plan)) return { action: "proceed" };
	const decision = await confirmSkillPlan({ userQuestions, agent, plan, signal });
	if (decision.action === "plan") {
		return { action: "proceed", note: decision.note ?? PASS_THROUGH_NOTE };
	}
	return decision.action === "cancel" ? { action: "cancel" } : { action: "proceed", choice: decision.choice, note: decision.note };
}
