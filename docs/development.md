# 开发与测试

host 源码是 `lib/*.ts`，由 `tsc` 编译到 `dist/`（构建产物，**不入库**）；`npm run build` 生成，`npm run dev` 持续构建。运行时依赖 `@morehao/dsh-skills-console`。没有 web client half。

## 目录

| 路径 | 作用 |
|---|---|
| `lib/index.ts` | 意图表 `COMMANDS`、`/skill-init` 元数据、`apply()` 注册命令与工具 |
| `lib/skill-setup.ts` | `/skill-init`（含 `--update`）的 plan、安装、软链、校验 |
| `lib/skill-paths.ts` | `$DSH_HOME` / `$DSH_AGENTS_HOME` / 本源 / lock 路径解析，以及统一的技能根顺序 `skillRoots()` |
| `lib/text.ts` | ANSI 清洗、spinner 折叠、尾部截断 |
| `lib/proc.ts` | 子进程 timeout / abort / 输出上限 |
| `lib/job-progress.ts` | 把长任务挂到 `ctx.jobs`，作业行/面板/停止/回执 |
| `lib/skill-command.ts` | `/skill-init` flags 解析、注入消息、handler、本地回退 |
| `lib/skill-confirm.ts` | `skill_init` 的确认问题/选项与 `confirmSkillPlan()` |
| `lib/tool-skill-init.ts` | `skill_init` 工具定义、execute 编排、结果 markdown |
| `lib/console-api.ts` | `@morehao/dsh-skills-console/api` 解析与旧 console / API 版本守卫 |
| `lib/plugin-update*.ts` / `lib/tool-plugin-update.ts` | 自更新版本检查、确认、执行与 `plugin_update` 工具 |
| `dist/`（构建产物） | `npm run build`（tsc）生成，**不入库**；包内实际入口 `dist/index.js` |
| `tsconfig.host.json` / `scripts/build-host.mjs` | tsc 构建配置与构建脚本 |
| `locale/{zh,en}.json` | 插件页标题与描述 |
| `cordis.patch.yml` | dsh profile bundle patch（注册插件） |
| `scripts/` | 契约校验、冒烟、命名/打包校验、发布脚本 |
| `.github/workflows/` | `check.yml`（PR 校验）、`release.yml`（tag 发布） |
| `docs/` | 架构、技能自举、过程可见、发布等细节文档 |

## 增删命令

改 `lib/index.ts` 的 `COMMANDS` 表即可，每条一行声明：

