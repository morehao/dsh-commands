# dsh-commands

一个可扩展的 **dsh 原生斜杠命令集合包**（npm 名 `@morehao/dsh-commands`）。当前内置 git-kit 的 Git 工作流命令与 handoff 的跨会话交接命令（与 opencode 入口、自然语言入口共用同一 skill 实现，单一真源）；将来其它 skill 的命令只需往 `lib/index.js` 的 `COMMANDS` 表加条目即可。

本仓只做 **dsh 分发/适配单元**：一张意图表 + locale/icon + 发布链，**不含任何 skill 逻辑**。技能本身由 [`morehao/ai-kit`](https://github.com/morehao/ai-kit) 提供。

## 提供的命令

| 命令 | 参数 | 委托的 skill 分支 |
|---|---|---|
| `/git-message` | `<中文描述>`（必填） | git-kit → commit-message |
| `/git-commit-push` | 无 | git-kit → commit-push |
| `/git-branch` | `<中文描述>`（必填） | git-kit → branch |
| `/git-pr-create` | `[目标分支]` | git-kit → pr-create |
| `/git-pr-merge` | `[PR/MR 编号]` | git-kit → pr-merge |
| `/git-release` | 无 | git-kit → release |
| `/git-tag` | `[tag名或分支名]` | git-kit → tag |
| `/git-slim` | `[保留天数]` | git-kit → slim |
| `/git-star-classify` | 无 | git-kit → star-classify |
| `/handoff` | `[任务范围]` | handoff → print（只打印，不落盘） |

## 原理（命令 = 意图表）

每条 dsh 命令注册到 `ctx.commands`（`name`/`description`/`input.hint`/`recordInput`/`handler`，即 `CommandDefinition`），出现在 dsh 斜杠菜单。`COMMANDS` 表是**自包含的意图表**：一行声明 = 注册元数据 + 对应的 skill 分支 key（`skill` 省略时默认 `git-kit`），**不读取任何仓库文件**，逻辑与路由唯一真源在各 skill（`SKILL.md` 意图决策树 + `references/` + `scripts/`）。

命令执行时 handler 校验必填输入，然后构造一条 user 消息经 `invocation.agent.followup()` 注入当前会话，由 agent 加载对应 skill（`git-kit` / `handoff`）并落到对应分支执行——交互确认步骤与自然语言触发同一 skill 完全一致。

因为输入已逐字写进这条注入的 user 消息（会话日志的真实事件），全部命令统一注册 `recordInput: false`，避免 `command/run` 再记一份同样的 `args`（dsh 官方指引：命令自身的权威事件已承载 payload 时置 false）。这不影响聊天区的命令行显示——`GenericCommandCard` 只渲染命令名与结算文案，不渲染 `args`。

> **描述文本不做 i18n（有意为之）**：dsh 只本地化它自己的 6 条一方命令——客户端 `HOST_DESCRIPTION_KEYS` 硬编码 `compact`/`export`/`feedback`/`goal`/`permission`/`plan`，且要求 `description` 与英文原文逐字相等才翻译，其余一律**原样透传**；第三方也**无法**用同名客户端 `CommandContribution` 覆盖（同名会在候选合成时 `collides with a host command` 直接抛错），`CommandDecoration` 又**没有** description 字段。Host 侧同样拿不到语言偏好（`SettingsProvider` 只提供 `register()`，namespace `locale` 已被 locale 插件独占、重复注册会抛错；且 `locale.preference` 缺省时本就交给浏览器 `navigator.language` 决定）。因此本插件 10 条描述直接写中文：中文界面下与一方命令表现一致。若将来 dsh 开放第三方描述 i18n 钩子，再改为按键取值。

- 编辑技能（`$DSH_HOME/skills/git-kit/`、`$DSH_HOME/skills/handoff/`）的内容**无需重启**，下次执行即生效——技能由 ai-kit 提供，与本插件版本无关。
- 修改本插件的 `lib/index.js`（含 `COMMANDS` 表）需重启 dsh web 生效。**但只有以 `link:` 方式接入时改源码才生效**：若 profile 里装的是 npm 版（`dsh plugin --profile web add @morehao/dsh-commands`），profile 下的 `node_modules` 是一份**拷贝**，改仓库源码不会生效，需先升版本发版再重装。

## 安装

**插件走 npm，技能走软链。**

```bash
# 1) 装插件（退出 dsh 客户端后执行，装完再启动）
dsh plugin --profile <profile> add @morehao/dsh-commands
```

> **skill 依赖**：插件只声明「命令 → skill 分支」意图表，真正的执行授权给对应 skill（`git-kit` / `handoff`）。而 dsh 不从 `node_modules` 扫描 skill，所以仍需把技能放进 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）：

```bash
# 2) 取技能（由 ai-kit 仓提供）
git clone https://github.com/morehao/ai-kit.git
mkdir -p "$HOME/.dsh/skills" && ln -s "$PWD/ai-kit/skills"/* "$HOME/.dsh/skills/"
```

本地开发 / 测试用 `link:` 方式（源码即时生效，不依赖 npm 版本）：

```bash
dsh plugin --profile <profile> add link:/绝对路径/dsh-commands
# 重启 dsh web
```

## 显示元信息（插件页标题 / 描述 / 图标）

dsh 的插件页（侧栏「插件」→ 组合包详情与组件行）在**不加载插件 JS** 的前提下读取展示元信息：

- 标题与描述取自导出的 `locale/<语言>.json` 的 `meta.title` / `meta.description`（本包提供 `en` 与 `zh`，随界面语言切换）。
- 图标取自 `package.json` 的 `icon`（优先）或导出的 `./icon`；格式限 SVG/PNG/JPEG/WebP，且不超过 256 KiB。
- 这些资源必须同时写进 `exports` 与 `files`；`package.json` 也要导出（`"./package.json": "./package.json"`）。否则「缺 locale 时回退到 package.json 的 `name`/`description`」这条兜底会因 `ERR_PACKAGE_PATH_NOT_EXPORTED` 静默失效：标题退化成模块名、描述为空，组件行还会多出一行与标题重复的包名。这正是本插件此前与 `dsh-context` 等信息完整的插件在页面上出现差异的原因。

> 标题表达「这个插件是什么」（`dsh 命令集 (dsh-commands)`），不表达「它从哪个仓来」——所以标题里**不写仓名**；「技能由 ai-kit 仓提供」只写在 `description` 末尾。

## 开发

- 增删命令：改 `lib/index.js` 的 `COMMANDS` 表即可（每条一行声明）；`branch` 值必须与对应 `SKILL.md` 决策树的分支 key 一致（`skill` 省略时默认 `git-kit`）。
- 命令与 ai-kit 里 opencode 侧 `commands-opencode/git/*.md`、`commands-opencode/handoff.md` 是同一 skill 的多条入口，只声明意图、不重复逻辑。
- **跨仓契约**：命令 → 技能分支的对应关系已跨仓（技能在 ai-kit），改动 `COMMANDS` 或技能分支后跑一次

  ```bash
  node scripts/check-skill-contract.mjs
  ```

  它逐条检查 `$DSH_HOME/skills/<skill>/references/<branch>.md` 是否存在（单分支技能只校验 `SKILL.md` 存在，如 `/handoff` 的 `print`）。技能改分支名而插件没跟，就是在这里暴露的。
- CI（`.github/workflows/check.yml`）在 PR 上机械校验：发布脚本语法、插件语法、包名/模块标识符/插件名三处一致、打包内容白名单。契约校验默认不在 CI 跑（它依赖另一仓的技能目录）。

## 发布（自动）

用**打 tag** 自动发布到 npm（OIDC / Trusted Publishing，无需长效 token；见 `.github/workflows/release.yml`；完整流程与踩坑见 [`PUBLISHING.md`](./PUBLISHING.md)）：

- 发布方式：升好版本后打 tag 并推送，workflow 用 OIDC 把该版本发布到 npmjs：

  ```bash
  # 1) 升版本：改本仓 package.json 的 version（如 0.1.8 -> 0.1.9），在分支上提交并 push，开 PR 合并到 main
  #    （稳定分支不接受直接提交，发版升版本也不例外；见 ai-kit 的 skills/git-kit/references/stable-branch.md）
  # 2) 合并后切回 main 拉取，再打与版本一致的 tag（去掉 v 前缀，指向合并后的提交）：
  #    git switch main && git pull --ff-only origin main
  #    git tag -a v0.1.9 -m "release: v0.1.9" origin/main && git push origin v0.1.9
  ```

  workflow 会校验 `tag 版本 == package.json version`（不一致拒绝发布）；同版本在 npm 已存在则跳过（幂等）。细则见 [`PUBLISHING.md`](./PUBLISHING.md)「日常发新版」与 ai-kit 的 `skills/git-kit/references/tag.md`「发版约束」。
- **关键约定**：`package.json` 的 `name`（npm 包名）与 `cordis.patch.yml` 的 `insert[0].name`（dsh 启动时 `import()` 的**模块标识符**）必须一致；`lib/index.js` 的 `export const name`（cordis 插件名）与 `cordis.patch.yml` 的 `insert[0].id` 保持一致即可，但与模块标识符解耦。改包名时请三者同步核对（CI 里有机械校验）。

## 历史

本包源码原在 [`morehao/ai-kit`](https://github.com/morehao/ai-kit) 的 `commands-dsh/` 目录（`v0.1.0`–`v0.1.7` 由其发布），2026-10 拆分为独立仓以便独立安装与发布；npm 包名不变，已装用户无迁移成本。旧目录提交历史见 [ai-kit/commits/main/commands-dsh](https://github.com/morehao/ai-kit/commits/main/commands-dsh)。
