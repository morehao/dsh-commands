/**
 * `/skill-init`（含 `--update`）的离线冒烟（v1.0：只消费 console 包 API，无 CLI / 无建链）。
 *
 * 覆盖：
 *   A) resolveConsoleApi：正常 / api-missing / 版本过旧旧 console 守卫 / 版本不兼容；
 *   B) runSkillInit / runSkillUpdate 本地回退（注入 fake api）：安装、幂等、更新、
 *      只补缺失、未知技能、API 缺失 blocked、安装失败回执；
 *   全程不碰真实 HOME / ~/.agents / ~/.dsh。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(ok, label, detail) {
	if (ok) {
		console.log(`✓ ${label}`);
		return;
	}
	failures++;
	console.error(`✗ ${label}${detail === undefined ? "" : `\n  ${String(detail).replace(/\n/g, "\n  ")}`}`);
}

const root = await mkdtemp(join(tmpdir(), "dsh-commands-skill-setup-"));
const home = join(root, "home");
const dshHome = join(root, "dsh");
const canonicalDir = (name) => join(home, ".agents", "skills", name);
const saved = { ...process.env };

try {
	process.env.HOME = home;
	process.env.DSH_HOME = dshHome;
	delete process.env.DSH_PROFILE_DIR;
	await mkdir(join(home, ".agents", "skills"), { recursive: true });
	await mkdir(join(dshHome, "skills"), { recursive: true });

	const { resolveConsoleApi } = await import("../dist/console-api.js");
	const { runSkillInit, runSkillUpdate } = await import("../dist/skill-setup.js");
	const { COMMANDS } = await import("../dist/index.js");
	const names = ["git-kit", "handoff", "disk-cleanup"];

	const writeSkill = async (name) => {
		await mkdir(canonicalDir(name), { recursive: true });
		await writeFile(join(canonicalDir(name), "SKILL.md"), `# ${name}\n`);
		const branches = COMMANDS.filter((c) => (c.skill ?? "git-kit") === name).map((c) => c.branch);
		if (name !== "handoff" && branches.length > 0) {
			await mkdir(join(canonicalDir(name), "references"), { recursive: true });
			for (const branch of branches) await writeFile(join(canonicalDir(name), "references", `${branch}.md`), "# b\n");
		}
	};
	const reset = async () => {
		await rm(join(home, ".agents"), { recursive: true, force: true });
		await mkdir(join(home, ".agents", "skills"), { recursive: true });
	};

	// ---- fake api：install/update 写 canonical，让 observe 能判“已安装” ----
	function makeFakeApi() {
		const state = { installed: new Set(), installCalls: [], updateCalls: [], failInstall: new Set(), listError: null };
		return {
			state,
			api: {
				apiVersion: 1,
				async list({ names: only } = {}) {
					if (state.listError) throw Object.assign(new Error(state.listError.message), { code: state.listError.code });
					return [...state.installed].filter((n) => !only || only.includes(n)).map((n) => ({ name: n, mode: "auto" }));
				},
				async adopt({ name }) {
					return { name, already: state.installed.has(name), subscriptionId: null, tracked: false };
				},
				async install({ source, skills }) {
					state.installCalls.push([...skills]);
					const ok = [];
					for (const name of skills) {
						if (state.failInstall.has(name)) continue;
						await writeSkill(name);
						state.installed.add(name);
						ok.push({ name, treeSha: null });
					}
					if (ok.length !== skills.length) throw new Error(`安装失败：${skills.join("、")}`);
					return { ok: true, source, subscriptionId: "sub-1", commit: "c".repeat(40), installed: ok, warnings: [] };
				},
				async update({ names: targets }) {
					state.updateCalls.push([...targets]);
					return {
						ok: true,
						results: targets.map((name) => (state.installed.has(name)
							? { name, status: "current", fromCommit: null, toCommit: null }
							: { name, status: "not-managed", fromCommit: null, toCommit: null })),
					};
				},
			},
		};
	}

	// ---- A) resolveConsoleApi ---------------------------------------------
	{
		const goodMod = { API_VERSION: 1, createSkillsConsole: () => ({ apiVersion: 1, async list() { return []; } }) };
		const ok = await resolveConsoleApi({ env: {}, importer: async () => goodMod });
		check(ok.api.apiVersion === 1, "A1. 正常解析：返回 apiVersion=1");

		await resolveConsoleApi({ env: {}, importer: async () => { throw new Error("Cannot find module"); } }).then(
			() => check(false, "A2. import 失败应抛 api-missing"),
			(error) => check(error.code === "api-missing", "A2. import 失败 → api-missing", error.code),
		);

		await resolveConsoleApi({ env: {}, importer: async () => ({}) }).then(
			() => check(false, "A3. 无 createSkillsConsole 应抛错"),
			(error) => check(error.code === "api-missing", "A3. 缺 createSkillsConsole → api-missing", error.code),
		);

		await resolveConsoleApi({ env: {}, importer: async () => ({ createSkillsConsole: () => ({ apiVersion: 2 }) }) }).then(
			() => check(false, "A4. apiVersion 不兼容应抛错"),
			(error) => check(error.code === "incompatible-api", "A4. apiVersion 不兼容 → incompatible-api", error.code),
		);

		// 旧 console 守卫：profile 顶层 <0.8 且 bundle 启用 → old-console，且不应 import
		const profileDir = join(root, "profile-old");
		await mkdir(profileDir, { recursive: true });
		await writeFile(join(profileDir, "package.json"), JSON.stringify({
			name: "dsh-profile-old",
			dependencies: { "@morehao/dsh-skills-console": "0.6.0" },
			dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@morehao/dsh-skills-console"] } },
		}));
		let imported = false;
		await resolveConsoleApi({ env: { DSH_PROFILE_DIR: profileDir }, importer: async () => { imported = true; return goodMod; } }).then(
			() => check(false, "A5. 旧 console 应 blocked"),
			(error) => check(error.code === "old-console" && imported === false, "A5. 旧 console(<0.8) 启用 → old-console，且不 import", error.code),
		);

		// 旧 console 未启用 → 不 block，正常 import
		await writeFile(join(profileDir, "package.json"), JSON.stringify({
			name: "dsh-profile-old",
			dependencies: { "@morehao/dsh-skills-console": "0.6.0" },
			dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
		}));
		const notEnabled = await resolveConsoleApi({ env: { DSH_PROFILE_DIR: profileDir }, importer: async () => goodMod });
		check(notEnabled.api.apiVersion === 1, "A6. 旧 console 未启用 → 不 block，正常解析");

		// 0.7.0 启用 → 正常
		await writeFile(join(profileDir, "package.json"), JSON.stringify({
			name: "dsh-profile-new",
			dependencies: { "@morehao/dsh-skills-console": "0.7.0" },
			dsh: { profile: { bundles: ["@morehao/dsh-skills-console"] } },
		}));
		const fresh = await resolveConsoleApi({ env: { DSH_PROFILE_DIR: profileDir }, importer: async () => goodMod });
		check(fresh.api.apiVersion === 1, "A7. console 0.7 启用 → 正常");
	}

	// ---- B) runSkillInit / runSkillUpdate ---------------------------------
	// B1 安装
	await reset();
	{
		const { api, state } = makeFakeApi();
		const text = await runSkillInit(COMMANDS, { api });
		check(text.includes("✅ 已完成") && text.includes("安装：git-kit、handoff、disk-cleanup"), "B1. init：安装 3 个技能", text);
		check(state.installCalls.length === 1 && JSON.stringify(state.installCalls[0]) === JSON.stringify(names), "B1. init：install 只调一次、批量 3 个", JSON.stringify(state.installCalls));
		check(existsSync(join(canonicalDir("git-kit"), "SKILL.md")), "B1. init：canonical 生成");
		check(!text.includes("契约问题"), "B1. init：契约校验无失败", text);
		check(!existsSync(join(dshHome, "skills", "git-kit")), "B1. init：不再写 ~/.dsh/skills");
	}

	// B2 幂等
	{
		const { api, state } = makeFakeApi();
		for (const name of names) { await writeSkill(name); state.installed.add(name); }
		const text = await runSkillInit(COMMANDS, { api });
		check(text.startsWith("✓ 无变更"), "B2. init 幂等：无变更", text);
		check(state.installCalls.length === 0, "B2. init 幂等：不调 install");
	}

	// B3 update 已最新
	{
		const { api, state } = makeFakeApi();
		for (const name of names) { await writeSkill(name); state.installed.add(name); }
		const text = await runSkillUpdate(COMMANDS, "", { api });
		check(text.includes("已最新") && state.updateCalls.length === 1, "B3. update：全部已最新", text);
	}

	// B4 只补缺失
	await reset();
	{
		const { api, state } = makeFakeApi();
		await writeSkill("handoff");
		state.installed.add("handoff");
		const text = await runSkillInit(COMMANDS, { api, choice: "missing" });
		check(text.includes("安装：git-kit、disk-cleanup"), "B4. 只补缺失：安装缺失两项", text);
		check(JSON.stringify(state.installCalls[0]) === JSON.stringify(["git-kit", "disk-cleanup"]), "B4. 只补缺失：install 只传缺失", JSON.stringify(state.installCalls));
	}

	// B5 未知技能
	await reset();
	{
		const { api } = makeFakeApi();
		await runSkillUpdate(COMMANDS, "nonexistent", { api }).then(
			() => check(false, "B5. 未知技能应报错"),
			(error) => check(String(error.message).includes("未知技能"), "B5. 未知技能报错", String(error.message)),
		);
	}

	// B6 API 缺失 → blocked 文案
	await reset();
	{
		const text = await runSkillInit(COMMANDS, {
			resolveApi: async () => { throw Object.assign(new Error("未找到 @morehao/dsh-skills-console/api"), { code: "api-missing" }); },
		});
		check(text.startsWith("⛔") && text.includes("技能控制台不可用"), "B6. API 缺失：blocked 文案，零写", text);
	}

	// B7 安装失败回执
	await reset();
	{
		const { api, state } = makeFakeApi();
		state.failInstall.add("handoff");
		const text = await runSkillInit(COMMANDS, { api });
		check(text.startsWith("⚠") && text.includes("handoff"), "B7. 安装失败：⚠ 回执指出失败技能", text);
	}
} finally {
	for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
	for (const [key, value] of Object.entries(saved)) if (process.env[key] !== value) process.env[key] = value;
	await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("冒烟通过：/skill-init 与 --update（API 消费版）符合预期");
