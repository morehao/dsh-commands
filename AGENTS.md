# AGENTS.md

> 给在本仓工作的 AI agent。人类向说明见 [README](README.md) 与 [docs/](docs/)；本文件只放**每次都必须遵守**的硬约束与任务路由。命中具体任务时再读 `docs/agents/` 对应篇，不要一次全读。

## 1. 项目速览

- 包：`@morehao/dsh-commands`，dsh 原生斜杠命令集合；**仓库根即包根**，纯 ESM，无构建步骤。
- 入口：[lib/index.js](lib/index.js) 注册 `COMMANDS`（委托型）与 `LOCAL_COMMANDS`（本地执行型）。
- 技能逻辑不在本仓：`git-kit` / `handoff` / `disk-cleanup` 由 [`morehao/ai-kit`](https://github.com/morehao/ai-kit) 提供；本仓只做「命令 → skill 分支」的薄映射。
- 运行时：Node.js ≥ 22.20；唯一 npm 依赖 `skills`（优先直接调用其 CLI，缺失时回退 `npx -y skills`）。
- 发布：tag `vX.Y.Z` → GitHub Actions OIDC → npm；发布成功后 CI 用注记 tag 正文创建 GitHub Release。

| 路径 | 作用 |
|---|---|
| [lib/index.js](lib/index.js) | 命令表、handler、注入消息、`apply()` |
| [lib/skill-setup.js](lib/skill-setup.js) | `/skill-init` / `/skill-install` / `/skill-update` 的 plan、安装、软链、校验 |
| [lib/skill-cache.js](lib/skill-cache.js) | 来源浅克隆缓存、TTL、lock 回写 |
| [lib/skill-paths.js](lib/skill-paths.js) | `$DSH_HOME` / `$DSH_AGENTS_HOME` / canonical / lock 路径 |
| [lib/job-progress.js](lib/job-progress.js) | 长任务挂到 `ctx.jobs`、作业行/面板/停止/降级 |
| [lib/proc.js](lib/proc.js) / [lib/text.js](lib/text.js) | 子进程 timeout/abort/输出上限；ANSI/spinner/tail 清洗 |
| [scripts/](scripts/) | 契约校验、命名/打包校验、离线冒烟、发布脚本 |
| [docs/](docs/) | 人类向架构、技能自举、过程可见、开发、发布、历史 |
| `docs/agents/` | Agent 任务手册；命中任务时按路由阅读 |
| `.dsh/` | 本地过程文档，已 gitignore；不是权威来源 |

## 2. 硬约束

### 架构边界

- 本仓是**薄入口**：不复制技能流程/脚本；新增能力先改 ai-kit 的 skill，再在这里加一行映射。
- `branch` 必须与目标 `SKILL.md` 决策树的分支 key 一致（即 `references/<branch>.md`）；`skill` 省略时默认 `git-kit`。
- 注入给 agent 的是手工构造的 user 消息，必须保留 `role` / `source: { kind: "user" }` / `content` / `id`；不要引入 `@deepseek-ai/*` 运行时 import。
- 委托型命令统一 `recordInput: false`（输入已随注入消息入日志）；本地执行型统一 `true`，不要互换。

### 命令注册

- 命令描述直接写中文；dsh 不向第三方提供描述 i18n 钩子，不要为此加 `locale` 键。
- `required` / `hint` 决定缺失参数的用法回执；`noInput` 承载无参数专门语义，`confirm` 承载需用户决策事项，`readFallback` 用于 `disable-model-invocation` 的技能。改这些字段前读 [命令契约](docs/agents/command-contract.md)。
- 新增/删除委托型命令后，`REQUIRED_SKILLS` 会自动从 `COMMANDS` 推导；不要维护第二份技能清单。

### 包与发布

- 三处命名必须一致：`package.json.name` = `cordis.patch.yml` 的 `insert[0].name`；`lib/index.js` 的 `export const name` = `insert[0].id`；`publishConfig.access` = `public`。
- 发包只含白名单：`lib/`、`locale/`、`package.json`、`README.md`、`LICENSE`、`cordis.patch.yml`、`icon.svg`。`.dsh/`、`docs/`、`scripts/`、`node_modules`、`*.tgz` 一律不入包。
- 稳定分支不直推；升版本也走 PR。tag 打在合并后的 `main`，tag 版本必须等于 `package.json.version`。
- GitHub Release 由 CI 在 npm 发布成功后创建，正文取自注记 tag；`gh release create` 必须留在 [.github/workflows/release.yml](.github/workflows/release.yml)，不要挪进 `scripts/`（git-kit 预检靠它判定后效）。

### 环境与安全

- 测试必须离线、用临时 HOME；禁止碰真实 `~/.dsh`、`~/.agents` 或真实技能目录。用 `DSH_COMMANDS_SKILL_CLI_OVERRIDE` 注入 stub。
- 破坏性操作（push、tag、publish、删缓存、改真实 HOME、覆盖/删除软链）先征得用户确认；本仓设计上**不做备份、不删真实目录**。
- 改 `lib/` 后需重启 dsh web；只有 `link:` 接入时源码即时生效。npm 版是拷贝。
- `.dsh/` 是本地过程文档，已 gitignore；不要把其中的草稿当权威，也不要提交。

## 3. 常用命令

| 目的 | 命令 |
|---|---|
| 全量本地检查 | `npm run check` |
| 两个技能冒烟 | `npm test` |
| 跨仓契约（需技能已安装） | `node scripts/check-skill-contract.mjs` |
| 三处命名 | `node scripts/check-naming.mjs` |
| 打包白名单 | `node scripts/check-pack.mjs` |
| Release body 投影冒烟 | `node scripts/smoke-release-notes.mjs` |

## 4. 任务路由

| 你要改 | 先读 | 必跑 |
|---|---|---|
| `COMMANDS` / `branch` / 注入文案 / `recordInput` | [命令契约](docs/agents/command-contract.md) | `npm run check` + 契约校验 |
| `skill-setup` / `cache` / `paths` / `proc` / `text` / `job-progress` | [技能运行时](docs/agents/skill-runtime.md) | `npm run check` |
| `scripts/` / CI / `package.json` / 发布 | [验证与发布](docs/agents/verification-release.md) | `npm run check` + 命名/打包校验 |
| 纯文档 | 对应人类文档 | 链接与事实核对 |

## 5. 完成定义

- [ ] `npm run check` 通过；改了 `COMMANDS` 或技能分支时，契约校验通过（技能未安装则说明原因）。
- [ ] 改了 `package.json` / `exports` / `files` / 命名时，`check-naming` 与 `check-pack` 通过。
- [ ] 行为变更同步 README / `docs/` / `CHANGELOG.md`（按影响面，不机械全改）。
- [ ] `git diff --stat` 无 `.dsh/`、`node_modules`、`*.tgz` 等意外文件。
- [ ] 需要用户确认的操作已确认。
- [ ] 子文档与代码冲突时以代码/脚本为准，并顺手修正文档。

## 6. 文档地图

| 层 | 位置 | 用途 |
|---|---|---|
| Agent 常驻约束 | `AGENTS.md` | 每次会话 |
| Agent 任务手册 | `docs/agents/*.md` | 命中任务时按需读 |
| 人类文档 | [docs/](docs/) | 背景、完整流程、排障 |
| 本地过程 | `.dsh/docs/` | 草稿/笔记，gitignored |
