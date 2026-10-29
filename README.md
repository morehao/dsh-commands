# dsh-commands

一个可扩展的 **dsh 原生斜杠命令集合包**（npm：`@morehao/dsh-commands`）。把 [`morehao/agent-skills`](https://github.com/morehao/agent-skills) 的 **git-kit**（Git 工作流）、**handoff**（跨会话交接）与 **disk-cleanup**（磁盘空间回收）接入为 dsh 命令。

命令只声明「命令 → 技能分支」的意图，执行逻辑与唯一真源在对应 skill 里，因此与 opencode 入口、自然语言触发共用同一套实现。本仓不含 skill 逻辑；将来其它 skill 的命令，往 `lib/index.ts` 的 `COMMANDS` 表加一行即可。技能的安装 / 更新委托给 [`@morehao/dsh-skills-console`](https://github.com/morehao/dsh-skills-console) 的包 API（本插件 dependency，自动带上），**不要求启用技能控制台插件**。

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
| `/git-checkout-tag` | `[tag名]` | git-kit → checkout-tag（切到最新 tag，detached HEAD 只切不改） |
| `/git-slim` | `[保留天数]` | git-kit → slim |
| `/git-star-classify` | 无 | git-kit → star-classify |
| `/handoff` | `[任务范围]` | handoff → print（只打印，不落盘） |
| `/cleanup` | `[清理范围]` | disk-cleanup → cleanup（无参数时先给选项，不执行脚本） |

维护型委托（经 `skill_init` 工具执行，负责把插件依赖的技能装到共享目录并保持最新）：

| 命令 | 参数 | 作用 |
|---|---|---|
| `/skill-init` | `[--update [技能名...]] [--yes]` | 检查并安装插件依赖的技能到共享目录 `~/.agents/skills`；**只在确定要写盘时**弹确认（缺失）。`/skill-init` 只补缺失，装到最新要用 `--update`（可指定技能名，显式更新不弹确认）；`--yes` 跳过确认 |

维护型委托（检查并更新插件**自身**，与技能无关；经 `plugin_update` 工具执行）：

| 命令 | 参数 | 作用 |
|---|---|---|
| `/plugin-update` | `[--apply] [--yes]` | 默认只检查 npm 上 `@morehao/dsh-commands` 的最新版本并显示当前 / 最新；`--apply` 会**先问答确认再一键更新**，更新过程显示在后台作业里，完成后提示重启 DSH 生效；`--yes` 跳过确认（仅 apply 有效） |

> 更新插件会 `remove` + `install` 重载插件本身：命令委托给 `plugin_update` 工具，确认卡、作业进度、结果都由 dsh 原生提供；更新成功后会在 `$DSH_HOME/dsh-commands/state.json` 记 pending 版本，**重启后首次加载**再给一条「已更新到 vX」提示（同一进程内只补发一次）。无 `tools`/无 agent 时回退为本地只读检查。

额外技能（例如 agent-skills 的 `tech-design`、`project-insight`）不再由插件安装：dsh 本身会扫描 `~/.agents/skills`，直接执行下面这条即可，或者用自然语言让 agent 装：

```bash
npx -y skills add morehao/agent-skills --skill tech-design -g -a universal -y
```

`/skill-init` 是一条维护型委托命令：注入一条 user 消息，由 agent 调用 `skill_init` 工具；工具内部按 **resolve-api → observe → adopt → plan → confirm → apply → verify** 执行，命令卡只显示一行「已开始检查依赖技能」。**安装 / 更新全部委托给 `@morehao/dsh-skills-console` 包 API**（本插件的 dependency，自动带上），**不要求启用技能控制台插件**：插件启用时包 API 命中插件实例共享同一个 StateStore，未启用时用 headless 实例单写。确定要写盘时，工具用 dsh 原生问答卡确认一次（`处理全部` / `只补缺失` / `取消`），`--yes` 跳过；安装/更新过程挂在后台作业上：会话头部实时显示阶段，可两击停止，不触发额外模型回合。结果由工具返回结论 + 逐项明细 + 契约/验证信息，agent 用 1–3 句话总结（有需处理事项才列下一步）。无 `tools` 或没有可用 agent 时，命令自动回退到本地执行核心，功能不丢。详见 [技能自举](./docs/skill-setup.md)。

## 安装

**插件走 npm；依赖技能由技能控制台包直接装到共享目录。**

要求：dsh `>=0.2.1-rc.3 <0.3.0-0`（`engines.dsh`）+ Node.js `>=22.20`；低于该范围的宿主会在 bundle 加载阶段被跳过。

```bash
# 退出 dsh 客户端后执行，装完再启动
dsh plugin --profile <profile> add @morehao/dsh-commands
```

装完在 dsh 里执行 `/skill-init`：检查 `git-kit` / `handoff` / `disk-cleanup`，缺失则通过 `@morehao/dsh-skills-console` 包 API 安装到共享目录 `~/.agents/skills`（同时写 v3 lock 与 `state.json`）；`/skill-init` 只补缺失，`--update` 才把已装技能跟到上游最新。**不需要额外装或启用技能控制台插件**——本插件的 `dependencies` 会带上 console 包，`createSkillsConsole()` 在包内部选择 headless 或复用插件实例。安装结果仍是标准的 `~/.agents/skills` + `.skill-lock.json`，其他 agent 可以继续用 `npx skills`。

技能目录 `~/.agents/skills` 本身就是 DSH 的扫描根，装好即对 DSH 可见；本插件**不再**往 `~/.dsh/skills` 建可见性链（那是两份真相）。已经手工放好的技能会被识别为「已安装」，控制台账本里没有时先 `adopt` 只补记账。安装器的事务（下载 → 安全解压 → 原子 promote → lock）由控制台包的 native installer 负责，失败自动回滚。

装好后直接输入 `/` 选择命令，例如 `/git-message 修复登录超时`、`/git-commit-push`、`/handoff`、`/cleanup`（不带参数时先给编号选项）。

手工准备技能与环境变量的说明见 [技能自举](./docs/skill-setup.md)；`link:` 本地开发见 [开发与测试](./docs/development.md)。

## 原理

每条命令注册到 `ctx.commands`。执行时 handler 校验必填输入，构造一条 user 消息经 `invocation.agent.followup()` 注入当前会话，由 agent 加载对应 skill、按对应分支执行——交互确认步骤与自然语言触发完全一致。`COMMANDS` 表自包含，不读取任何仓库文件。

注入的 user 消息优先用 DSH 官方 `@deepseek-ai/dsh-llm` 的 `createUserMessage`（可选加载，自带 `id` 与深冻结）；没有该模块（离线冒烟 / 旧宿主）时回退到等价的本地契约实现（`role` / `source` / `content` / `id` 齐全、深冻结）。

- 编辑技能内容（本源 `~/.agents/skills/...`）**无需重启**，下次执行即生效。
- 委托型命令执行前会确认依赖技能可用：优先问 DSH 技能目录（`ctx.skills.list()`，权威、已校验），目录不可用时回退文件探测（`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` 或 `~/.agents/skills`，顺序固定）；缺失时不注入消息，直接返回 `/skill-init` 与手工 `npx` 两条修复路径。控制台把技能设为停用 / 完全停用 / 仅手动时也会提前给原因。
- 维护型委托 `/skill-init`（含 `--update`）注入一条 user 消息，由 agent 调用 `skill_init` 工具（`mode=init/update/check`、`names`、`yes`）：默认先确认；无确认通道时只返回计划、不写盘；`yes=true` 只跳过确认，不跳过 apiVersion 校验与旧 console 版本守卫。
- 命令与工具共用 `lib/skill-setup.ts` 的 observe/plan/apply/verify，安装/更新经 `lib/console-api.ts` 解析出的包 API 执行；无 `tools`、无 `agent.followup` 或注入失败时，命令回退到 `runSkillInit` / `runSkillUpdate`，旧宿主仍可用。
- 修改插件源码（含 `COMMANDS` 表）需重启 dsh web；只有以 `link:` 方式接入时才改源码即生效，npm 版是拷贝。
- 命令描述直接写中文：dsh 目前不向第三方提供描述文本的 i18n 钩子。

注入消息与 `recordInput`、i18n 的完整依据、`handoff` 的 `readFallback`、插件页元信息，见 [架构与原理](./docs/architecture.md)。

## 开发

```bash
npm run build                           # tsc 把 lib/*.ts 编译到 dist/（产物不入库）
npm run check                           # 本地全量：构建 + 产物自检 + 语法扫描 / 命名 / 打包 / Release 投影 + 全部离线冒烟
npm test                                # 全部离线冒烟（注入 fake API / stub，不联网）
node scripts/check-skill-contract.mjs   # 命令 → 技能分支的跨仓契约（需技能已安装）
node scripts/smoke-skill-setup.mjs      # 技能自举（API 消费 / 旧 console 守卫，不联网）
node scripts/smoke-skill-contract.mjs   # 契约校验：技能根顺序 / 缺分支 / 缺技能去重（临时 HOME）
```

CI 在 PR 上先 `npm ci` + `npm run build`（`tsc` 把 `lib/*.ts` 编译到 `dist/`），再校验发布脚本语法、`scripts/` 语法与 locale JSON、三处命名一致、打包白名单、Release 正文投影与全部离线冒烟（`npm test`），用的就是上面这几个 npm script。扩展命令、测试细节与命名约定见 [开发与测试](./docs/development.md)。

## 发布

升 `package.json` 版本 → PR 合并 → 在合并后的 `main` 打 `vX.Y.Z` tag，GitHub Actions 用 OIDC 自动发布到 npm（无需长效 token），发布成功后用注记 tag 的正文创建 GitHub Release。workflow 会校验 tag 版本与包版本一致；npm 上已存在同版本则跳过（幂等），Release 已存在也跳过。

合并之后推荐用 `/git-release` 完成打 tag、校验 Release 与后效；它探测到本仓由 CI 建 Release 时只校验、不重复建。只想打标签、不建 Release 用 `/git-tag`。完整流程、一次性配置与踩坑见 [发布说明](./docs/publishing.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [架构与原理](./docs/architecture.md) | 意图表、执行链路、i18n 与记录策略、生效条件、展示元信息 |
| [技能自举](./docs/skill-setup.md) | `/skill-init` / `--update`、包 API 安装模型、环境变量、典型用法 |
| [过程可见](./docs/job-progress.md) | 后台任务、作业面板、无事可做、降级 |
| [开发与测试](./docs/development.md) | 目录、扩展命令、契约校验、冒烟、CI、命名约定 |
| [发布说明](./docs/publishing.md) | npm OIDC 发布、一次性配置、排障 |
| [历史](./docs/history.md) | 从 agent-skills 拆仓的记录 |

## 许可

[MIT](./LICENSE)
