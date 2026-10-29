#!/usr/bin/env node
/**
 * `/plugin-update` 只读检查冒烟：
 * - `isNewerVersion` / `parseSemver` 版本比较边界（含 prerelease / v 前缀 / 非法值）；
 * - `registryPlan`：宿主 registries 顺序、去重、回退官方 registry；
 * - `createPluginUpdater().check()`：有更新 / 已最新 / 网络失败 / 自定义镜像 / 非法版本；
 * - 命令层：`parsePluginUpdateInput`、`formatCheck` 三态、handler 成功与抛错。
 *
 * 全程注入假 fetch，不联网、不写盘、不依赖 dsh。
 */
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
	createPluginUpdater
} = await import(join(here, "..", "lib", "plugin-update.js"));
const {
	PLUGIN_UPDATE_USAGE,
	parsePluginUpdateInput,
	formatCheck,
	makePluginUpdateHandler
} = await import(join(here, "..", "lib", "plugin-update-command.js"));

const META = { name: "@morehao/dsh-commands", version: "0.3.2", repo: "morehao/dsh-commands" };
const okFetch = (version) => async () => ({ ok: true, json: async () => ({ version }) });
const failFetch = async () => {
	throw new Error("network down");
};

// ---- 1) semver ---------------------------------------------------------
{
	check(parseSemver("v1.2.3")?.core.join(".") === "1.2.3", "1. parseSemver 接受 v 前缀");
	check(parseSemver("not-a-version") === undefined, "1. 非法版本返回 undefined");
	check(isNewerVersion("1.2.3", "1.2.4") === true, "1. 1.2.3 < 1.2.4");
	check(isNewerVersion("1.2.4", "1.2.3") === false, "1. 1.2.4 > 1.2.3 不算更新");
	check(isNewerVersion("1.2.3", "1.2.3") === false, "1. 同版本不算更新");
	check(isNewerVersion("v1.2.3", "1.2.4") === true, "1. v 前缀参与比较");
	check(isNewerVersion("1.2.3-beta", "1.2.3") === true, "1. 正式版新于同核心 prerelease");
	check(isNewerVersion("1.2.3", "1.2.3-beta") === false, "1. prerelease 不算新于正式版");
	check(isNewerVersion("1.2.3", "abc") === false, "1. 候选非法：不更新");
}

// ---- 2) registryPlan ---------------------------------------------------
{
	const plan = registryPlan({ resolved: "https://mirror.a/", registry: "https://mirror.b", fallbackRegistries: ["https://mirror.a/", "https://mirror.c"] });
	check(plan.join(",") === "https://mirror.a/,https://mirror.b/,https://mirror.c/", "2. registries 顺序 + 去重 + 补斜杠", plan.join(","));
	check(registryPlan(null).join(",") === OFFICIAL_REGISTRY, "2. 空配置回退官方 registry");
	check(registryPlan({ registry: "ftp://x" }).join(",") === OFFICIAL_REGISTRY, "2. 非法协议被忽略");
}

// ---- 3) check：有更新 --------------------------------------------------
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
	check(result.updateAvailable === true && result.latestVersion === "9.9.9" && result.checkFailed === false, "3. 有新版本", JSON.stringify(result));
	check(result.currentVersion === "0.3.2" && result.packageName === META.name, "3. 当前版本/包名来自 meta");
	check(result.manualCommand.includes("@morehao/dsh-commands@latest"), "3. manualCommand 带 @latest", result.manualCommand);
	check(urls[0] === `${OFFICIAL_REGISTRY}@morehao%2Fdsh-commands/latest`, "3. 请求路径对 scoped 包编码", urls[0]);
}

// ---- 4) check：已最新 --------------------------------------------------
{
	const updater = createPluginUpdater({ meta: META, fetchImpl: okFetch("0.3.2") });
	const result = await updater.check();
	check(result.updateAvailable === false && result.latestVersion === "0.3.2", "4. 同版本：不提示更新", JSON.stringify(result));
}

