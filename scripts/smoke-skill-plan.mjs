/**
 * `skill_init` 核心（observe / plan）的离线冒烟：15 个用例（设计 §测试 / 计划 §9.2）。
 *
 * 只读：不装技能、不联网、不写真实 `~/.dsh` / `~/.agents`；console 存在性用注入，
 * 不依赖真实安装。fixture 全部落在临时 HOME/DSH_HOME 下。
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

const root = await mkdtemp(join(tmpdir(), "dsh-commands-skill-plan-"));
const home = join(root, "home");
const dshHome = join(root, "dsh");
const consoleHome = join(root, "console");
const dshSkillsDir = join(dshHome, "skills");
const canonicalDir = (name) => join(home, ".agents", "skills", name);
const linkPath = (name) => join(dshSkillsDir, name);
const statePath = join(consoleHome, "state.json");

const saved = { ...process.env };
try {
	process.env.HOME = home;
	process.env.DSH_HOME = dshHome;
	process.env.DSH_SKILLS_CONSOLE_HOME = consoleHome;
	// 关掉来源缓存（usesSourceCache 在有 CLI override 时为 false），plan 不联网、不碰 git。
	process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE = "/bin/true";
	delete process.env.DSH_COMMANDS_SKILL_BACKEND;

	const { observeSkills, planOperation, requirements } = await import("../lib/skill-setup.js");
	const { detectConsole, readConsoleState, backendOf, resolveOwnership } = await import("../lib/skills-console.js");
	const { COMMANDS } = await import("../lib/index.js");
	const names = ["git-kit", "handoff", "disk-cleanup"];

	await mkdir(dshSkillsDir, { recursive: true });
	await mkdir(join(home, ".agents"), { recursive: true });
	await mkdir(consoleHome, { recursive: true });

	const writeSkill = async (name, { refs = false } = {}) => {
		await mkdir(canonicalDir(name), { recursive: true });
		await writeFile(join(canonicalDir(name), "SKILL.md"), `# ${name}\n`);
		if (refs) {
			await mkdir(join(canonicalDir(name), "references"), { recursive: true });
			await writeFile(join(canonicalDir(name), "references", "commit-message.md"), "# branch\n");
		}
	};
	const managed = async (name) => {
		await writeSkill(name);
		await symlink(canonicalDir(name), linkPath(name), "dir");
	};
	const reset = async ({ canonical = [], links = [] } = {}) => {
		await rm(join(home, ".agents"), { recursive: true, force: true });
		await rm(dshSkillsDir, { recursive: true, force: true });
		await mkdir(dshSkillsDir, { recursive: true });
		await mkdir(join(home, ".agents"), { recursive: true });
		for (const name of canonical) await writeSkill(name, { refs: name === "git-kit" });
		for (const name of links) await symlink(canonicalDir(name), linkPath(name), "dir");
	};
	const writeState = async (installs, version = 3) => {
		await writeFile(statePath, `${JSON.stringify({ version, installs }, null, 2)}\n`);
	};
	const observe = async (env = process.env, options = {}) => {
		const snapshot = await observeSkills(env, COMMANDS, options);
		return { snapshot, plan: (mode = "init", extra = {}) => planOperation(mode, extra, snapshot) };
	};
	const actionsOf = (plan, type) => plan.actions.filter((action) => action.type === type).map((action) => action.name);
	const stateOf = async (name) => {
		const text = await readFile(statePath, "utf8");
		return { text, entry: JSON.parse(text).installs.find((item) => item.name === name) };
	};

	// ---- 1) 全 missing，无 console -----------------------------------------
	await reset();
	{
		const { snapshot, plan } = await observe();
		const init = plan("init");
		check(
			JSON.stringify(actionsOf(init, "install")) === JSON.stringify(names),
			"1. 全缺失：3 个 install，顺序 = REQUIRED_SKILLS",
			JSON.stringify(init.actions)
		);
		check(init.confirm.needs === true && init.confirm.installs === 3, "1. 全缺失：confirm.needs=true", JSON.stringify(init.confirm));
		check(init.skipReason === undefined && init.pending.length === 3, "1. 全缺失：有待办，无 skipReason", String(init.skipReason));
		check(snapshot.backend === "auto" && snapshot.consolePresent === false, "1. 快照：auto + console 不存在", JSON.stringify(snapshot));
		check(
			requirements(COMMANDS).length === COMMANDS.length &&
				requirements(COMMANDS).every((req) => typeof req.file === "string" && req.file.startsWith("references/")),
			"1. requirements：每个命令一条分支契约",
			JSON.stringify(requirements(COMMANDS).slice(0, 2))
		);
	}

	// ---- 2) 全 managed，无 console -----------------------------------------
	await reset({ canonical: names, links: names });
	{
		const { plan } = await observe();
		const init = plan("init");
		check(init.actions.every((action) => action.type === "skip"), "2. 全托管：没有写 action", JSON.stringify(init.actions));
		check(init.skipReason === "已全部托管，无需安装", "2. 全托管：skipReason 精确", String(init.skipReason));
		check(init.confirm.needs === false, "2. 全托管：不需要确认", JSON.stringify(init.confirm));
	}

	// ---- 3) managed + changed（P1b：只 warn，不写盘）-----------------------
	await reset({ canonical: names, links: names });
	{
		const { snapshot, plan } = await observe();
		snapshot.cache.changed = ["handoff"];
		const init = plan("init");
		const action = init.actions.find((entry) => entry.name === "handoff");
		check(action?.type === "warn" && action?.writes === false, "3. 上游更新：changed 只 warn，零写", JSON.stringify(init.actions));
		check(actionsOf(init, "install").length === 0, "3. 上游更新：不进写盘集合", JSON.stringify(init.actions));
		check(
			action?.detail.includes("未安装") && action?.detail.includes("--update"),
			"3. 上游更新：提示本次不装、用 --update",
			JSON.stringify(action)
		);
		check(init.confirm.needs === false, "3. 上游更新：不触发确认", JSON.stringify(init.confirm));
		check(init.skipReason === "已全部托管，无需安装", "3. 上游更新：只读结论不建作业", String(init.skipReason));
	}

	// ---- 4) foreign-link ----------------------------------------------------
	await reset({ canonical: names, links: names });
	{
		const foreign = join(root, "foreign", "git-kit");
		await mkdir(foreign, { recursive: true });
		await writeFile(join(foreign, "SKILL.md"), "# foreign\n");
		await rm(linkPath("git-kit"), { force: true });
		await symlink(foreign, linkPath("git-kit"), "dir");
		const { snapshot, plan } = await observe();
		const init = plan("init");
		const gitKit = snapshot.skills.find((skill) => skill.name === "git-kit");
		check(gitKit.link.kind === "foreign", "4. 外链：link.kind=foreign", JSON.stringify(gitKit.link));
		check(
			init.actions.find((action) => action.name === "git-kit")?.type === "install" &&
				init.actions.find((action) => action.name === "git-kit")?.writes === true,
			"4. 外链：install（替换为托管链）",
			JSON.stringify(init.actions)
		);
	}

	// ---- 5) real-dir -------------------------------------------------------
	await reset({ canonical: names, links: names });
	{
		await rm(linkPath("handoff"), { force: true });
		await mkdir(linkPath("handoff"), { recursive: true });
		await writeFile(join(linkPath("handoff"), "SKILL.md"), "# local\n");
		const { snapshot, plan } = await observe();
		const init = plan("init");
		const handoff = snapshot.skills.find((skill) => skill.name === "handoff");
		check(handoff.link.kind === "real-dir", "5. 真实目录：link.kind=real-dir", JSON.stringify(handoff.link));
		check(
			init.actions.find((action) => action.name === "handoff")?.type === "install" &&
				init.actions.find((action) => action.name === "handoff")?.reason === "real-dir",
			"5. 真实目录：安装 canonical，链不改写（不 relink）",
			JSON.stringify(init.actions)
		);
	}

	// ---- 6) dangling -------------------------------------------------------
	await reset({ canonical: names, links: names });
	{
		await rm(linkPath("disk-cleanup"), { force: true });
		await symlink(join(root, "gone", "disk-cleanup"), linkPath("disk-cleanup"), "dir");
		const { snapshot, plan } = await observe();
		const init = plan("init");
		const disk = snapshot.skills.find((skill) => skill.name === "disk-cleanup");
		check(disk.link.kind === "dangling", "6. 悬空链：link.kind=dangling", JSON.stringify(disk.link));
		check(
			init.actions.find((action) => action.name === "disk-cleanup")?.type === "install",
			"6. 悬空链：按旧语义 install",
			JSON.stringify(init.actions)
		);
	}

	// ---- 7) console absent + 残留 state ------------------------------------
	await reset();
	{
		await writeState([{ name: "git-kit", mode: "on" }]);
		const state = await readConsoleState();
		const { snapshot, plan } = await observe(process.env, { console: { present: false, state } });
		const init = plan("init");
		check(state?.installs?.length === 1, "7. 残留记录：state 可读", JSON.stringify(state));
		check(
			snapshot.consolePresent === false && init.actions.every((action) => action.type !== "delegate"),
			"7. 残留记录：console 不存在时忽略记录，按 self 处理",
			JSON.stringify(init.actions)
		);
		check(actionsOf(init, "install").length === 3, "7. 残留记录：仍安装 3 个缺失技能", JSON.stringify(init.actions));
	}

	// ---- 8) console present + on -------------------------------------------
	await reset({ canonical: names, links: names });
	{
		await writeState([{ name: "git-kit", mode: "on" }]);
		const { snapshot, plan } = await observe(process.env, { console: { present: true, state: await readConsoleState() } });
		const init = plan("init");
		const gitKit = snapshot.skills.find((skill) => skill.name === "git-kit");
		check(gitKit.console.record?.mode === "on", "8. console on：记录按技能匹配", JSON.stringify(gitKit.console));
		check(
			init.actions.find((action) => action.name === "git-kit")?.type === "delegate",
			"8. console on：delegate",
			JSON.stringify(init.actions)
		);
		check(init.actions.every((action) => action.writes === false), "8. console on：零写", JSON.stringify(init.actions));
	}

	// ---- 9) console present + off ------------------------------------------
	await reset({ canonical: names, links: names });
	{
		await writeState([{ name: "handoff", enabled: false }], 3);
		const { snapshot, plan } = await observe(process.env, { console: { present: true, state: await readConsoleState() } });
		const init = plan("init");
		check(
			snapshot.skills.find((skill) => skill.name === "handoff")?.console.record?.mode === "off",
			"9. console off：mode=off",
			JSON.stringify(snapshot.skills.find((skill) => skill.name === "handoff")?.console)
		);
		check(
			init.actions.find((action) => action.name === "handoff")?.type === "delegate" &&
				init.actions.find((action) => action.name === "handoff")?.detail.includes("停用"),
			"9. console off：delegate + 停用说明",
			JSON.stringify(init.actions)
		);
		check(init.actions.every((action) => action.writes === false), "9. console off：零写", JSON.stringify(init.actions));
	}

	// ---- 10) console + on + 链缺失 -----------------------------------------
	await reset({ canonical: names, links: ["handoff", "disk-cleanup"] });
	{
		await writeState([{ name: "git-kit", mode: "on" }]);
		const { plan } = await observe(process.env, { console: { present: true, state: await readConsoleState() } });
		const init = plan("init");
		const action = init.actions.find((entry) => entry.name === "git-kit");
		check(action?.type === "relink" && action?.writes === true, "10. console on + 链缺失：relink", JSON.stringify(init.actions));
		check(init.confirm.needs === true && init.confirm.relinks === 1, "10. relink 计入确认", JSON.stringify(init.confirm));
	}

	// ---- 11) console + canonical 缺失 --------------------------------------
	await reset({ canonical: ["handoff", "disk-cleanup"], links: ["handoff", "disk-cleanup"] });
	{
		await writeState([{ name: "git-kit", mode: "on" }]);
		const { plan } = await observe(process.env, { console: { present: true, state: await readConsoleState() } });
		const init = plan("init");
		const action = init.actions.find((entry) => entry.name === "git-kit");
		check(
			action?.type === "blocked" && action?.detail.includes("canonical 缺失"),
			"11. console + canonical 缺失：blocked，零写",
			JSON.stringify(init.actions)
		);
		check(action?.writes === false && init.confirm.needs === false, "11. blocked 不触发确认与安装", JSON.stringify(init.confirm));
	}

	// ---- 12) state 损坏 / 超大 ---------------------------------------------
	await reset();
	{
		await writeFile(statePath, "{not json\n");
		const broken = await readConsoleState();
		check(broken === null, "12. 损坏 state：readConsoleState 返回 null", JSON.stringify(broken));
		const before = await stat(statePath);
		const { snapshot, plan } = await observe(process.env, { console: { present: true, state: broken } });
		const init = plan("init");
		check(snapshot.consoleState === null, "12. 损坏 state：快照无可用记录", JSON.stringify(snapshot.consoleState));
		check(actionsOf(init, "install").length === 3, "12. 损坏 state：auto 正常走 CLI", JSON.stringify(init.actions));
		const after = await stat(statePath);
		check(before.size === after.size && before.mtimeMs === after.mtimeMs, "12. 损坏 state：只读，不改字节");

		await writeFile(statePath, "x".repeat(1024 * 1024 + 1));
		const oversized = await readConsoleState();
		check(oversized === null, "12. 超大 state（>1 MiB）：返回 null", String(oversized));
	}

	// ---- 13) backend=console 无记录 ----------------------------------------
	await reset();
	{
		process.env.DSH_COMMANDS_SKILL_BACKEND = "console";
		const { snapshot, plan } = await observe(process.env, { console: { present: true, state: await readConsoleState() } });
		const init = plan("init");
		check(snapshot.backend === "console", "13. backend=console：快照记录后端", String(snapshot.backend));
		check(
			init.actions.every((action) => action.type === "blocked") && init.actions.length === 3,
			"13. backend=console 无记录：全部 blocked，零写",
			JSON.stringify(init.actions)
		);
		check(init.confirm.needs === false && init.actions.every((action) => action.writes === false), "13. blocked 不写盘", JSON.stringify(init.confirm));
		delete process.env.DSH_COMMANDS_SKILL_BACKEND;
	}

	// ---- 14) backend=cli + on ----------------------------------------------
	await reset({ canonical: names, links: names });
	{
		await writeState([{ name: "git-kit", mode: "on" }]);
		process.env.DSH_COMMANDS_SKILL_BACKEND = "cli";
		const { snapshot, plan } = await observe(process.env, { console: { present: true, state: await readConsoleState() } });
		snapshot.cache.changed = ["handoff"];
		const init = plan("init");
		check(snapshot.backend === "cli", "14. backend=cli：快照记录后端", String(snapshot.backend));
		check(
			init.actions.every((action) => action.type !== "delegate") &&
				init.actions.find((action) => action.name === "handoff")?.type === "warn",
			"14. backend=cli：忽略 console 记录，按 self 只 warn 上游更新",
			JSON.stringify(init.actions)
		);
		check(init.confirm.needs === false, "14. backend=cli：上游更新不触发确认", JSON.stringify(init.confirm));
		delete process.env.DSH_COMMANDS_SKILL_BACKEND;
	}

	// ---- 15) 同一快照两次 plan 深相等 --------------------------------------
	await reset();
	{
		const { snapshot } = await observe();
		snapshot.cache.changed = ["git-kit"];
		const first = planOperation("init", {}, snapshot);
		const second = planOperation("init", {}, snapshot);
		check(
			JSON.stringify(first.actions) === JSON.stringify(second.actions) &&
				JSON.stringify(first.confirm) === JSON.stringify(second.confirm) &&
				first.skipReason === second.skipReason,
			"15. 确定性：同一快照两次 plan 深相等",
			JSON.stringify({ first: first.actions, second: second.actions })
		);
	}

	// ---- 16) console v4 归一化（enabled 唯一启停 + mode auto/manual/hidden）----
	await reset({ canonical: names, links: names });
	{
		await writeState(
			[
				{ name: "git-kit", enabled: true, mode: "auto" },
				{ name: "handoff", enabled: true, mode: "manual" },
				{ name: "disk-cleanup", enabled: false, mode: "hidden" }
			],
			4
		);
		const state = await readConsoleState();
		const modes = Object.fromEntries((state?.installs ?? []).map((entry) => [entry.name, entry.mode]));
		check(state?.version === 4, "16. v4：state.version=4", String(state?.version));
		check(modes["git-kit"] === "on", "16. v4 auto → on", JSON.stringify(modes));
		check(modes["handoff"] === "manual", "16. v4 manual → manual", JSON.stringify(modes));
		check(modes["disk-cleanup"] === "off", "16. v4 enabled:false → off", JSON.stringify(modes));
	}

	// ---- 17) v4 hidden（enabled:true + mode:hidden）→ hidden，只读不写 ----
	await reset({ canonical: names, links: names });
	{
		await writeState([{ name: "git-kit", enabled: true, mode: "hidden" }], 4);
		const state = await readConsoleState();
		check(state?.installs?.find((entry) => entry.name === "git-kit")?.mode === "hidden", "17. v4 mode:hidden → hidden", JSON.stringify(state?.installs));
		const { plan } = await observe(process.env, { console: { present: true, state } });
		const action = plan("init").actions.find((entry) => entry.name === "git-kit");
		check(
			action?.type === "delegate" && action?.writes === false && action?.reason === "console-hidden",
			"17. v4 hidden：delegate/writes:false",
			JSON.stringify(action)
		);
	}

	// ---- 18) v1 / v3 归一化 ----------------------------------------------
	await reset();
	{
		await writeState([{ name: "git-kit", mode: "off" }, { name: "handoff", mode: "on" }], 1);
		const v1 = await readConsoleState();
		check(
			v1?.installs?.find((entry) => entry.name === "git-kit")?.mode === "off" &&
				v1?.installs?.find((entry) => entry.name === "handoff")?.mode === "on",
			"18. v1 mode off/on 归一化",
			JSON.stringify(v1?.installs)
		);
		await writeState([{ name: "git-kit", enabled: false }, { name: "handoff", enabled: true }], 3);
		const v3 = await readConsoleState();
		check(
			v3?.installs?.find((entry) => entry.name === "git-kit")?.mode === "off" &&
				v3?.installs?.find((entry) => entry.name === "handoff")?.mode === "on",
			"18. v3 enabled 归一化",
			JSON.stringify(v3?.installs)
		);
	}

	// ---- 19) 未来版本（>4）→ unknown（只读不写）--------------------------
	await reset({ canonical: names, links: names });
	{
		await writeState([{ name: "git-kit", enabled: true, mode: "auto" }], 5);
		const state = await readConsoleState();
		check(state?.installs?.[0]?.mode === "unknown", "19. v5 → unknown", JSON.stringify(state?.installs));
		const { plan } = await observe(process.env, { console: { present: true, state } });
		const action = plan("init").actions.find((entry) => entry.name === "git-kit");
		check(
			action?.type === "delegate" && action?.writes === false && action?.reason === "console-unknown",
			"19. v5 unknown：delegate/writes:false",
			JSON.stringify(action)
		);
	}

	// ---- 20) off/hidden/manual/unknown 全部 writes:false -----------------
	await reset({ canonical: names, links: names });
	{
		const cases = [
			["off", 4, { enabled: false, mode: "auto" }],
			["hidden", 4, { enabled: true, mode: "hidden" }],
			["manual", 4, { enabled: true, mode: "manual" }],
			["unknown", 5, { enabled: true, mode: "auto" }]
		];
		for (const [mode, version, entry] of cases) {
			await writeState([{ name: "git-kit", ...entry }], version);
			const state = await readConsoleState();
			const { plan } = await observe(process.env, { console: { present: true, state } });
			const action = plan("init").actions.find((item) => item.name === "git-kit");
			check(
				action?.type === "delegate" && action?.writes === false && action?.reason === `console-${mode}`,
				`20. console ${mode}：delegate/writes:false`,
				JSON.stringify(action)
			);
		}
	}

	// ---- 附加：模块级只读探测 ----------------------------------------------
	{
		check(backendOf({}) === "auto", "附加：backend 默认 auto");
		check(backendOf({ DSH_COMMANDS_SKILL_BACKEND: "nonsense" }) === "auto", "附加：非法 backend 回落 auto");
		check(detectConsole({}, { resolvePackage: () => { throw Object.assign(new Error("x"), { code: "MODULE_NOT_FOUND" }); } }) === false, "附加：包不存在 → false");
		check(detectConsole({}, { resolvePackage: () => "/x" }) === true, "附加：包存在 → true");
		check(detectConsole({}, { resolvePackage: () => { throw Object.assign(new Error("boom"), { code: "EACCES" }); } }) === null, "附加：未知错误 → null");
		check(
			resolveOwnership("x", { backend: "auto", consolePresent: false, state: null }).owner === "self",
			"附加：console 不存在 → self"
		);
	}
} finally {
	for (const key of Object.keys(process.env)) {
		if (!(key in saved)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(saved)) {
		if (process.env[key] !== value) process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`plan 冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("plan 冒烟通过：observe/plan 20 例 + 附加探测符合预期");
