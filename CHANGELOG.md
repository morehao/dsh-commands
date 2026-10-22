# Changelog

本文件记录 `@morehao/dsh-commands` 的发布历史。`v0.1.0`–`v0.1.7` 由旧仓
[`morehao/ai-kit`](https://github.com/morehao/ai-kit) 的 `commands-dsh/` 目录发布，
2026-10 起在本仓发布；npm 包名未变，版本号连续。

## 0.1.8

### 变更

- 包源码迁至独立仓 `morehao/dsh-commands`：仓库根即包根（不再有 `commands-dsh/` 目录），发布链
  （`release.yml` + `scripts/ci-publish.sh`）随之迁移，npm 包名与模块标识符不变，已装用户无感。
- 插件页标题去掉仓名：`ai-kit 命令 (dsh-commands)` → `dsh 命令集 (dsh-commands)`，
  `ai-kit Commands (dsh-commands)` → `DSH Commands (dsh-commands)`；`description` 改为描述插件本身，
  末尾注明技能由 ai-kit 仓提供。仅展示名变化，`package.json.name` / `cordis.patch.yml` 模块标识符 /
  插件导出名一律不变。

### 新增

- `scripts/check-skill-contract.mjs`：跨仓契约校验（`COMMANDS` 里每条命令的 `skill`/`branch` 是否在
  `$DSH_HOME/skills` 中真实存在），把「技能改分支名 → 命令静默失效」变成可执行的失败。
- `lib/index.js` 导出 `COMMANDS`（纯增量，`apply` 行为不变），供契约校验使用。
- 最小 CI `.github/workflows/check.yml`：发布脚本语法、插件语法、包名/模块标识符/插件名三处一致、
  打包内容白名单。

### 修复

- 无（本版无功能变更，仅迁仓与元信息中性化）。
