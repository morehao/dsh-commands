#!/usr/bin/env node
// 从注记 tag 读出发布说明正文（Release body）。
//
// 为什么只读 tag、不读 CHANGELOG：`/git-release` 把「中文摘要层 + 折叠的原文层」写进注记并在推送前
// 让用户确认，推送后不可改；`CHANGELOG.md` 只放原文层（不掺摘要）。所以注记是唯一含摘要的载体，
// 拿 CHANGELOG 拼 body 会丢掉用户唯一能读的那半。
//
// 也不重新生成：正文含模型写的摘要层，重算必然与已推送内容漂移。这里只做投影。
//
// 读回方式必须与 git-kit 的 `TAGGED` 重跑一致（scripts/smoke-release-notes.mjs 会逐字比对）：
//   git for-each-ref --format='%(contents)' refs/tags/<tag>        # 去掉尾部空行
//   git tag 注记 → tail -n +2 | sed '1{/^$/d;}'                    # 去掉首行 release: <tag> 及其后的空行
//
// 用法：node scripts/release-notes.mjs <tag>   （或 RELEASE_TAG=v1.2.3）
// 输出：body 写到 stdout；取不到正文（非注记 tag / 只有首行）时非零退出，不产出空说明。
import { execFileSync } from "node:child_process";

const tag = process.argv[2] ?? process.env.RELEASE_TAG;
if (!tag) {
	console.error("用法：release-notes.mjs <tag>（或设置 RELEASE_TAG）");
	process.exit(1);
}

const run = (args) =>
	execFileSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });

// 轻量 tag 没有正文；`%(contents)` 对它会落到 commit message 上，投影出来是错的，必须先拦住。
let type;
try {
	type = run(["cat-file", "-t", `refs/tags/${tag}`]).trim();
} catch {
	console.error(`✗ 找不到 tag：${tag}（先用 git fetch --tags 取回）`);
	process.exit(1);
}
if (type !== "tag") {
	console.error(`✗ ${tag} 不是注记 tag（类型 ${type}）：轻量 tag 没有正文可投影`);
	process.exit(1);
}

const raw = run(["for-each-ref", "--format=%(contents)", `refs/tags/${tag}`]);
const lines = raw.replace(/\n+$/, "").split("\n");
lines.shift(); // release: <tag>
if (lines[0] === "") lines.shift(); // 紧随其后的空行

const body = lines.join("\n");
if (body.trim() === "") {
	console.error(
		`✗ ${tag} 的注记只有首行，没有变更说明；不生成空 Release（历史单行 tag 请手动补）`,
	);
	process.exit(1);
}

process.stdout.write(`${body}\n`);
