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
| `/git-checkout-tag` | `[tag名]` | git-kit → checkout-tag（切到最新 tag，detached HEAD 只切不改） |
| `/git-slim` | `[保留天数]` | git-kit → slim |
| `/git-star-classify` | 无 | git-kit → star-classify |
| `/handoff` | `[任务范围]` | handoff → print（只打印，不落盘） |
| `/cleanup` | `[清理范围]` | disk-cleanup → cleanup（无参数时先给选项，不执行脚本） |

维护型委托（经 `skill_init` 工具执行，负责把插件依赖的技能装上、软链进 dsh 并保持最新）：

| 命令 | 参数 | 作用 |
|---|---|---|
| `/skill-init` | `[--update [技能名...]] [--yes]` | 检查并安装插件依赖的技能，软链进 dsh；**只在确定要写盘时**弹确认（缺失/待修复）。上游有更新的技能不会被静默覆盖：`/skill-init` 只报告，装到最新要用 `--update`（可指定技能名，显式更新不弹确认）；`--yes` 跳过确认 |

维护型本地执行（检查插件**自身**是否有新版本，与技能无关）：

| 命令 | 参数 | 作用 |
|---|---|---|
| `/plugin-update` | 无 | 查 npm 上 `@morehao/dsh-commands` 的最新版本，显示当前 / 最新版本；**只检查、不自动安装**。有更新时给出手动命令：退出 dsh 后执行 `dsh plugin --profile <profile> add @morehao/dsh-commands@latest` |

> `/plugin-update` 故意不做一键安装：更新自己会触发 `remove` + `install` 重载本插件，命令卡可能来不及结算。dsh 插件页本身也能更新插件，这条命令提供的是会话内的只读检查。

额外技能（例如 agent-skills 的 `tech-design`、`project-insight`）不再由插件安装：dsh 本身会扫描 `~/.agents/skills`，直接执行下面这条即可，或者用自然语言让 agent 装：

```bash
npx -y skills add morehao/agent-skills --skill tech-design -g -a universal -y
```

`/skill-init` 是一条维护型委托命令：注入一条 user 消息，由 agent 调用 `skill_init` 工具；工具内部按 observe → plan → confirm → apply → verify 执行，命令卡只显示一行「已开始检查依赖技能」。确定要写盘时，工具用 dsh 原生问答卡确认一次（`处理全部` / `只补缺失` / `取消`），`--yes` 跳过；缓存过期只做只读检查、不打断。安装/更新过程挂在后台作业上：会话头部实时显示阶段，面板里是 `skills` CLI 的流式输出，可两击停止，不触发额外模型回合。结果由工具返回结论 + 逐项明细 + 契约/验证信息，agent 用 1–3 句话总结（有需处理事项才列下一步）。无 `tools` 或没有可用 agent 时，命令自动回退到本地执行核心，功能不丢。技能来源默认缓存在 `$DSH_HOME/cache/skills-sources`，首次 clone、之后增量 fetch；`--update` 是显式更新，init 发现上游更新只报告。详见 [技能自举](./docs/skill-setup.md) 与 [过程可见](./docs/job-progress.md)。

## 安装

**插件走 npm，技能走软链。**

```bash
# 退出 dsh 客户端后执行，装完再启动
dsh plugin --profile <profile> add @morehao/dsh-commands
```

装完在 dsh 里执行 `/skill-init`：检查 `git-kit` / `handoff` / `disk-cleanup`，缺失则从本地缓存（首次自动 clone）用 `skills` CLI 全局安装并软链进 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）；已托管且缓存 TTL 内与 lock 一致则跳过，TTL 过期会检查上游，**有更新只报告不重装**。确定要写盘（装缺失/修链）时工具会先弹一次确认，`/skill-init --yes` 可跳过；要把装好的技能跟到最新用 `/skill-init --update`。安装结果仍是标准的 `~/.agents/skills` + `.skill-lock.json`，其他 agent 可以继续用 `npx skills`。

这条链路与 agent-skills 自己的发布模型同向：仓库 → 本源 `~/.agents/skills`（`skills-install.sh`）→ 各 agent 目录软链（`skills-fanout.sh`）。所以已经跑过那两个脚本的机器，`/skill-init` 会判定为已托管并直接跳过——两边用的都是 skills CLI + 同一份 lock，不会互相覆盖。

装好后直接输入 `/` 选择命令，例如 `/git-message 修复登录超时`、`/git-commit-push`、`/handoff`、`/cleanup`（不带参数时先给编号选项）。

手工准备技能、可达镜像与环境变量的说明见 [技能自举](./docs/skill-setup.md)；`link:` 本地开发见 [开发与测试](./docs/development.md)。

## 原理

每条命令注册到 `ctx.commands`。执行时 handler 校验必填输入，构造一条 user 消息经 `invocation.agent.followup()` 注入当前会话，由 agent 加载对应 skill、按对应分支执行——交互确认步骤与自然语言触发完全一致。`COMMANDS` 表自包含，不读取任何仓库文件。

- 编辑技能内容（本源 `~/.agents/skills/...`，或 `$DSH_HOME/skills` 下的软链）**无需重启**，下次执行即生效。
- 委托型命令执行前会确认依赖技能是否已安装（`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` 或 `~/.agents/skills`，顺序固定）；缺失时不注入消息，直接返回 `/skill-init` 与手工 `npx` 两条修复路径。
- 维护型委托 `/skill-init`（含 `--update`）注入一条 user 消息，由 agent 调用 `skill_init` 工具（`mode=init/update/check`、`names`、`yes`）：默认先确认；无确认通道时只返回计划、不写盘；`yes=true` 只跳过确认，不跳过所有权/真实目录/指纹检查。
- 命令与工具共用 `lib/skill-setup.js` 的 observe/plan/apply/verify；无 `tools`、无 `agent.followup` 或注入失败时，命令回退到 `runSkillInit` / `runSkillUpdate`，旧宿主仍可用。
- 修改插件源码（含 `COMMANDS` 表）需重启 dsh web；只有以 `link:` 方式接入时才改源码即生效，npm 版是拷贝。
- 命令描述直接写中文：dsh 目前不向第三方提供描述文本的 i18n 钩子。

注入消息与 `recordInput`、i18n 的完整依据、`handoff` 的 `readFallback`、插件页元信息，见 [架构与原理](./docs/architecture.md)。

## 开发

```bash
npm run check                           # 本地全量：语法扫描 / 命名 / 打包 / Release 投影 + 全部离线冒烟
npm test                                # 全部离线冒烟（stub + 本地 git，不联网）
node scripts/check-skill-contract.mjs   # 命令 → 技能分支的跨仓契约（需技能已安装）
node scripts/smoke-skill-setup.mjs      # 技能自举 + 过程可见（stub，不联网）
node scripts/smoke-skill-cache.mjs      # 来源缓存 / TTL / lock 回写（本地 git，不联网）
node scripts/smoke-skill-contract.mjs   # 契约校验：技能根顺序 / 缺分支 / 缺技能去重（临时 HOME）
```

CI 在 PR 上校验发布脚本语法、全量插件语法（扫 `lib/`、`scripts/` 与 locale JSON）、三处命名一致、打包白名单、Release 正文投影与全部离线冒烟（`npm test`），用的就是上面这几个 npm script。扩展命令、测试细节与命名约定见 [开发与测试](./docs/development.md)。

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
