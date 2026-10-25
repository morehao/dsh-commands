# 开发与测试

host 没有构建步骤，源码即产物（纯 ESM）；唯一运行时依赖是 `skills` CLI。web client half（`lib/client.js`）也是手写的预打包 bundle，不需要前端构建。

## 目录

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 意图表 `COMMANDS` / `LOCAL_COMMANDS`、`apply()` 注册命令 |
| `lib/skill-setup.js` | `/skill-init`（含 `--update`）的 plan、安装、软链、校验 |
| `lib/skill-paths.js` | `$DSH_HOME` / `$DSH_AGENTS_HOME` / lock 路径解析 |
| `lib/skill-cache.js` | 来源浅克隆缓存、TTL、lock 回写 |
| `lib/text.js` | ANSI 清洗、spinner 折叠、尾部截断 |
| `lib/proc.js` | 子进程 timeout / abort / 输出上限 |
| `lib/job-progress.js` | 把长任务挂到 `ctx.jobs`，作业行/面板/停止/回执 |
| `lib/confirm.js` | `/skill-init` 执行前的 `ctx.userQuestions` 确认、按 plan 生成范围选项、`--yes` 降级 |
| `lib/client.js` | web client half：命令状态卡、`shell.overlay` 完成提示、会话行未读点 |
| `locale/{zh,en}.json` | 插件页标题与描述 |
| `cordis.patch.yml` | dsh profile bundle patch（注册插件） |
| `scripts/` | 契约校验、冒烟、命名/打包校验、发布脚本 |
| `.github/workflows/` | `check.yml`（PR 校验）、`release.yml`（tag 发布） |
| `docs/` | 架构、技能自举、过程可见、发布等细节文档 |

## 增删命令

改 `lib/index.js` 的 `COMMANDS` 表即可，每条一行声明：

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

它逐条检查 `$DSH_HOME/skills/<skill>/references/<branch>.md` 是否存在（单分支技能只校验 `SKILL.md` 存在，如 `/handoff` 的 `print`）。技能改分支名而插件没跟，就是在这里暴露的。技能目录默认 `~/.dsh/skills`，可用 `DSH_HOME` 覆盖；技能未安装时先 `/skill-init`。

CI 默认不跑契约校验——它依赖另一仓的技能目录。

## 冒烟测试

```bash
npm test                             # 等价于下面三个冒烟（CI 也只调这一个入口）
node scripts/smoke-client-bundle.mjs # client half 接线：命令卡 / 完成提示 / 未读点注册到约定槽
node scripts/smoke-skill-setup.mjs   # stub CLI：安装/软链/并发/超时/作业
node scripts/smoke-skill-cache.mjs   # 本地 git 源：cache/TTL/refresh/离线/lock 回写
```

`smoke-client-bundle` 加载 `lib/client.js` 的预打包 bundle，断言 client half 把命令卡、应用级完成提示、会话行未读点注册到约定槽，并核对 locale 与 `inject()` 形状（不启动 dsh、不联网）。

`smoke-skill-setup` 用 `DSH_COMMANDS_SKILL_CLI_OVERRIDE` 指向一个 stub 顶替 `skills` CLI，在临时 HOME 里覆盖：

- 「缺失 → 装 + 软链 / 已托管 → 跳过 / 非托管软链 → 替换 / 真实目录 → 拒绝覆盖 / `--update`」五条路径，以及技能缺失时委托命令的预检；
- 全程不联网、不碰真实 `~/.dsh`，也不会产生备份目录；
- 失败回执剥框线、ANSI 与 CLI logo，网络不可达时给代理/镜像提示；
- 过程可见层用假 jobs 注册表断言「只启动一个作业 / kind·owner·label 透传 / 阶段文案刷新 / CLI 输出流入面板 / 结算前已 `wait`（awaited，不投通知）/ 结果带回作业视图 / 作业被停止返回 killed / 取消只 kill 不抢跑 / jobs 缺失与无控制器降级 / `apply()` 注册的 handler 端到端跑通（12 条命令、`--update`、非法位置参数、/cleanup 无参数注入「先给选项」、回执首行结论 + 第二行作业 id）」；
- 执行前确认用假 `ctx.userQuestions` 断言「确定要写盘才问 / 缓存过期不提问 / 真实目录也会问（仍装 canonical）/ 取消不建作业 / 继续后正常执行 / `--yes` 跳过」；`installTargets()` 单独断言写盘范围（仅缺失/待修复；上游更新只报告，缓存过期时也为空），与技能冒烟一起跑，共一百三十余项断言。

`smoke-skill-cache` 用临时 git 源验证首次 clone、TTL 命中、refresh 更新、`ttl<0` 离线、fetch 失败回退、`--json` 解析与 lock 来源/40 位 git tree hash 回写（24 项，不联网）。

改动 `lib/job-progress.js` 前先读 `scripts/smoke-skill-setup.mjs` 顶部注释：它记录了「为什么只能用 `wait` 收尾」以及 dsh 侧的行号证据。

## CI

`.github/workflows/check.yml` 在 PR 上机械校验，每一步都调同一个 npm script（CI 不另列文件清单）：

- 发布脚本语法：`bash -n scripts/ci-publish.sh`；
- 插件语法：`npm run check:syntax`（扫 `lib/`、`scripts/` 全量 + `locale/*.json`；新增文件自动纳入）；
- Release 正文投影：`npm run check:release-notes`（注记 tag → Release body）；
- 包名 / 模块标识符 / 插件名三处一致：`npm run check:naming`；
- 打包内容白名单：`npm run check:pack`（防止 `.dsh/` 草稿、`node_modules`、`*.tgz` 混进 npm tarball）；
- 三个离线冒烟：`npm test`（client half 接线 + 技能自举 + 技能缓存）。

本地 `npm run check` = 上面除 `bash -n` 外的全部（`check:contract` 不在其中，它依赖另一仓的技能目录）。

## 命名约定

- `package.json` 的 `name`（npm 包名）== `cordis.patch.yml` 的 `insert[0].name`（dsh 启动时 `import()` 的**模块标识符**）。
- `lib/index.js` 的 `export const name`（cordis 插件名）== `cordis.patch.yml` 的 `insert[0].id`，与模块标识符**解耦**。
- `publishConfig.access` 必须是 `public`。

改包名时三处同步核对（CI 有机械校验）；完整发布约定见 [发布说明](./publishing.md#5-dsh-插件命名约定改包名插件名时三处同步核对)。

## 本地开发

用 `link:` 方式接入，源码即时生效，不依赖 npm 版本：

```bash
npm install        # link 不会代装 dependencies；装 skills 依赖后才会走「直接调用 CLI」
dsh plugin --profile <profile> add link:/绝对路径/dsh-commands
# 重启 dsh web
```

没装 `skills` 依赖也能跑：`resolveCli` 会回退 `npx -y skills`，只是每次多 2–3s 的 npx 启动。

若 profile 里装的是 npm 版，profile 下的 `node_modules` 是一份**拷贝**，改仓库源码不会生效，需先升版本发版再重装。
