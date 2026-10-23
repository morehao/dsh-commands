# 命令契约（Agent）

> 读这篇的时机：改 `COMMANDS` / `LOCAL_COMMANDS`、命令描述、注入文案、`recordInput`，或排查「命令点了但行为不对」。
> 完整背景见 [架构与原理](../architecture.md) 与 [开发与测试](../development.md)；这里只列 agent 必须照做的契约。

## 1. 两张表

| 表 | 位置 | 谁执行 | 典型命令 |
|---|---|---|---|
| `COMMANDS` | `lib/index.js` | agent 加载 skill 后执行 | `/git-message`、`/git-pr-create`、`/cleanup` |
| `LOCAL_COMMANDS` | `lib/index.js` | handler 直接执行 | `/skill-init`、`/skill-install`、`/skill-update` |

- 委托型：handler 只校验输入 → 生成指令 → `invocation.agent.followup(userMessage(...))`；不在本仓跑技能脚本。
- 本地型：handler 按 `plan` → （需要时 `ctx.userQuestions` 确认）→ `runInJob` → `run` 执行；不经过 agent，结果必须确定。`--yes` 跳过确认；无问答能力时降级直接执行。
- `REQUIRED_SKILLS` 从 `COMMANDS` 推导（`skill ?? "git-kit"` 去重）；不要写第二份依赖清单。

## 2. 字段语义

| 字段 | 适用 | 约束 |
|---|---|---|
| `name` | 两者 | 唯一；出现在斜杠菜单 |
| `branch` | 委托型 | 必填；必须等于目标技能 `references/<branch>.md` 的 key（单分支技能除外） |
| `skill` | 委托型 | 省略 = `git-kit`；必须是 ai-kit 提供的技能名 |
| `hint` | 两者 | 输入提示；`required` 为真且输入为空时用于 `Usage: /<name> <hint>` 回执 |
| `required` | 委托型 | 为真时，空输入直接返回用法错误，不注入消息 |
| `description` | 两者 | 直接写中文；原样进菜单，不做 i18n |
| `noInput` | 委托型 | 无参数时追加的专门指引；不设则注入「按分支流程默认处理」 |
| `confirm` | 委托型 | 有参数时提示用户需确认的事项；默认是 git 语境 |
| `readFallback` | 委托型 | 仅用于 `disable-model-invocation` 的技能（当前是 `handoff`） |

`recordInput` 不在每条声明里写：委托型统一 `false`，本地型统一 `true`，由 `apply()` 固定。不要为了「记录参数」改回 `true`。

## 3. 执行链路（委托型）

1. 用户执行命令，进入 `makeHandler(def)`。
2. `required` 校验；缺失返回 `Usage: /<name> <hint>`，不注入消息。
3. `buildInstruction(def, input)` 生成委托指令（`【dsh 命令 /xxx】`、用户请求、加载 skill 的指示）。
4. `userMessage()` 手工构造 user 消息；`source` 必填，否则 dsh 的 Message 契约读 `message.source.kind` 时会崩。
5. `invocation.agent.followup()` 注入当前会话。
6. agent 用 `skill` 工具加载技能，按 `branch` 流程执行；需要决策先问用户。
7. 命令卡片返回「已按 `<skill>` `<branch>` 分支委托执行…」。

## 4. 注入文本的边界

- 无参数且没有 `noInput`：请求写「（未附加说明，按分支流程默认处理）」，再追加默认 `confirm` 提示。
- 无参数且有 `noInput`：请求写「（未附加说明）」，只追加 `noInput` 全文；不要再补默认处理语。
- 有参数且有 `confirm`：提示用户确认 `confirm` 列出的事项。
- `readFallback: true`：追加「若 skill 工具报 not available for model invocation，改用 read 读 `$DSH_HOME/skills/<skill>/SKILL.md`」。
- 不要把技能流程写进注入文本；agent 会自己读 skill。

## 5. 为什么这些字段是这样

- `recordInput: false`（委托型）：用户输入已逐字写进注入的 user 消息，再记 `command/run.args` 就是同一 payload 两份日志。
- `recordInput: true`（本地型）：输入只是可选的技能名/来源，没有别的权威事件承载。
- 描述不做 i18n：dsh 只本地化它自己的一方命令；第三方同名覆盖会撞 host command，`CommandDecoration` 也没有 `description` 字段。故直接写中文。
- `locale/{zh,en}.json` 只服务插件页 `meta.title` / `meta.description`，不服务命令描述。

## 6. 增删命令清单

- [ ] `branch` 与 ai-kit `SKILL.md` 决策树一致；多分支技能确认 `references/<branch>.md` 存在。
- [ ] `skill` 写对；省略时确认默认 `git-kit` 是想要的。
- [ ] `hint` / `required` / `noInput` / `confirm` 覆盖参数边界。
- [ ] 描述是中文、面向用户、不写实现细节。
- [ ] 新增委托型命令后确认 `REQUIRED_SKILLS` 自动包含技能；不要手改清单。
- [ ] 跑 `npm run check`；技能已安装时跑 `node scripts/check-skill-contract.mjs`。
- [ ] 同步 README 命令表、`CHANGELOG.md`、必要的 `docs/`。

## 7. 跨仓契约

- 技能在 ai-kit；本仓只存映射。技能改分支名而插件没跟，命令仍可点，但结果不对。
- [check-skill-contract.mjs](../../scripts/check-skill-contract.mjs) 读取 `COMMANDS`，检查 `$DSH_HOME/skills/<skill>/SKILL.md` 与 `references/<branch>.md`；单分支技能只校验 `SKILL.md`。
- `handoff` 的 `branch: "print"` 是装饰性的：它没有 `references/`，不要为了通过校验去改技能文案。
- 技能未安装时契约校验必然失败；先 `/skill-init`，或在交付说明里写明未跑及原因。
- CI 默认不跑契约校验（依赖另一仓的技能目录）。

## 8. 常见故障

| 症状 | 先查 |
|---|---|
| 命令点了只回 Usage | `required` 与 `hint`；用户是否真的传了参数 |
| agent 没按预期分支执行 | `branch` 拼写、`skill` 默认值、技能版本是否落后 |
| 会话回合崩溃，提示 `source` | `userMessage()` 是否保留 `source: { kind: "user" }` |
| 命令卡片参数重复 | 是否把委托型 `recordInput` 改成了 `true` |
| `/handoff` 加载失败 | `readFallback` 是否还在；技能是否标了 `disable-model-invocation` |
| `/skill-*` 看不到过程/结果 | 回执首行是否为 `✓/✅/⚠` 结论；第二行是否有「过程：作业 …」；是否被 `--yes` 或降级路径影响 |
| `/skill-*` 有变更却没弹确认 | `needsConfirmation()` 是否只看到真实目录；`ctx.userQuestions` 是否可用；是否带了 `--yes` |
| 确认卡住/命令不返回 | `confirmSkillOperation()` 是否在无问答能力时降级；是否只有 `ASK_CANCELLED` 才取消 |
| 契约校验失败 | 技能是否安装、`DSH_HOME` 是否指向正确技能根、ai-kit 是否改了分支名 |

## 9. 相关文档

- [架构与原理](../architecture.md)
- [开发与测试](../development.md)
- [技能运行时](./skill-runtime.md)
