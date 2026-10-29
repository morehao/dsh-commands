# 命令契约（Agent）

> 读这篇的时机：改 `COMMANDS` / `/skill-init`、命令描述、注入文案、`recordInput`，或排查「命令点了但行为不对」。
> 完整背景见 [架构与原理](../architecture.md) 与 [开发与测试](../development.md)；这里只列 agent 必须照做的契约。

## 1. 三类命令

| 类 | 位置 | 谁执行 | 典型命令 |
|---|---|---|---|
| 委托型 | `COMMANDS`（`lib/index.js`） | agent 加载 skill 后执行 | `/git-message`、`/git-pr-create`、`/cleanup` |
| 维护型委托 | `SKILL_INIT_DEF` + `makeSkillInitHandler()`（`lib/skill-command.js`） | agent 调用 `skill_init` 工具 | `/skill-init`（`--update` 是同一命令的更新分支） |
| 维护型委托（插件自身） | `PLUGIN_UPDATE_DEF` + `makePluginUpdateHandler()`（`lib/plugin-update-command.js`） | agent 调用 `plugin_update` 工具 | `/plugin-update`（`--apply` 一键更新） |

- 委托型：handler 只校验输入 → 生成指令 → `invocation.agent.followup(userMessage(...))`；不在本仓跑技能脚本。
- 维护型委托：handler 只解析 flags → 注入一条 user 消息 → agent 调用 `skill_init`；确认/进度/停止/写盘都在工具里。无 `tools`、无 `agent.followup` 或注入失败时回退到 `runSkillInit` / `runSkillUpdate`。
- 维护型委托 `/plugin-update`：handler 解析 `--apply` / `--yes` → 注入 user 消息 → agent 调 `plugin_update` 工具；工具内 `observe → plan → confirm → apply(挂 ctx.jobs) → verify`。更新走 `pluginManager.installBundle → already-installed → removeBundle → installBundle`，结果给「是否需重启」；成功后写 `state.json` 的 `pendingVersion`，重启后 `announcePluginUpdate()` 补发「已更新到 vX」。无 tools / 无 agent / 注入失败回退到 `lib/plugin-update.js` 的只读 `check()`。
- 委托型 handler 在执行前会预检依赖技能是否落在 `$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` 或 canonical `~/.agents/skills`；缺失时返回 `/skill-init` 与手工 `npx` 指引，不注入消息。`/skill-init` 自己就是安装器，不做预检。
- `REQUIRED_SKILLS` 从 `COMMANDS` 推导（`skill ?? "git-kit"` 去重）；不要写第二份依赖清单。

## 2. 字段语义

| 字段 | 适用 | 约束 |
|---|---|---|
| `name` | 两类 | 唯一；出现在斜杠菜单 |
| `branch` | 委托型 | 必填；必须等于目标技能 `references/<branch>.md` 的 key（单分支技能除外） |
| `skill` | 委托型 | 省略 = `git-kit`；必须是 agent-skills 提供的技能名 |
| `hint` | 两类 | 输入提示；`required` 为真且输入为空时用于 `Usage: /<name> <hint>` 回执 |
| `required` | 委托型 | 为真时，空输入直接返回用法错误，不注入消息 |
| `description` | 两类 | 直接写中文；原样进菜单，不做 i18n |
| `noInput` | 委托型 | 无参数时追加的专门指引；不设则注入「按分支流程默认处理」 |
| `confirm` | 委托型 | 有参数时提示用户需确认的事项；默认是 git 语境 |
| `readFallback` | 委托型 | 技能可能被 `disable-model-invocation` 拒绝加载时的 read 兜底（当前仅 `handoff`，属旧安装兼容；上游 #51 已移除该标记） |

`recordInput` 不在每条声明里写：三类命令统一 `false`，由 `apply()` 固定。不要为了「记录参数」改回 `true`。

## 3. 执行链路

1. 用户执行命令，进入 `makeHandler(def)`。
2. `required` 校验；缺失返回 `Usage: /<name> <hint>`，不注入消息。
3. `buildInstruction(def, input)` 生成委托指令（`【dsh 命令 /xxx】`、用户请求、加载 skill 的指示）。
4. `userMessage()` 手工构造 user 消息；`source` 必填，否则 dsh 的 Message 契约读 `message.source.kind` 时会崩。
5. `invocation.agent.followup()` 注入当前会话。
6. agent 用 `skill` 工具加载技能，按 `branch` 流程执行；需要决策先问用户。
7. 命令卡片返回「已按 `<skill>` `<branch>` 分支委托执行…」。

维护型 `/skill-init`：

1. `parseSkillInitInput(rawInput)`：`--update` / `--yes` / 技能名；init 带技能名、未知 flag → 用法错误，不注入。
2. 无 tools / 无 followup → `fallback(parsed, invocation)` 直接跑核心，返回文本。
3. `buildSkillInitMessage(parsed)` 生成消息，`createUserMessage()` 注入；成功返回一行「已开始检查/更新依赖技能」。
4. 注入抛错 → 本地回退，不留半条消息。

## 4. 注入文本的边界

