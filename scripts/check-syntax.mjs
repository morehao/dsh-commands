#!/usr/bin/env node
/**
 * 逐文件语法自检：`node --check` 一次只看一个文件，这里把 `scripts/` 全扫一遍，
 * 另校验 `locale/*.json` 能被 JSON.parse。`lib/*.ts` 的类型/语法由 `tsc`（npm run build）负责。
 *
 * 为什么要有这一层：原先 `.github/workflows/check.yml` 里硬编码了文件名，
 * 新增 `scripts/xxx.mjs` 忘了往 YAML 里加就静默漏检；扫描目录后新增文件自动纳入。
 *
 * 只做语法，不执行业务逻辑（需要行为断言请写冒烟）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const abs = (p) => join(repoRoot, p);
const rel = (p) => relative(repoRoot, p);

/** 递归收集 JS 文件（lib/ 与 scripts/ 都有子目录的余量）。 */
function collect(roots) {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(js|mjs|cjs)$/.test(entry.name)) files.push(full);
		}
	};
	for (const root of roots) {
		const dir = abs(root);
		if (existsSync(dir)) walk(dir);
	}
	return files;
}

let failed = 0;
const fail = (file, detail) => {
	failed += 1;
	console.error(`✖ ${rel(file)}\n${detail}`);
};

const jsFiles = collect(["scripts"]);
if (jsFiles.length === 0) {
	console.error("✖ scripts/ 下没有可检查的 JS 文件");
	process.exit(1);
}
for (const file of jsFiles) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
	} catch (error) {
		fail(file, error.stderr?.toString() || error.message);
	}
}

// locale 是运行时被 JSON.parse / import 的数据，语法错同样只在装到用户机器后才暴露。
const localeDir = abs("locale");
const jsonFiles = existsSync(localeDir)
	? readdirSync(localeDir).filter((name) => name.endsWith(".json")).map((name) => join(localeDir, name))
	: [];
for (const file of jsonFiles) {
	try {
		JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		fail(file, error.message);
	}
}

if (failed > 0) {
	console.error(`语法自检失败：${failed} 个文件`);
	process.exit(1);
}
console.log(`✓ 语法自检通过：${jsFiles.length} 个 JS 文件、${jsonFiles.length} 个 locale JSON`);
