/**
 * `skill_init` 工具冒烟（v1.0：API 消费版）。
 *
 * 全部离线：临时 HOME/DSH_HOME + 注入 fake api（写 canonical）。
 * 覆盖：安装、幂等、console 停用 delegate、API 缺失/旧 console blocked、update 本地改动 warn、
 * 确认（plan/cancel/yes）、纯函数 narrowToMissing / planHasWrites、render/schema。
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

const root = await mkdtemp(join(tmpdir(), "dsh-commands-skill-tool-"));
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

	const { createSkillInitTool, narrowToMissing, planHasWrites, renderPlanDetail } = await import("../dist/tool-skill-init.js");
	const { observeSkills, planOperation } = await import("../dist/skill-setup.js");
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

	function makeFakeApi() {
		const state = { installed: new Set(), records: new Map(), installCalls: [], updateCalls: [], updateStatus: {} };
		return {
			state,
			api: {
				apiVersion: 1,
				async list({ names: only } = {}) {
					const keys = new Set([...state.installed, ...state.records.keys()]);
					return [...keys]
						.filter((n) => !only || only.includes(n))
						.map((n) => ({ name: n, mode: state.records.get(n) ?? "auto" }));
				},
				async adopt({ name }) { return { name, already: state.installed.has(name), subscriptionId: null, tracked: false }; },
				async install({ source, skills }) {
					state.installCalls.push([...skills]);
					const installed = [];
					for (const name of skills) { await writeSkill(name); state.installed.add(name); installed.push({ name, treeSha: null }); }
					return { ok: true, source, subscriptionId: "sub-1", commit: "c".repeat(40), installed, warnings: [] };
				},
				async update({ names: targets }) {
					state.updateCalls.push([...targets]);
					return {
						ok: true,
						results: targets.map((name) => ({ name, status: state.updateStatus[name] ?? "current", fromCommit: null, toCommit: null })),
					};
				},
			},
		};
	}

	const makeTool = ({ resolveApi, userQuestions } = {}) => createSkillInitTool({
		env: process.env,
		commands: COMMANDS,
		services: { userQuestions: () => userQuestions, jobs: () => undefined },
		resolveApi: resolveApi ?? (async () => ({ api: makeFakeApi().api })),
	});
	// 允许传入具体 api 实例的便捷构造
	const toolWith = (api, { userQuestions } = {}) => createSkillInitTool({
		env: process.env,
		commands: COMMANDS,
		services: { userQuestions: () => userQuestions, jobs: () => undefined },
		resolveApi: async () => ({ api }),
	});
	const run = (tool, args = {}, exec = {}) => tool.execute(args, { agent: { session: { id: "s" } }, signal: undefined, ...exec });

	// ---- 1) 安装 ----
	await reset();
	{
		const { api, state } = makeFakeApi();
		const result = await run(toolWith(api), { mode: "init", yes: true });
		check(result.status === "changed" && result.actions.filter((a) => a.status === "changed").length === 3, "1. init：安装 3 个，status=changed", JSON.stringify(result.actions));
		check(state.installCalls.length === 1, "1. init：install 只调一次", JSON.stringify(state.installCalls));
		check(result.verification.canonical === "3/3", "1. verify：canonical 3/3", JSON.stringify(result.verification));
		check(result.contract.ok === true, "1. 契约通过", JSON.stringify(result.contract));
		check(!existsSync(join(dshHome, "skills", "git-kit")), "1. 不写 ~/.dsh/skills");
	}

	// ---- 2) 幂等：已安装 → 无写 ----
	{
		const { api, state } = makeFakeApi();
		for (const name of names) { await writeSkill(name); state.installed.add(name); }
		const result = await run(toolWith(api), { mode: "init", yes: true });
		check(result.status === "ok" && state.installCalls.length === 0, "2. 幂等：已安装无写、status=ok", JSON.stringify({ status: result.status }));
	}

	// ---- 3) console 停用 → delegate，零写 ----
	await reset();
	{
		const { api, state } = makeFakeApi();
		for (const name of names) state.records.set(name, "off");
		const result = await run(toolWith(api), { mode: "init", yes: true });
		check(result.actions.every((a) => a.status === "delegated") && state.installCalls.length === 0, "3. console off：全部 delegate，零写", JSON.stringify(result.actions));
		check(result.next.some((item) => item.includes("控制台")), "3. 回执提示去控制台", JSON.stringify(result.next));
	}

	// ---- 4) API 缺失 → blocked ----
	await reset();
	{
		const result = await run(makeTool({ resolveApi: async () => { throw Object.assign(new Error("未找到 @morehao/dsh-skills-console/api"), { code: "api-missing" }); } }), { mode: "init", yes: true });
		check(result.status === "blocked" && result.next.some((item) => item.includes("npm i @morehao/dsh-skills-console")), "4. API 缺失：blocked + 安装指引", JSON.stringify({ status: result.status, next: result.next }));
	}

	// ---- 5) 旧 console → blocked ----
	{
		const result = await run(makeTool({ resolveApi: async () => { throw Object.assign(new Error("旧 console v0.6.0"), { code: "old-console" }); } }), { mode: "init", yes: true });
		check(result.status === "blocked" && result.next.some((item) => item.includes("升级")), "5. 旧 console：blocked + 升级提示", JSON.stringify({ status: result.status, next: result.next }));
	}

	// ---- 6) update：locally-modified → warn，不覆盖 ----
	await reset();
	{
		const { api, state } = makeFakeApi();
		for (const name of names) { await writeSkill(name); state.installed.add(name); }
		state.updateStatus.handoff = "locally-modified";
		const result = await run(toolWith(api), { mode: "update", yes: true });
		check(result.actions.find((a) => a.name === "handoff")?.status === "warn", "6. update：locally-modified → warn", JSON.stringify(result.actions));
		check(result.status === "attention", "6. update：有 warn → attention", result.status);
	}

	// ---- 7) update：updated / current ----
	{
		const { api, state } = makeFakeApi();
		for (const name of names) { await writeSkill(name); state.installed.add(name); }
		state.updateStatus["git-kit"] = "updated";
		const result = await run(toolWith(api), { mode: "update", yes: true });
		check(result.actions.find((a) => a.name === "git-kit")?.status === "changed", "7. update：updated → changed", JSON.stringify(result.actions));
		check(result.actions.find((a) => a.name === "handoff")?.status === "skipped", "7. update：current → skipped", JSON.stringify(result.actions));
	}

	// ---- 8) 无确认通道、未 yes → 只出 plan ----
	await reset();
	{
		const { api, state } = makeFakeApi();
		const result = await run(toolWith(api), { mode: "init" });
		check(result.status === "plan" && result.requiresConfirmation === true, "8. headless：status=plan + requiresConfirmation", JSON.stringify({ status: result.status, req: result.requiresConfirmation }));
		check(state.installCalls.length === 0, "8. headless：零写");
	}

	// ---- 9) 用户取消 → cancelled ----
	{
		const { api, state } = makeFakeApi();
		const asker = { async ask(req) { return { answers: [{ id: req.questions[0].id, selected: ["取消"] }] }; } };
		const result = await run(toolWith(api, { userQuestions: asker }), { mode: "init" });
		check(result.status === "cancelled" && state.installCalls.length === 0, "9. 取消：status=cancelled，零写", JSON.stringify({ status: result.status }));
	}

	// ---- 10) 纯函数：narrowToMissing / planHasWrites ----
	await reset();
	{
		const { api } = makeFakeApi();
		const snapshot = await observeSkills(process.env, COMMANDS, { api });
		const plan = planOperation("init", {}, snapshot);
		check(planHasWrites(plan) === true, "10. planHasWrites：有 install 动作");
		const narrowed = narrowToMissing(plan);
		check(narrowed.confirm.installs === 3 && narrowed.confirm.needs === true, "10. 只补缺失：保留 install，重算 confirm", JSON.stringify(narrowed.confirm));
	}

	// ---- 11) render / schema ----
	{
		const tool = makeTool();
		const result = await run(tool, { mode: "check" });
		const rendered = tool.output.render({}, result);
		check(rendered.length === 1 && rendered[0].type === "text" && rendered[0].text === result.markdown, "11. render 返回 markdown 文本");
		check(tool.parameters.mode.enum.join(",") === "init,update,check", "11. parameters.mode enum");
		check(tool.output.schema.additionalProperties === true, "11. output schema 允许扩展字段");
		check(typeof renderPlanDetail(planOperation("init", {}, { skills: [], warnings: [], source: "x", requirements: [] })) === "string", "11. renderPlanDetail 返回字符串");
	}
} finally {
	for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
	for (const [key, value] of Object.entries(saved)) if (process.env[key] !== value) process.env[key] = value;
	await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`tool 冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("tool 冒烟通过：skill_init（API 消费版）矩阵 + 交互不变量符合预期");
