/**
 * `plugin_update` 工具：把 /plugin-update 的检查 / 确认 / 更新包装成一次 dsh 工具调用。
 *
 * 与 `/skill-init` 同构：命令注入 user 消息 → agent 调本工具；工具内 observe → plan →
 * confirm → apply(挂 ctx.jobs) → verify，返回 markdown，agent 用 1–3 句话总结。
 *
 * 纯定义：不 import `@deepseek-ai/*`；所有服务在 `execute` 时经 `services` 惰性取出
 * （P0 实测 `ctx.get("userQuestions")` 在 apply 阶段可能尚未可用）。
 */
import { runInJob } from "./job-progress.js";
import {
	PLUGIN_META,
	createPluginUpdater,
	readInstalledVersion,
	readPluginState,
	writePluginState
} from "./plugin-update.js";
import { applyPluginUpdate, confirmPluginUpdate, renderPlanDetail, verifyPluginUpdate } from "./plugin-update-service.js";

const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const firstLine = (error) => messageOf(error).split("\n")[0]?.trim() ?? "";
const dedupe = (items) => [...new Set(items.filter((item) => typeof item === "string" && item.length > 0))];

function makeResult({ mode, status, summary, currentVersion, latestVersion, updatedVersion, restartRequired, warnings, next, markdown }) {
	return {
		mode,
		status,
		summary,
		currentVersion: currentVersion ?? null,
		latestVersion: latestVersion ?? null,
		...(updatedVersion === undefined ? {} : { updatedVersion }),
		...(restartRequired === undefined ? {} : { restartRequired }),
		warnings: dedupe(warnings ?? []),
		next: dedupe(next ?? []),
		markdown: markdown ?? summary
	};
}

/**
 * @param {object} options
 * @param {Record<string, any>} [options.services]  `{ pluginManager, userQuestions, jobs, profileContext }`，值可为函数（惰性）
 * @param {typeof runInJob} [options.runJob] 测试注入
 * @param {typeof createPluginUpdater} [options.createUpdater] 测试注入
 * @param {() => string} [options.readVersion] 测试注入
 * @param {Record<string, string>} [options.env] 测试注入（state 路径）
 */
