#!/usr/bin/env node
// 打包内容白名单校验：发出去的 tarball 不可撤（npm 已发布版本不能 unpublish 重用版本号），
// 所以 `.dsh/` 草稿、node_modules、*.tgz 之类混进包必须在 PR 阶段就红。
//
// 复用 `npm pack --dry-run --json`（只打印清单、不生成 tgz），用临时 cache 目录避免本机
// ~/.npm 属主问题（EPERM）。
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const ALLOWED_EXACT = new Set([
	"package.json",
	"README.md",
	"LICENSE",
	"cordis.patch.yml",
	"icon.svg",
]);
const ALLOWED_PREFIX = ["lib/", "locale/"];

const cacheDir = await mkdtemp(join(tmpdir(), "dsh-commands-pack-"));
let files;
try {
	const { stdout } = await run(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{ cwd: new URL("..", import.meta.url), env: { ...process.env, npm_config_cache: cacheDir } },
	);
	files = JSON.parse(stdout)[0].files.map((f) => f.path);
} finally {
	await rm(cacheDir, { recursive: true, force: true });
}

const unwanted = files.filter(
	(p) => !ALLOWED_EXACT.has(p) && !ALLOWED_PREFIX.some((prefix) => p.startsWith(prefix)),
);
// 反向检查：白名单里的必备文件一个都不能少（少了就是个空包 / 缺图标缺 locale）。
const required = ["package.json", "README.md", "LICENSE", "cordis.patch.yml", "icon.svg"];
const missing = required.filter((p) => !files.includes(p));

for (const p of unwanted) console.error(`✗ 包内出现非白名单文件：${p}`);
for (const p of missing) console.error(`✗ 包内缺少必备文件：${p}`);

console.log(`包内共 ${files.length} 个文件：\n  ${files.sort().join("\n  ")}`);
if (unwanted.length || missing.length) {
	console.error("打包内容校验失败");
	process.exit(1);
}
console.log("打包内容校验通过");
