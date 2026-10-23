# 过程可见（后台任务）

首次 `/skill-init` 要真下上游（首次 clone 实测 8 秒上下；之后 TTL 内约 0.4–1 秒，TTL 过期检查上游约 4–5 秒）。dsh 的 host 命令面**没有进度通道**：`@deepseek-ai/dsh-commands` 的 `execute()` 只 append `command/run` 和 `command/done` 两个事件。所以过程放在 dsh 的**后台任务**上（`lib/job-progress.js`，用 `ctx.jobs`；base 组合已含 `dsh-jobs-local` + `dsh-tool-jobs`），并由 web client half 把这些快照渲染回命令卡：

| 面 | 内容 |
|---|---|
| 会话头部的作业行 | 实时阶段文案：`检查依赖技能 → 检查上游 → 安装/更新 → 链入 dsh → 校验契约`；结算后保留最后一条 `完成：<结论>` |
| 展开的面板 | 阶段流水（`log` 通道）+ `skills` CLI 的**流式输出**（去 ANSI 的纯文本，下载/进度/Done 都在），保留 256 KB，结算后留 16 KB |
| 行上的停止控件 | 两击停止：先 SIGTERM 再 SIGKILL 子进程，命令卡片结算为「已停止」 |
| 命令卡片 | 标题是**命令行 + 参数**、状态和耗时；第二行不再重复状态头，而是按结局给影响面/具体问题（`技能：…`、变更规模、`⚠` 的遮蔽/契约问题）；`⚠` 为琥珀色「需处理」，`后台作业` / `未确认` / `客户端未加载` 是 chips；完整回执在展开区。无作业时耗时从回执首行兜底 |
| 客户端命令卡（web） | 执行中显示阶段、计时、可展开日志和停止；完成/失败后保留结论。没有 client half 时回退 dsh 的通用卡 |

阶段文案同时写进作业输出（`log` 通道，只给观察者）：即使本次一步实事没干，展开面板也有可读的执行流水，而不是空白。

## 执行前确认

确定要写盘（需要安装/替换软链、真实目录仍需装 canonical，或 plan 已知上游有更新要重装）时，handler 会在建作业之前用 `ctx.userQuestions` 问一次。问题、选项和说明都按本次 plan 生成，不再复用模板句：

```
检查依赖技能
  处理这 3 个技能？
  技能现状：
  ✗ git-kit — 未安装 → 将安装
  ✓ handoff — 已安装
  ! disk-cleanup — 真实目录 → 保留，不链入
  来源：morehao/agent-skills
  [处理全部] [只补缺失] [取消]
```

- `/skill-init` 有缺失时给「处理全部 / 只补缺失」；只有上游更新时给「处理全部」。`choice` 会传到 `run*`，`missing` 只装 `state=missing` 的条目，已有条目不动（为了拿到缺失技能，远端缓存仍可能 fetch）。
- **缓存过期不提问**：联网检查是只读的，直接做；检查中发现的上游更新只报告（`ℹ 无变更，上游有 N 项更新` + `--update` 指引），不写盘。这样「会不会弹问题」不取决于「距上次检查多久」。
- 取消 → 回执 `已取消 /skill-init，未做任何变更。`，不建作业。
- `--yes` → 完全跳过确认，适合自动化。
- 真实目录/文件会跳过链入、不会删除，但来源仍会装到 canonical，所以同样会问；确认卡会说明这一点。
- 没有 `userQuestions`、没有活 agent、或命令被委派时**不阻塞**：直接执行，回执首行标 `· 未确认`，末尾补「确认：当前会话不支持交互确认，已直接执行。」
- `--update` 是用户显式要求更新，不弹确认。

## 确认最新 / 无事可做时不建作业

`/skill-init`（含 `--update`）会先判定「有没有需要装/修的技能」：

- 缓存 TTL 内且 lock 的 `skillFolderHash` 与缓存 git tree hash 一致 → 内容确实最新，不建作业，回执首行 `✓ 无变更 · …`；
- TTL 过期或无缓存 → 建作业 fetch 上游；hash 没变就只出「无变更」，不重复执行 `skills add`；有变化只报告（不重装）；
- 已安装但 TTL 过期时仍会**检查**，不会因为「已托管」就永久跳过；检查失败但技能已托管时回执「已安装；上游检查失败」，不把环境判失败。

这样既不会在会话头部闪一个零输出的空作业行（0.1.10 的实测问题：已托管环境下 `/skill-init` 3ms 结束，头部空作业 + 面板空白，看起来像没执行），也不会让技能永远停在旧版本。

`planSkillOperation()` 一次算出 `skipReason`，skip 文案只解释「为什么没有过程」（如「10 分钟内已检查过上游，本次不重复联网」），不再复述回执首行的「无变更」。