export function createPluginUpdateTool({
	services = {},
	runJob = runInJob,
	createUpdater = createPluginUpdater,
	readVersion = readInstalledVersion,
	env = process.env
} = {}) {
	const serviceOf = (name) => {
		const value = services?.[name];
		return typeof value === "function" ? value() : value;
	};
	const profileName = () => {
		const profile = serviceOf("profileContext");
		return typeof profile?.name === "string" ? profile.name : null;
	};

	const tool = {
		name: "plugin_update",
		description:
			"检查并更新 dsh-commands 插件自身到 npm 最新版。默认只检查；apply 会先确认再更新，更新后需重启 DSH 生效。由 /plugin-update 触发。",
		parameters: {
			mode: {
				type: "string",
				enum: ["check", "apply"],
				description: "check=只检查（默认）；apply=检查并在确认后更新"
			},
			yes: {
				type: "boolean",
				description: "仅在用户明确同意跳过确认时传 true（对应 /plugin-update --yes）；不要自行推断"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					mode: { type: "string", required: true },
					status: { type: "string", required: true },
					summary: { type: "string", required: true },
					markdown: { type: "string", required: true },
					currentVersion: { type: "string" },
					latestVersion: { type: "string" },
					updatedVersion: { type: "string" },
					restartRequired: { type: "boolean" },
					warnings: { type: "array", items: { type: "string" } },
					next: { type: "array", items: { type: "string" } }
				}
			},
			render: (_args, value) => [{ type: "text", text: typeof value?.markdown === "string" ? value.markdown : "" }]
		},
		async execute(args = {}, exec = {}) {
			const mode = args?.mode === "apply" ? "apply" : "check";
			const yes = args?.yes === true;
			try {
				const pluginManager = serviceOf("pluginManager");
				const updater = createUpdater({
					getPluginManager: () => pluginManager,
					getProfileName: profileName
				});
				const observed = await updater.check();
				const base = { currentVersion: observed.currentVersion, latestVersion: observed.latestVersion };

				if (observed.checkFailed === true) {
					return makeResult({
						mode,
						status: "attention",
						...base,
						summary: "暂时无法获取最新版本",
						markdown: [
							"### 插件更新",
							"暂时无法获取最新版本（registry 不可达或超时）。",
							"稍后重试，或手动更新（退出 dsh 后执行）：",
							`\`${observed.manualCommand}\``
						].join("\n"),
						next: [`手动更新：${observed.manualCommand}`]
					});
				}

				if (observed.updateAvailable !== true) {
					return makeResult({
						mode,
						status: "ok",
						...base,
						summary: `已是最新版本 v${observed.currentVersion}`,
						markdown: `### 插件更新\n已是最新版本 **v${observed.currentVersion}**。`
					});
				}

				const plan = { ...base, manualCommand: observed.manualCommand };
				if (mode === "check") {
					return makeResult({
						mode,
						status: "available",
						...base,
						summary: `有新版本 v${observed.latestVersion}`,
						markdown: [
							"### 插件更新",
							`- 当前版本：v${observed.currentVersion}`,
							`- 最新版本：v${observed.latestVersion}`,
							"",
							"可更新（尚未安装）。要更新请运行 `/plugin-update --apply`，或在对话中确认更新。"
						].join("\n"),
						next: ["运行 /plugin-update --apply 更新"]
					});
				}

				if (!pluginManager || typeof pluginManager.installBundle !== "function") {
					return makeResult({
						mode,
						status: "blocked",
						...base,
						summary: "当前环境不支持一键更新",
						markdown: [
							"### 插件更新",
							`当前环境不支持一键更新。请手动执行（先退出 dsh）：`,
							`\`${observed.manualCommand}\``
						].join("\n"),
						next: [`手动更新：${observed.manualCommand}`]
					});
				}

				const confirm = await confirmPluginUpdate({
					userQuestions: serviceOf("userQuestions"),
					agent: exec.agent,
					plan,
					signal: exec.signal,
					yes
				});
				if (confirm.action === "cancel") {
					return makeResult({
						mode,
						status: "cancelled",
						...base,
						summary: "已取消，未做任何变更",
						markdown: "### 插件更新\n已取消，未做任何变更。"
					});
				}
				if (confirm.action === "plan") {
					return makeResult({
						mode,
						status: "attention",
						...base,
						summary: "需要确认，未写盘",
						markdown: ["### 插件更新", confirm.note ?? "需要确认，未写盘。", "", renderPlanDetail(plan)].join("\n"),
						next: ["在支持交互确认的会话中重试，或用户明确同意后传 yes=true"]
					});
				}

				const outcome = await runJob({
					jobs: serviceOf("jobs"),
					owner: exec.agent?.session?.id,
					kind: "plugin-update",
					label: `更新插件到 v${observed.latestVersion}`,
					signal: exec.signal,
					work: async (reporter) => {
						const applied = await applyPluginUpdate({
							pluginManager,
							name: observed.packageName || PLUGIN_META.name,
							targetVersion: observed.latestVersion,
							reporter
						});
						const verification = await verifyPluginUpdate({ targetVersion: observed.latestVersion, readVersion });
						return { ...applied, ...verification };
					}
				});

				if (outcome.killed === true) {
					return makeResult({
						mode,
						status: "cancelled",
						...base,
						summary: "已停止，未继续",
						markdown: "### 插件更新\n已停止，未继续。"
					});
				}
				if (outcome.error !== undefined) {
					const tail = typeof outcome.outputTail === "string" ? outcome.outputTail.trim().slice(-800) : "";
					return makeResult({
						mode,
						status: "error",
						...base,
						summary: `更新失败：${firstLine(outcome.error)}`,
						markdown: [
							"### 插件更新",
							`❌ 更新失败：${firstLine(outcome.error)}`,
							tail.length > 0 ? `最后输出：${tail}` : "",
							`手动更新：\`${observed.manualCommand}\``
						]
							.filter(Boolean)
							.join("\n"),
						next: [`手动更新：${observed.manualCommand}`]
					});
				}

				const value = outcome.value ?? {};
				// 为「重启后提示」留痕：当前运行版本仍是旧版，重启后新代码会比对到差异。
				await writePluginState(env, {
					...(await readPluginState(env)),
					lastSeenVersion: observed.currentVersion,
					pendingVersion: observed.latestVersion
				});

				const warnings = [];
				if (outcome.fallbackReason !== undefined) warnings.push(`未启用后台作业：${outcome.fallbackReason}`);
				if (value.ok !== true) warnings.push(`校验：安装副本版本为 v${value.installedVersion || "未知"}，未到 v${observed.latestVersion}`);
				const appliedOk = value.ok === true;
				return makeResult({
					mode,
					status: appliedOk ? "updated" : "attention",
					...base,
					updatedVersion: value.installedVersion || observed.latestVersion,
					restartRequired: value.restartRequired === true,
					summary: appliedOk ? `已更新到 v${observed.latestVersion}，重启 DSH 生效` : "已执行更新，但版本校验未通过",
					markdown: [
						"### 插件更新",
						appliedOk
							? `✅ 已更新到 **v${observed.latestVersion}**（安装副本 v${value.installedVersion || observed.latestVersion}）。`
							: `⚠ 已执行更新，但安装副本版本为 v${value.installedVersion || "未知"}，请重启后确认。`,
						value.restartRequired === false ? "已热生效（无需重启）。" : "**请重启 DSH 使新版本生效。**"
					].join("\n"),
					warnings,
					next: value.restartRequired === false ? [] : ["重启 DSH 生效"]
				});
			} catch (error) {
				return makeResult({
					mode,
					status: "error",
					summary: `检查更新失败：${firstLine(error)}`,
					markdown: `### 插件更新\n❌ 检查更新失败：${firstLine(error)}`
				});
			}
		}
	};
	return tool;
}
