#!/usr/bin/env node
/**
 * 产物自检：dist 存在、可加载、导出宿主约定符号；dist 无 .ts。
 * （「lib 无 .js 源」在 P8 收口后再启用，见迁移计划。）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(path.relative(ROOT, full));
  }
  return out;
}

const entry = path.join(ROOT, 'dist', 'index.js');
assert.ok(fs.existsSync(entry), 'dist/index.js 缺失：先跑 npm run build');

const mod = await import('../dist/index.js');
assert.equal(mod.name, 'dsh-commands');
assert.ok(Array.isArray(mod.inject));
assert.equal(typeof mod.apply, 'function');
assert.ok(Array.isArray(mod.COMMANDS) && mod.COMMANDS.length > 0);
assert.ok(Array.isArray(mod.REQUIRED_SKILLS) && mod.REQUIRED_SKILLS.length > 0);

// ../package.json 读取路径必须仍然正确（D1/D3 的核心不变量）
const { PLUGIN_META } = await import('../dist/plugin-update.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.equal(PLUGIN_META.version, pkg.version, 'dist 读到的 package.json 版本不一致（资源路径错位？）');

const distTs = walk(path.join(ROOT, 'dist')).filter((f) => f.endsWith('.ts'));
assert.deepEqual(distTs, [], 'dist 里不应出现 .ts');

console.log('✓ 产物自检通过：dist 可加载、导出完整、资源路径正确、无残留 .ts');