| 场景 | 作业 | 回执首行 |
|---|---|---|
| `/skill-init`，已托管且 TTL 内 hash 一致 | 不建 | `✓ 无变更 · 0.7s` |
| `/skill-init`，已托管但 TTL 过期（fetch 后无变化） | 建 | `✓ 无变更 · 4.5s` |
| `/skill-init`，TTL 过期且 fetch 后发现上游有更新 | 建 | `ℹ 无变更，上游有 2 项更新 · 4.5s`（只报告，`--update` 才装） |
| `/skill-init`，需要装/换软链（首次 clone） | 建（执行前确认） | `✅ 已完成：3 项变更 · 8.0s · 后台作业` |
| `/skill-init`，需要装/换软链（已缓存） | 建（执行前确认） | `✅ 已完成：1 项变更 · 1.0s · 后台作业` |
| `/skill-init`，真实目录遮蔽 | 建（仍会确认：来源会装 canonical，但链入会被拒绝） | `⚠ 已完成，但有 1 项需处理 · 0.5s` |
| `/skill-init --update` | 建（显式更新，不确认） | `✅ 已更新：3 个技能 · 4.5s · 后台作业` |

第二行固定是「过程：作业 …」/「未创建后台任务（短因）」/「未启用后台任务（原因）」；第三行固定是客户端卡状态；技能/缓存明细从第四行开始。首行保持短，是为了折叠状态下也能看到结论和 `· 后台作业`。

网络不通时是例外：首次 clone 前的 `git ls-remote` 预检默认 8s 内失败，命令卡片直接出「连不上技能来源 …」并给代理/镜像提示，不需要等 `clone`。网络正常时，首次 clone 约 8s；之后从本地缓存安装约 1–2s；`--update` 强制 fetch 约 4–6s（随网络变化）。没有 client half 时，这段时间卡片显示「执行中…」，阶段文案与流式输出在作业面板里；有 client half 时，卡片直接显示阶段、计时和日志。

## 为什么不耗 token

命令 handler 自己 `wait()` 到作业终态，结算时 `awaited` 为真，`dsh-tool-jobs` 便跳过完成通知——既不注入消息，也不会唤醒一个模型回合（这一点在冒烟里有断言）。

反过来若改成「订阅结算事件」收尾，就会走通知路径、可能白开一轮，所以代码里固定用 `wait` 循环。

## 完成感知

`run*` 在返回前写一条 `完成：<结论>` 的 progress，所以作业结算后，作业行仍保留最终结论；命令卡片也会在结算时出现首行结论。因为 handler 自己 `wait`（`awaited=true`），`dsh-tool-jobs` **不会**再投一条完成通知——这条零 token 取舍没有变。

离开会话的完成感知由 web client half 补上，不经过 host 通知：

| 场景 | 信号 |
|---|---|
| 还在当前会话 | 命令卡切到「已完成 / 无变更 / 已取消 / 已停止 / 失败」，保留结论、耗时和可展开日志；**并且照常弹一次 toast**（0.2.0 只在切走后弹，用户看着会话时反而只靠卡片，容易漏） |
| 切到别的会话 | `shell.overlay` 的应用级 toast，带「查看」；约 6.5 秒自动关闭，也可手动关 |
| 稍后才回来 | `sidebar.session.row.leading` 的未读点；打开会话即清。该座位只在会话行空闲时挂载，更高优先的状态会占用它 |
| 浏览器在后台 | 不覆盖。DOM toast 看不见，需要 title 角标/系统通知（权限），v1 不做 |
| dsh 已关闭 | 不覆盖。没有推送通道；v1 的 toast/未读是内存态，重启不保留 |

实现要点：

- 命令卡挂载时把 `sessionId` 注册到 client 侧的 tracker；卡片卸载后 tracker 仍持有 `ctx.jobs.watchRows(sessionId)`，直到本次 skill 作业结算。
- tracker 只对 `kind` 为 `skill-init` 的作业发提示（`--update` 的 kind 仍是 `skill-init`）；作业结算后**一律推 toast**，未读点只在「不在当前会话」时标。
- 无作业的路径（`skip`：缓存 TTL 内无事可做）不产生作业事件，完成感由命令卡的 `无变更` 态 + 回执第二行「本次没有变更，未创建后台任务（原因）」承担。
- 点击「查看」走 `ctx.uiWorkspace.openSession(sessionId)`；当前会话切过去时清未读。
- 不新增 host 事件、不唤醒模型；客户端的 toast/未读是派生状态，刷新后不保留（v1 内存态）。

如果 client half 没加载，命令卡回退 dsh 通用卡；完成仍只剩卡片，但 host 行为完全不变。

### 结论交给 agent 复核（每次运行都会发一条消息）

命令卡只活在**对话流**里，而 dsh 的会话 `blank` 状态**只由 `turn/start` 解除**：

```js
// dsh-api-session-controller：blank 投影
const blank = state.blank && event.type !== "turn/start";
// dsh-client-ui-conversation：blank → 渲染空状态，对话流不渲染
return conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  ? "active" : session.promptAttempted ? "engaging" : "blank";
```

命令事件（`command/run`、`job/*`、`command/done`）和 `inject()` 的 notice 都不产生 `turn/start`。所以在新建会话里跑 `/skill-init`，**不唤醒一轮就必然什么都看不到**（实测：日志完整、页面无卡、无命令行）。

因此每条出口都会把回执交给会话，默认 **`followup()` 唤醒一轮让 agent 复核**：

