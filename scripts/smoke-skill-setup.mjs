#!/usr/bin/env node
// /skill-init 与 /skill-update 的行为冒烟测试：不联网、不碰真实 HOME。
//
// 用 DSH_COMMANDS_SKILL_CLI 指向一个 stub 可执行文件来顶替 `npx skills`，覆盖六条路径：
//   1) missing            → 安装 + 软链进 $DSH_HOME/skills
//   2) 再跑一次（managed） → 跳过，且不再调用 CLI
//   3) unmanaged（本地 clone 软链）→ 替换为托管软链（本地 clone 不受影响）
//   4) /skill-update      → 幂等重装，软链仍然有效
//   5) 真实目录           → 拒绝覆盖（不删除、不备份），其余技能不受影响
//   6) /skill-install     → 任意来源安装（显式技能名 / 装全部 / 缺参数报错），同样只替换软链
// 另外校验：全程不产生 skills-backup/ 之类的备份目录（设计上不做备份）。
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stub：把 --skill 指定的技能（不指定时模拟"该来源的两个技能"）写到 $HOME/.agents/skills/<name>/，
// 记录调用行，并写一份 lock（模拟上游行为，用来覆盖 lock 匹配路径）。
const STUB = `#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
await appendFile(process.env.STUB_LOG, JSON.stringify(argv) + "\\n");
const source = argv[1];
const skills = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--skill") skills.push(argv[++i]);
if (skills.length === 0) skills.push("demo-a", "demo-b");
const branches = { "git-kit": ["commit-push","commit-message","branch","pr-create","pr-merge","tag","release","slim","star-classify"] };
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
const localClone = join(root, "ai-kit-clone");
const stubLog = join(root, "stub.log");

try {
	await mkdir(join(home, ".agents"), { recursive: true });
	await mkdir(join(dshHome, "skills"), { recursive: true });
	await mkdir(localClone, { recursive: true });

	const stub = join(root, "stub-skills.mjs");
	await writeFile(stub, STUB, { mode: 0o755 });
	await writeFile(stubLog, "");

	// skill-setup 里 canonical 目录由 homedir() 决定、技能根由 DSH_HOME 决定，
	// 改 process.env 即可把它们指向临时目录（不触碰真实 ~/.dsh、~/.agents）。
	process.env.HOME = home;
	process.env.DSH_HOME = dshHome;
	process.env.DSH_COMMANDS_SKILL_CLI = stub;
	process.env.STUB_LOG = stubLog;
	process.env.DSH_COMMANDS_SKILL_TIMEOUT_MS = "60000";

	const { runSkillInit, runSkillUpdate } = await import("../lib/skill-setup.js");
	const { COMMANDS } = await import("../lib/index.js");

	const canonical = (name) => join(home, ".agents", "skills", name);
	const linkPath = (name) => join(dshHome, "skills", name);
	const stubCalls = async () =>
		(await readFile(stubLog, "utf8")).split("\n").filter((line) => line.trim()).length;
	const readlinkOrError = (p) =>
		readlink(p).catch((error) => `readlink 失败：${error.code ?? error.message}`);

	// ---- 1) missing → 安装 + 软链 -------------------------------------------
	let text = await runSkillInit(COMMANDS, {});
	check(text.includes("+ git-kit") && text.includes("+ handoff"), "init：缺失技能被安装", text);
	check(existsSync(join(canonical("git-kit"), "SKILL.md")), "init：canonical 目录已生成");
	check(
		existsSync(linkPath("git-kit")) && existsSync(linkPath("handoff")),
		"init：两个技能都软链进 $DSH_HOME/skills",
		`${linkPath("git-kit")} / ${linkPath("handoff")}`,
	);
	check((await readlinkOrError(linkPath("git-kit"))) === canonical("git-kit"), "init：软链指向 canonical 目录");
	check(!text.includes("契约问题"), "init：契约校验无失败项", text);

	const argv0 = JSON.parse((await readFile(stubLog, "utf8")).trim().split("\n")[0]);
	check(
		argv0.includes("add") && argv0.includes("-g") && argv0.includes("universal") && argv0.includes("-y"),
		"init：CLI 参数含 -g / -a universal / -y",
		JSON.stringify(argv0),
	);
	check(
		argv0.filter((arg) => arg === "--skill").length === 2,
		"init：只为缺失技能传 --skill",
		JSON.stringify(argv0),
	);

	// ---- 2) 已托管 → 跳过且不调 CLI -----------------------------------------
	const callsBefore = await stubCalls();
	text = await runSkillInit(COMMANDS, {});
	check(text.includes("已托管，跳过"), "init 幂等：已托管技能跳过", text);
	check((await stubCalls()) === callsBefore, "init 幂等：未再次调用 CLI");

	// ---- 3) unmanaged（本地 clone 软链）→ 替换，不做备份 --------------------
	await rm(linkPath("handoff"));
	await writeFile(join(localClone, "SKILL.md"), "---\nname: handoff\ndescription: local\n---\n");
	await symlink(localClone, linkPath("handoff"), "dir");
	text = await runSkillInit(COMMANDS, {});
	check(text.includes("↻ handoff：已替换为托管软链"), "init：非托管软链被替换", text);
	check((await readlinkOrError(linkPath("handoff"))) === canonical("handoff"), "init：替换后软链指向 canonical");
	check(existsSync(join(localClone, "SKILL.md")), "init：本地 clone 未被删除（只动了链接）");
	check(!existsSync(join(dshHome, "skills-backup")), "init：不生成任何备份目录");

	// ---- 4) /skill-update ---------------------------------------------------
	const callsBeforeUpdate = await stubCalls();
	text = await runSkillUpdate(COMMANDS, "", {});
	check(text.includes("✓ git-kit") && text.includes("✓ handoff"), "update：两个托管技能都更新", text);
	check((await stubCalls()) === callsBeforeUpdate + 1, "update：只调用一次 CLI（批量）");
	check(existsSync(join(linkPath("git-kit"), "SKILL.md")), "update：软链仍可读");

	const scoped = await runSkillUpdate(COMMANDS, "handoff", {});
	check(scoped.includes("技能更新（1 个：handoff）"), "update：可按技能名限定范围", scoped);
	await runSkillUpdate(COMMANDS, "nonexistent", {}).then(
		() => check(false, "update：未知技能名应报错"),
		(error) => check(String(error.message).includes("未知技能"), "update：未知技能名报错", String(error.message)),
	);

	// ---- 5) 真实目录 → 拒绝覆盖（不删除、不备份） ---------------------------
	await rm(linkPath("handoff"));
	await mkdir(linkPath("handoff"), { recursive: true });
	await writeFile(
		join(linkPath("handoff"), "SKILL.md"),
		"---\nname: handoff\ndescription: 手工拷进来的\n---\n",
	);
	text = await runSkillInit(COMMANDS, {});
	check(text.includes("✗ handoff") && text.includes("拒绝覆盖"), "init：真实目录被拒绝覆盖", text);
	check((await stat(linkPath("handoff"))).isDirectory(), "init：真实目录原样保留（没有删）");
	check(
		(await readFile(join(linkPath("handoff"), "SKILL.md"), "utf8")).includes("手工拷进来的"),
		"init：真实目录内容未被改动",
	);
	check(!existsSync(join(dshHome, "skills-backup")), "init：拒绝覆盖时同样没有备份目录");
	check(!text.includes("+ git-kit"), "init：不受影响的技能不被重复处理", text);

	// ---- 6) /skill-install：任意来源 ---------------------------------------
	const { runSkillInstall } = await import("../lib/skill-setup.js");

	await runSkillInstall(COMMANDS, "", {}).then(
		() => check(false, "install：缺来源时应报错"),
		(error) => check(String(error.message).includes("缺少来源"), "install：缺来源报错", String(error.message)),
	);

	const callsBeforeInstall = await stubCalls();
	text = await runSkillInstall(COMMANDS, "acme/toolkit tech-design", {});
	const installArgv = JSON.parse((await readFile(stubLog, "utf8")).trim().split("\n").pop());
	check(
		installArgv[0] === "add" && installArgv[1] === "acme/toolkit" && installArgv.includes("tech-design"),
		"install：把来源与技能名透传给 CLI",
		JSON.stringify(installArgv),
	);
	check(
		installArgv.includes("-a") && installArgv[installArgv.indexOf("-a") + 1] === "universal",
		"install：同样固定 -a universal",
		JSON.stringify(installArgv),
	);
	check(text.includes("+ tech-design：已安装"), "install：显式技能名被软链", text);
	check(
		(await readlinkOrError(linkPath("tech-design"))) === canonical("tech-design"),
		"install：软链指向 canonical",
	);
	check((await stubCalls()) === callsBeforeInstall + 1, "install：只调用一次 CLI");

	// 装"全部"：CLI 未收到 --skill，靠 canonical 目录 diff 找出新技能；
	// 同时把 demo-a 预先做成真实目录，验证 install 也拒绝覆盖真实目录。
	await mkdir(linkPath("demo-a"), { recursive: true });
	await writeFile(join(linkPath("demo-a"), "SKILL.md"), "---\nname: demo-a\ndescription: 手工拷入\n---\n");
	text = await runSkillInstall(COMMANDS, "acme/bundle", {});
	check(text.includes("+ demo-b：已安装"), "install：未指定技能名时按目录 diff 建链", text);
	check(text.includes("✗ demo-a") && text.includes("拒绝覆盖"), "install：真实目录同样拒绝覆盖", text);
	check((await stat(linkPath("demo-a"))).isDirectory(), "install：真实目录原样保留");
	check(
		(await readlinkOrError(linkPath("demo-b"))) === canonical("demo-b"),
		"install：diff 发现的技能也被软链",
	);

	// ---- 7) 未托管/缺失时 update 只提示 -------------------------------------
	text = await runSkillUpdate(COMMANDS, "", {});
	check(
		text.includes("不由 skills CLI 托管") || text.includes("未安装，跳过"),
		"update：非托管/缺失条目给出提示",
		text,
	);
} finally {
	await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("冒烟通过：/skill-init、/skill-install、/skill-update 行为符合预期");
