/**
 * `skill_init` 核心（observe / plan）的离线冒烟（v1.0：API 消费版）。
 *
 * 只读：不装技能、不联网、不写真实 ~/.dsh / ~/.agents。console 记录来自注入的 fake api，
 * 不依赖真实安装、不读 state.json。fixture 全部落在临时 HOME/DSH_HOME 下。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const canonicalDir = (name) => join(home, ".agents", "skills", name);

const saved = { ...process.env };
try {
	process.env.HOME = home;
	process.env.DSH_HOME = dshHome;

	const { observeSkills, planOperation, requirements } = await import("../dist/skill-setup.js");
	const { COMMANDS } = await import("../dist/index.js");
	const names = ["git-kit", "handoff", "disk-cleanup"];

	await mkdir(join(home, ".agents", "skills"), { recursive: true });
	await mkdir(join(dshHome, "skills"), { recursive: true });

	const writeSkill = async (name) => {
		await mkdir(canonicalDir(name), { recursive: true });
		await writeFile(join(canonicalDir(name), "SKILL.md"), `# ${name}\n`);
		const branches = COMMANDS.filter((c) => (c.skill ?? "git-kit") === name).map((c) => c.branch);
		if (name !== "handoff" && branches.length > 0) {
			await mkdir(join(canonicalDir(name), "references"), { recursive: true });
			for (const branch of branches) await writeFile(join(canonicalDir(name), "references", `${branch}.md`), "# b\n");
		}
	};
	const reset = async ({ canonical = [] } = {}) => {
		await rm(join(home, ".agents"), { recursive: true, force: true });
		await mkdir(join(home, ".agents", "skills"), { recursive: true });
		for (const name of canonical) await writeSkill(name);
	};
	const fakeApi = (records = []) => ({
		apiVersion: 1,
		async list({ names: only } = {}) {
			return records.filter((row) => !only || only.includes(row.name));
		},
	});
	const observe = (records, options = {}) => observeSkills(process.env, COMMANDS, { api: fakeApi(records), ...options });
	const actionsOf = (plan, type) => plan.actions.filter((action) => action.type === type).map((action) => action.name);

	// ---- 1) 全 missing，api 无记录 -----------------------------------------
	await reset();
	{
		const snapshot = await observe([]);
		const init = planOperation("init", {}, snapshot);
		check(JSON.stringify(actionsOf(init, "install")) === JSON.stringify(names), "1. 全缺失：3 个 install，顺序 = REQUIRED_SKILLS", JSON.stringify(init.actions));
		check(init.confirm.needs === true && init.confirm.installs === 3, "1. 全缺失：confirm.needs=true", JSON.stringify(init.confirm));
		check(init.skipReason === undefined, "1. 全缺失：无 skipReason", String(init.skipReason));
		check(snapshot.consolePresent === true && snapshot.consoleError === null, "1. 快照：有 api、无 consoleError", JSON.stringify({ present: snapshot.consolePresent }));
		check(
			requirements(COMMANDS).length === COMMANDS.length &&
				requirements(COMMANDS).every((req) => typeof req.file === "string" && req.file.startsWith("references/")),
			"1. requirements：每个命令一条分支契约",
		);
	}

	// ---- 2) 全 installed ------------------------------------------------
	await reset({ canonical: names });
	{
		const init = planOperation("init", {}, await observe(names.map((name) => ({ name, mode: "auto" }))));
		check(init.actions.every((action) => action.type === "skip"), "2. 全安装：没有写 action", JSON.stringify(init.actions));
		check(init.skipReason === "已全部安装，无需操作", "2. 全安装：skipReason 精确", String(init.skipReason));
		check(init.confirm.needs === false, "2. 全安装：不需要确认");
	}

	// ---- 3) console off / hidden / manual → delegate，零写 -----------------
	await reset({ canonical: names });
	{
		for (const mode of ["off", "hidden", "manual"]) {
			const snapshot = await observe([{ name: "git-kit", mode }]);
			const init = planOperation("init", {}, snapshot);
			const action = init.actions.find((item) => item.name === "git-kit");
			check(action?.type === "delegate" && action?.writes === false && action?.reason === `console-${mode}`, `3. console ${mode}：delegate/零写`, JSON.stringify(action));
		}
	}

	// ---- 4) console auto 记录 = on：installed 跳过 / missing 安装 ----------
	await reset({ canonical: ["handoff", "disk-cleanup"] });
	{
		const init = planOperation("init", {}, await observe(names.map((name) => ({ name, mode: "auto" }))));
		check(init.actions.find((a) => a.name === "git-kit")?.type === "install", "4. auto + 缺失：install", JSON.stringify(init.actions));
		check(init.actions.find((a) => a.name === "handoff")?.type === "skip", "4. auto + 已装：skip", JSON.stringify(init.actions));
	}

	// ---- 5) api.list 抛 read-only → 全部 blocked/零写 ---------------------
	await reset({ canonical: names });
	{
		const snapshot = await observeSkills(process.env, COMMANDS, {
			api: { apiVersion: 1, async list() { throw Object.assign(new Error("state read-only"), { code: "read-only" }); } },
		});
		const init = planOperation("init", {}, snapshot);
		check(snapshot.consoleError?.code === "read-only", "5. list 抛错：快照记录 consoleError", JSON.stringify(snapshot.consoleError));
		check(init.actions.every((a) => a.type === "blocked" && a.writes === false), "5. list 抛错：全部 blocked", JSON.stringify(init.actions));
		check(init.confirm.needs === false, "5. blocked 不触发确认");
	}

	// ---- 6) check 只读：missing → warn，installed → skip ------------------
	await reset({ canonical: ["handoff"] });
	{
		const init = planOperation("check", {}, await observe([]));
		check(init.actions.every((a) => a.writes === false), "6. check：全部零写", JSON.stringify(init.actions));
		check(init.actions.find((a) => a.name === "git-kit")?.type === "warn", "6. check：缺失 warn", JSON.stringify(init.actions));
		check(init.actions.find((a) => a.name === "handoff")?.type === "skip", "6. check：已装 skip", JSON.stringify(init.actions));
	}

	// ---- 7) update：installed → update，missing → skip -------------------
	await reset({ canonical: ["git-kit", "handoff"] });
	{
		const plan = planOperation("update", {}, await observe([]));
		check(actionsOf(plan, "update").join(",") === "git-kit,handoff", "7. update：已装两项 update", JSON.stringify(plan.actions));
		check(plan.actions.find((a) => a.name === "disk-cleanup")?.type === "skip", "7. update：缺失 skip", JSON.stringify(plan.actions));
		check(plan.confirm.needs === true, "7. update：有写盘需确认");
	}

	// ---- 8) 确定性：同一快照两次 plan 深相等 ------------------------------
	await reset();
	{
		const snapshot = await observe([]);
		const first = planOperation("init", {}, snapshot);
		const second = planOperation("init", {}, snapshot);
		check(
			JSON.stringify(first.actions) === JSON.stringify(second.actions) && JSON.stringify(first.confirm) === JSON.stringify(second.confirm),
			"8. 确定性：同一快照两次 plan 深相等",
		);
	}

	// ---- 9) 不写 ~/.dsh/skills：observe/plan 全程只读 ---------------------
	check(!existsSync(join(dshHome, "skills", "git-kit")), "9. 不再往 ~/.dsh/skills 建链");
} finally {
	for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
	for (const [key, value] of Object.entries(saved)) if (process.env[key] !== value) process.env[key] = value;
	await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`plan 冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("plan 冒烟通过：observe/plan（API 消费版）符合预期");
