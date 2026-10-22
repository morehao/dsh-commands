#!/usr/bin/env node
// release-notes.mjs 的回归：在临时仓库里造注记 tag，验证
//   1) 取出的正是「去掉首行 release: <tag> 及空行」后的正文；
//   2) 与 git-kit `TAGGED` 重跑用的那条 shell 管道**逐字一致**（不然 CI 投影的 body 会和注记漂移）；
//   3) 取不到正文时非零退出（轻量 tag / 只有首行 / tag 不存在），不产出空说明。
// 不联网、不碰真实仓库。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const script = new URL("./release-notes.mjs", import.meta.url).pathname;
const dir = await mkdtemp(join(tmpdir(), "release-notes-test-"));
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

// 与 git-kit release.md「TAGGED 重跑」给的读回管道完全一致。
const readBackViaShell = (tag) =>
	execFileSync(
		"bash",
		[
			"-c",
			`git for-each-ref --format='%(contents)' "refs/tags/$TAG" \
| awk '{l[NR]=$0} END{n=NR; while(n>0 && l[n]=="") n--; for(i=1;i<=n;i++) print l[i]}' \
| tail -n +2 | sed '1{/^$/d;}'`,
		],
		{ cwd: dir, encoding: "utf8", env: { ...process.env, TAG: tag } },
	);

const runNotes = (tag) =>
	spawnSync(process.execPath, [script, tag], { cwd: dir, encoding: "utf8" });

const trimmed = (s) => s.replace(/\n+$/, "");

const fail = (msg) => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};

try {
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("config", "commit.gpgsign", "false");
	await writeFile(join(dir, "README.md"), "# fixture\n");
	git("add", ".");
	git("commit", "-q", "-m", "chore: init fixture");

	// 两层正文：中文摘要 + <details> 折叠的原文层；小标题以 # 开头，依赖 --cleanup=verbatim 才不被吃掉。
	const body = [
		"## 本次发布",
		"",
		"新增 cleanup 命令；Release 由 CI 按注记正文创建。",
		"",
		"### 新增",
		"- 新增 /cleanup 命令，按项目勾选清理项（#45）",
		"",
		"### 改进",
		"- 版本源改为「读仓库判定」（#43）",
		"",
		"<details><summary>原始变更记录（自动生成，未改写）</summary>",
		"",
		"### Features",
		"- **git-kit**: generalize release version source (#43)",
		"",
		"**Full Changelog**: https://example.com/compare/v9.9.8...v9.9.9",
		"</details>",
	].join("\n");
	const note = `release: v9.9.9\n\n${body}\n`;
	await writeFile(join(dir, "note.txt"), `${note}\n\n`); // 末尾多留空行，验证两边都按同一规则裁掉

	git("tag", "-a", "--cleanup=verbatim", "v9.9.9", "-F", join(dir, "note.txt"));
	git("tag", "-a", "--cleanup=verbatim", "v9.9.8", "-F", join(dir, "note.txt"));
	git("tag", "v1.0.0-light"); // 轻量 tag
	git("tag", "-a", "-m", "release: v1.0.1", "v1.0.1"); // 注记只有首行

	// 1) 正常路径：与 shell 管道逐字一致，且等于预期正文（去掉首行 + 空行）。
	const out = runNotes("v9.9.9");
	if (out.status !== 0) fail(`正常注记应成功，实际 exit=${out.status} stderr=${out.stderr}`);
	const fromShell = readBackViaShell("v9.9.9");
	assert.equal(trimmed(out.stdout), trimmed(fromShell), "与 git-kit 读回管道不一致");
	assert.equal(trimmed(out.stdout), trimmed(body), "正文内容不符合预期");
	if (out.stdout.includes("release: v9.9.9")) fail("正文里混进了首行 release: <tag>");

	// 2) 没有摘要层的历史格式（只有原文层）也应照常投影。
	const outRaw = runNotes("v9.9.8");
	if (outRaw.status !== 0) fail(`原文层注记应成功，实际 exit=${outRaw.status}`);
	assert.ok(outRaw.stdout.includes("### Features"), "原文层丢失");

	// 3) 轻量 tag：必须拒绝，而不是把 commit message 当正文。
	const outLight = runNotes("v1.0.0-light");
	if (outLight.status === 0) fail("轻量 tag 不应返回成功");
	assert.match(outLight.stderr, /不是注记 tag/);

	// 4) 注记只有首行：不得产出空 Release。
	const outEmpty = runNotes("v1.0.1");
	if (outEmpty.status === 0) fail("空正文不应返回成功");
	assert.match(outEmpty.stderr, /没有变更说明/);

	// 5) tag 不存在：报错而不是静默输出空内容。
	const outMissing = runNotes("v0.0.0-nope");
	if (outMissing.status === 0) fail("不存在的 tag 不应返回成功");
	assert.match(outMissing.stderr, /找不到 tag/);

	console.log("release-notes 冒烟通过：正文一致、轻量 tag / 空正文 / 缺失 tag 均被拒绝");
} catch (error) {
	fail(error?.message ?? String(error));
} finally {
	await rm(dir, { recursive: true, force: true });
}
