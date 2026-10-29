/**
 * `/plugin-update` 的命令 handler：只做**只读检查**，不做一键安装。
 *
 * 为什么不一键更新：命令 handler 把结算文本写进 `command/done`；若在 handler 里
 * `removeBundle` 掉插件自己，插件会被卸载/重载，命令卡可能来不及落、当前回合也可能被打断。
 * 本版本先只给「当前版本 / 最新版本 / 手动命令」，把写盘与重载交给用户在 dsh 外执行。
 *
 * 本文件是纯函数 + 薄 handler，不 import 任何 `@deepseek-ai/*`；`pluginManager` /
 * `profileContext` 都由 `lib/index.js` 用惰性闭包注入，缺能力时自然降级。
 */

export const PLUGIN_UPDATE_USAGE = "用法：/plugin-update（检查是否有新版本；本版本不自动安装）";

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/** 解析 `rawInput`：当前只接受空参数；`--apply` 是预留 flag（只回手动命令）。 */
export function parsePluginUpdateInput(rawInput = "") {
	const tokens = String(rawInput)
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return { mode: "check" };
	const unknown = tokens.find((token) => token !== "--apply");
	if (unknown !== undefined) return { error: `${PLUGIN_UPDATE_USAGE}\n未知参数：${unknown}` };
	return { mode: "apply" };
}

/** 把 `check()` 的结构化结果渲染成命令卡文本。 */
export function formatCheck(result, { mode = "check" } = {}) {
	const name = result.packageName || "@morehao/dsh-commands";
	const manual = result.manualCommand;
	const hint = "本命令只做检查，不自动安装。手动更新（先退出 dsh）后执行：";
	if (result.checkFailed === true) {
		return [
			`无法获取 ${name} 的最新版本（registry 不可达或超时）。`,
			"稍后重试，或直接手动更新（先退出 dsh）后执行：",
			`  ${manual}`
		].join("\n");
	}
	if (result.updateAvailable === true) {
		const lines = [`发现新版本：v${result.currentVersion} → v${result.latestVersion}`, hint, `  ${manual}`];
		if (mode === "apply") lines.push("（当前版本不带一键安装，请按上面的命令手动执行。）");
		return lines.join("\n");
	}
	return [`${name} 已是最新版本 v${result.currentVersion}。`].join("\n");
}

/**
 * 命令 handler。
 *
 * `getUpdater()` 返回 `createPluginUpdater()` 的实例（惰性取，避免注册时就读服务）。
 */
export function makePluginUpdateHandler({ getUpdater } = {}) {
	return async (invocation = {}) => {
		const parsed = parsePluginUpdateInput(invocation.rawInput ?? "");
		if (parsed.error !== undefined) return { kind: "error", text: parsed.error };
		try {
			const updater = getUpdater();
			const result = await updater.check();
			return { kind: "success", text: formatCheck(result, { mode: parsed.mode }) };
		} catch (error) {
			return { kind: "error", text: `检查更新失败：${messageOf(error)}` };
		}
	};
}
