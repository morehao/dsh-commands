#!/usr/bin/env node
/**
 * Host 构建：tsc 把 lib/ 编译到 dist/（1:1 保结构）。
 *
 *   node scripts/build-host.mjs            重建 dist/（先清空，避免残留已删模块的产物）
 *   node scripts/build-host.mjs --check    编译到临时目录，与 dist/ 逐文件逐字节比对
 *   node scripts/build-host.mjs --watch    tsc --watch 持续写 dist/
 *
 * 为什么不用 esbuild/tsup：lib/plugin-update.js 两处按 import.meta.url 读 `../package.json`
 * （PLUGIN_META / readInstalledVersion）。打成单文件会把该相对路径解析到错误位置，
 * 所以必须保结构 emit（lib/X → dist/X，层级不变）。见迁移计划 D1/D3。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const tscJs = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const config = path.join(root, 'tsconfig.host.json');
const outDir = path.join(root, 'dist');

const argv = new Set(process.argv.slice(2));

function compile(target) {
  execFileSync(process.execPath, [tscJs, '-p', config, '--outDir', target], { cwd: root, stdio: 'inherit' });
}

function walk(dir) {
  const out = [];
  const visit = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(path.relative(dir, full));
    }
  };
  visit(dir);
  return out.sort();
}

function compare(actualDir, expectedDir) {
  const actual = walk(actualDir);
  const expected = walk(expectedDir);
  const problems = [];
  for (const file of expected) if (!actual.includes(file)) problems.push(`dist 缺文件：${file}`);
  for (const file of actual) if (!expected.includes(file)) problems.push(`dist 多文件：${file}`);
  for (const file of expected) {
    if (!actual.includes(file)) continue;
    if (!readFileSync(path.join(actualDir, file)).equals(readFileSync(path.join(expectedDir, file)))) {
      problems.push(`内容不一致：${file}`);
    }
  }
  return problems;
}

if (argv.has('--watch')) {
  execFileSync(process.execPath, [tscJs, '-p', config, '--watch'], { cwd: root, stdio: 'inherit' });
} else if (argv.has('--check')) {
  const temp = mkdtempSync(path.join(tmpdir(), 'dshcmd-dist-'));
  try {
    compile(temp);
    const problems = compare(outDir, temp);
    if (problems.length) {
      for (const line of problems) console.error(`✖ ${line}`);
      console.error(`dist 与 lib/ 不一致（${problems.length} 处）；跑 npm run build 重建`);
      process.exit(1);
    }
    console.log(`✔ dist 与 lib/ 一致（${walk(temp).length} 个文件）`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  rmSync(outDir, { recursive: true, force: true });
  compile(outDir);
  console.log(`✔ 已生成 dist/（${walk(outDir).length} 个文件）`);
}