- 无参数且没有 `noInput`：请求写「（未附加说明，按分支流程默认处理）」，再追加默认 `confirm` 提示。
- 无参数且有 `noInput`：请求写「（未附加说明）」，只追加 `noInput` 全文；不要再补默认处理语。
- 有参数且有 `confirm`：提示用户确认 `confirm` 列出的事项。
- `readFallback: true`：追加「若 skill 工具报 not available for model invocation，改用 read 读技能文件」——优先 `$DSH_HOME/skills/<skill>/SKILL.md`，不存在时读本源 `~/.agents/skills/<skill>/SKILL.md`（上游 #50 之后本源才是真实内容，只给软链层会指空）。
- 不要把技能流程写进注入文本；agent 会自己读 skill。

## 5. 为什么这些字段是这样

- `recordInput: false`（委托型）：用户输入已逐字写进注入的 user 消息，再记 `command/run.args` 就是同一 payload 两份日志。
- `recordInput: false`（`/skill-init`）：输入已写进注入的 user 消息；回退路径没有注入，但命令行本身仍可见。
- 描述不做 i18n：dsh 只本地化它自己的一方命令；第三方同名覆盖会撞 host command，`CommandDecoration` 也没有 `description` 字段。故直接写中文。
- `locale/{zh,en}.json` 只服务插件页 `meta.title` / `meta.description`，不服务命令描述。

## 6. 增删命令清单

- [ ] `branch` 与 agent-skills `SKILL.md` 决策树一致；多分支技能确认 `references/<branch>.md` 存在。
- [ ] `skill` 写对；省略时确认默认 `git-kit` 是想要的。
- [ ] `hint` / `required` / `noInput` / `confirm` 覆盖参数边界。
- [ ] 描述是中文、面向用户、不写实现细节。
- [ ] 新增委托型命令后确认 `REQUIRED_SKILLS` 自动包含技能；不要手改清单。
- [ ] 跑 `npm run check`；技能已安装时跑 `node scripts/check-skill-contract.mjs`。
- [ ] 同步 README 命令表、`CHANGELOG.md`、必要的 `docs/`。

## 7. 跨仓契约

- 技能在 agent-skills；本仓只存映射。技能改分支名而插件没跟，命令仍可点，但结果不对。
- [check-skill-contract.mjs](../../scripts/check-skill-contract.mjs) 读取 `COMMANDS`，按 `skillRoots()` 找技能（`$DSH_HOME/skills` → `$DSH_AGENTS_HOME/skills` → 本源 `~/.agents/skills`，与 handler 预检同序），再检查 `references/<branch>.md`；单分支技能只校验 `SKILL.md`。缺技能按技能去重报一次。
- 不要退回「只看 `$DSH_HOME/skills`」：上游 #50 之后本源才是真实内容，软链层可能没建（`skills-fanout.sh` 才建）。
- `handoff` 的 `branch: "print"` 是装饰性的：它没有 `references/`，不要为了通过校验去改技能文案。
- 技能未安装时契约校验必然失败；先 `/skill-init`，或在交付说明里写明未跑及原因。
- CI 默认不跑契约校验（依赖另一仓的技能目录）；根顺序与失败输出由 `smoke-skill-contract.mjs` 在临时 HOME 覆盖。

## 8. 常见故障

| 症状 | 先查 |
|---|---|
| 命令点了只回 Usage | `required` 与 `hint`；用户是否真的传了参数 |
| agent 没按预期分支执行 | `branch` 拼写、`skill` 默认值、技能版本是否落后 |
| 会话回合崩溃，提示 `source` | `userMessage()` 是否保留 `source: { kind: "user" }` |
| 命令卡片参数重复 | 是否把 `recordInput` 改成了 `true`（输入已在注入消息里） |
| agent 的回复复述工具结果 | `buildSkillInitMessage()` 的汇报约束是否被删；正常应只做 1–3 句总结 |
| `/skill-init` 注入后没有后续 | `toolReady` 是否在工具注册前被读成 `false`（必须惰性）；`ctx.get("tools")` 是否可用 |
| `/handoff` 加载失败 | `readFallback` 是否还在；旧版技能是否还标着 `disable-model-invocation`（上游 #51 已移除） |
| `/skill-init` 看不到过程/结果 | 是否注册了 `skill_init` 工具；`ctx.get("tools")` 是否可用；是否走了本地回退 |
| `/skill-init` 有变更却没弹确认 | `skill-confirm.js` 的 `needsConfirmation()`；`ctx.userQuestions` 是否可用；是否带了 `--yes` 或 `--update` |
| `/git-*` 提示技能未安装 | 依赖技能是否在 `$DSH_HOME/skills` / `$DSH_AGENTS_HOME/skills` / `~/.agents/skills`；先跑 `/skill-init`，或按回执里的 `npx` 命令手工装 |
| 确认卡住/工具不返回 | `skill_init` 的 `confirm` 是否在无问答能力时返回 `plan`；是否只有 `ASK_CANCELLED` 才取消 |
| 契约校验失败 | 技能是否安装（`$DSH_HOME/skills` / `$DSH_AGENTS_HOME/skills` / 本源都查过）、agent-skills 是否改了分支名；根顺序可用 `smoke-skill-contract.mjs` 复现 |

## 9. 相关文档

- [架构与原理](../architecture.md)
- [开发与测试](../development.md)
- [技能运行时](./skill-runtime.md)
