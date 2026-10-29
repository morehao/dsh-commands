/**
 * `skill_init` 工具冒烟：15 例工具矩阵 + 交互不变量（设计 §测试 / 计划 §9.3）。
 *
 * 全部离线：临时 HOME/DSH_HOME/console state/CLI stub；console 存在性用注入。
 * 断言工具返回的 status/actions/contract/verification/markdown 与副作用（CLI argv、state 字节）。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

const STUB = `#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const argv = process.argv.slice(2);
await appendFile(process.env.STUB_LOG, JSON.stringify(argv) + "\\n");
const source = argv[1];
const skills = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--skill") skills.push(argv[++i]);
const branches = { "git-kit": ["commit-push","commit-message","branch","pr-create","pr-merge","tag","checkout-tag","release","slim","star-classify"], "disk-cleanup": ["cleanup"] };
for (const name of skills) {
	const dir = join(homedir(), ".agents", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), "---\\nname: " + name + "\\ndescription: stub\\n---\\n");
	const refs = branches[name] ?? [];
	if (refs.length > 0) {
		await mkdir(join(dir, "references"), { recursive: true });
		for (const b of refs) await writeFile(join(dir, "references", b + ".md"), "# " + b + "\\n");
	}
}
const lockPath = join(homedir(), ".agents", ".skill-lock.json");
let lock = { version: 3, skills: {} };
try { lock = JSON.parse(await readFile(lockPath, "utf8")); } catch {}
for (const name of skills) lock.skills[name] = { source, sourceUrl: source, sourceType: "github", skillFolderHash: "stub" };
await mkdir(join(homedir(), ".agents"), { recursive: true });
await writeFile(lockPath, JSON.stringify(lock, null, 2));
process.stdout.write("stub: installed " + skills.join(",") + "\\n");
`;

const root = await mkdtemp(join(tmpdir(), "dsh-commands-skill-tool-"));
const home = join(root, "home");
const dshHome = join(root, "dsh");
const consoleHome = join(root, "console");
const statePath = join(consoleHome, "state.json");
const cliLog = join(root, "stub.log");
const dshSkillsDir = join(dshHome, "skills");
const canonicalDir = (name) => join(home, ".agents", "skills", name);
const linkPath = (name) => join(dshSkillsDir, name);
const lockPath = join(home, ".agents", ".skill-lock.json");

const saved = { ...process.env };
let consoleHint = { present: false, state: null };
let ctxState = { userQuestions: undefined, jobs: undefined };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	process.env.HOME = home;
	process.env.DSH_HOME = dshHome;
	process.env.DSH_SKILLS_CONSOLE_HOME = consoleHome;
	process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE = join(root, "stub-skills.mjs");
	process.env.STUB_LOG = cliLog;
	await writeFile(process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE, STUB, { mode: 0o755 });
	await writeFile(cliLog, "");
	await mkdir(dshSkillsDir, { recursive: true });
	await mkdir(join(home, ".agents"), { recursive: true });
	await mkdir(consoleHome, { recursive: true });

	const { createSkillInitTool, narrowToMissing, planHasWrites } = await import("../lib/tool-skill-init.js");
	const { readConsoleState } = await import("../lib/skills-console.js");
	const { COMMANDS } = await import("../lib/index.js");
	const { planOperation } = await import("../lib/skill-setup.js");
	const names = ["git-kit", "handoff", "disk-cleanup"];
	const refsFor = new Map();
	for (const def of COMMANDS) {
		const skill = def.skill ?? "git-kit";
		if (!refsFor.has(skill)) refsFor.set(skill, new Set());
		refsFor.get(skill).add(def.branch);
	}

	const makeTool = (overrides = {}) =>
		createSkillInitTool({
			env: process.env,
			commands: COMMANDS,
			services: {
				userQuestions: () => ctxState.userQuestions,
				jobs: () => ctxState.jobs
			},
			console: () => consoleHint,
			...overrides
		});

	const asker = (answer) => {
		const state = { calls: 0 };
		return {
			state,
			service: {
				async ask(request) {
					state.calls += 1;
					return { answers: [{ id: request.questions[0].id, selected: [answer] }] };
				}
			}
		};
	};

	const createFakeJobs = () => {
		const state = { starts: [], waits: 0, settled: false, view: undefined };
		const api = {
			start(spec) {
				state.starts.push(spec);
				const handle = { append() {}, updateProgress() {} };
				spec.run(handle).done.then(() => {
					state.settled = true;
				});
				state.view = () => ({ id: "job-1", kind: spec.kind, label: spec.label, status: state.settled ? "completed" : "running" });
				return "job-1";
			},
			get: () => state.view(),
			async wait() {
				state.waits += 1;
				await sleep(1);
				return state.view();
			},
			kill: () => {},
			readAt: async () => ({ chunks: [] })
		};
		return { api, state };
	};

	const writeSkill = async (name) => {
		await mkdir(canonicalDir(name), { recursive: true });
		await writeFile(join(canonicalDir(name), "SKILL.md"), `# ${name}\n`);
		const refs = refsFor.get(name) ?? new Set();
		if (refs.size > 0) {
			await mkdir(join(canonicalDir(name), "references"), { recursive: true });
			for (const branch of refs) await writeFile(join(canonicalDir(name), "references", `${branch}.md`), "# branch\n");
		}
	};
	const reset = async ({ canonical = [], links = [], installs = null, lock = null } = {}) => {
		await rm(join(home, ".agents"), { recursive: true, force: true });
		await rm(dshSkillsDir, { recursive: true, force: true });
		await mkdir(dshSkillsDir, { recursive: true });
		await mkdir(join(home, ".agents"), { recursive: true });
		for (const name of canonical) await writeSkill(name);
		for (const name of links) await symlink(canonicalDir(name), linkPath(name), "dir");
		await rm(statePath, { force: true });
		if (installs !== null) await writeFile(statePath, `${JSON.stringify({ version: 3, installs })}\n`);
		if (lock !== null) await writeFile(lockPath, `${JSON.stringify(lock)}\n`);
		await writeFile(cliLog, "");
		consoleHint = { present: false, state: null };
		ctxState = { userQuestions: undefined, jobs: undefined };
	};
	const cliCalls = async () =>
		(await readFile(cliLog, "utf8"))
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line));
	const stateBytes = async () => {
		try {
			return await readFile(statePath, "utf8");
		} catch {
			return null;
		}
	};
	const lockBytes = async () => {
		try {
			return await readFile(lockPath, "utf8");
		} catch {
			return null;
		}
	};
	const run = async (tool, args = {}, exec = {}) =>
		tool.execute(args, { agent: { session: { id: "session-tool" } }, signal: undefined, ...exec });
	const enabledHint = async (installs) => {
		consoleHint = { present: true, state: { path: statePath, installs } };
		return consoleHint;
	};

	// ---- 1) console 不存在：安装 + 建链；job 绑定 owner ---------------------
	await reset();
	{
		const fake = createFakeJobs();
		ctxState.jobs = fake.api;
		const result = await run(makeTool(), { mode: "init", yes: true });
		const calls = await cliCalls();
		check(result.status === "changed" && result.actions.filter((a) => a.status === "changed").length === 3, "1. 无 console：安装 3 个技能，status=changed", JSON.stringify(result.actions));
		check(calls.length === 1 && calls[0].filter((arg) => arg === "--skill").length === 3, "1. 无 console：CLI 只调一次、批量 3 个", JSON.stringify(calls));
		check(fake.state.starts.length === 1 && fake.state.starts[0].owner === "session-tool" && fake.state.starts[0].kind === "skill-init", "1. 工具复用 runInJob：kind/owner 透传", JSON.stringify(fake.state.starts));
		check(fake.state.waits > 0, "1. 作业被 wait 到终态（awaited）", String(fake.state.waits));
		check(result.verification.canonical === "3/3" && result.verification.links === "3/3", "1. verify：canonical 3/3、links 3/3", JSON.stringify(result.verification));
		check((await readFile(join(linkPath("git-kit"), "SKILL.md"), "utf8")).includes("git-kit"), "1. 链可解析");
	}

	// ---- 2) console on：init/update 都交给控制台 ---------------------------
	await reset({ canonical: names, links: names, installs: names.map((name) => ({ name, mode: "on" })) });
	await enabledHint(names.map((name) => ({ name, mode: "on" })));
	{
		const init = await run(makeTool(), { mode: "init" });
		check(init.status === "ok" && init.actions.every((a) => a.status === "delegated"), "2. console on：delegate，零写", JSON.stringify(init.actions));
		check((await cliCalls()).length === 0, "2. console on：init 不调 CLI");
		check(init.next.some((item) => item.includes("控制台")), "2. 回执提示去控制台", JSON.stringify(init.next));
		const update = await run(makeTool(), { mode: "update" });
		check(update.status === "ok" && update.actions.every((a) => a.status === "delegated"), "2. console on：--update 也不写", JSON.stringify(update.actions));
		check((await cliCalls()).length === 0, "2. console on：--update 不调 CLI");
	}

	// ---- 3) console off：不装、不建链 --------------------------------------
	await reset({ canonical: names, links: names, installs: names.map((name) => ({ name, mode: "off" })) });
	await enabledHint(names.map((name) => ({ name, mode: "off" })));
	{
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.status === "ok" && result.actions.every((a) => a.status === "delegated" && a.detail.includes("停用")), "3. console off：delegate + 停用说明", JSON.stringify(result.actions));
		check((await cliCalls()).length === 0, "3. console off：不调 CLI");
		check(result.next.some((item) => item.includes("DSH_COMMANDS_SKILL_BACKEND=cli")), "3. 提示可切 cli 接管", JSON.stringify(result.next));
	}

	// ---- 4) backend=console + 无记录 --------------------------------------
	await reset({ installs: [] });
	await enabledHint([]);
	process.env.DSH_COMMANDS_SKILL_BACKEND = "console";
	{
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.status === "blocked" && (await cliCalls()).length === 0, "4. backend=console 无记录：blocked，零写", JSON.stringify(result.actions));
		check(result.next.some((item) => item.includes("控制台尚未纳管") || item.includes("控制台")), "4. 提示去控制台安装", JSON.stringify(result.next));
	}
	delete process.env.DSH_COMMANDS_SKILL_BACKEND;

	// ---- 5) backend=cli + on：忽略记录，--update 调 CLI ---------------------
	await reset({ canonical: names, links: names, installs: names.map((name) => ({ name, mode: "on" })) });
	await enabledHint(names.map((name) => ({ name, mode: "on" })));
	process.env.DSH_COMMANDS_SKILL_BACKEND = "cli";
	{
		const result = await run(makeTool(), { mode: "update" });
		check(result.status === "changed" && (await cliCalls()).length === 1, "5. backend=cli：--update 调 CLI", JSON.stringify(result.actions));
		check(result.warnings.some((item) => item.includes("记账可能过期")), "5. 回执警告控制台记账可能过期", JSON.stringify(result.warnings));
	}
	delete process.env.DSH_COMMANDS_SKILL_BACKEND;

	// ---- 6) state 损坏 + auto：无记录，正常安装 ----------------------------
	await reset();
	await writeFile(statePath, "{not json");
	consoleHint = { present: true, state: await readConsoleState() };
	{
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.status === "changed" && (await cliCalls()).length === 1, "6. state 损坏 + auto：按 CLI 安装", JSON.stringify(result.actions));
	}

	// ---- 7) state 损坏 + console 后端：不写 --------------------------------
	await reset();
	await writeFile(statePath, "{not json");
	consoleHint = { present: true, state: await readConsoleState() };
	process.env.DSH_COMMANDS_SKILL_BACKEND = "console";
	{
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.status === "blocked" && (await cliCalls()).length === 0, "7. state 损坏 + console：blocked，零写", JSON.stringify(result.actions));
		check(result.next.some((item) => item.includes("状态不可读") || item.includes("修复")), "7. 提示修复控制台或切 cli", JSON.stringify(result.next));
	}
	delete process.env.DSH_COMMANDS_SKILL_BACKEND;

	// ---- 8) console on + 链缺失：只修链 ------------------------------------
	await reset({ canonical: names, links: ["handoff", "disk-cleanup"], installs: names.map((name) => ({ name, mode: "on" })), lock: { version: 3, skills: {} } });
	await enabledHint(names.map((name) => ({ name, mode: "on" })));
	{
		const lockBefore = await lockBytes();
		const stateBefore = await stateBytes();
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.status === "changed" && (await cliCalls()).length === 0, "8. 只修链：不调 CLI", JSON.stringify(result.actions));
		check(result.actions.find((a) => a.name === "git-kit")?.action === "relink" && result.actions.find((a) => a.name === "git-kit")?.status === "changed", "8. git-kit 重建软链", JSON.stringify(result.actions));
		check((await lockBytes()) === lockBefore, "8. 不改 lock");
		check((await stateBytes()) === stateBefore, "8. 不改 console state");
	}

	// ---- 9) console on + canonical 缺失：不装 ------------------------------
	await reset({ canonical: ["handoff", "disk-cleanup"], links: ["handoff", "disk-cleanup"], installs: names.map((name) => ({ name, mode: "on" })) });
	await enabledHint(names.map((name) => ({ name, mode: "on" })));
	{
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.status === "blocked" && (await cliCalls()).length === 0, "9. canonical 缺失：blocked，零写", JSON.stringify(result.actions));
		check(result.next.some((item) => item.includes("canonical") || item.includes("控制台")), "9. 提示去控制台处理", JSON.stringify(result.next));
	}

	// ---- 10) state 冻结：一次混合写前后字节一致 ----------------------------
	await reset({ canonical: ["handoff", "disk-cleanup"], links: ["handoff"], installs: [{ name: "handoff", mode: "on" }] });
	await enabledHint([{ name: "handoff", mode: "on" }]);
	{
		const before = await stateBytes();
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.status === "changed", "10. 混合：装上缺失技能", JSON.stringify(result.actions));
		check((await cliCalls()).length === 1, "10. 混合：CLI 只装缺失项", JSON.stringify(await cliCalls()));
		check((await stateBytes()) === before, "10. state 字节前后一致");
	}

	// ---- 11) console on + 分支文件缺失：契约可执行提示 ---------------------
	await reset({ canonical: ["git-kit", "handoff", "disk-cleanup"], links: names, installs: names.map((name) => ({ name, mode: "on" })) });
	await rm(join(canonicalDir("git-kit"), "references", "commit-message.md"), { force: true });
	await enabledHint(names.map((name) => ({ name, mode: "on" })));
	{
		const result = await run(makeTool(), { mode: "check" });
		check(result.status === "attention" && result.contract.problems.length > 0, "11. 契约漂移：attention + 契约问题", JSON.stringify(result.contract));
		check(result.contract.problems.some((item) => item.includes("控制台里的技能版本") || item.includes("契约")), "11. 提示在控制台更新或切 cli", JSON.stringify(result.contract.problems));
	}

	// ---- 12) console off + 文件存在：仍 delegate ---------------------------
	await reset({ canonical: names, links: names, installs: [{ name: "git-kit", mode: "off" }] });
	await enabledHint([{ name: "git-kit", mode: "off" }]);
	{
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.actions.find((a) => a.name === "git-kit")?.status === "delegated", "12. console off：delegate（命令层软警告不在工具）", JSON.stringify(result.actions));
		check((await cliCalls()).length === 0, "12. console off：零写");
	}

	// ---- 13) console 不存在 + 残留记录：按 CLI 并警告 ----------------------
	await reset({ installs: [{ name: "git-kit", mode: "on" }] });
	consoleHint = { present: false, state: await readConsoleState() };
	{
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.status === "changed" && (await cliCalls()).length === 1, "13. 残留记录：按 CLI 安装", JSON.stringify(result.actions));
		check(result.warnings.some((item) => item.includes("残留记录")), "13. 警告记录可能过期", JSON.stringify(result.warnings));
	}

	// ---- 14) 混合所有权：A 修链 / B 停用 / C 安装 --------------------------
	await reset({
		canonical: ["git-kit", "handoff"],
		links: ["handoff"],
		installs: [
			{ name: "git-kit", mode: "on" },
			{ name: "handoff", mode: "off" }
		]
	});
	await enabledHint([
		{ name: "git-kit", mode: "on" },
		{ name: "handoff", mode: "off" }
	]);
	{
		const result = await run(makeTool(), { mode: "init", yes: true });
		const calls = await cliCalls();
		check(calls.length === 1 && calls[0].includes("disk-cleanup") && !calls[0].includes("git-kit"), "14. 只有 C（无记录缺失）调 CLI", JSON.stringify(calls));
		check(result.actions.find((a) => a.name === "git-kit")?.action === "relink", "14. A 只修链", JSON.stringify(result.actions));
		check(result.actions.find((a) => a.name === "handoff")?.status === "delegated", "14. B 完全不动", JSON.stringify(result.actions));
		check(result.actions.find((a) => a.name === "disk-cleanup")?.status === "changed", "14. C 走 bootstrap 安装", JSON.stringify(result.actions));
		check(result.status === "changed", "14. 混合结果 changed", result.status);
	}

	// ---- 15) console on + 上游更新：不调 CLI、不改 lock/state --------------
	await reset({ canonical: names, links: names, installs: names.map((name) => ({ name, mode: "on" })), lock: { version: 3, skills: {} } });
	await enabledHint(names.map((name) => ({ name, mode: "on" })));
	{
		const { observeSkills } = await import("../lib/skill-setup.js");
		const observeChanged = async (...args) => {
			const snapshot = await observeSkills(...args);
			snapshot.cache.changed = [...names];
			return snapshot;
		};
		const lockBefore = await lockBytes();
		const stateBefore = await stateBytes();
		const result = await run(makeTool({ observe: observeChanged }), { mode: "init", yes: true });
		check((await cliCalls()).length === 0 && result.actions.every((a) => a.status === "delegated"), "15. 上游更新：仍 delegate，不调 CLI", JSON.stringify(result.actions));
		check((await lockBytes()) === lockBefore && (await stateBytes()) === stateBefore, "15. 不改 lock / state");
		check(result.next.some((item) => item.includes("控制台")), "15. 提示去控制台更新", JSON.stringify(result.next));
	}

	// ---- 16) headless（无 userQuestions、未 yes）：只出 plan ----------------
	await reset();
	{
		const result = await run(makeTool(), { mode: "init" });
		check(result.status === "plan" && result.requiresConfirmation === true, "16. headless：status=plan + requiresConfirmation", JSON.stringify({ status: result.status, requiresConfirmation: result.requiresConfirmation }));
		check((await cliCalls()).length === 0, "16. headless：零写（不调 CLI）");
		check(result.next.some((item) => item.includes("yes=true")), "16. 提示需要显式同意", JSON.stringify(result.next));
	}

	// ---- 17) headless + yes=true：允许执行 ---------------------------------
	await reset();
	{
		const result = await run(makeTool(), { mode: "init", yes: true });
		check(result.status === "changed" && (await cliCalls()).length === 1, "17. headless + yes：显式授权后执行", JSON.stringify(result.actions));
	}

	// ---- 18) 用户取消：零写、只问一次 --------------------------------------
	await reset();
	{
		const ask = asker("取消");
		ctxState.userQuestions = ask.service;
		const result = await run(makeTool(), { mode: "init" });
		check(result.status === "cancelled" && ask.state.calls === 1, "18. 取消：status=cancelled，只问一次", JSON.stringify({ status: result.status, calls: ask.state.calls }));
		check((await cliCalls()).length === 0, "18. 取消：零写");
	}

	// ---- 19) 只补缺失：不修链、不更新 --------------------------------------
	await reset({
		canonical: ["git-kit", "handoff"],
		links: [],
		installs: [{ name: "handoff", mode: "on" }]
	});
	await enabledHint([{ name: "handoff", mode: "on" }]);
	{
		const ask = asker("只补缺失");
		ctxState.userQuestions = ask.service;
		const result = await run(makeTool(), { mode: "init" });
		const calls = await cliCalls();
		check(calls.length === 1 && calls[0].filter((arg) => arg === "--skill").length === 2, "19. 只补缺失：只装 2 个缺失技能", JSON.stringify(calls));
		check(result.actions.find((a) => a.name === "handoff")?.status === "skipped", "19. 只补缺失：handoff 修链降级为 skip", JSON.stringify(result.actions));
		check(result.actions.find((a) => a.name === "git-kit")?.status === "changed", "19. git-kit 被安装", JSON.stringify(result.actions));
		check(!existsSync(linkPath("handoff")), "19. handoff 链仍缺失（只补缺失不修链）");
	}

	// ---- 20) 指纹变化：确认后链被改动，整次中止 ---------------------------
	await reset();
	{
		const { observeSkills } = await import("../lib/skill-setup.js");
		let calls = 0;
		const observeFlaky = async (...args) => {
			calls += 1;
			const snapshot = await observeSkills(...args);
			if (calls >= 2) {
				const skill = snapshot.skills.find((entry) => entry.name === "git-kit");
				skill.link.kind = "managed";
			}
			return snapshot;
		};
		const result = await run(makeTool({ observe: observeFlaky }), { mode: "init", yes: true });
		check(result.status === "attention" && result.summary.includes("环境已变化"), "20. 指纹变化：attention，未写盘", JSON.stringify({ status: result.status, summary: result.summary }));
		check((await cliCalls()).length === 0, "20. 指纹变化：不调 CLI");
	}

	// ---- 21) 未知 names：attention，零写 -----------------------------------
	await reset();
	{
		const result = await run(makeTool(), { mode: "init", names: ["nope"], yes: true });
		check(result.status === "attention" && result.summary.includes("未知技能"), "21. 未知 names：attention", JSON.stringify(result));
		check((await cliCalls()).length === 0, "21. 未知 names：零写");
	}

	// ---- 22) 作业被停止：cancelled，不误报成功 ----------------------------
	await reset();
	{
		let seen;
		const runJobKilled = async (options) => {
			seen = options;
			return { killed: true, job: { id: "job-k", status: "killed" }, outputTail: "" };
		};
		const controller = new AbortController();
		const result = await run(makeTool({ runJob: runJobKilled }), { mode: "init", yes: true }, { signal: controller.signal });
		check(result.status === "cancelled" && result.summary.includes("已停止"), "22. 作业停止：status=cancelled", JSON.stringify({ status: result.status, summary: result.summary }));
		check(seen?.kind === "skill-init" && seen?.owner === "session-tool" && seen?.signal === controller.signal, "22. runJob 收到 kind/owner/signal", JSON.stringify({ kind: seen?.kind, owner: seen?.owner }));
		check((await cliCalls()).length === 0, "22. 停止后未调 CLI");
	}

	// ---- 23) render 与 schema ---------------------------------------------
	{
		const tool = makeTool();
		const result = await run(tool, { mode: "check" });
		const rendered = tool.output.render({}, result);
		check(rendered.length === 1 && rendered[0].type === "text" && rendered[0].text === result.markdown, "23. render 返回 markdown 文本");
		check(tool.parameters.mode.enum.join(",") === "init,update,check", "23. parameters.mode enum", JSON.stringify(tool.parameters.mode));
		check(tool.output.schema.additionalProperties === true, "23. output schema 允许扩展字段（actions/contract…）");
	}

	// ---- 24) apply：命令注册不受工具注册失败影响 --------------------------
	{
		const { apply } = await import("../lib/index.js");
		const commands = [];
		let effects = 0;
		const ctx = {
			effect(fn) {
				effects += 1;
				const iterator = fn();
				return (async () => {
					for (;;) {
						const step = iterator.next();
						if (step.done) return;
						await step.value;
					}
				})();
			},
			commands: {
				async register(def) {
					commands.push(def.name);
				}
			},
			get: (name) => (name === "tools" ? { register() {} } : undefined)
		};
		const pending = apply(ctx);
		check(pending !== null && typeof pending?.then === "function", "24. apply 是 async（工具注册需要动态 import）");
		await pending;
		await sleep(10);
		check(effects === 0 && commands.length === COMMANDS.length + 2, "24. 宿主无 dsh-tools：命令照常注册（无 effect 包装）", JSON.stringify({ effects, commands: commands.length }));
	}

	// ---- 25) R1：停止 → 生产者结算 killed（不是 failed）-------------------
	{
		const { runInJob } = await import("../lib/job-progress.js");
		let handle;
		const jobs = {
			start(spec) {
				handle = spec.run({ append() {}, updateProgress() {} });
				return "job-killed";
			},
			get: () => ({ id: "job-killed", status: "running" }),
			async wait() {
				return { id: "job-killed", status: "killed" };
			},
			kill() {
				handle.cancel("stopped");
			},
			readAt: async () => ({ chunks: [] })
		};
		const result = await runInJob({
			jobs,
			owner: "session-tool",
			kind: "skill-init",
			label: "停止测试",
			signal: AbortSignal.abort(),
			work: (_reporter, registerCancel) =>
				new Promise((_resolve, reject) => {
					registerCancel(() => reject(new Error("stopped")));
				})
		});
		check(result.killed === true, "25. R1：停止后 runInJob 返回 killed", JSON.stringify(result));
	}

	// ---- 26) 缓存过期只读探针：上游更新 → attention，零写 ----------------
	await reset({ canonical: names, links: names });
	{
		const { observeSkills } = await import("../lib/skill-setup.js");
		const observeStale = async (...args) => {
			const snapshot = await observeSkills(...args);
			snapshot.cache = { cacheSource: true, fresh: false, stale: true, changed: [] };
			return snapshot;
		};
		let probed = 0;
		const result = await run(
			makeTool({
				observe: observeStale,
				probe: async () => {
					probed += 1;
					return { cache: undefined, changed: ["git-kit"] };
				}
			}),
			{ mode: "init", yes: true }
		);
		check(probed === 1 && result.status === "attention", "26. 只读探针：调用一次，status=attention", JSON.stringify({ probed, status: result.status }));
		check(result.summary.includes("上游有 1 项更新") && result.next.some((item) => item.includes("--update")), "26. 提示上游更新与 --update", JSON.stringify({ summary: result.summary, next: result.next }));
		check((await cliCalls()).length === 0, "26. 只读探针：零写");
	}

	// ---- 27) 纯函数：narrowToMissing / planHasWrites ------------------------
	{
		const snapshot = {
			version: 1,
			backend: "auto",
			consolePresent: false,
			consoleState: null,
			source: "x",
			paths: { dshSkillsDir, canonicalSkillsDir: join(home, ".agents", "skills") },
			cache: { cacheSource: false, fresh: false, changed: [] },
			requirements: [],
			warnings: [],
			skills: names.map((name) => ({
				name,
				canonical: { ok: false, path: canonicalDir(name) },
				link: { kind: name === "git-kit" ? "missing" : "managed", target: undefined },
				lock: null,
				console: { present: false, record: null },
				effectiveDir: canonicalDir(name),
				shadowed: false,
				state: name === "git-kit" ? "missing" : "managed",
				linkPath: linkPath(name),
				target: undefined,
				isSymlink: name !== "git-kit",
				isDirectory: false
			}))
		};
		const plan = planOperation("init", {}, snapshot);
		const narrowed = narrowToMissing(plan);
		check(planHasWrites(plan) === true && narrowed.actions.some((a) => a.name === "git-kit" && a.type === "install"), "27. planHasWrites + 只补缺失保留 missing install");
		check(narrowed.confirm.needs === true && narrowed.confirm.installs === 1, "27. 只补缺失重算 confirm", JSON.stringify(narrowed.confirm));
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
	console.error(`tool 冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("tool 冒烟通过：skill_init 15 例矩阵 + 交互不变量符合预期");
