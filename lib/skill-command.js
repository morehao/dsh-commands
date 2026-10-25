/**
 * `/skill-init` 的委托命令：解析 flags、构造 user 消息、交给 agent 调 `skill_init`。
 *
 * 为什么改成委托：技能维护是一次多步、可对话的过程（确认、进度、停止、上游提示），
 * dsh 的命令面没有进度通道，本地 handler 只能把过程塞进作业面板 + 自绘卡；委托后
 * 工具结果是普通对话内容，确认卡/job/停止都由宿主原生提供（设计 C1）。
 *
 * 本文件是纯函数 + 薄 handler，不 import `@deepseek-ai/*`；无 tools / 无 agent 时由
 * 调用方传入的 `fallback` 回执行核心，保证旧宿主不丢功能。
 */
import { randomUUID } from "node:crypto";

export const SKILL_INIT_USAGE = "用法：/skill-init [--update [技能名...]] [--yes]";

const FLAGS = new Set(["--update", "--yes"]);

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/** 解析 `rawInput`：`--update` / `--yes` / 技能名；其余一律用法错误。 */
export function parseSkillInitInput(rawInput = "") {
	const tokens = String(rawInput)
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	const unknownFlag = tokens.find((token) => token.startsWith("-") && !FLAGS.has(token));
	if (unknownFlag !== undefined) return { error: `${SKILL_INIT_USAGE}\n未知参数：${unknownFlag}` };

	const update = tokens.includes("--update");
	const yes = tokens.includes("--yes");
	const names = tokens.filter((token) => !FLAGS.has(token));
	if (names.length > 0 && !update) {
		// init 不接受位置参数：/skill-init git-kit 会被误读成「只装 git-kit」，保持旧契约。
		return { error: `${SKILL_INIT_USAGE}\n只有 --update 接受技能名；init 会检查全部依赖。` };
	}
	return { mode: update ? "update" : "init", update, yes, names };
}

/** 注入消息：第一段自然语言请求同时是标题来源。 */
export function buildSkillInitMessage({ mode = "init", names = [], yes = false } = {}) {
	const target = names.length > 0 ? names.join("、") : "全部依赖技能";
	const intro =
		mode === "update"
			? `把本插件依赖的技能（${target}）更新到上游最新（显式更新，不再确认）。`
			: "检查本插件依赖的技能（git-kit、handoff、disk-cleanup）：缺失的安装、链缺失的修复、契约校验。";
	const argumentsText = [
		`mode=${mode}`,
		`names=${names.length > 0 ? `[${names.join(", ")}]` : "[]"}`,
		`yes=${yes === true ? "true" : "false"}`
	].join("；");
	return [
		intro,
		"",
		`【执行方式】调用 skill_init 工具（${argumentsText}）。`,
		"不要自行运行 skills CLI，不要直接读写 ~/.agents、~/.dsh 或控制台 state。",
		"【汇报】工具返回后用 1–3 句话总结；有需要用户处理的事项列 ≤3 条下一步；不要复述工具回执。"
	].join("\n");
}

/** 与官方 `createUserMessage` 契约一致（source 必填，全深冻结）。 */
export function createUserMessage(text) {
	const value = String(text);
	if (value.length === 0) throw new Error("createUserMessage() 需要非空文本");
	return Object.freeze({
		role: "user",
		source: Object.freeze({ kind: "user" }),
		content: Object.freeze([Object.freeze({ type: "text", text: value })]),
		id: randomUUID()
	});
}

/**
 * 命令 handler。
 *
 * - `toolReady()`：本次 boot 是否真的注册了 `skill_init`（工具注册在命令注册之后完成，必须惰性读）。
 * - `fallback(parsed, invocation)`：无 tools / 无 followup / followup 抛错时的本地回退。
 */
export function makeSkillInitHandler({ def, toolReady, fallback } = {}) {
	return async (invocation = {}) => {
		const parsed = parseSkillInitInput(invocation.rawInput ?? "");
		if (parsed.error !== undefined) return { kind: "error", text: parsed.error };

		const canDelegate = toolReady?.() === true && typeof invocation.agent?.followup === "function";
		if (!canDelegate) {
			try {
				return await fallback(parsed, invocation);
			} catch (error) {
				return { kind: "error", text: messageOf(error) };
			}
		}

		try {
			invocation.agent.followup(createUserMessage(buildSkillInitMessage(parsed)));
		} catch (error) {
			// 注入失败（会话已关闭等）：不留半条消息，回退本地执行。
			try {
				return await fallback(parsed, invocation);
			} catch (fallbackError) {
				return {
					kind: "error",
					text: `无法交给当前会话执行：${messageOf(error)}；本地回退也失败：${messageOf(fallbackError)}`
				};
			}
		}
		const label = parsed.mode === "update" ? "更新依赖技能" : "检查依赖技能";
		return { kind: "success", text: `已开始${label}` };
	};
}