```
/skill-init --update git-kit：✅ 已更新：1 个技能 · 2.4s · 后台作业 / 过程：作业 … / 技能：… / …
以上是命令本体刚跑完的确定性结果，不需要你再执行或重跑。
命令卡已经展示了命令、参数和结论，不要复述这些内容。
只做两件事：如果有需要用户处理的事项，按重要性列出（最多 3 条，每条一句，写明下一步动作）；否则只回复「无异常」。
不要调用任何工具，不要修改文件。
```

- 命令本体仍然是 handler 里的确定性执行（不交给模型跑）；agent 只负责「读结论 → 回报」，有真实目录遮蔽、上游可更新等事项时给出下一步，没有就回一行「无异常」。
- **每次执行都唤醒**（不按结局跳过复核）；「按需」体现在回复的详略：正常一行，有事项才列 ≤3 条。
- 消息的三段式正好对上「问答对」：命令卡是**问题**（命令行 + 参数 + 第二行影响面），`followup()` 的触发行是系统注解，agent 的回复才是答案。
  - `source.kind` 用 `cordis-host-runner`（`MessageSourceMap` 里声明给插件来源的 kind），`form: "notice"`，`summary` 带命令行与结论。唤醒时 dsh 走 `TurnTriggerNodeView`：折叠态只按 kind 显示标题「插件状态更新」，**不读 summary**，展开才是消息原文；这与 `ContextInjectionRow` 是两个分支。
  - 不用 `tool-jobs`：`/skill-init` 的 skip / Usage / 取消出口没有作业，标题「后台任务状态更新」会是假话；也不能冒充别的包。
  - 只有非唤醒的 `inject()` 才走 `ContextInjectionRow`，summary 显示为折叠态那一行。
- 报告上限 1400 字符（超出截断），避免把整段回执灌进上下文。
- **取消**只 `inject()` 记一行，不唤醒模型（用户刚点了取消，没必要再花一次调用）；`DSH_COMMANDS_SKILL_NOTIFY=notice` 可整体降级为「只记录不唤醒」。
- `followup`/`inject` 都不可用时静默跳过，命令回执不变。

### 排障：自绘命令卡根本没出现

**客户端模块表在 dsh 启动时构建，运行中新装/升级的包不会自动进 boot graph。** host half 会被 hmr 热加载（所以回执文案已经是新的），client half 不会——结果就是「命令确实跑完了，但自绘卡、完成 toast、未读点全都不存在，只剩一行通用命令」。

真实案例：desktop host 09:19 启动，插件 11:30 / 14:23 才装进 profile，`/skill-init` 执行成功（作业 1.4s 结算、回执完整），但 `conversation.chat.commandview` 没有任何占用者、boot graph 里也没有 `@morehao/dsh-commands` 行。

判断与修复：

1. 看回执首行有没有 `· 客户端未加载`（有 = 就是这个问题）；第三行会写「重启 dsh 后生效」。
2. **重启 dsh**（不是刷新页面）。Settings → Plugins 的插件列表会显示页内同步失败并给出重试。
3. 重启后回执第三行应变成「客户端：命令卡已加载（web）」。


## 降级

`ctx.jobs` 缺失（headless 组合）、没控制器（未加载 `dsh-tool-jobs`）、并发上限、或当前会话没有活 agent 时，命令自动退回原来的「转圈 → 一次性回执」：首行仍带结论，并补 `· 未启用后台作业`；`过程：` 行会写「未启用后台任务（原因）」。

确认交互也会独立降级：`ctx.userQuestions` 缺失、无活 agent 或命令被委派时直接执行，回执末尾补「确认：当前会话不支持交互确认，已直接执行。」

host 的 `apply` 不把 `jobs` 写进 `inject`，所以没有 jobs 的组合照常加载。client half 的 `inject` 才包含 `jobs` / `slots` / `locale` / `uiWorkspace`；缺失时整个 client half 不激活，host 命令不受影响。

## 实现约束

- `lib/skill-setup.js` 的 `planSkillOperation()` 与 init/update 两个 `run*` 只认 `reporter.progress` / `reporter.write`，不直接接触 `ctx.jobs`；这层适配全在 `lib/job-progress.js` 的 `runInJob` / `NO_REPORTER`。来源缓存与 lock 回写在 `lib/skill-cache.js`；输出清洗与子进程分别在 `lib/text.js` / `lib/proc.js`；执行前确认在 `lib/confirm.js`。
- `lib/client.js` 是 web client half（预打包 `window.__ModuleLoader__` bundle，不需要构建）：注册 `conversation.chat.commandview`、`shell.overlay`、`sidebar.session.row.leading` 三个槽；把 `ctx.jobs` 快照映射成卡片/提示/未读，不写 host 事件。
- 失败回执会剥掉 ANSI、框线与 CLI 的 ASCII logo（`lib/text.js` 的 `tail()`），完整输出留在作业面板里；只保留最后 15 行、单行 240 字符、整段 1200 字符，避免 clack 的进度重绘把命令卡片撑到几十 KB。
- 作业输出先去 ANSI 再旁路：面板是纯文本终端，不去色会把 `[38;5;250m` 之类转义码原样显示。
