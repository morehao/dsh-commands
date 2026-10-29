#!/usr/bin/env node
// 三处命名一致性校验（只在安装后才暴露的错位，前移到 PR）：
//   package.json 的 name          == cordis.patch.yml 的 insert[0].name（dsh import() 的模块标识符）
//   lib/index.ts 的 export name == cordis.patch.yml 的 insert[0].id（cordis 配置树内的键；产物 dist/index.js）
import { readFile } from "node:fs/promises";

const read = async (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const fail = (msg) => {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
};

const pkg = JSON.parse(await read("package.json"));
const patch = await read("cordis.patch.yml");
const { name: pluginName } = await import("../dist/index.js");

// 极简读取：本仓 patch 只有一条 insert，取第一个 id / name 即可，不引入 YAML 依赖。
const insertId = patch.match(/^\s*-\s+id:\s*(\S+)\s*$/m)?.[1];
const insertName = patch.match(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1];

if (!insertId) fail("cordis.patch.yml 未找到 insert[0].id");
if (!insertName) fail("cordis.patch.yml 未找到 insert[0].name");

if (insertName && insertName !== pkg.name) {
	fail(`包名不一致：package.json name=${pkg.name}，cordis.patch.yml insert[0].name=${insertName}`);
}
if (insertId && insertId !== pluginName) {
	fail(`插件名不一致：lib/index.ts（产物 dist/index.js）export const name=${pluginName}，cordis.patch.yml insert[0].id=${insertId}`);
}
if (!pkg.publishConfig || pkg.publishConfig.access !== "public") {
	fail("package.json 缺少 publishConfig.access = \"public\"");
}

console.log(
	process.exitCode
		? "命名校验失败"
		: `命名校验通过：包名 ${pkg.name} / 模块标识符 ${insertName} / 插件名 ${pluginName}`,
);