// ---- 5) check：网络失败 / 非法版本 -------------------------------------
{
	const down = await createPluginUpdater({ meta: META, fetchImpl: failFetch }).check();
	check(down.checkFailed === true && down.latestVersion === null, "5. fetch 抛错：checkFailed", JSON.stringify(down));
	const bad = await createPluginUpdater({ meta: META, fetchImpl: okFetch("abc") }).check();
	check(bad.checkFailed === true && bad.latestVersion === null, "5. registry 返回非法版本：checkFailed", JSON.stringify(bad));

	let status = 0;
	const notOk = await createPluginUpdater({
		meta: META,
		fetchImpl: async () => {
			status += 1;
			return { ok: false };
		}
	}).check();
	check(notOk.checkFailed === true && status === 1, "5. 非 2xx：checkFailed", JSON.stringify({ notOk, status }));
}

// ---- 6) 自定义镜像（宿主 registries）-----------------------------------
{
	const urls = [];
	const updater = createPluginUpdater({
		meta: META,
		getPluginManager: () => ({ registries: async () => ({ resolved: "https://mirror.example/" }) }),
		fetchImpl: async (url) => {
			urls.push(url);
			return { ok: true, json: async () => ({ version: "1.0.0" }) };
		}
	});
	await updater.check();
	check(urls[0]?.startsWith("https://mirror.example/"), "6. 优先用宿主 registries 的镜像", urls[0]);
}

// ---- 7) 命令解析 / 格式化 ---------------------------------------------
{
	check(parsePluginUpdateInput("").mode === "check", "7. 空输入 → check");
	check(parsePluginUpdateInput("--apply").mode === "apply", "7. --apply → apply（预留，只回手动命令）");
	check(parsePluginUpdateInput("--force").error?.startsWith(PLUGIN_UPDATE_USAGE), "7. 未知参数 → 用法错误", parsePluginUpdateInput("--force").error);

	const failed = formatCheck({ packageName: META.name, currentVersion: "0.3.2", latestVersion: null, updateAvailable: false, checkFailed: true, manualCommand: manualCommand(META, "desktop") });
	check(failed.includes("无法获取") && failed.includes("dsh plugin --profile desktop add"), "7. checkFailed 文案给手动命令", failed);

	const latest = formatCheck({ packageName: META.name, currentVersion: "0.3.2", latestVersion: "0.3.2", updateAvailable: false, checkFailed: false, manualCommand: manualCommand(META, "desktop") });
	check(latest.includes("已是最新版本 v0.3.2"), "7. 已最新文案", latest);

	const available = formatCheck({ packageName: META.name, currentVersion: "0.3.2", latestVersion: "0.4.0", updateAvailable: true, checkFailed: false, manualCommand: manualCommand(META, null) });
	check(available.includes("v0.3.2 → v0.4.0") && available.includes("不自动安装") && available.includes("dsh plugin add"), "7. 有更新文案 + 手动命令", available);
}

// ---- 8) handler --------------------------------------------------------
{
	const handler = makePluginUpdateHandler({
		getUpdater: () => ({ check: async () => ({ packageName: META.name, currentVersion: "0.3.2", latestVersion: "0.4.0", updateAvailable: true, checkFailed: false, manualCommand: manualCommand(META, null) }) })
	});
	const out = await handler({ rawInput: "" });
	check(out.kind === "success" && out.text.includes("v0.4.0"), "8. handler 成功走 check", JSON.stringify(out));
	check((await handler({ rawInput: "--apply" })).text.includes("手动"), "8. handler --apply 只回手动命令");

	const bad = await handler({ rawInput: "--nope" });
	check(bad.kind === "error" && bad.text.startsWith(PLUGIN_UPDATE_USAGE), "8. handler 未知参数 → error");

	const boom = makePluginUpdateHandler({ getUpdater: () => ({ check: async () => { throw new Error("kaboom"); } }) });
	const err = await boom({});
	check(err.kind === "error" && err.text.includes("kaboom"), "8. handler 捕获 check 异常", JSON.stringify(err));
}

console.log("");
if (failures > 0) {
	console.error(`plugin-update 冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("plugin-update 冒烟通过：版本比较 / registry / 三态文案符合预期");
