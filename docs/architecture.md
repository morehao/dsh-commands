# 架构与原理

本仓只做 **dsh 分发/适配单元**：一张意图表 + locale/icon + 发布链，**不含任何 skill 逻辑**。技能本身由 [`morehao/ai-kit`](https://github.com/morehao/ai-kit) 提供；命令与 ai-kit 里 opencode 侧的 `commands-opencode/git/*.md`、`commands-opencode/handoff.md`、`commands-opencode/cleanup.md`、以及自然语言触发，是同一条 skill 的多条入口，只声明意图、不重复逻辑。

## 命令 = 意图表

每条命令注册到 `ctx.commands`（`CommandDefinition`：`name` / `description` / `input.hint` / `recordInput` / `handler`），出现在 dsh 斜杠菜单。

`lib/index.js` 里的 `COMMANDS` 是**自包含的意图表**：一行声明 = 注册元数据 + 对应的 skill 分支 key（`branch`；`skill` 省略时默认 `git-kit`）。它**不读取任何仓库文件**，逻辑与路由的唯一真源在各 skill（`SKILL.md` 意图决策树 + `references/` + `scripts/`）。

```js
{
  name: "git-message",
  branch: "commit-message",
  hint: "<中文描述>",
  required: true,
  description: "…"
}
```

本地执行型命令是另一张表 `LOCAL_COMMANDS`（`/skill-init`、`/skill-install`、`/skill-update`），见 [技能自举](./skill-setup.md)。它们依赖的技能集合由 `COMMANDS` 推导：

```js
export const REQUIRED_SKILLS = Object.freeze(referencedSkills(COMMANDS));
```

新增/删除委托型命令后，技能自举与 `/skill-update` 自动跟进，不需要维护第二份清单。

`LOCAL_COMMANDS` 的每条声明包含 `plan` / `label` / `run` 三个函数：

```js
{
  plan: (commands, input, options) => planSkillOperation("skill-init", commands, input, options),
  label: (input) => "检查并安装插件依赖的技能",
  run: (commands, input, options) => runSkillInit(commands, options),
}
```

- `plan` 只做本地判定（不联网）：要不要建作业、处理哪些技能、是否已最新；
- handler 把 `plan` 的结果同时用于 `runInJob.skip` 与 `run({ plan })`，所以同一条规则只算一次；
- `run` 不再自己 inspect 技能或比对 hash，只执行 plan 与措辞。

## 执行链路

1. 用户从斜杠菜单执行命令，进入 `makeHandler(def)`。
2. handler 校验必填输入（`required`），缺失时返回 `Usage: /<name> <hint>` 示例。
3. `buildInstruction(def, input)` 生成一段委托指令。
4. 指令被包装成一条 **user 消息**，通过 `invocation.agent.followup()` 注入当前会话。
5. agent 用 `skill` 工具加载对应 skill，把本次请求视为 `branch` 分支，按该分支的完整流程执行；需要用户决策（候选分支名 / PR·MR 编号 / tag 版本号 / 交接范围等）时先确认。
6. 命令卡片返回 `已按 <skill> <branch> 分支委托执行…` 的结算文案。

user 消息由 `userMessage()` **手工构造**，形态与官方 `createUserMessage` 的契约一致（`role` / `source` / `content` / `id` 齐全，深冻结），因此本模块不依赖任何 `@deepseek-ai/*` 运行时 import。`source` 字段必填——dsh 的 Message 契约会读 `message.source.kind`，缺失会在 agent 回合崩溃。

### handoff 的 readFallback

`handoff` 的 `SKILL.md` 标了 `disable-model-invocation`（只允许用户手动调用），dsh 会把它移出模型可见的技能目录，且 `skill` 工具直接拒绝加载。所以这条命令在 `COMMANDS` 里置 `readFallback: true`，注入文本会带一条兜底路径：

> 若 `skill` 工具报 `not available for model invocation`，改用 `read` 工具读取 `$DSH_HOME/skills/handoff/SKILL.md`（`DSH_HOME` 通常为 `~/.dsh`），需要时再读同目录下的 `references/`。

### cleanup 的无参数语义

`disk-cleanup` 的 `SKILL.md` 第 0 步规定：用户没有文字说明时**不执行任何脚本**，先给编号选项（只看占用 / 选勾清理 / 只处理本地数据库 / 取消），等用户选。通用语「未附加说明，按分支流程默认处理」会把模型推向直接开跑，所以 `/cleanup` 在 `COMMANDS` 里置 `noInput`，无参数时注入：

> 用户未附加说明：按 SKILL.md 第 0 步先给出编号选项（…），等用户选择后再继续；不要执行任何脚本，也不要替用户选默认项。

带参数时则按 `confirm` 提示需要用户决策的事项（清理范围 / 清理项编码），与其它命令一致。

## 会话记录：`recordInput`

委托型命令统一注册 `recordInput: false`。

原因：用户输入已经逐字写进注入的那条 user 消息（会话日志里的真实事件），若再让 `command/run` 记一份同样的 `args`，就是同一 payload 落两份日志。按 dsh 官方指引（命令自身的权威事件已承载 payload 时置 `false`）统一关掉。

这不影响聊天区的命令行显示：`GenericCommandCard` 只渲染命令名与结算文案，不渲染 `args`。

本地执行型命令相反，注册 `recordInput: true`：它们的输入只是可选的技能名/来源，没有别的权威事件承载这份 payload。

## 描述文本不做 i18n（有意为之）

dsh 只本地化它自己的 6 条一方命令：客户端 `HOST_DESCRIPTION_KEYS` 硬编码 `compact` / `export` / `feedback` / `goal` / `permission` / `plan`，且要求 `description` 与英文原文逐字相等才翻译，其余一律**原样透传**。

第三方也**无法**用同名客户端 `CommandContribution` 覆盖：同名会在候选合成时以 `collides with a host command` 直接抛错；`CommandDecoration` 又**没有** `description` 字段。Host 侧同样拿不到语言偏好——`SettingsProvider` 只提供 `register()`，namespace `locale` 已被 locale 插件独占（重复注册会抛错），且 `locale.preference` 缺省时本就交给浏览器 `navigator.language` 决定。

因此本插件 14 条命令描述直接写中文：中文界面下与一方命令表现一致。若将来 dsh 开放第三方描述 i18n 钩子，再改为按键取值。

## 生效与重启

- 编辑技能（`$DSH_HOME/skills/git-kit/`、`$DSH_HOME/skills/handoff/`、`$DSH_HOME/skills/disk-cleanup/`）**无需重启**，下次执行即生效——技能由 ai-kit 提供，与本插件版本无关。技能根有 watcher，安装完也免重启。
- 修改本插件 `lib/index.js`（含 `COMMANDS` 表）需重启 dsh web 生效。
- **只有以 `link:` 方式接入时改源码才生效**：若 profile 里装的是 npm 版（`dsh plugin --profile web add @morehao/dsh-commands`），profile 下的 `node_modules` 是一份**拷贝**，改仓库源码不会生效，需先升版本发版再重装。

## 插件页展示元信息

dsh 的插件页（侧栏「插件」→ 组合包详情与组件行）在**不加载插件 JS** 的前提下读取展示元信息：

- 标题与描述取自导出的 `locale/<语言>.json` 的 `meta.title` / `meta.description`（本包提供 `en` 与 `zh`，随界面语言切换）。
- 图标取自 `package.json` 的 `icon`（优先）或导出的 `./icon`；格式限 SVG/PNG/JPEG/WebP，且不超过 256 KiB。
- 这些资源必须同时写进 `exports` 与 `files`；`package.json` 也要导出（`"./package.json": "./package.json"`）。否则「缺 locale 时回退到 package.json 的 `name` / `description`」这条兜底会因 `ERR_PACKAGE_PATH_NOT_EXPORTED` 静默失效：标题退化成模块名、描述为空，组件行还会多出一行与标题重复的包名。这正是本插件此前与 `dsh-context` 等信息完整的插件在页面上出现差异的原因。

> 标题表达「这个插件是什么」（`dsh 命令集 (dsh-commands)`），不表达「它从哪个仓来」——所以标题里**不写仓名**；「技能由 ai-kit 仓提供」只写在 `description` 末尾。

## 扩展命令

往 `lib/index.js` 的 `COMMANDS` 表加一条声明即可，无需改注册代码：

- `branch` 必须与对应 `SKILL.md` 决策树的分支 key 一致（即 `references/<branch>.md`）；`skill` 省略时默认 `git-kit`。
- `hint` + `required` 决定输入提示与校验；`description` 会原样出现在斜杠菜单（见上文 i18n 说明）。
- 技能对「无参数」有专门语义时（如 `/cleanup` 必须先问再动），用 `noInput` 覆盖默认注入语；有参数时需要用户确认的事项用 `confirm` 覆盖 git 语境的默认措辞。
- 新增后跑一次跨仓契约校验：`node scripts/check-skill-contract.mjs`，详见 [开发与测试](./development.md)。技能未安装时它无法通过，先 `/skill-init`。
