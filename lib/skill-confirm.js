/**
 * `/skill-init` / `skill_init` 的确认请求与决策。
 *
 * - `skill_init` 工具直接调用 `confirmSkillPlan()`：
 *   - `yes=true` → 直接执行；
 *   - 无 `userQuestions` / 无活 agent → 返回 `{ action: "plan" }`，工具只回 plan、零写入；
 *   - 用户取消 / 问题卡被关闭 / 空选择 → `{ action: "cancel" }`。
 *
 * v1.0：计划里只有 install / update 两种写动作（不再有 relink）；只补缺失 = 只保留 install。
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

/** 这次是否有需要用户确认的副作用（只有确定要写盘才算）。 */
export function needsConfirmation(plan) {
  if (plan === undefined || plan.skipReason !== undefined) return false;
  // `--update` 走强制更新分支，显式更新不打断。
  if (plan.kind === "skill-update") return false;
  if (plan.confirm !== undefined) return plan.confirm.needs === true;
  const actions = plan.actions ?? [];
  return actions.some((action) => action.type === "install" || action.type === "update");
}

/** 单个技能的现状 → 用户能一眼看懂的状态与动作。 */
function stateLine(state) {
  return state.state === "missing"
    ? { icon: "✗", status: "未安装", action: "将安装" }
    : { icon: "✓", status: "已安装", action: "保持不变" };
}

/** 按本次 plan 生成问题、说明和选项；不依赖具体安装实现。 */
export function confirmationRequest(plan) {
  const actions = plan.actions ?? [];
  const installs = actions.filter((action) => action.type === "install");
  const updates = actions.filter((action) => action.type === "update");
  const states = plan.states ?? [];
  const missing = states.filter((state) => state.state === "missing");
  const details = ["技能现状："];
  for (const state of states) {
    const line = stateLine(state);
    details.push(`${line.icon} ${state.name} — ${line.status}${line.action === "保持不变" ? "" : ` → ${line.action}`}`);
  }
  if (updates.length > 0) details.push(`将更新：${namesLine(updates.map((action) => action.name))}`);
  if (plan.source !== undefined) details.push(`来源：${plan.source}`);
  details.push("执行过程会显示在会话头部「作业」里，可随时停止。");

  const pending = installs.length + updates.length;
  const question = `处理这 ${pending} 个技能？`;
  const options = [];
  if (installs.length > 0) {
    options.push({ label: CONTINUE_ALL, description: `安装 ${installs.length} 个缺失技能${updates.length > 0 ? `、更新 ${updates.length} 个` : ""}` });
    if (missing.length > 0 && installs.length > 1) {
      options.push({ label: CONTINUE_MISSING, description: `只装缺失的 ${missing.length} 个` });
    }
  } else {
    options.push({ label: CONTINUE_ALL, description: "处理本次计划中的技能" });
  }
  options.push({ label: CANCEL, description: "不执行任何变更" });

  return { header: "检查依赖技能", question, detail: details.join("\n"), options };
}

/** 选项 label → run 阶段使用的 choice；取消单独返回。 */
function choiceOf(label) {
  if (label === CANCEL) return "cancel";
  if (label === CONTINUE_MISSING) return "missing";
  if (label === CONTINUE_ALL) return "all";
  return undefined;
}

/**
 * 在副作用之前询问用户。
 *
 * @returns {Promise<
 *   | { action: "proceed", choice?: "all" | "missing", note?: string }
 *   | { action: "cancel" }
 *   | { action: "plan", note?: string }
 * >}
 */
export async function confirmSkillPlan({ userQuestions, agent, plan, signal, yes = false, detail, onError = "proceed" } = {}) {
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
      return { action: "plan", note: "当前会话不支持交互确认；只返回计划，未写盘。" };
    }
    if (onError === "plan") {
      return { action: "plan", note: `确认：交互不可用（${firstLine(error)}）；只返回计划，未写盘。` };
    }
    return { action: "proceed", note: `确认：交互不可用（${firstLine(error)}），已直接执行。` };
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
  return { action: "cancel" };
}
