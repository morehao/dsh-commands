#!/usr/bin/env node
/**
 * `/plugin-update` 冒烟（v2：委托式问答 + 一键更新）：
 * - 版本比较 / registry 计划 / 只读 check（沿用）；
 * - 命令解析、委托注入、本地回退；
 * - 服务层：确认、apply（installBundle → already-installed → removeBundle → installBundle）、verify；
 * - 工具层：check 三态、apply 无能力 blocked、无确认 plan-only、yes=true 走更新并写 state；
 * - 状态文件读写。
 *
 * 全程注入假 fetch / 假 pluginManager / 假 jobs / 临时 HOME，不联网、不写真实目录。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let failures = 0;
function check(ok, label, detail) {
	if (ok) {
		console.log(`✓ ${label}`);
		return;
	}
	failures++;
	console.error(`✗ ${label}${detail === undefined ? "" : `\n  ${String(detail).replace(/\n/g, "\n  ")}`}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const {
	OFFICIAL_REGISTRY,
	parseSemver,
	isNewerVersion,
	registryPlan,
	manualCommand,
	createPluginUpdater,
	readPluginState,
	writePluginState
} = await import(join(here, "..", "lib", "plugin-update.js"));
const {
	PLUGIN_UPDATE_USAGE,
	parsePluginUpdateInput,
	buildPluginUpdateMessage,
	formatCheck,
	makePluginUpdateHandler
} = await import(join(here, "..", "lib", "plugin-update-command.js"));
const { confirmPluginUpdate, applyPluginUpdate, verifyPluginUpdate } = await import(
	join(here, "..", "lib", "plugin-update-service.js")
);
const { createPluginUpdateTool } = await import(join(here, "..", "lib", "tool-plugin-update.js"));

const META = { name: "@morehao/dsh-commands", version: "0.3.3", repo: "morehao/dsh-commands" };
const okFetch = (version) => async () => ({ ok: true, json: async () => ({ version }) });
const failFetch = async () => {
	throw new Error("network down");
};

// ---- 1) semver ---------------------------------------------------------
{
	check(parseSemver("v1.2.3")?.core.join(".") === "1.2.3", "1. parseSemver 接受 v 前缀");
	check(parseSemver("not-a-version") === undefined, "1. 非法版本返回 undefined");
	check(isNewerVersion("1.2.3", "1.2.4") === true, "1. 1.2.3 < 1.2.4");
	check(isNewerVersion("1.2.3", "1.2.3") === false, "1. 同版本不算更新");
	check(isNewerVersion("1.2.3-beta", "1.2.3") === true, "1. 正式版新于同核心 prerelease");
	check(isNewerVersion("1.2.3", "abc") === false, "1. 候选非法：不更新");
}

// ---- 2) registryPlan ---------------------------------------------------
{
	const plan = registryPlan({ resolved: "https://mirror.a/", registry: "https://mirror.b", fallbackRegistries: ["https://mirror.a/"] });
	check(plan.join(",") === "https://mirror.a/,https://mirror.b/", "2. registries 顺序 + 去重", plan.join(","));
	check(registryPlan(null).join(",") === OFFICIAL_REGISTRY, "2. 空配置回退官方 registry");
}

// ---- 3) updater.check --------------------------------------------------
{
	const urls = [];
	const updater = createPluginUpdater({
		meta: META,
		fetchImpl: async (url) => {
			urls.push(url);
			return { ok: true, json: async () => ({ version: "9.9.9" }) };
		}
	});
	const result = await updater.check();
	check(result.updateAvailable === true && result.latestVersion === "9.9.9", "3. 有新版本", JSON.stringify(result));
	check(urls[0] === `${OFFICIAL_REGISTRY}@morehao%2Fdsh-commands/latest`, "3. scoped 包编码", urls[0]);
	const down = await createPluginUpdater({ meta: META, fetchImpl: failFetch }).check();
	check(down.checkFailed === true && down.latestVersion === null, "3. 网络失败 checkFailed");
}

// ---- 3b) pnpm view 优先（继承 profile registry/token）-------------------
{
	let fetched = 0;
	const viaPnpm = await createPluginUpdater({
		meta: META,
		runPnpmView: async () => "9.9.9",
		fetchImpl: async () => {
			fetched += 1;
			return { ok: true, json: async () => ({ version: "0.0.1" }) };
		}
	}).check();
	check(viaPnpm.latestVersion === "9.9.9" && viaPnpm.updateAvailable === true && fetched === 0, "3b. pnpm view 命中：不 fetch", JSON.stringify({ viaPnpm, fetched }));

	fetched = 0;
	const fallback = await createPluginUpdater({
		meta: META,
		runPnpmView: async () => null,
		fetchImpl: async () => {
			fetched += 1;
			return { ok: true, json: async () => ({ version: "9.9.9" }) };
		}
	}).check();
	check(fallback.latestVersion === "9.9.9" && fetched === 1, "3b. pnpm view 取不到：回退 fetch", JSON.stringify({ fallback, fetched }));

	const noProfile = await createPluginUpdater({ meta: META, fetchImpl: okFetch("9.9.9") }).check();
	check(noProfile.latestVersion === "9.9.9", "3b. 无 profile：直接回退 fetch", JSON.stringify(noProfile));
}

// ---- 4) 命令解析 -------------------------------------------------------
{
	check(parsePluginUpdateInput("").mode === "check" && parsePluginUpdateInput("").yes === false, "4. 空输入 → check");
	check(parsePluginUpdateInput("--apply").mode === "apply", "4. --apply → apply");
	check(parsePluginUpdateInput("--apply --yes").yes === true, "4. --yes 解析");
	check(parsePluginUpdateInput("--check").mode === "check", "4. --check → check");
	check(parsePluginUpdateInput("--force").error?.startsWith(PLUGIN_UPDATE_USAGE), "4. 未知参数 → 用法错误");
	const msg = buildPluginUpdateMessage({ mode: "apply", yes: true });
	check(msg.includes("mode=apply") && msg.includes("yes=true") && msg.includes("plugin_update 工具"), "4. 注入消息含工具与参数", msg);
}

// ---- 5) formatCheck（本地回退）----------------------------------------
{
	const failed = formatCheck({ packageName: META.name, currentVersion: "0.3.3", latestVersion: null, updateAvailable: false, checkFailed: true, manualCommand: manualCommand(META, "desktop") });
	check(failed.includes("无法获取") && failed.includes("dsh plugin --profile desktop add"), "5. checkFailed 给手动命令");
	const latest = formatCheck({ packageName: META.name, currentVersion: "0.3.3", latestVersion: "0.3.3", updateAvailable: false, checkFailed: false, manualCommand: "x" });
	check(latest.includes("已是最新版本 v0.3.3"), "5. 已最新文案");
	const available = formatCheck({ packageName: META.name, currentVersion: "0.3.3", latestVersion: "0.4.0", updateAvailable: true, checkFailed: false, manualCommand: "x" });
	check(available.includes("当前版本：v0.3.3") && available.includes("最新版本：v0.4.0") && available.includes("--apply"), "5. 有更新文案");
}

// ---- 6) 命令 handler（委托 + 回退）-------------------------------------
{
	const fallback = async (parsed) => ({ kind: "success", text: `fallback:${parsed.mode}` });
	const noTool = makePluginUpdateHandler({ toolReady: () => false, fallback });
	check((await noTool({ rawInput: "" })).text === "fallback:check", "6. 无工具走回退");
	check((await noTool({ rawInput: "--apply" })).text === "fallback:apply", "6. 回退保留 mode");

	let injected = null;
	const delegated = makePluginUpdateHandler({ toolReady: () => true, fallback });
	const out = await delegated({ rawInput: "--apply", agent: { followup: (m) => { injected = m; } } });
	check(out.kind === "success" && out.text === "已开始更新插件", "6. 有工具 → 注入并回执", JSON.stringify(out));
	check(injected?.role === "user" && injected?.source?.kind === "user" && injected.content[0].text.includes("mode=apply"), "6. 注入消息契约正确");

	const throwing = makePluginUpdateHandler({ toolReady: () => true, fallback });
	const out2 = await throwing({ rawInput: "", agent: { followup: () => { throw new Error("closed"); } } });
	check(out2.text === "fallback:check", "6. followup 抛错 → 回退", JSON.stringify(out2));

	const bad = await noTool({ rawInput: "--nope" });
	check(bad.kind === "error", "6. 非法参数 → error");
}

// ---- 7) confirm --------------------------------------------------------
{
	const plan = { currentVersion: "0.3.3", latestVersion: "0.4.0" };
	check((await confirmPluginUpdate({ yes: true })).action === "proceed", "7. yes → proceed");
	check((await confirmPluginUpdate({ plan })).action === "plan", "7. 无 userQuestions → plan");
	const proceed = await confirmPluginUpdate({
		plan,
		agent: {},
		userQuestions: { ask: async () => ({ answers: [{ id: "confirm-plugin-update", selected: ["更新"] }] }) }
	});
	check(proceed.action === "proceed", "7. 选「更新」→ proceed");
	const cancel = await confirmPluginUpdate({
		plan,
		agent: {},
		userQuestions: { ask: async () => ({ answers: [{ id: "confirm-plugin-update", selected: ["取消"] }] }) }
	});
	check(cancel.action === "cancel", "7. 选「取消」→ cancel");
	const abort = await confirmPluginUpdate({
		plan,
		agent: {},
		userQuestions: { ask: async () => { const e = new Error("aborted"); e.code = "ASK_CANCELLED"; throw e; } }
	});
	check(abort.action === "cancel", "7. 问题卡取消 → cancel");
}

// ---- 8) applyPluginUpdate ---------------------------------------------
{
	let calls = [];
	const pm = {
		installBundle: async (spec) => {
			calls.push(`install:${spec}`);
			if (calls.length === 1) return { error: { code: "already-installed" } };
			return { application: "applied" };
		},
		removeBundle: async (name) => {
			calls.push(`remove:${name}`);
			return { application: "applied" };
		}
	};
	const result = await applyPluginUpdate({ pluginManager: pm, name: META.name, targetVersion: "0.4.0" });
	check(calls.join("|") === `install:${META.name}@0.4.0|remove:${META.name}|install:${META.name}@0.4.0`, "8. already-installed → remove → install", calls.join("|"));
	check(result.application === "applied" && result.restartRequired === false && result.updatedVersion === "0.4.0", "8. applied → 无需重启", JSON.stringify(result));

	const pm2 = { installBundle: async () => ({ application: "restart-required" }) };
	const r2 = await applyPluginUpdate({ pluginManager: pm2, name: META.name, targetVersion: "0.4.0" });
	check(r2.restartRequired === true, "8. restart-required → 需重启");

	let threw = false;
	try {
		await applyPluginUpdate({ pluginManager: { installBundle: async () => ({ application: "failed", error: { message: "boom" } }) }, name: META.name, targetVersion: "0.4.0" });
	} catch {
		threw = true;
	}
	check(threw, "8. failed → 抛错");

	threw = false;
	try {
		await applyPluginUpdate({ pluginManager: null, name: META.name, targetVersion: "0.4.0" });
	} catch {
		threw = true;
	}
	check(threw, "8. 无 pluginManager → 抛错");

	check((await verifyPluginUpdate({ targetVersion: "0.4.0", readVersion: () => "0.4.0" })).ok === true, "8. verify 命中");
	check((await verifyPluginUpdate({ targetVersion: "0.4.0", readVersion: () => "0.3.3" })).ok === false, "8. verify 未命中");
}

// ---- 9) 状态文件 -------------------------------------------------------
const home = await mkdtemp(join(tmpdir(), "dsh-commands-plugin-update-"));
const env = { ...process.env, DSH_HOME: home };
{
	check(Object.keys(await readPluginState(env)).length === 0, "9. 初始无状态");
	await writePluginState(env, { lastSeenVersion: "0.3.3" });
	const state = await readPluginState(env);
	check(state.lastSeenVersion === "0.3.3" && typeof state.updatedAt === "string", "9. 写入并读回", JSON.stringify(state));
}

// ---- 10) 工具 ----------------------------------------------------------
{
	const observed = (over) => ({
		packageName: META.name,
		currentVersion: "0.3.3",
		latestVersion: "0.4.0",
		updateAvailable: true,
		checkFailed: false,
		manualCommand: manualCommand(META, null),
		...over
	});
	const baseServices = () => ({
		pluginManager: () => undefined,
		userQuestions: () => undefined,
		jobs: () => undefined,
		profileContext: () => null
	});

	const tool1 = createPluginUpdateTool({ services: baseServices(), createUpdater: () => ({ check: async () => observed({ latestVersion: "0.3.3", updateAvailable: false }) }) });
	const r1 = await tool1.execute({ mode: "check" }, {});
	check(r1.status === "ok" && r1.markdown.includes("已是最新"), "10.1 已最新", r1.markdown);

	const tool2 = createPluginUpdateTool({ services: baseServices(), createUpdater: () => ({ check: async () => observed() }) });
	const r2 = await tool2.execute({ mode: "check" }, {});
	check(r2.status === "available" && r2.markdown.includes("最新版本：v0.4.0"), "10.2 check 有更新", r2.markdown);

	const tool3 = createPluginUpdateTool({ services: baseServices(), createUpdater: () => ({ check: async () => observed({ checkFailed: true, latestVersion: null }) }) });
	const r3 = await tool3.execute({ mode: "check" }, {});
	check(r3.status === "attention" && r3.markdown.includes("无法获取"), "10.3 检查失败", r3.markdown);

	const r4 = await tool2.execute({ mode: "apply" }, { agent: {} });
	check(r4.status === "blocked" && r4.markdown.includes("不支持一键更新"), "10.4 无 pluginManager → blocked", r4.markdown);

	let applied5 = false;
	const pm5 = { installBundle: async () => { applied5 = true; return { application: "applied" }; }, removeBundle: async () => ({ application: "applied" }) };
	const tool5 = createPluginUpdateTool({ services: { ...baseServices(), pluginManager: () => pm5 }, createUpdater: () => ({ check: async () => observed() }) });
	const r5 = await tool5.execute({ mode: "apply" }, { agent: {} });
	check(r5.status === "attention" && r5.summary.includes("需要确认") && applied5 === false, "10.5 无确认通道 → 只返回计划", JSON.stringify(r5));

	let calls6 = [];
	const pm6 = {
		installBundle: async () => {
			calls6.push("install");
			if (calls6.length === 1) return { error: { code: "already-installed" } };
			return { application: "applied" };
		},
		removeBundle: async () => {
			calls6.push("remove");
			return { application: "applied" };
		}
	};
	const tool6 = createPluginUpdateTool({
		env,
		services: { ...baseServices(), pluginManager: () => pm6 },
		createUpdater: () => ({ check: async () => observed() }),
		readVersion: () => "0.4.0",
		runJob: async ({ work }) => ({ value: await work({ progress() {} }) })
	});
	const r6 = await tool6.execute({ mode: "apply", yes: true }, { agent: {} });
	check(r6.status === "updated" && r6.restartRequired === false && calls6.join("|") === "install|remove|install", "10.6 yes=true 执行更新", JSON.stringify({ r6, calls6 }));
	const state6 = await readPluginState(env);
	check(state6.pendingVersion === "0.4.0" && state6.lastSeenVersion === "0.3.3", "10.6 写 pending 状态（供重启提示）", JSON.stringify(state6));

	const tool7 = createPluginUpdateTool({
		env,
		services: { ...baseServices(), pluginManager: () => pm6 },
		createUpdater: () => ({ check: async () => observed() }),
		readVersion: () => "0.4.0",
		runJob: async () => ({ error: new Error("boom"), outputTail: "tail" })
	});
	const r7 = await tool7.execute({ mode: "apply", yes: true }, { agent: {} });
	check(r7.status === "error" && r7.markdown.includes("boom"), "10.7 更新失败 → error", r7.markdown);
}

await rm(home, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`plugin-update 冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("plugin-update 冒烟通过：版本比较 / registry / 委托 / 确认 / 更新 / 状态符合预期");
