# Changelog

本文件记录 `@morehao/dsh-commands` 的发布历史。`v0.1.0`–`v0.1.7` 由旧仓
[`morehao/ai-kit`](https://github.com/morehao/ai-kit) 的 `commands-dsh/` 目录发布，
2026-10 起在本仓发布；npm 包名未变，版本号连续。

## 0.1.9

### 新增

- `/skill-init`：检查 `COMMANDS` 依赖的技能（`git-kit`、`handoff`），缺失则用 `npx skills` 全局安装
  （`add morehao/ai-kit --skill … -g -a universal -y`）并软链进 `$DSH_HOME/skills`；已由 skills CLI 托管的
  跳过；存在但来自别处（如指向本地 ai-kit clone 的软链）则**替换**为托管软链——只删旧链接本身，
  不做备份、不动链接目标；同名真实目录/文件一律拒绝覆盖并提示用户自行移走。末尾按 `COMMANDS`
  的分支契约逐条校验。
- `/skill-install <来源> [技能名...]`：安装**任意来源**的技能（不限本插件依赖），同样走
  `npx skills add … -g -a universal -y` 并把结果软链进 `$DSH_HOME/skills`。装完用三路并集决定给谁建链：
  显式技能名、canonical 目录安装前后差集、lock 里 source 匹配的技能（`owner/repo` / URL / 本地路径
  都做了来源归一化）。真实目录同样拒绝覆盖。
- `/skill-update`：把依赖技能（或指定子集）幂等重装到上游最新并校验软链仍可解析。不调 `skills update`
  —— 它内部 spawn 的 `add` 不带 `-a`，会把链接撒到其它 agent 目录，未检测到 agent 时甚至装到全部 agent。
- `lib/skill-setup.js`：依赖推导、状态判定（missing / managed / unmanaged / broken）、npx 解析
  （PATH + 登录 shell 反查）、软链替换（真实目录拒绝）、契约校验。`lib/index.js` 新增 `LOCAL_COMMANDS` 与
  `REQUIRED_SKILLS` 导出（`COMMANDS` 与 `apply` 对既有命令行为不变）。
- `scripts/smoke-skill-setup.mjs` + CI 步骤：「技能自举冒烟」，用 `DSH_COMMANDS_SKILL_CLI` 指定的 stub
  顶替 `npx skills`，在临时 HOME 里覆盖安装/跳过/软链替换/真实目录拒绝/任意来源安装/更新六条路径，不联网。

### 变更

- README「安装」：安装技能从"手工 clone + ln"改为推荐 `/skill-init`（手工方式保留为离线/自管场景），
  并补充技能托管链路、"只替换软链、真实目录拒绝覆盖"的覆盖策略与 `-a universal` 等不可改的上游约束。

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
