/**
 * `/plugin-update` 的委托命令：解析 flags、构造 user 消息、交给 agent 调 `plugin_update` 工具。
 *
 * 为什么改成委托（对齐 `/skill-init`）：插件自更新是一次需要确认、进度与结果的交互过程，
 * 命令面没有进度/确认通道；委托后在对话里出问答卡、后台作业与结果卡，反馈完整。
 *
 * 纯函数 + 薄 handler，不 import `@deepseek-ai/*`；无 tools / 无 agent 时由调用方传入的
 * `fallback` 回退到本地只读检查（`plugin-update.js` 的 `check()`）。
 */
import { createUserMessage } from "./skill-command.js";

export const PLUGIN_UPDATE_USAGE = "用法：/plugin-update [--apply] [--yes]（默认只检查；--apply 确认后更新）";

const FLAGS = new Set(["--apply", "--yes", "--check"]);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface ParsedPluginUpdateInput {
  error?: string;
  mode?: "check" | "apply";
  yes?: boolean;
}

/** 解析 `rawInput`：`--apply`（更新）/ `--yes`（跳过确认）/ `--check`（显式检查）。 */
export function parsePluginUpdateInput(rawInput = ""): ParsedPluginUpdateInput {
  const tokens = String(rawInput)
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const unknown = tokens.find((token) => !FLAGS.has(token));
  if (unknown !== undefined) return { error: `${PLUGIN_UPDATE_USAGE}\n未知参数：${unknown}` };
  return {
    mode: tokens.includes("--apply") ? "apply" : "check",
    yes: tokens.includes("--yes")
  };
}

/** 注入消息：第一段自然语言请求同时是标题来源。 */
export function buildPluginUpdateMessage({
  mode = "check",
  yes = false,
}: { mode?: "check" | "apply"; yes?: boolean } = {}): string {
  const intro =
    mode === "apply"
      ? "把 dsh-commands 插件自身更新到 npm 最新版（先确认，再重装；完成后需重启 DSH 生效）。"
      : "检查 dsh-commands 插件自身是否有 npm 新版本（只检查，不安装）。";
  return [
    intro,
    "",
    `【执行方式】调用 plugin_update 工具（mode=${mode}；yes=${yes === true ? "true" : "false"}）。`,
    "不要自行运行 dsh plugin / pnpm，不要直接改 node_modules，也不要直接读写 ~/.dsh。",
    "【汇报】工具返回后用 1–3 句话总结；有需要用户处理的事项列 ≤3 条下一步；不要复述工具回执。"
  ].join("\n");
}

/** 本地只读回退的渲染（与 tool-plugin-update 的 markdown 风格保持一致）。 */
export function formatCheck(result: any, { mode = "check" }: { mode?: "check" | "apply" } = {}): string {
  const name = result.packageName || "@morehao/dsh-commands";
  const manual = result.manualCommand;
  if (result.checkFailed === true) {
    return [
      "### 插件更新",
      `暂时无法获取 ${name} 的最新版本（registry 不可达或超时）。`,
      "稍后重试，或手动更新（先退出 dsh）后执行：",
      `\`${manual}\``
    ].join("\n");
  }
  if (result.updateAvailable === true) {
    const lines = ["### 插件更新", `- 当前版本：v${result.currentVersion}`, `- 最新版本：v${result.latestVersion}`, ""];
    if (mode === "apply") {
      lines.push("当前会话没有可用的交互确认通道，未更新。请手动执行（先退出 dsh）：", `\`${manual}\``);
    } else {
      lines.push("可更新（尚未安装）。要更新请运行 `/plugin-update --apply`。");
    }
    return lines.join("\n");
  }
  return ["### 插件更新", `${name} 已是最新版本 v${result.currentVersion}。`].join("\n");
}

export interface PluginUpdateHandlerOptions {
  /**
   * 本次 boot 是否注册了 `plugin_update` 工具（工具注册在命令注册之后，必须惰性读）。
   */
  toolReady?: () => boolean;
  /** 无 tools / 无 followup / 注入失败时的本地只读回退。 */
  fallback?: (parsed: ParsedPluginUpdateInput, invocation: any) => Promise<{ kind: string; text: string }>;
}

/**
 * 命令 handler。
 */
export function makePluginUpdateHandler({ toolReady, fallback }: PluginUpdateHandlerOptions = {}) {
  return async (invocation: any = {}): Promise<{ kind: string; text: string }> => {
    const parsed = parsePluginUpdateInput(invocation.rawInput ?? "");
    if (parsed.error !== undefined) return { kind: "error", text: parsed.error };

    const canDelegate = toolReady?.() === true && typeof invocation.agent?.followup === "function";
    if (!canDelegate) {
      try {
        return await fallback!(parsed, invocation);
      } catch (error) {
        return { kind: "error", text: messageOf(error) };
      }
    }

    try {
      invocation.agent.followup(createUserMessage(buildPluginUpdateMessage(parsed)));
    } catch (error) {
      try {
        return await fallback!(parsed, invocation);
      } catch (fallbackError) {
        return { kind: "error", text: `无法交给当前会话执行：${messageOf(error)}；本地回退也失败：${messageOf(fallbackError)}` };
      }
    }
    return { kind: "success", text: parsed.mode === "apply" ? "已开始更新插件" : "已开始检查插件更新" };
  };
}
