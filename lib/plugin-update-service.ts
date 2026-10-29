/**
 * `/plugin-update` 的服务层：确认与执行（P1 in-process）。
 *
 * 设计约束：
 * - 纯逻辑 + 依赖注入，不 import `@deepseek-ai/*`，便于离线冒烟。
 * - 更新走宿主 `pluginManager`（desktop/web 的 profile 均有该服务）：
 *   `installBundle` 在 HMR 下对已装包会返回 `already-installed`，此时按官方更新路径
 *   `removeBundle` → `installBundle`。注意 remove 的是**本插件自己**，会触发重载；
 *   因此调用方（工具）把它放进后台作业，并用完成通知 / 启动提示兜底。
 * - 确认走宿主 `userQuestions.ask`；无确认通道时只返回计划、零写盘。
 */

const CONFIRM_ID = "confirm-plugin-update";
const APPLY_LABEL = "更新";
const CANCEL_LABEL = "取消";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const firstLine = (error: unknown): string => messageOf(error).split("\n")[0]?.trim() ?? "";

/** 宿主 `installBundle` 结果两种形态都接：本地返回 `{application,error?}`，远程可能包一层 `{ok,value|error}`。 */
function unwrapResult(result: any): any {
  if (
    result &&
    typeof result === "object" &&
    typeof result.ok === "boolean" &&
    !("application" in result) &&
    ("value" in result || "error" in result)
  ) {
    return result.ok ? result.value : { application: "failed", error: result.error ?? { code: "operation-error" } };
  }
  return result;
}

function failureMessage(result: any): string {
  return result?.error?.diagnostic || result?.error?.message || result?.error?.code || "更新失败";
}

/** 计划里给用户/模型看的细节。 */
export function renderPlanDetail(plan: any): string {
  return [
    `当前版本：v${plan.currentVersion}`,
    `最新版本：v${plan.latestVersion}`,
    `更新方式：重装本插件并重新启用${plan.restart ? `，之后需要重启 DSH 生效` : ""}`,
    "取消不会产生任何变更。"
  ].join("\n");
}

export type ConfirmPluginAction =
  | { action: "proceed" }
  | { action: "cancel" }
  | { action: "plan"; note: string };

/** 在写盘前询问用户。 */
export async function confirmPluginUpdate({
  userQuestions,
  agent,
  plan,
  signal,
  yes = false,
}: any = {}): Promise<ConfirmPluginAction> {
  if (yes === true) return { action: "proceed" };
  if (typeof userQuestions?.ask !== "function" || agent === undefined || agent === null) {
    return { action: "plan", note: "当前会话没有可用的确认通道；只返回计划，未写盘。" };
  }
  let answer: any;
  try {
    answer = await userQuestions.ask({
      questions: [
        {
          id: CONFIRM_ID,
          header: "更新插件",
          question: `将 dsh-commands 从 v${plan.currentVersion} 更新到 v${plan.latestVersion}？`,
          detail: renderPlanDetail({ ...plan, restart: true }),
          options: [
            { label: APPLY_LABEL, description: `安装 v${plan.latestVersion}，完成后需重启 DSH 生效` },
            { label: CANCEL_LABEL, description: "不做任何变更" }
          ]
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
    return { action: "plan", note: `确认：交互不可用（${firstLine(error)}）；只返回计划，未写盘。` };
  }
  const item = answer?.answers?.find((entry: any) => entry.id === CONFIRM_ID);
  const selected = item?.selected?.[0];
  const custom = item?.custom?.trim() ?? "";
  if (selected === APPLY_LABEL) return { action: "proceed" };
  if (selected === CANCEL_LABEL) return { action: "cancel" };
  if (custom.length > 0) {
    if (/^(取消|cancel|no|n)/iu.test(custom)) return { action: "cancel" };
    if (/^(更新|继续|执行|安装|重装|yes|y|ok)/iu.test(custom)) return { action: "proceed" };
  }
  return { action: "cancel" };
}

export interface ApplyPluginUpdateOptions {
  pluginManager?: any;
  name: string;
  targetVersion: string;
  reporter?: { progress?: (line: string) => void };
}

/** 执行更新：`installBundle` →（already-installed）`removeBundle` → `installBundle`。 */
export async function applyPluginUpdate({
  pluginManager,
  name,
  targetVersion,
  reporter,
}: ApplyPluginUpdateOptions): Promise<{ application: string; restartRequired: boolean; updatedVersion: string }> {
  if (!pluginManager || typeof pluginManager.installBundle !== "function") {
    throw new Error("当前环境不支持一键更新（缺少 pluginManager.installBundle）");
  }
  const spec = `${name}@${targetVersion}`;
  reporter?.progress?.(`正在更新到 v${targetVersion}`);
  let result = unwrapResult(await pluginManager.installBundle(spec));
  if (result?.error?.code === "already-installed" && typeof pluginManager.removeBundle === "function") {
    reporter?.progress?.("移除旧版本");
    const removed = unwrapResult(await pluginManager.removeBundle(name));
    if (removed?.error || removed?.application === "failed") {
      throw new Error(`移除旧版本失败：${failureMessage(removed)}`);
    }
    reporter?.progress?.("安装新版本");
    result = unwrapResult(await pluginManager.installBundle(spec));
  }
  if (result?.error) throw new Error(String(failureMessage(result)).slice(0, 600));
  const application = result?.application;
  if (!["applied", "restart-required", "overridden"].includes(application)) {
    throw new Error(`更新未生效（application=${application ?? "unknown"}）`);
  }
  return {
    application,
    restartRequired: application !== "applied",
    updatedVersion: targetVersion
  };
}

export interface VerifyPluginUpdateOptions {
  targetVersion?: string;
  readVersion?: () => string;
}

/** 读安装副本版本，确认是否已经到目标版本。 */
export async function verifyPluginUpdate({
  targetVersion,
  readVersion,
}: VerifyPluginUpdateOptions = {}): Promise<{ installedVersion: string; ok: boolean }> {
  const installed = typeof readVersion === "function" ? readVersion() : "";
  return { installedVersion: installed, ok: installed === targetVersion };
}
