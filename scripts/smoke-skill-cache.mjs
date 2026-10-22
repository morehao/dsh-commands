#!/usr/bin/env node
// 本地缓存的离线冒烟：不联网、不碰真实 HOME，验证
//   clone 一次 → TTL 内不 fetch → refresh 拉到新 commit → 离线模式不 fetch
// 以及 --json 解析、lock 来源回写（sourceType/skillPath/skillFolderHash）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cacheKey, cacheStatus, cachedSkillHash, ensureSourceCache, parseAddResult, rewriteLockSource } from "../lib/skill-cache.js";

const root = await mkdtemp(join(tmpdir(), "dsh-commands-skill-cache-"));
const repo = join(root, "source");
const cacheDir = join(root, "cache");
const home = join(root, "home");
const lockPath = join(home, ".agents", ".skill-lock.json");

function git(args, cwd = repo) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

let checks = 0;
function check(ok, label, detail) {
	checks += 1;
	if (!ok) {
		console.error(`✗ ${label}${detail === undefined ? "" : `\n  ${String(detail).replace(/\n/g, "\n  ")}`}`);
		process.exitCode = 1;
		return;
	}
	console.log(`✓ ${label}`);
}

try {
	// 1) 缓存键稳定且不暴露 URL。
	check(cacheKey("https://github.com/acme/demo.git") === cacheKey("https://github.com/acme/demo.git"), "cacheKey：同 URL 稳定");
	check(cacheKey("https://github.com/acme/demo.git") !== cacheKey("https://github.com/acme/other.git"), "cacheKey：不同 URL 不同键");

	// 2) --json 解析。
	check(Array.isArray(parseAddResult('[{"name":"demo","status":"installed"}]')), "parseAddResult：纯 JSON");
	check(parseAddResult('提示\n[{"name":"demo"}]\n尾声')[0].name === "demo", "parseAddResult：JSON 前后有提示");
	check(parseAddResult("not json") === undefined, "parseAddResult：非 JSON 返回 undefined");

	// 3) 建一个本地 git 源，模拟远端。
	await mkdir(join(repo, "skills", "demo"), { recursive: true });
	await writeFile(join(repo, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: v1\n---\n");
	git(["init", "-b", "main"]);
	git(["add", "."]);
	git(["commit", "-m", "v1"]);
	const v1 = git(["rev-parse", "HEAD"]);

	const first = await ensureSourceCache({
		cacheDir,
		url: `file://${repo}`,
		env: process.env,
		ttlMs: 60_000,
	});
	check(first.first === true && first.commit === v1 && first.fetched === true, "cache：首次 clone 并记录 commit", JSON.stringify(first));
	check((await readFile(join(cacheDir, "skills", "demo", "SKILL.md"), "utf8")).includes("v1"), "cache：clone 内容可读");
	const freshStatus = await cacheStatus(cacheDir, { ...process.env, DSH_COMMANDS_SKILL_CACHE_TTL_MS: "60000" });
	check(freshStatus.exists === true && freshStatus.fresh === true, "cache：cacheStatus 报告 TTL 内 fresh", JSON.stringify(freshStatus));
	const demoHash = await cachedSkillHash(cacheDir, "demo");
	check(/^[0-9a-f]{40}$/u.test(demoHash), "cache：cachedSkillHash 返回 40 位 git tree hash", demoHash);
	const zeroStatus = await cacheStatus(cacheDir, { ...process.env, DSH_COMMANDS_SKILL_CACHE_TTL_MS: "0" });
	check(zeroStatus.exists === true && zeroStatus.fresh === false, "cache：TTL=0 时 cacheStatus 不 fresh", JSON.stringify(zeroStatus));

	const second = await ensureSourceCache({
		cacheDir,
		url: `file://${repo}`,
		env: process.env,
		ttlMs: 60_000,
	});
	check(second.first === false && second.fresh === true && second.commit === v1 && second.fetched === false, "cache：TTL 内不 fetch，直接命中");

	// 4) 源仓新增 commit；refresh 必须更新，--depth 1 的 fetch 也要能 reset。
	await writeFile(join(repo, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: v2\n---\n");
	git(["add", "."]);
	git(["commit", "-m", "v2"]);
	const v2 = git(["rev-parse", "HEAD"]);
	const refreshed = await ensureSourceCache({
		cacheDir,
		url: `file://${repo}`,
		env: process.env,
		refresh: true,
		allowStale: false,
		ttlMs: 60_000,
	});
	check(refreshed.commit === v2 && refreshed.fetched === true, "cache：refresh 拉到新 commit", `${refreshed.commit} != ${v2}`);
	check((await readFile(join(cacheDir, "skills", "demo", "SKILL.md"), "utf8")).includes("v2"), "cache：reset 后内容更新");

	// 5) ttl < 0 = 离线模式：即便源仓又变了，也不 fetch。
	await writeFile(join(repo, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: v3\n---\n");
	git(["add", "."]);
	git(["commit", "-m", "v3"]);
	const offline = await ensureSourceCache({
		cacheDir,
		url: `file://${repo}`,
		env: process.env,
		ttlMs: -1,
	});
	check(offline.commit === v2 && offline.fetched === false, "cache：ttl<0 时保持离线缓存（不 fetch）", offline.commit);

	// 5b) fetch 失败但已有缓存：allowStale=true 时继续用旧 commit（安装不因上游抖动失败）。
	git(["-C", cacheDir, "remote", "set-url", "origin", `file://${join(root, "missing")}`]);
	const stale = await ensureSourceCache({
		cacheDir,
		url: `file://${repo}`,
		env: process.env,
		refresh: true,
		allowStale: true,
		ttlMs: 60_000,
	});
	check(stale.stale === true && stale.commit === v2, "cache：fetch 失败时回退旧缓存（stale）", JSON.stringify(stale));
	let updateError = "";
	try {
		await ensureSourceCache({
			cacheDir,
			url: `file://${repo}`,
			env: process.env,
			refresh: true,
			allowStale: false,
			ttlMs: 60_000,
		});
	} catch (error) {
		updateError = String(error.message);
	}
	check(updateError.includes("更新本地缓存失败"), "cache：allowStale=false 时 fetch 失败直接报错", updateError);
	git(["-C", cacheDir, "remote", "set-url", "origin", `file://${repo}`]);

	// 6) lock 回写：本地路径安装的条目 → 远端 source。
	await mkdir(join(home, ".agents"), { recursive: true });
	await writeFile(
		lockPath,
		`${JSON.stringify(
			{
				version: 3,
				skills: {
					demo: {
						source: cacheDir,
						sourceType: "local",
						sourceUrl: cacheDir,
						skillFolderHash: "sha256-local",
						installedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				},
				dismissed: {},
			},
			null,
			2,
		)}\n`,
	);
	const rewritten = await rewriteLockSource({
		lockPath,
		cacheDir,
		commit: v2,
		source: "acme/demo",
		sourceUrl: "https://github.com/acme/demo.git",
		sourceType: "github",
		names: ["demo"],
		installed: [{ name: "demo", hash: "json-hash" }],
	});
	const lock = JSON.parse(await readFile(lockPath, "utf8"));
	check(rewritten.updated.includes("demo"), "lock：回写目标技能");
	check(lock.skills.demo.source === "acme/demo", "lock：source 改为 owner/repo", JSON.stringify(lock.skills.demo));
	check(lock.skills.demo.sourceType === "github", "lock：sourceType 改为 github");
	check(lock.skills.demo.sourceUrl === "https://github.com/acme/demo.git", "lock：sourceUrl 改为远端");
	check(lock.skills.demo.skillPath === "skills/demo/SKILL.md", "lock：skillPath 正确", lock.skills.demo.skillPath);
	check(/^[0-9a-f]{40}$/u.test(lock.skills.demo.skillFolderHash), "lock：skillFolderHash 是 git tree hash", lock.skills.demo.skillFolderHash);
	const currentHash = await cachedSkillHash(cacheDir, "demo");
	check(lock.skills.demo.skillFolderHash === currentHash, "lock：skillFolderHash 与 cachedSkillHash 一致", `${lock.skills.demo.skillFolderHash} != ${currentHash}`);
	check(lock.skills.demo.installedAt === "2026-01-01T00:00:00.000Z", "lock：保留 installedAt");

	console.log(`\n缓存冒烟通过：${checks} 项检查`);
} finally {
	await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
}
