#!/usr/bin/env node
// /skill-init（含 --update）的行为冒烟测试：不联网、不碰真实 HOME。
//
// 用 DSH_COMMANDS_SKILL_CLI_OVERRIDE 指向一个 stub 可执行文件来顶替 `npx skills`，覆盖五条路径：
//   1) missing            → 安装 + 软链进 $DSH_HOME/skills
//   2) 再跑一次（managed） → 跳过，且不再调用 CLI
//   3) unmanaged（本地 clone 软链）→ 替换为托管软链（本地 clone 不受影响）
//   4) --update           → 强制重装，软链仍然有效
//   5) 真实目录           → 拒绝覆盖（不删除、不备份），其余技能不受影响
// 另外校验：全程不产生 skills-backup/ 之类的备份目录（设计上不做备份）。
import { mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stub：把 --skill 指定的技能（不指定时模拟"该来源的两个技能"）写到 $HOME/.agents/skills/<name>/，
// 记录调用行，并写一份 lock（模拟上游行为，用来覆盖 lock 匹配路径）。
const STUB = `#!/usr/bin/env node
import { writeSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
await appendFile(process.env.STUB_LOG, JSON.stringify(argv) + "\\n");
if (process.env.STUB_ENV_LOG) {
	await appendFile(process.env.STUB_ENV_LOG, JSON.stringify({
		cloneTimeout: process.env.SKILLS_CLONE_TIMEOUT_MS ?? null,
		gitPrompt: process.env.GIT_TERMINAL_PROMPT ?? null,
	}) + "\\n");
}
if (process.env.STUB_HANG === "1") {
	setInterval(() => {}, 1000);
	await new Promise(() => {});
}
if (process.env.STUB_SLEEP_MS) {
	await new Promise((resolve) => setTimeout(resolve, Number(process.env.STUB_SLEEP_MS)));
}
if (process.env.STUB_NOISE === "1") {
	// writeSync：一次写 5 KB 的 spinner 必须先落盘再 exit，否则管道里的缓冲会被丢掉
	let noisy = "███████╗██╗  ██╗██╗██╗     ██╗     ███████╗\\n";
	noisy += "╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝\\n";
	const glyphs = ["◒", "◐", "◓", "◑"];
	for (let i = 0; i < 200; i += 1) noisy += glyphs[i % glyphs.length] + "  Cloning repository" + ".".repeat(i % 4) + "…\\r";
	noisy += "\\nFailed to connect to github.com port 443 after 75002 ms: Couldn't connect to server\\n";
	writeSync(1, noisy);
	process.exit(1);
}
if (process.env.STUB_FAIL === "1") {
	process.stdout.write("╭──────────────────────╮\\n│   resolving source   │\\n╰──────────────────────╯\\n─────\\n");
	process.stderr.write("[stub] registry unreachable\\n");
	process.exit(1);
}
const source = argv[1];
const skills = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--skill") skills.push(argv[++i]);
if (skills.length === 0) skills.push("demo-a", "demo-b");
const branches = { "git-kit": ["commit-push","commit-message","branch","pr-create","pr-merge","tag","release","slim","star-classify"], "disk-cleanup": ["cleanup"] };
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
const localClone = join(root, "agent-skills-clone");
const stubLog = join(root, "stub.log");
const stubEnvLog = join(root, "stub-env.log");

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
	process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE = stub;
	process.env.STUB_LOG = stubLog;
	process.env.STUB_ENV_LOG = stubEnvLog;
	process.env.DSH_COMMANDS_SKILL_TIMEOUT_MS = "60000";

	const {
		runSkillInit,
		runSkillUpdate,
		resolveSkillSource,
		probeUrlForSource,
		probeSourceReachability,
		planSkillOperation,
		installTargets,
	} = await import("../lib/skill-setup.js");
	const { COMMANDS } = await import("../lib/index.js");
	check(resolveSkillSource({}) === "morehao/agent-skills", "来源：默认 morehao/agent-skills");
	check(
		resolveSkillSource({ DSH_COMMANDS_SKILL_SOURCE: "acme/mirror" }) === "acme/mirror",
		"来源：DSH_COMMANDS_SKILL_SOURCE 可覆盖（镜像/本地目录逃生口）",
	);

	// ---- 0) 连通性预检：来源 → URL 归一化 -----------------------------------
	check(
		probeUrlForSource("morehao/agent-skills") === "https://github.com/morehao/agent-skills.git",
		"预检：owner/repo 归一为 GitHub HTTPS",
		probeUrlForSource("morehao/agent-skills"),
	);
	check(
		probeUrlForSource("https://github.com/morehao/agent-skills.git") === "https://github.com/morehao/agent-skills.git",
		"预检：HTTPS URL 原样使用",
		probeUrlForSource("https://github.com/morehao/agent-skills.git"),
	);
	check(
		probeUrlForSource("git+https://gitlab.com/acme/tools.git") === "https://gitlab.com/acme/tools.git",
		"预检：去掉 git+ 前缀",
		probeUrlForSource("git+https://gitlab.com/acme/tools.git"),
	);
	check(
		probeUrlForSource("git@github.com:morehao/agent-skills.git") === "git@github.com:morehao/agent-skills.git",
		"预检：SSH scp 语法原样使用",
		probeUrlForSource("git@github.com:morehao/agent-skills.git"),
	);
	check(
		probeUrlForSource("./local-skill") === undefined && probeUrlForSource("~/agent-skills/skills/svg-maker") === undefined,
		"预检：本地路径不联网探测",
	);
	const skippedProbe = await probeSourceReachability("morehao/agent-skills", {
		env: { DSH_COMMANDS_SKILL_PROBE_MS: "0" },
	});
	check(skippedProbe.status === "skipped", "预检：超时设为 0 时跳过", JSON.stringify(skippedProbe));
	const abortedProbe = await probeSourceReachability("morehao/agent-skills", {
		env: { DSH_COMMANDS_SKILL_PROBE_MS: "8000" },
		signal: AbortSignal.abort(),
	});
	check(abortedProbe.status === "skipped", "预检：命令已取消时不联网", JSON.stringify(abortedProbe));

	// 假 git 卡住：预检必须在自己的超时内杀掉它，而不是等硬超时
	const fakeBin = join(root, "fake-bin");
	await mkdir(fakeBin, { recursive: true });
	// 用绝对路径：测试把 PATH 收窄成 fake-bin，Linux 上 PATH 里没有 sleep。
	await writeFile(join(fakeBin, "git"), "#!/bin/sh\nexec /bin/sleep 5\n", { mode: 0o755 });
	const timedOutProbe = await probeSourceReachability("acme/slow", {
		env: { PATH: fakeBin, DSH_COMMANDS_SKILL_PROBE_MS: "120" },
	});
	check(
		timedOutProbe.status === "unreachable" && timedOutProbe.timedOut === true,
		"预检：git 卡住时按预检超时快速失败",
		JSON.stringify(timedOutProbe),
	);

	const canonical = (name) => join(home, ".agents", "skills", name);
	const linkPath = (name) => join(dshHome, "skills", name);
	const stubCalls = async () =>
		(await readFile(stubLog, "utf8")).split("\n").filter((line) => line.trim()).length;
	const readlinkOrError = (p) =>
		readlink(p).catch((error) => `readlink 失败：${error.code ?? error.message}`);

	// ---- 1) missing → 安装 + 软链 -------------------------------------------
	let text = await runSkillInit(COMMANDS, {});
	check(
		text.includes("✓ git-kit") && text.includes("✓ handoff") && text.includes("✓ disk-cleanup"),
		"init：缺失技能被安装",
		text,
	);
	check(existsSync(join(canonical("git-kit"), "SKILL.md")), "init：canonical 目录已生成");
	check(
		existsSync(linkPath("git-kit")) && existsSync(linkPath("handoff")) && existsSync(linkPath("disk-cleanup")),
		"init：三个技能都软链进 $DSH_HOME/skills",
		`${linkPath("git-kit")} / ${linkPath("handoff")} / ${linkPath("disk-cleanup")}`,
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
		argv0.filter((arg) => arg === "--skill").length === 3,
		"init：只为缺失技能传 --skill",
		JSON.stringify(argv0),
	);
	const cliEnv = JSON.parse((await readFile(stubEnvLog, "utf8")).trim().split("\\n").pop());
	check(
		cliEnv.cloneTimeout === "30000",
		"cli：克隆超时比外层硬超时早 30s（60000 → 30000），避免被 SIGKILL 截断诊断",
		JSON.stringify(cliEnv),
	);
	check(cliEnv.gitPrompt === "0", "cli：GIT_TERMINAL_PROMPT=0，凭据提示不会让命令无限挂起", JSON.stringify(cliEnv));

	// ---- 2) 已托管 → 跳过且不调 CLI -----------------------------------------
	const callsBefore = await stubCalls();
	text = await runSkillInit(COMMANDS, {});
	check(text.includes("已托管，跳过"), "init 幂等：已托管技能跳过", text);
	check(text.startsWith("✓ 无变更 ·"), "init 幂等：首行是结论式「无变更」", text);
	check((await stubCalls()) === callsBefore, "init 幂等：未再次调用 CLI");
	const idlePlan = await planSkillOperation("skill-init", COMMANDS, "");
	check(
		idlePlan.skipReason === "已全部托管，无需安装",
		"init：plan 给出短因（不复述回执结论）",
		String(idlePlan.skipReason),
	);

	// ---- 3) unmanaged（本地 clone 软链）→ 替换，不做备份 --------------------
	await rm(linkPath("handoff"));
	await writeFile(join(localClone, "SKILL.md"), "---\nname: handoff\ndescription: local\n---\n");
	await symlink(localClone, linkPath("handoff"), "dir");
	text = await runSkillInit(COMMANDS, {});
	check(text.includes("↻ handoff：已替换为托管软链"), "init：非托管软链被替换", text);
	check((await readlinkOrError(linkPath("handoff"))) === canonical("handoff"), "init：替换后软链指向 canonical");
	check(existsSync(join(localClone, "SKILL.md")), "init：本地 clone 未被删除（只动了链接）");
	check(!existsSync(join(dshHome, "skills-backup")), "init：不生成任何备份目录");

	// ---- 4) --update：强制重装 ----------------------------------------------
	const callsBeforeUpdate = await stubCalls();
	text = await runSkillUpdate(COMMANDS, "", {});
	check(
		text.includes("✓ git-kit") && text.includes("✓ handoff") && text.includes("✓ disk-cleanup"),
		"update：三个托管技能都更新",
		text,
	);
	check((await stubCalls()) === callsBeforeUpdate + 1, "update：只调用一次 CLI（批量）");
	check(existsSync(join(linkPath("git-kit"), "SKILL.md")), "update：软链仍可读");

	const scoped = await runSkillUpdate(COMMANDS, "handoff", {});
	check(scoped.includes("✅ 已更新：1 个技能") && scoped.includes("✓ handoff"), "update：可按技能名限定范围", scoped);
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
	check(text.includes("遮蔽提示"), "init：真实目录给出「会遮蔽托管版本」的提示", text);
	check((await stat(linkPath("handoff"))).isDirectory(), "init：真实目录原样保留（没有删）");
	check(
		(await readFile(join(linkPath("handoff"), "SKILL.md"), "utf8")).includes("手工拷进来的"),
		"init：真实目录内容未被改动",
	);
	check(!existsSync(join(dshHome, "skills-backup")), "init：拒绝覆盖时同样没有备份目录");
	check(!text.includes("✓ git-kit"), "init：不受影响的技能不被重复处理", text);

	// ---- 6) 连不上来源：不启动 CLI，几秒内给出可操作错误 ---------------------
	if (spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0) {
		const savedCli = process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE;
		const savedProbe = process.env.DSH_COMMANDS_SKILL_PROBE_MS;
		const savedSource = process.env.DSH_COMMANDS_SKILL_SOURCE;
		delete process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE;
		process.env.DSH_COMMANDS_SKILL_PROBE_MS = "2000";
		process.env.DSH_COMMANDS_SKILL_SOURCE = "http://127.0.0.1:1/x.git";
		let unreachableError = "";
		const probeStartedAt = Date.now();
		try {
			await runSkillUpdate(COMMANDS, "git-kit", {});
		} catch (error) {
			unreachableError = String(error.message);
		}
		const probeElapsed = Date.now() - probeStartedAt;
		if (savedCli === undefined) delete process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE;
		else process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE = savedCli;
		if (savedProbe === undefined) delete process.env.DSH_COMMANDS_SKILL_PROBE_MS;
		else process.env.DSH_COMMANDS_SKILL_PROBE_MS = savedProbe;
		if (savedSource === undefined) delete process.env.DSH_COMMANDS_SKILL_SOURCE;
		else process.env.DSH_COMMANDS_SKILL_SOURCE = savedSource;
		check(
			unreachableError.includes("连不上技能来源") && unreachableError.includes("代理"),
			"预检：明确网络不通时快速失败并给代理/镜像提示",
			unreachableError,
		);
		check(probeElapsed < 10_000, "预检：失败发生在硬超时之前", `${probeElapsed}ms`);
	}

	// 旧变量名只差一个 S：保留 fallback，避免已配置的用户升级后静默失效。
	const savedOverride = process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE;
	delete process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE;
	process.env.DSH_COMMANDS_SKILL_CLI = stub;
	const legacyPlan = await planSkillOperation("skill-init", COMMANDS, "");
	check(legacyPlan.freshness.cacheSource === false, "env：旧 CLI 变量名仍被识别（fallback）", JSON.stringify(legacyPlan.freshness));
	if (savedOverride === undefined) delete process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE;
	else process.env.DSH_COMMANDS_SKILL_CLI_OVERRIDE = savedOverride;
	delete process.env.DSH_COMMANDS_SKILL_CLI;

	// ---- 6b) 并发保护：第二次 Enter 不再并行执行 ---------------------------
	process.env.STUB_SLEEP_MS = "400";
	const firstUpdate = runSkillUpdate(COMMANDS, "git-kit", {});
	await new Promise((resolve) => setTimeout(resolve, 80));
	let concurrentError = "";
	try {
		await runSkillUpdate(COMMANDS, "git-kit", {});
	} catch (error) {
		concurrentError = String(error.message);
	}
	check(concurrentError.includes("已有技能更新任务正在进行"), "并发：第二次更新被拒绝（不重复克隆）", concurrentError);
	const firstUpdateText = await firstUpdate;
	check(firstUpdateText.includes("git-kit"), "并发：第一次更新正常完成", firstUpdateText);
	delete process.env.STUB_SLEEP_MS;

	// ---- 6c) 硬超时：错误写明"超时/强制终止"，且锁会释放 ---------------------
	process.env.STUB_HANG = "1";
	process.env.DSH_COMMANDS_SKILL_TIMEOUT_MS = "1200";
	const timeoutStartedAt = Date.now();
	let timeoutError = "";
	try {
		await runSkillUpdate(COMMANDS, "git-kit", {});
	} catch (error) {
		timeoutError = String(error.message);
	}
	const timeoutElapsed = Date.now() - timeoutStartedAt;
	delete process.env.STUB_HANG;
	process.env.DSH_COMMANDS_SKILL_TIMEOUT_MS = "60000";
	check(
		timeoutError.includes("更新超时") && timeoutError.includes("已强制终止"),
		"超时：回执写明超时与强制终止（不再是退出码 SIGKILL）",
		timeoutError,
	);
	check(timeoutElapsed < 5_000, "超时：按 DSH_COMMANDS_SKILL_TIMEOUT_MS 及时收敛", `${timeoutElapsed}ms`);
	text = await runSkillUpdate(COMMANDS, "git-kit", {});
	check(text.includes("✓ git-kit：已更新到最新"), "并发/超时：失败后锁已释放，下一次仍可执行", text);

	// ---- 7) 未托管/缺失时 --update 只提示 -----------------------------------
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
		String(outcome.value).startsWith("⚠ 已完成") && !String(outcome.value).includes("CLI："),
		"jobs：回执首行是结论（不再塞 CLI 原始输出）",
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
		skip: "git-kit、handoff、disk-cleanup 均已托管，没有需要安装或修复的技能",
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
		kind: "skill-init",
		label: "y",
		work: () => runSkillUpdate(COMMANDS, "", {}),
	});
	check(
		fellBack.job === undefined && String(fellBack.value).includes("✅ 已更新"),
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

	// 失败回执：clack 的 \\r 重绘 + ASCII logo 不能把卡片撑成几十 KB
	process.env.STUB_NOISE = "1";
	let noisyFailure = null;
	try {
		await runSkillUpdate(COMMANDS, "", {});
	} catch (error) {
		noisyFailure = error;
	}
	delete process.env.STUB_NOISE;
	const noisyText = noisyFailure === null ? "" : String(noisyFailure.message);
	check(noisyText.includes("Couldn't connect to server"), "失败回执：保留最后的网络错误行", noisyText);
	check(
		noisyText.length < 1_200,
		"失败回执：spinner 重绘被折叠（卡片不再爆长）",
		`${noisyText.length} 字符：${noisyText.slice(0, 200)}`,
	);
	check(
		(noisyText.match(/Cloning repository/g) ?? []).length === 1,
		"失败回执：重复的克隆进度只留一条",
		noisyText,
	);
	check(noisyText.includes("网络提示"), "失败回执：网络不可达时给出代理/镜像提示", noisyText);
	check(!/[█╗╚╔]/.test(noisyText), "失败回执：ASCII logo 被剥掉", noisyText);
	// ---- 9) 端到端：apply() 注册的 handler 真的把命令挂到作业上 ------------
	const { apply } = await import("../lib/index.js");
	const registered = new Map();
	const driveEffect = (input) => {
		const generator = typeof input === "function" ? input() : input;
		let step = generator.next();
		while (!step.done) step = generator.next(step.value);
		return step.value;
	};
	apply({
		effect: (generator) => driveEffect(generator),
		get: () => undefined,
		commands: {
			register(definition) {
				registered.set(definition.name, definition);
				return () => registered.delete(definition.name);
			},
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	check(
		registered.size === 12 && registered.has("skill-init") && registered.has("git-message") && registered.has("cleanup"),
		"e2e：注册了 12 条命令（11 委托 + 1 维护型委托）",
		[...registered.keys()].join(","),
	);
	check(
		!registered.has("skill-install") && !registered.has("skill-update"),
		"e2e：不再注册 /skill-install 与 /skill-update",
		[...registered.keys()].join(","),
	);
	// 无 tools 时 /skill-init 走本地回退：无 agent → 直接执行核心，回执仍是结论式文本。
	const e2eResult = await registered.get("skill-init").handler({
		rawInput: "",
		signal: undefined,
		agent: undefined,
	});
	check(
		e2eResult.kind === "success" && e2eResult.text.startsWith("⚠ 已完成"),
		"e2e：/skill-init 无 tools 时本地回退并返回结论",
		e2eResult.text,
	);

	// --update 同样走回退，仍是强制更新。
	const e2eUpdateResult = await registered.get("skill-init").handler({
		rawInput: "--update git-kit",
		signal: undefined,
		agent: undefined,
	});
	check(
		e2eUpdateResult.kind === "success" && e2eUpdateResult.text.includes("已更新：1 个技能"),
		"e2e：/skill-init --update 回退走强制更新",
		e2eUpdateResult.text,
	);

	// 非 --update 时不允许位置参数：以前这些词会被静默忽略，现在直接给用法。
	const badInit = await registered.get("skill-init").handler({
		rawInput: "git-kit",
		signal: undefined,
		agent: { session: { id: "session-e2e" } },
	});
	check(
		badInit.kind === "error" && badInit.text.includes("用法：/skill-init"),
		"e2e：/skill-init 的非法位置参数报用法",
		badInit.text,
	);

	// /cleanup 与其它命令不同：无参数时必须先问再动（技能第 0 步），不能被通用语带去直接执行。
	let cleanupMessage;
	const cleanupResult = await registered.get("cleanup").handler({
		rawInput: "",
		signal: undefined,
		agent: {
			session: { id: "session-e2e" },
			followup(message) {
				cleanupMessage = message;
			},
		},
	});
	const cleanupText = cleanupMessage?.content?.[0]?.text ?? "";
	check(
		cleanupResult.kind === "success" && cleanupResult.text.includes("disk-cleanup cleanup"),
		"e2e：/cleanup 委托到 disk-cleanup 的 cleanup 分支",
		cleanupResult.text,
	);
	check(
		cleanupText.includes("编号选项") && cleanupText.includes("不要执行任何脚本"),
		"e2e：/cleanup 无参数时注入第 0 步「先给选项、不跑脚本」",
		cleanupText,
	);
	check(!cleanupText.includes("按分支流程默认处理"), "e2e：/cleanup 无参数时不带通用的默认处理措辞", cleanupText);
	check(
		cleanupMessage?.role === "user" && cleanupMessage?.source?.kind === "user",
		"e2e：/cleanup 注入的是一条 user 消息",
		JSON.stringify({ role: cleanupMessage?.role, source: cleanupMessage?.source }),
	);

	let cleanupArgsMessage;
	await registered.get("cleanup").handler({
		rawInput: "看看什么最占地方",
		signal: undefined,
		agent: {
			session: { id: "session-e2e" },
			followup(message) {
				cleanupArgsMessage = message;
			},
		},
	});
	const cleanupArgsText = cleanupArgsMessage?.content?.[0]?.text ?? "";
	check(
		cleanupArgsText.includes("看看什么最占地方") && cleanupArgsText.includes("清理项编码"),
		"e2e：/cleanup 带参数时原样透传范围并提示勾选编码",
		cleanupArgsText,
	);

	// 技能缺失：不注入委托，直接给 /skill-init 与手工 npx 两条修复路径。
	const emptyHome = join(root, "empty-home");
	const emptyDsh = join(root, "empty-dsh");
	await mkdir(emptyHome, { recursive: true });
	await mkdir(join(emptyDsh, "skills"), { recursive: true });
	const savedHome = process.env.HOME;
	const savedDshHome = process.env.DSH_HOME;
	const savedAgentsHome = process.env.DSH_AGENTS_HOME;
	process.env.HOME = emptyHome;
	process.env.DSH_HOME = emptyDsh;
	process.env.DSH_AGENTS_HOME = join(emptyHome, ".agents");
	let delegatedWithoutSkill = false;
	let missingSkillResult;
	try {
		missingSkillResult = await registered.get("git-message").handler({
			rawInput: "修复登录超时",
			signal: undefined,
			agent: {
				session: { id: "session-e2e" },
				followup() {
					delegatedWithoutSkill = true;
				},
			},
		});
	} finally {
		process.env.HOME = savedHome;
		process.env.DSH_HOME = savedDshHome;
		if (savedAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME;
		else process.env.DSH_AGENTS_HOME = savedAgentsHome;
	}
	check(
		missingSkillResult?.kind === "error" &&
			missingSkillResult.text.includes("git-kit 未安装") &&
			missingSkillResult.text.includes("/skill-init") &&
			missingSkillResult.text.includes("npx -y skills add") &&
			missingSkillResult.text.includes("-a universal"),
		"e2e：技能缺失时不委托，给出 /skill-init 与手工安装命令",
		missingSkillResult?.text,
	);
	check(!delegatedWithoutSkill, "e2e：技能缺失时没有注入 user 消息");

	// ---- 10) 交互确认：有变更先问，取消/继续/--yes 都不炸 ---------------
	// 把 git-kit 换回非托管软链，制造一个「可执行待办 + 真实目录」的混合计划。
	await rm(linkPath("git-kit"), { force: true });
	await symlink(localClone, linkPath("git-kit"), "dir");
	// choice=missing：只补不存在的条目，不重装已托管技能。
	await rename(linkPath("handoff"), join(root, "handoff-missing-link"));
	const callsBeforeMissing = await stubCalls();
	const missingOnlyText = await runSkillInit(COMMANDS, { choice: "missing" });
	const missingArgv = JSON.parse((await readFile(stubLog, "utf8")).trim().split("\n").pop());
	check(
		missingOnlyText.includes("只补缺失") && existsSync(linkPath("handoff")),
		"init：choice=missing 只补缺失条目并重建软链",
		missingOnlyText,
	);
	check(
		(await stubCalls()) === callsBeforeMissing + 1 &&
			missingArgv.filter((arg) => arg === "--skill").length === 1 &&
			missingArgv.includes("handoff"),
		"init：choice=missing 只向 CLI 传缺失技能",
		JSON.stringify(missingArgv),
	);

	// ---- 11) 写盘范围与提问条件：只由「确定要写盘」驱动 ----------------------
	// 缓存过期 / 无事可做都不再提问：问不问不能取决于「距上次检查多久」。
	const { needsConfirmation } = await import("../lib/skill-confirm.js");
	const managedOnlyPlan = {
		skipReason: undefined,
		kind: "skill-init",
		targets: ["git-kit", "handoff", "disk-cleanup"],
		states: [],
		pending: [],
		freshness: { cacheSource: true, fresh: false, changed: [] },
	};
	check(
		needsConfirmation({ name: "skill-init" }, managedOnlyPlan) === false,
		"confirm：只有缓存过期（要联网检查）时不提问",
		JSON.stringify(managedOnlyPlan),
	);
	const changedOnlyPlan = {
		...managedOnlyPlan,
		freshness: { cacheSource: true, fresh: true, changed: ["handoff"] },
	};
	check(
		needsConfirmation({ name: "skill-init" }, changedOnlyPlan) === false,
		"confirm：上游有更新只 warn，不提问",
		JSON.stringify(changedOnlyPlan),
	);

	const pendingState = { name: "git-kit", state: "missing", isSymlink: false, isDirectory: false };
	const unmanagedState = { name: "handoff", state: "unmanaged", isSymlink: true, isDirectory: false };
	const plannedOnly = installTargets({ pending: [pendingState], freshness: {} });
	check(
		JSON.stringify(plannedOnly) === JSON.stringify(["git-kit"]),
		"init：写盘集合 = 缺失/待修复项",
		JSON.stringify(plannedOnly),
	);
	const plannedWithChanged = installTargets({
		pending: [pendingState],
		freshness: { fresh: true, changed: ["handoff", "disk-cleanup"] },
	});
	check(
		JSON.stringify(plannedWithChanged) === JSON.stringify(["git-kit"]),
		"init：上游更新不进写盘集合（只报告）",
		JSON.stringify(plannedWithChanged),
	);
	const plannedFromStale = installTargets({ pending: [], freshness: { fresh: false, changed: undefined } });
	check(
		JSON.stringify(plannedFromStale) === JSON.stringify([]),
		"init：缓存过期且 plan 无从得知 changed 时不写盘（运行时只报告）",
		JSON.stringify(plannedFromStale),
	);

	// plan 已知更新 → 只报告、不重装、不调 CLI（重装走 --update）。
	const managedNow = await planSkillOperation("skill-init", COMMANDS, "");
	const changedPlan = {
		...managedNow,
		skipReason: undefined,
		targets: ["handoff", "disk-cleanup"],
		actions: [],
		pending: [],
		states: [],
		freshness: { ...managedNow.freshness, fresh: true, changed: ["handoff"] },
	};
	const callsBeforeChanged = await stubCalls();
	const changedText = await runSkillInit(COMMANDS, { plan: changedPlan });
	check(
		(await stubCalls()) === callsBeforeChanged,
		"init：plan 已知的上游更新不调用 CLI",
		String(await stubCalls()),
	);
	check(
		changedText.startsWith("ℹ 无变更，上游有 1 项更新"),
		"init：上游更新只报告，首行给出数量",
		changedText,
	);
	check(
		changedText.includes("运行 /skill-init --update 更新"),
		"init：给出 --update 下一步",
		changedText,
	);

} finally {
	await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("冒烟通过：/skill-init 与 --update 行为符合预期");