- `branch` 值必须与对应 `SKILL.md` 决策树的分支 key 一致（即 `references/<branch>.md`）；`skill` 省略时默认 `git-kit`。
- `hint` / `required` 决定输入提示与校验；`description` 原样出现在斜杠菜单，不做 i18n（原因见 [架构与原理](./architecture.md#描述文本不做-i18n有意为之)）。
- 技能对「无参数」有专门语义时用 `noInput` 覆盖默认注入语（`/cleanup` 靠它实现「先给选项、不执行脚本」），需要用户确认的事项用 `confirm` 覆盖默认措辞。
- 命令与 agent-skills 里 opencode 侧 `commands-opencode/git/*.md`、`commands-opencode/handoff.md`、`commands-opencode/cleanup.md` 是同一 skill 的多条入口，只声明意图、不重复逻辑。
- 新增委托型命令后，`REQUIRED_SKILLS` 会自动带上它的技能，`/skill-init` 与 `--update` 无需另改；委托型 handler 也会自动预检该技能是否已安装。
- 任意来源的额外技能不进 `COMMANDS`，也不由插件安装：直接 `npx -y skills add <来源> --skill <名称> -g -a universal -y`。

## 跨仓契约

命令 → 技能分支的对应关系已跨仓（技能在 agent-skills）。改动 `COMMANDS` 或技能分支后跑：

```bash
node scripts/check-skill-contract.mjs
```

它按 `skillRoots()` 的顺序找技能（`$DSH_HOME/skills` → `$DSH_AGENTS_HOME/skills` → 本源 `~/.agents/skills`，与委托型 handler 的预检完全一致），命中后检查 `references/<branch>.md` 是否存在（单分支技能只校验 `SKILL.md` 存在，如 `/handoff` 的 `print`）。缺技能按技能去重报一次，并列出所有查过的路径。技能改分支名而插件没跟，就是在这里暴露的。

上游自 #50 起「本源才是真实内容、`$DSH_HOME/skills` 只是 fanout 软链层」，所以只发了本源、没建链的机器也能通过；反之，装了软链但本源缺失时，会按实际目录校验。技能未安装时先 `/skill-init`。

CI 默认不跑契约校验——它依赖另一仓的技能目录；根顺序与失败输出由 `smoke-skill-contract.mjs` 在临时 HOME 里覆盖。

## 冒烟测试

```bash
npm test                             # 等价于下面六个冒烟（CI 也只调这一个入口）
node scripts/smoke-skill-setup.mjs   # stub CLI：安装/软链/并发/超时/作业/命令回退
node scripts/smoke-skill-plan.mjs    # observe/plan：所有权、缺失、真实目录、控制台记录
node scripts/smoke-skill-tool.mjs    # skill_init：确认/写盘/停止/指纹/结果矩阵
node scripts/smoke-skill-command.mjs # /skill-init：flags、注入消息、source.kind、回退
node scripts/smoke-plugin-update.mjs # /plugin-update：解析、注入、版本检查、确认、更新
node scripts/smoke-skill-contract.mjs # 契约校验：技能根顺序 / 缺分支 / 缺技能去重（临时 HOME）
```

`smoke-skill-plan` 用临时 HOME 覆盖 observe/plan 的 15 种组合；`smoke-skill-tool` 用假 jobs/asker 覆盖工具的完整矩阵与交互不变量；`smoke-skill-command` 只测命令层，不启动 dsh。

`smoke-skill-setup` 用 `DSH_COMMANDS_SKILL_CLI_OVERRIDE` 指向一个 stub 顶替 `skills` CLI，在临时 HOME 里覆盖：

- 「缺失 → 装 + 软链 / 已托管 → 跳过 / 非托管软链 → 替换 / 真实目录 → 拒绝覆盖 / `--update`」五条路径，以及技能缺失时委托命令的预检；
- 全程不联网、不碰真实 `~/.dsh`，也不会产生备份目录；
- 失败回执剥框线、ANSI 与 CLI logo，网络不可达时给代理/镜像提示；
- 过程可见层用假 jobs 注册表断言「只启动一个作业 / kind·owner·label 透传 / 阶段文案刷新 / CLI 输出流入面板 / 结算前已 `wait`（awaited，不投通知）/ 结果带回作业视图 / 作业被停止返回 killed / 取消只 kill 不抢跑 / jobs 缺失与无控制器降级 / `apply()` 注册的 handler 端到端跑通（12 条命令、`--update`、非法位置参数、/cleanup 无参数注入「先给选项」、回执首行结论 + 第二行作业 id）」；
- `needsConfirmation()` 与 `installTargets()` 单独断言：写盘只由缺失/待修复驱动，上游更新只报告；确认逻辑本身由 `smoke-skill-tool` 覆盖。
- `/skill-init` 命令层在无 tools 时走本地回退（`--update` 仍强制更新，非法位置参数报用法）；有 tools 时的注入行为由 `smoke-skill-command` 覆盖。

`smoke-skill-contract` 在临时 HOME 里铺技能目录，覆盖契约校验的两类行为：技能根顺序（只有本源 / 只有 `$DSH_HOME/skills` / 只有 `$DSH_AGENTS_HOME/skills` / 软链层指向本源都算已安装）与失败输出（缺 `references/<branch>.md`、缺技能按技能去重并列出查过的路径）。它 spawn 真实脚本，不联网。

改动 `lib/job-progress.ts` 前先读 `scripts/smoke-skill-setup.mjs` 顶部注释：它记录了「为什么只能用 `wait` 收尾」以及 dsh 侧的行号证据。

## CI

`.github/workflows/check.yml` 在 PR 上机械校验，每一步都调同一个 npm script（CI 不另列文件清单）：

- 发布脚本语法：`bash -n scripts/ci-publish.sh`；
- 插件语法：`npm run check:syntax`（扫 `scripts/` + `locale/*.json`；TS 类型/语法由 `npm run build` 的 tsc 负责）；
- Release 正文投影：`npm run check:release-notes`（注记 tag → Release body）；
- 包名 / 模块标识符 / 插件名三处一致：`npm run check:naming`；
- 打包内容白名单：`npm run check:pack`（防止 `.dsh/` 草稿、`node_modules`、`*.tgz` 混进 npm tarball）；
- 六个离线冒烟：`npm test`（技能自举 + plan + 工具 + 命令 + 缓存 + 契约校验）。

本地 `npm run check` = 上面除 `bash -n` 外的全部（`check:contract` 不在其中，它依赖另一仓的技能目录）。

## 命名约定

- `package.json` 的 `name`（npm 包名）== `cordis.patch.yml` 的 `insert[0].name`（dsh 启动时 `import()` 的**模块标识符**）。
- `lib/index.ts` 的 `export const name`（cordis 插件名）== `cordis.patch.yml` 的 `insert[0].id`，与模块标识符**解耦**。
- `publishConfig.access` 必须是 `public`。

改包名时三处同步核对（CI 有机械校验）；完整发布约定见 [发布说明](./publishing.md#5-dsh-插件命名约定改包名插件名时三处同步核对)。

## 本地开发

用 `link:` 方式接入，源码即时生效，不依赖 npm 版本：

```bash
npm install        # 安装 devDependencies（typescript/@types/node）并触发一次 prepare 构建
npm run build      # 改源码后重建 dist/（或 npm run dev 持续构建）
dsh plugin --profile <profile> add link:/绝对路径/dsh-commands
# 重启 dsh web
```

没装 `skills` 依赖也能跑：`resolveCli` 会回退 `npx -y skills`，只是每次多 2–3s 的 npx 启动。

若 profile 里装的是 npm 版，profile 下的 `node_modules` 是一份**拷贝**，改仓库源码不会生效，需先升版本发版再重装。
