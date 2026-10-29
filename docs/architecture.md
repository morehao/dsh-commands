# 架构与原理

本仓只做 **dsh 分发/适配单元**：一张意图表 + locale/icon + 发布链，**不含任何 skill 逻辑**。技能本身由 [`morehao/agent-skills`](https://github.com/morehao/agent-skills) 提供；命令与 agent-skills 里 opencode 侧的 `commands-opencode/git/*.md`、`commands-opencode/handoff.md`、`commands-opencode/cleanup.md`、以及自然语言触发，是同一条 skill 的多条入口，只声明意图、不重复逻辑。

## 命令 = 意图表

每条命令注册到 `ctx.commands`（`CommandDefinition`：`name` / `description` / `input.hint` / `recordInput` / `handler`），出现在 dsh 斜杠菜单。

`lib/index.ts` 里的 `COMMANDS` 是**自包含的意图表**：一行声明 = 注册元数据 + 对应的 skill 分支 key（`branch`；`skill` 省略时默认 `git-kit`）。它**不读取任何仓库文件**，逻辑与路由的唯一真源在各 skill（`SKILL.md` 意图决策树 + `references/` + `scripts/`）。

```js
{
  name: "git-message",
  branch: "commit-message",
  hint: "<中文描述>",
  required: true,
  description: "…"
}
```

维护型命令有两类：`/skill-init`（`--update` 走同一命令的更新分支，委托 `skill_init` 工具，见 [技能自举](./skill-setup.md)）与 `/plugin-update`（委托 `plugin_update` 工具，检查并一键更新插件自身）。`/skill-init` 依赖的技能集合由 `COMMANDS` 推导：

```js
export const REQUIRED_SKILLS = Object.freeze(referencedSkills(COMMANDS));
```

新增/删除委托型命令后，技能自举与 `--update` 自动跟进，不需要维护第二份清单。

`/skill-init` 不在本地执行：handler 解析 `--update` / `--yes` / 技能名，构造一条 **`source.kind: "user"`** 的消息注入当前会话，让 agent 调用 `skill_init` 工具（实现在 `lib/skill-command.ts`）。命令卡只返回一行「已开始检查依赖技能 / 已开始更新依赖技能」。

`lib/tool-skill-init.ts` 是 `skill_init` 的纯定义：`lib/index.ts` 在 `ctx.get("tools")` 可用且动态 `import("@deepseek-ai/dsh-tools")` 成功时注册（`apply` 是 async：先可选加载官方消息工厂，再 `await ctx.commands.register(...)` 注册命令，`register()` 内部已绑定调用方 fiber，卸载自动注销）；旧宿主或 import 失败只跳过工具，命令回退不变。

工具的 execute 顺序固定：

1. `observeSkills()` 读取本机 canonical / 软链 / lock / 控制台记录；
2. `planOperation()` 只做本地判定：写盘范围（缺失/修链）、上游已知更新只 warn、控制台所有权；
3. 有写盘且未 `yes` 时 `confirmSkillPlan()`：无 `userQuestions` 或确认通道异常只返回 `plan`、零写；`只补缺失` 会把非 missing 的 install/relink 降级；
4. 写前再 observe 一次做指纹，涉及技能的链/canonical 变了就整次中止；
5. `runInJob()` 把 `probeUpstream`（缓存过期时）与 `applyPlan` 挂到 dsh 后台作业；`owner` 取 `exec.agent.session.id`；
6. `verifyPlan()` 复核 canonical/links/state，结果里给 `status` / `actions` / `contract` / `verification` / `next` / `markdown`。

命令与工具共用 `lib/skill-setup.ts` 的 observe/plan/apply/verify；无 `tools`、无 `agent.followup` 或注入失败时，handler 回退到 `runSkillInit` / `runSkillUpdate`（本地执行，无 agent 回合），保证旧宿主不丢功能。

`/plugin-update` 是第二条**维护型委托**命令：handler 解析 `--apply` / `--yes` 后注入一条 user 消息，让 agent 调用 `plugin_update` 工具。工具内 observe → plan → confirm → apply → verify：

- `lib/plugin-update.ts` 从自身 `package.json` 取包名/版本；最新版优先走 `pnpm view <pkg>@latest version --json`（继承 profile 的镜像/私源/token），拿不到再用 `ctx.get("pluginManager").registries()` 的 registry 计划（含镜像/私源）依次查 `<pkg>/latest`（8s 超时、5 分钟缓存），手写 semver 比较；另含状态文件 `<home>/dsh-commands/state.json` 的读写（`home` 优先取 `profileContext.home`，缺省 `$DSH_HOME`）。
- `lib/plugin-update-service.ts` 负责确认（`userQuestions.ask`）与执行：`installBundle → already-installed → removeBundle → installBundle`，返回 `application` / `restartRequired`。
- `lib/tool-plugin-update.ts` 负责流程编排；apply 时把安装挂到 `ctx.jobs`（作业行/面板可见、可停止），成功后写 `pendingVersion`。
- 更新自身会 `remove` 本插件、触发重载，因此工具把安装放进后台作业，并用作业完成通知 + 启动提示兜底；`ctx.get("pluginManager")` / `userQuestions` / `jobs` 都按可选服务惰性取，缺失时回退本地只读检查或给手动命令。
- 重启后 `announcePluginUpdate()` 比对 `lastSeenVersion` / `pendingVersion`，向活跃会话补一条「已更新到 vX」的 notice（best-effort；无活跃 agent 时等下一个 agent 创建补发一次，补发成功后立即注销 `agent/created` 监听，避免同进程内每个新会话重复收到）。工具写 pending 时只前进 `lastSeenVersion`、不回退。

## 执行链路

1. 用户从斜杠菜单执行命令，进入 `makeHandler(def, ctx)`（委托型）、`makeSkillInitHandler()`（维护型委托）或 `makePluginUpdateHandler()`（维护型委托，插件自身更新）。
2. 委托型：handler 校验必填输入（`required`），缺失时返回 `Usage: /<name> <hint>` 示例；随后预检依赖技能可用性——优先 `ctx.get("skills").list({ cwd })`（权威、已校验，能识别 `disable-model-invocation` 等被过滤的技能），目录不可用时回退文件探测（`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` 或 canonical `~/.agents/skills`）；缺失时不注入委托，直接返回 `/skill-init` 与手工 `npx` 两条修复路径。`/skill-init` 自己就是安装器，不做技能预检。
3. `buildInstruction(def, input)`（或 `buildSkillInitMessage()`）生成一段委托指令。
4. 指令被包装成一条 **user 消息**，通过 `invocation.agent.followup()` 注入当前会话。
5. 委托型命令由 agent 用 `skill` 工具加载对应 skill，把本次请求视为 `branch` 分支执行；`/skill-init` 由 agent 调用 `skill_init` 工具，确认/进度/停止都在工具里。
6. 命令卡片返回一行结算文案（`已按 … 委托执行…` / `已开始检查依赖技能`）。

user 消息优先用 DSH 官方 `@deepseek-ai/dsh-llm` 的 `createUserMessage`（`apply()` 里经 `try { await import("@deepseek-ai/dsh-llm") } catch {}` 可选加载；含 `id` 与深冻结）；没有该模块（离线冒烟 / 非 DSH 宿主）时回退到等价的本地契约实现（`role` / `source` / `content` / `id` 齐全，深冻结）。因此 `lib/` 仍**不引入**任何顶层 `@deepseek-ai/*` 静态 import。`source` 字段必填——dsh 的 Message 契约会读 `message.source.kind`，缺失会在 agent 回合崩溃。

### handoff 的 readFallback（历史兼容）

`handoff` 的 `SKILL.md` 在 2026-10-25 之前标了 `disable-model-invocation`（只允许用户手动调用），dsh 会把它移出模型可见的技能目录，且 `skill` 工具直接拒绝加载。agent-skills #51 已移除该标记，`handoff` 恢复成模型可见、可自行触发；本插件仍保留 `readFallback: true`，让装了旧版技能目录的机器还能跑通，新装环境不会走到这条兜底。注入文本给的是一条按技能根顺序可用的兜底路径：

> 若 `skill` 工具报 `not available for model invocation`（技能被标为仅用户可调用；旧版 handoff 会这样），改用 `read` 工具读取技能文件：优先 `$DSH_HOME/skills/handoff/SKILL.md`（dsh 软链层），不存在时读本源 `~/.agents/skills/handoff/SKILL.md`，需要时再读同目录下的 `references/`。

补本源路径是必须的：agent-skills #50 之后本源才是真实内容，`$DSH_HOME/skills` 只是 fanout 软链层，可能根本不存在。

### cleanup 的无参数语义

`disk-cleanup` 的 `SKILL.md` 第 0 步规定：用户没有文字说明时**不执行任何脚本**，先给编号选项（只看占用 / 选勾清理 / 只处理本地数据库 / 取消），等用户选。通用语「未附加说明，按分支流程默认处理」会把模型推向直接开跑，所以 `/cleanup` 在 `COMMANDS` 里置 `noInput`，无参数时注入：

> 用户未附加说明：按 SKILL.md 第 0 步先给出编号选项（…），等用户选择后再继续；不要执行任何脚本，也不要替用户选默认项。

带参数时则按 `confirm` 提示需要用户决策的事项（清理范围 / 清理项编码 `--only`），与其它命令一致。技能侧（#52 起）还要求报告区分「目录总量 / 本次可删量」、`--clean` 前先 `--dry-run` 复核，并且 agent 侧只用 `--only`、不用 `--all`；命令描述已同步这层含义。

## 会话记录：`recordInput`

委托型命令统一注册 `recordInput: false`。

原因：用户输入已经逐字写进注入的那条 user 消息（会话日志里的真实事件），若再让 `command/run` 记一份同样的 `args`，就是同一 payload 落两份日志。按 dsh 官方指引（命令自身的权威事件已承载 payload 时置 `false`）统一关掉。

这不影响聊天区的命令行显示：`GenericCommandCard` 只渲染命令名与结算文案，不渲染 `args`。

`/skill-init` 也注册 `recordInput: false`：输入已经逐字写进注入的 user 消息；回退路径没有注入，但同一次用户输入仍由命令行本身可见，不需要再记一份 `args`。

## 描述文本不做 i18n（有意为之）

dsh 只本地化它自己的 6 条一方命令：客户端 `HOST_DESCRIPTION_KEYS` 硬编码 `compact` / `export` / `feedback` / `goal` / `permission` / `plan`，且要求 `description` 与英文原文逐字相等才翻译，其余一律**原样透传**。

第三方也**无法**用同名客户端 `CommandContribution` 覆盖：同名会在候选合成时以 `collides with a host command` 直接抛错；`CommandDecoration` 又**没有** `description` 字段。Host 侧同样拿不到语言偏好——`SettingsProvider` 只提供 `register()`，namespace `locale` 已被 locale 插件独占（重复注册会抛错），且 `locale.preference` 缺省时本就交给浏览器 `navigator.language` 决定。

因此本插件 12 条命令描述直接写中文：中文界面下与一方命令表现一致。若将来 dsh 开放第三方描述 i18n 钩子，再改为按键取值。

## 生效与重启

- 编辑技能（本源 `~/.agents/skills/{git-kit,handoff,disk-cleanup}/`，或 `$DSH_HOME/skills` 下的软链）**无需重启**，下次执行即生效——技能由 agent-skills 提供，与本插件版本无关。技能根有 watcher，安装完也免重启。
- 修改本插件 `lib/index.ts`（含 `COMMANDS` 表）需先 `npm run build`，再重启 dsh web 生效（产物在 `dist/`）。
- **只有以 `link:` 方式接入时改源码才生效**：若 profile 里装的是 npm 版（`dsh plugin --profile web add @morehao/dsh-commands`），profile 下的 `node_modules` 是一份**拷贝**，改仓库源码不会生效，需先升版本发版再重装。

## 插件页展示元信息

dsh 的插件页（侧栏「插件」→ 组合包详情与组件行）在**不加载插件 JS** 的前提下读取展示元信息：

- 标题与描述取自导出的 `locale/<语言>.json` 的 `meta.title` / `meta.description`（本包提供 `en` 与 `zh`，随界面语言切换）。
- 图标取自 `package.json` 的 `icon`（优先）或导出的 `./icon`；格式限 SVG/PNG/JPEG/WebP，且不超过 256 KiB。
- 这些资源必须同时写进 `exports` 与 `files`；`package.json` 也要导出（`"./package.json": "./package.json"`）。否则「缺 locale 时回退到 package.json 的 `name` / `description`」这条兜底会因 `ERR_PACKAGE_PATH_NOT_EXPORTED` 静默失效：标题退化成模块名、描述为空，组件行还会多出一行与标题重复的包名。这正是本插件此前与 `dsh-context` 等信息完整的插件在页面上出现差异的原因。

> 标题表达「这个插件是什么」（`dsh 命令集 (dsh-commands)`），不表达「它从哪个仓来」——所以标题里**不写仓名**；「技能由 agent-skills 仓提供」只写在 `description` 末尾。

## 扩展命令

往 `lib/index.ts` 的 `COMMANDS` 表加一条声明即可，无需改注册代码：

- `branch` 必须与对应 `SKILL.md` 决策树的分支 key 一致（即 `references/<branch>.md`）；`skill` 省略时默认 `git-kit`。
- `hint` + `required` 决定输入提示与校验；`description` 会原样出现在斜杠菜单（见上文 i18n 说明）。
- 技能对「无参数」有专门语义时（如 `/cleanup` 必须先问再动），用 `noInput` 覆盖默认注入语；有参数时需要用户确认的事项用 `confirm` 覆盖 git 语境的默认措辞。
- 新增后跑一次跨仓契约校验：`node scripts/check-skill-contract.mjs`，详见 [开发与测试](./development.md)。技能未安装时它无法通过，先 `/skill-init`。
