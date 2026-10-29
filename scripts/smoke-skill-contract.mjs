/**
 * 契约校验（`scripts/check-skill-contract.mjs`）的离线冒烟。
 *
 * 背景：agent-skills #50（2026-10-23）把技能模型改成「本源 + 分发软链」——本源
 * `~/.agents/skills` 是 skills CLI 写入的真实内容，`$DSH_HOME/skills` 只是
 * `skills-fanout.sh` / `/skill-init` 建的软链层。契约校验必须与运行期预检共用
 * `skillRoots()` 的顺序，否则「发了本源、还没 fanout」的机器会被误报「技能未安装」。
 *
 * 用例（全部在临时 HOME 下；不联网、不碰真实 ~/.dsh / ~/.agents）：
 *   1) 只有本源 → 通过，解析到本源
 *   2) 只有 `$DSH_HOME/skills` → 通过（优先级最高的根）
 *   3) 只有 `$DSH_AGENTS_HOME/skills` → 通过（自定义 agents home）
 *   4) 软链层指向本源 → 通过，且优先报软链层（与 dsh 的根优先级一致）
 *   5) 缺分支文件 → 失败，指出具体 `references/<branch>.md`
 *   6) 缺技能 → 每个技能只报一次，并列出查过的所有路径
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(ok, label, detail) {
	if (ok) {
		console.log(`✓ ${label}`);
		return;
	}
	failures++;
	console.error(`✗ ${label}${detail === undefined ? "" : `\n  ${String(detail).replace(/\n/g, "\n  ")}`}`);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repoRoot, "scripts", "check-skill-contract.mjs");
const { COMMANDS } = await import("../dist/index.js");

const root = await mkdtemp(join(tmpdir(), "dsh-commands-contract-"));
const home = join(root, "home");
const dshHome = join(home, ".dsh");
const customAgentsHome = join(root, "agents-home");
const canonical = join(home, ".agents", "skills");
const dshSkills = join(dshHome, "skills");
const customSkills = join(customAgentsHome, "skills");

const skills = [...new Set(COMMANDS.map((command) => command.skill ?? "git-kit"))];
const branchesOf = (skill) =>
	COMMANDS.filter((command) => (command.skill ?? "git-kit") === skill).map((command) => command.branch);

/** 与真实目录一致：handoff 是单文件技能（没有 references/），其余按 COMMANDS 建分支文件。 */
async function writeSkill(dir, name, { withReferences = name !== "handoff", branches = branchesOf(name) } = {}) {
	await mkdir(join(dir, name), { recursive: true });
	await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: smoke fixture\n---\n`);
	if (!withReferences) return;
	await mkdir(join(dir, name, "references"), { recursive: true });
	for (const branch of branches) await writeFile(join(dir, name, "references", `${branch}.md`), "# branch\n");
}

async function reset({ target = canonical, names = skills } = {}) {
	for (const dir of [dshSkills, canonical, customSkills]) await rm(dir, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	for (const name of names) await writeSkill(target, name);
}

function run(env = {}) {
	// 只给必要变量：不继承外层的 DSH_HOME / DSH_AGENTS_HOME / DSH_COMMANDS_*，避免宿主机状态渗入。
	const result = spawnSync(process.execPath, [script], {
		cwd: repoRoot,
		env: { PATH: process.env.PATH, HOME: home, ...env },
		encoding: "utf8",
	});
	return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const mention = (text, value) => text.includes(value);

try {
	// ---- 1) 只有本源：新模型的常态（只跑 skills-install.sh，没有 fanout） ----
	await reset();
	{
		const result = run();
		check(result.code === 0, "1. 只有本源 → 通过", result.stderr);
		check(mention(result.stdout, `git-kit → ${join(canonical, "git-kit")}`), "1. 解析到本源目录", result.stdout);
		check(mention(result.stdout, `契约校验通过：${COMMANDS.length} 条命令 / 3 个技能`), "1. 汇总按技能去重", result.stdout);
	}

	// ---- 2) 只有 $DSH_HOME/skills（fanout 关掉、手工放的副本） ----
	await reset({ target: dshSkills });
	{
		const result = run({ DSH_HOME: dshHome });
		check(result.code === 0, "2. 只有 $DSH_HOME/skills → 通过", result.stderr);
		check(mention(result.stdout, `git-kit → ${join(dshSkills, "git-kit")}`), "2. 解析到软链层", result.stdout);
	}

	// ---- 3) 只有 $DSH_AGENTS_HOME/skills（自定义 agents home） ----
	await reset({ target: customSkills });
	{
		const result = run({ DSH_HOME: dshHome, DSH_AGENTS_HOME: customAgentsHome });
		check(result.code === 0, "3. 只有 $DSH_AGENTS_HOME/skills → 通过", result.stderr);
		check(mention(result.stdout, `handoff → ${join(customSkills, "handoff")}`), "3. 解析到自定义 agents home", result.stdout);
	}

	// ---- 4) 软链层 → 本源：与 skills-fanout.sh 的布局一致，优先报软链层 ----
	await reset();
	{
		await mkdir(dshSkills, { recursive: true });
		for (const name of skills) await symlink(join(canonical, name), join(dshSkills, name), "dir");
		const result = run({ DSH_HOME: dshHome });
		check(result.code === 0, "4. 软链层 → 本源 → 通过", result.stderr);
		check(mention(result.stdout, `handoff → ${join(dshSkills, "handoff")}`), "4. 优先解析到软链层", result.stdout);
	}

	// ---- 5) 缺分支文件：必须失败并指出具体文件 ----
	await reset();
	{
		await rm(join(canonical, "git-kit", "references", "commit-message.md"), { force: true });
		const result = run();
		check(result.code === 1, "5. 缺分支文件 → 退出码 1", `code=${result.code}`);
		check(mention(result.stderr, "/git-message → git-kit#commit-message"), "5. 指出命令与分支", result.stderr);
		check(mention(result.stderr, join(canonical, "git-kit", "references", "commit-message.md")), "5. 指出缺失文件", result.stderr);
	}

	// ---- 6) 缺技能：按技能去重（git-kit 有多条命令，只报一次），并列出所有查过的路径 ----
	await reset({ names: skills.filter((name) => name !== "handoff") });
	{
		const result = run({ DSH_HOME: dshHome });
		const missingLines = result.stderr.split("\n").filter((line) => line.includes("缺少技能：handoff"));
		check(result.code === 1, "6. 缺技能 → 退出码 1", `code=${result.code}`);
		check(missingLines.length === 1, "6. 每个缺技能只报一次", result.stderr);
		check(mention(result.stderr, join(dshSkills, "handoff", "SKILL.md")), "6. 列出 $DSH_HOME 根", result.stderr);
		check(mention(result.stderr, join(canonical, "handoff", "SKILL.md")), "6. 列出本源根", result.stderr);
		check(!mention(result.stderr, "缺少技能：git-kit"), "6. 已找到的技能不误报", result.stderr);
	}
} finally {
	await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`契约冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("契约冒烟通过：技能根顺序 / 缺分支 / 缺技能去重符合预期");
