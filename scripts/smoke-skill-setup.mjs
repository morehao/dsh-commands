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
if (process.env.STUB_FAIL === "1") {
	process.stdout.write("╭──────────────────────╮\\n│   resolving source   │\\n╰──────────────────────╯\\n─────\\n");
	process.stderr.write("[stub] registry unreachable\\n");
	process.exit(1);
}
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
	check(text.includes("✓ git-kit") && text.includes("✓ handoff"), "init：缺失技能被安装", text);
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
	check(text.startsWith("✓ 无需操作："), "init 幂等：首行是结论式「无需操作」", text);
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
	check(scoped.includes("技能更新 · handoff ·"), "update：可按技能名限定范围", scoped);
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
	check(!text.includes("✓ git-kit"), "init：不受影响的技能不被重复处理", text);

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
	check(text.includes("✓ tech-design：已安装"), "install：显式技能名被软链", text);
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
	check(text.includes("✓ demo-b：已安装"), "install：未指定技能名时按目录 diff 建链", text);
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
	// ---- 8) 过程可见：后台任务（jobs） -------------------------------------
	// 假注册表：只实现 runInJob 用到的那几个方法，断言"启动一次 / 阶段文案 / 流式输出 /
	// 结算前已 wait（awaited → 不投完成通知）/ 结果带回作业视图"。
	const { runInJob } = await import("../lib/job-progress.js");
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const createFakeJobs = () => {
		const state = { starts: [], progresses: [], chunks: [], waits: 0, settled: false, view: undefined };
		const id = "skill-init-fake0000000000000";
		const api = {
			start(spec) {
				state.starts.push({ id, kind: spec.kind, label: spec.label, owner: spec.owner });
				const handle = {
					append: (text, options) => state.chunks.push({ text, channel: options?.channel }),
					updateProgress: (line) => state.progresses.push(line),
				};
				spec.run(handle).done.then(() => {
					state.settled = true;
					state.awaited = state.waits > 0;
				});
				state.view = () => ({
					id,
					kind: spec.kind,
					label: spec.label,
					status: state.settled ? "completed" : "running",
				});
				return id;
			},
			get: () => state.view(),
			async wait() {
				state.waits += 1;
				await sleep(2);
				return state.view();
			},
			kill: () => {},
			readAt: async () => ({ chunks: state.chunks }),
		};
		return { api, state, id };
	};

	const fake = createFakeJobs();
	const outcome = await runInJob({
		jobs: fake.api,
		owner: "session-1",
		kind: "skill-init",
		label: "检查并安装插件依赖的技能",
		work: (reporter, registerCancel) => runSkillInit(COMMANDS, { reporter, registerCancel }),
	});
	check(fake.state.starts.length === 1, "jobs：只启动一个作业", JSON.stringify(fake.state.starts));
	check(
		fake.state.starts[0]?.kind === "skill-init" &&
			fake.state.starts[0]?.owner === "session-1" &&
			String(fake.state.starts[0]?.label ?? "").length > 0,
		"jobs：kind / owner / label 透传",
		JSON.stringify(fake.state.starts[0]),
	);
	check(
		fake.state.progresses.length >= 3 &&
			fake.state.progresses.some((line) => line.includes("检查依赖技能")) &&
			fake.state.progresses.some((line) => line.includes("校验命令分支契约")),
		"jobs：阶段文案实时刷新",
		JSON.stringify(fake.state.progresses),
	);
	check(
		fake.state.chunks.some((chunk) => typeof chunk.text === "string" && chunk.text.includes("stub: installed")),
		"jobs：CLI 输出流进作业面板",
		JSON.stringify(fake.state.chunks),
	);
	check(
		fake.state.chunks.some((chunk) => chunk.channel === "log" && String(chunk.text).includes("检查依赖技能")),
		"jobs：阶段文案同时写进输出（log 通道，面板里能读到执行流水）",
		JSON.stringify(fake.state.chunks.slice(0, 4)),
	);
	check(fake.state.awaited === true, "jobs：结算前已 wait（awaited，不投完成通知）", JSON.stringify(fake.state));
	check(outcome.job?.id === fake.id, "jobs：结果带回作业视图", JSON.stringify(outcome.job));
	check(
		String(outcome.value).includes("技能依赖检查 ·") && !String(outcome.value).includes("CLI："),
		"jobs：回执是结构化文本（不再塞 CLI 原始输出）",
		outcome.value,
	);

	// 用户停止（作业被 kill）→ killed 分支
	let killWorkDone = false;
	const killed = await runInJob({
		jobs: {
			start: (spec) => {
				spec.run({ append: () => {}, updateProgress: () => {} });
				return "killed-job";
			},
			get: () => ({ id: "killed-job", status: "running" }),
			wait: async () => {
				killWorkDone = true;
				return { id: "killed-job", status: "killed" };
			},
			kill: () => {},
			readAt: async () => ({ chunks: [{ text: "partial" }] }),
		},
		owner: "session-1",
		kind: "skill-init",
		label: "x",
		work: () => runSkillInit(COMMANDS, {}),
	});
	check(killed.killed === true && killWorkDone, "jobs：作业被停止时返回 killed（不误报成功）", JSON.stringify(killed));

	// 无事可做：命令自己给出理由 → 不建作业（头部不出现零输出的空作业行），工作照常执行
	const idleJobs = createFakeJobs();
	const idleOutcome = await runInJob({
		jobs: idleJobs.api,
		owner: "session-1",
		kind: "skill-init",
		label: "x",
		skip: "git-kit、handoff 均已托管，没有需要安装或修复的技能",
		work: () => runSkillInit(COMMANDS, {}),
	});
	check(idleJobs.state.starts.length === 0, "无事可做：没有启动作业", JSON.stringify(idleJobs.state.starts));
	check(
		idleOutcome.job === undefined &&
			idleOutcome.skippedReason !== undefined &&
			typeof idleOutcome.value === "string" &&
			idleOutcome.value.length > 0,
		"无事可做：跳过作业但照常执行并出回执",
		String(idleOutcome.value),
	);

	// 命令被取消（signal）→ 只 kill 作业、继续等终态（保住 awaited）
	const abortController = new AbortController();
	let abortKillCalls = 0;
	let abortKilled = false;
	const abortOutcome = await runInJob({
		jobs: {
			start: (spec) => {
				spec.run({ append: () => {}, updateProgress: () => {} });
				return "abort-job";
			},
			get: () => ({ id: "abort-job", status: abortKilled ? "killed" : "running" }),
			wait: async () => {
				if (!abortKilled) abortController.abort();
				return { id: "abort-job", status: abortKilled ? "killed" : "running" };
			},
			kill: () => {
				abortKilled = true;
				abortKillCalls += 1;
			},
			readAt: async () => ({ chunks: [] }),
		},
		owner: "session-1",
		kind: "skill-init",
		label: "x",
		signal: abortController.signal,
		work: () => runSkillInit(COMMANDS, {}),
	});
	check(
		abortKillCalls === 1 && abortOutcome.killed === true,
		"取消：signal 中止只 kill 作业并继续等到终态",
		JSON.stringify({ abortKillCalls, status: abortOutcome.job?.status }),
	);

	// 降级 1：没有 jobs 服务
	const degraded = await runInJob({
		jobs: undefined,
		owner: "session-1",
		kind: "skill-init",
		label: "x",
		work: () => runSkillInit(COMMANDS, {}),
	});
	check(
		degraded.job === undefined && typeof degraded.value === "string" && degraded.fallbackReason.length > 0,
		"降级：jobs 缺失时直接执行并保留回执",
		JSON.stringify(degraded.fallbackReason),
	);

	// 降级 2：有服务但没控制器（start 抛错）——工作还没开始，必须退回而不是失败
	const noController = {
		start() {
			throw new Error("background jobs unavailable: no job controller serves this agent");
		},
	};
	const fellBack = await runInJob({
		jobs: noController,
		owner: "session-1",
		kind: "skill-update",
		label: "y",
		work: () => runSkillUpdate(COMMANDS, "", {}),
	});
	check(
		fellBack.job === undefined && String(fellBack.value).includes("技能更新 ·"),
		"降级：无控制器时退回直接执行（不报失败）",
		String(fellBack.value),
	);

	// 失败回执：保留真正的错误行，剥掉 clack 的框线/分隔线
	process.env.STUB_FAIL = "1";
	let cliFailure = null;
	try {
		await runSkillUpdate(COMMANDS, "", {});
	} catch (error) {
		cliFailure = error;
	}
	delete process.env.STUB_FAIL;
	const failureText = cliFailure === null ? "" : String(cliFailure.message);
	check(failureText.includes("registry unreachable"), "失败回执：保留真正的错误行", failureText);
	check(failureText.length > 0 && !/[│╭╰─]/.test(failureText), "失败回执：框线/装饰线被剥掉", failureText);
	// ---- 9) 端到端：apply() 注册的 handler 真的把命令挂到作业上 ------------
	const { apply } = await import("../lib/index.js");
	const registered = new Map();
	const driveEffect = (input) => {
		const generator = typeof input === "function" ? input() : input;
		let step = generator.next();
		while (!step.done) step = generator.next(step.value);
		return step.value;
	};
	const e2eJobs = createFakeJobs();
	apply({
		effect: (generator) => driveEffect(generator),
		get: (name) => (name === "jobs" ? e2eJobs.api : undefined),
		commands: {
			register(definition) {
				registered.set(definition.name, definition);
				return () => registered.delete(definition.name);
			},
		},
	});
	check(
		registered.size === 13 && registered.has("skill-init") && registered.has("git-message"),
		"e2e：注册了 13 条命令（10 委托 + 3 本地）",
		[...registered.keys()].join(","),
	);
	const e2eResult = await registered.get("skill-init").handler({
		rawInput: "",
		signal: undefined,
		agent: { session: { id: "session-e2e" } },
	});
	check(e2eResult.kind === "success" && e2eResult.text.includes("技能依赖检查 ·"), "e2e：/skill-init 返回结构化回执", e2eResult.text);
	check(e2eResult.text.includes("过程：作业 skill-init-fake"), "e2e：回执末行指向作业", e2eResult.text);
	check(e2eJobs.state.starts[0]?.owner === "session-e2e", "e2e：作业 owner 是当前会话", JSON.stringify(e2eJobs.state.starts[0]));
} finally {
	await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("冒烟通过：/skill-init、/skill-install、/skill-update 行为符合预期");
