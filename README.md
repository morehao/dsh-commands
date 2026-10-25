# dsh-commands

一个可扩展的 **dsh 原生斜杠命令集合包**（npm：`@morehao/dsh-commands`）。把 [`morehao/agent-skills`](https://github.com/morehao/agent-skills) 的 **git-kit**（Git 工作流）、**handoff**（跨会话交接）与 **disk-cleanup**（磁盘空间回收）接入为 dsh 命令。

命令只声明「命令 → 技能分支」的意图，执行逻辑与唯一真源在对应 skill 里，因此与 opencode 入口、自然语言触发共用同一套实现。本仓不含 skill 逻辑；将来其它 skill 的命令，往 `lib/index.js` 的 `COMMANDS` 表加一行即可。

## 命令

委托给技能执行（需先 `/skill-init`）：

| 命令 | 参数 | 委托的 skill 分支 |
|---|---|---|
| `/git-message` | `<中文描述>`（必填） | git-kit → commit-message |
| `/git-commit-push` | 无 | git-kit → commit-push |
| `/git-branch` | `<中文描述>`（必填） | git-kit → branch |
| `/git-pr-create` | `[目标分支]` | git-kit → pr-create |
| `/git-pr-merge` | `[PR/MR 编号]` | git-kit → pr-merge |
| `/git-release` | `[版本号或tag]` | git-kit → release |
| `/git-tag` | `[tag名或分支名]` | git-kit → tag |
| `/git-slim` | `[保留天数]` | git-kit → slim |
| `/git-star-classify` | 无 | git-kit → star-classify |
| `/handoff` | `[任务范围]` | handoff → print（只打印，不落盘） |
| `/cleanup` | `[清理范围]` | disk-cleanup → cleanup（无参数时先给选项，不执行脚本） |

本地执行型（不经 agent，负责把插件依赖的技能装上、软链进 dsh 并保持最新）：

| 命令 | 参数 | 作用 |
|---|---|---|
| `/skill-init` | `[--update [技能名...]] [--yes]` | 检查并安装插件依赖的技能，软链进 dsh；**只在确定要写盘时**确认（缺失/待修复）。上游有更新的技能不会被静默覆盖：`/skill-init` 只报告，装到最新要用 `--update`（可指定技能名，显式更新不弹确认）；`--yes` 跳过确认 |

额外技能（例如 agent-skills 的 `tech-design`、`project-insight`）不再由插件安装：dsh 本身会扫描 `~/.agents/skills`，直接执行下面这条即可，或者用自然语言让 agent 装：

```bash
npx -y skills add morehao/agent-skills --skill tech-design -g -a universal -y
```

长任务会挂到 dsh 后台任务上：会话头部实时显示阶段，面板里是 `skills` CLI 的流式输出，可两击停止，且不触发模型回合。web 端由 `lib/client.js` 接管命令卡，执行中显示阶段、计时、日志和停止；完成/失败后卡片保留结论。切到别的会话时，右下角会出现应用级完成提示，「技能维护」会话保留未读点，点开即清。每条本地命令结束都会把回执交给会话：默认发一条 notice 形式的执行报告并唤醒一轮让 agent 复核——正常只回「无异常」，有需处理事项才列 ≤3 条下一步，所以新建会话里也看得到结果；`DSH_COMMANDS_SKILL_NOTIFY=notice` 可降级为只记录不唤醒。命令卡是**问题**（命令行 + 参数 + 影响面），触发行是系统注解，agent 的回复才是答案。回执首行是结论（`✓ 无变更` / `✅ 已完成：N 项变更` / `✅ 已更新：…` / `ℹ 无变更，上游有 N 项更新` / `⚠ 已完成，但有 N 项需处理`），第二行是「过程：作业 …」，第三行是「客户端：命令卡已加载 / 未加载」；卡片本身第二行直接给影响面或具体问题（不重复状态与耗时），`⚠` 用琥珀色「需处理」态，`后台作业` / `未确认` / `客户端未加载` 是 chips。无事可做时也写清「本次没有变更，未创建后台任务（原因）」，client half 没进页面时首行会直接标 `· 客户端未加载`（重启 dsh 生效）。作业结算时会弹一次完成提示（当前会话也弹），切走后另有未读点。`/skill-init` 只在**确定要写盘**时用 dsh 的问答卡确认一次（缺失/待修复），缓存过期只做只读检查不打断，`--yes` 可跳过；`--update` 是显式更新，不打断。技能来源默认缓存在 `$DSH_HOME/cache/skills-sources`，首次 clone、之后增量 fetch，安装不再每次整仓克隆。详见 [技能自举](./docs/skill-setup.md) 与 [过程可见](./docs/job-progress.md)。

## 安装

**插件走 npm，技能走软链。**

```bash
# 退出 dsh 客户端后执行，装完再启动
dsh plugin --profile <profile> add @morehao/dsh-commands
```

装完在 dsh 里执行 `/skill-init`：检查 `git-kit` / `handoff` / `disk-cleanup`，缺失则从本地缓存（首次自动 clone）用 `skills` CLI 全局安装并软链进 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）；已托管且缓存 TTL 内与 lock 一致则跳过，TTL 过期会检查上游，**有更新只报告不重装**。确定要写盘（装缺失/修链）时会先弹一次确认，`/skill-init --yes` 可跳过；要把装好的技能跟到最新用 `/skill-init --update`。安装结果仍是标准的 `~/.agents/skills` + `.skill-lock.json`，其他 agent 可以继续用 `npx skills`。

装好后直接输入 `/` 选择命令，例如 `/git-message 修复登录超时`、`/git-commit-push`、`/handoff`、`/cleanup`（不带参数时先给编号选项）。

手工准备技能、可达镜像与环境变量的说明见 [技能自举](./docs/skill-setup.md)；`link:` 本地开发见 [开发与测试](./docs/development.md)。

## 原理

每条命令注册到 `ctx.commands`。执行时 handler 校验必填输入，构造一条 user 消息经 `invocation.agent.followup()` 注入当前会话，由 agent 加载对应 skill、按对应分支执行——交互确认步骤与自然语言触发完全一致。`COMMANDS` 表自包含，不读取任何仓库文件。

- 编辑技能内容（`$DSH_HOME/skills/...`）**无需重启**，下次执行即生效。
- 委托型命令执行前会确认依赖技能是否已安装（`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` 或 `~/.agents/skills`）；缺失时不注入消息，直接返回 `/skill-init` 与手工 `npx` 两条修复路径。
- 本地执行型命令 `/skill-init`（含 `--update`）不走 agent：确定要写盘时才通过 `ctx.userQuestions` 确认，执行过程走后台作业，回执首行给结论；`--yes` 跳过确认。
- 修改插件源码（含 `COMMANDS` 表）需重启 dsh web；只有以 `link:` 方式接入时才改源码即生效，npm 版是拷贝。
- 命令描述直接写中文：dsh 目前不向第三方提供描述文本的 i18n 钩子。

注入消息与 `recordInput`、i18n 的完整依据、`handoff` 的 `readFallback`、插件页元信息，见 [架构与原理](./docs/architecture.md)。

## 开发

```bash
npm run check                           # 本地全量：语法扫描 / 命名 / 打包 / Release 投影 + 三个冒烟
npm test                                # 三个冒烟（stub + 本地 git，不联网）
node scripts/check-skill-contract.mjs   # 命令 → 技能分支的跨仓契约（需技能已安装）
node scripts/smoke-skill-setup.mjs      # 技能自举 + 过程可见（stub，不联网）
node scripts/smoke-skill-cache.mjs      # 来源缓存 / TTL / lock 回写（本地 git，不联网）
```

CI 在 PR 上校验发布脚本语法、全量插件语法（扫 `lib/`、`scripts/` 与 locale JSON）、三处命名一致、打包白名单、Release 正文投影与三个离线冒烟（`npm test`），用的就是上面这几个 npm script。扩展命令、测试细节与命名约定见 [开发与测试](./docs/development.md)。

## 发布

升 `package.json` 版本 → PR 合并 → 在合并后的 `main` 打 `vX.Y.Z` tag，GitHub Actions 用 OIDC 自动发布到 npm（无需长效 token），发布成功后用注记 tag 的正文创建 GitHub Release。workflow 会校验 tag 版本与包版本一致；npm 上已存在同版本则跳过（幂等），Release 已存在也跳过。

合并之后推荐用 `/git-release` 完成打 tag、校验 Release 与后效；它探测到本仓由 CI 建 Release 时只校验、不重复建。只想打标签、不建 Release 用 `/git-tag`。完整流程、一次性配置与踩坑见 [发布说明](./docs/publishing.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [架构与原理](./docs/architecture.md) | 意图表、执行链路、i18n 与记录策略、生效条件、展示元信息 |
| [技能自举](./docs/skill-setup.md) | `/skill-init` / `--update`、软链模型、环境变量、典型用法 |
| [过程可见](./docs/job-progress.md) | 后台任务、作业面板、无事可做、降级 |
| [开发与测试](./docs/development.md) | 目录、扩展命令、契约校验、冒烟、CI、命名约定 |
| [发布说明](./docs/publishing.md) | npm OIDC 发布、一次性配置、排障 |
| [历史](./docs/history.md) | 从 agent-skills 拆仓的记录 |

## 许可

[MIT](./LICENSE)
