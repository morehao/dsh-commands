# 过程可见（后台任务）

首次 `/skill-init` 要真下上游（首次 clone 实测 8 秒上下；之后 TTL 内约 0.4–1 秒，TTL 过期检查上游约 4–5 秒），而 dsh 的命令面**没有进度通道**：`@deepseek-ai/dsh-commands` 的 `execute()` 只 append `command/run` 和 `command/done` 两个事件，UI 的命令卡片在运行期只能渲染「执行中…」（一方命令 `/compact` 同样如此）。

所以「过程」放在 dsh 的**后台任务**上（`lib/job-progress.js`，用 `ctx.jobs`；base 组合已含 `dsh-jobs-local` + `dsh-tool-jobs`）：

| 面 | 内容 |
|---|---|
| 会话头部的作业行 | 实时阶段文案：`检查依赖技能 → 安装 git-kit → 链入 dsh → 校验契约` |
| 展开的面板 | 阶段流水（`log` 通道）+ `skills` CLI 的**流式输出**（去 ANSI 的纯文本，下载/进度/Done 都在），保留 256 KB，结算后留 16 KB |
| 行上的停止控件 | 两击停止：先 SIGTERM 再 SIGKILL 子进程，命令卡片结算为「已停止」 |
| 命令卡片 | 结构化回执（逐技能结论 + 耗时）+ 一行「过程：作业 `skill-init-…`」；无作业时为「过程：未创建后台任务（短因）」 |

阶段文案同时写进作业输出（`log` 通道，只给观察者）：即使本次一步实事没干，展开面板也有可读的执行流水，而不是空白。

## 确认最新 / 无事可做时不建作业

`/skill-init`、`/skill-install`、`/skill-update` 会先判定「有没有需要装/修的技能」：

- 缓存 TTL 内且 lock 的 `skillFolderHash` 与缓存 git tree hash 一致 → 内容确实最新，不建作业，回执首行 `✓ 已是最新：…`；
- TTL 过期或无缓存 → 建作业 fetch 上游；hash 没变就只出「已是最新」，不重复执行 `skills add`；
- 已安装但 TTL 过期时仍会**检查**，不会因为「已托管」就永久跳过；检查失败但技能已托管时回执「已安装；上游检查失败」，不把环境判失败。

这样既不会在会话头部闪一个零输出的空作业行（0.1.10 的实测问题：已托管环境下 `/skill-init` 3ms 结束，头部空作业 + 面板空白，看起来像没执行），也不会让技能永远停在旧版本。

`planSkillOperation()` 一次算出 `skipReason`，skip 文案只解释「为什么没有过程」（如「缓存 TTL 内，无需检查上游」），不再复述回执首行的「已是最新」。

| 场景 | 作业 | 回执首行 |
|---|---|---|
| `/skill-init`，已托管且 TTL 内 hash 一致 | 不建 | `✓ 已是最新：git-kit、handoff、disk-cleanup · 0.7s` |
| `/skill-init`，已托管但 TTL 过期（fetch 后无变化） | 建 | `✓ 已是最新：git-kit、handoff、disk-cleanup · 4.5s · 缓存 c570a7b` |
| `/skill-init`，需要装/换软链（首次 clone） | 建 | `技能依赖检查 · git-kit、handoff、disk-cleanup · 8.0s · 缓存 c570a7b` |
| `/skill-init`，需要装/换软链（已缓存） | 建 | `技能依赖检查 · git-kit、handoff、disk-cleanup · 1.0s · 缓存 c570a7b` |
| `/skill-install <来源> <技能名>`，TTL 内 hash 一致 | 不建 | `✓ 已是最新：…（缓存 TTL 内且与 lock 一致）· 0.7s` |
| `/skill-install <来源> <技能名>`，TTL 过期且上游有变化 | 建 | `技能安装 · 来源 <来源> · … · 2s · 缓存 …` |
| `/skill-install <来源>`，不指定技能名 / 有新装 | 建 | `技能安装 · 来源 <来源> · … · 1–3s · 缓存 c570a7b` |

网络不通时是例外：首次 clone 前的 `git ls-remote` 预检默认 8s 内失败，命令卡片直接出「连不上技能来源 …」并给代理/镜像提示，不需要等 `clone`。网络正常时，首次 clone 约 8s；之后从本地缓存安装约 1–2s；`/skill-update` 强制 fetch 约 4–6s（随网络变化）。这段时间卡片仍显示「执行中…」，阶段文案与流式输出在作业面板里。

## 为什么不耗 token

命令 handler 自己 `wait()` 到作业终态，结算时 `awaited` 为真，`dsh-tool-jobs` 便跳过完成通知——既不注入消息，也不会唤醒一个模型回合（这一点在冒烟里有断言）。

反过来若改成「订阅结算事件」收尾，就会走通知路径、可能白开一轮，所以代码里固定用 `wait` 循环。

## 降级

`ctx.jobs` 缺失（headless 组合）、没控制器（未加载 `dsh-tool-jobs`）、并发上限、或当前会话没有活 agent 时，命令自动退回原来的「转圈 → 一次性回执」，回执末尾会写「过程：未启用后台任务（原因）」。

`apply` 不把 `jobs` 写进 `inject`，所以没有 jobs 的组合照常加载。

## 实现约束

- `lib/skill-setup.js` 的 `planSkillOperation()` 与三个 `run*` 只认 `reporter.progress` / `reporter.write`，不直接接触 `ctx.jobs`；这层适配全在 `lib/job-progress.js` 的 `runInJob` / `NO_REPORTER`。来源缓存与 lock 回写在 `lib/skill-cache.js`；输出清洗与子进程分别在 `lib/text.js` / `lib/proc.js`。
- 失败回执会剥掉 ANSI、框线与 CLI 的 ASCII logo（`lib/text.js` 的 `tail()`），完整输出留在作业面板里；只保留最后 15 行、单行 240 字符、整段 1200 字符，避免 clack 的进度重绘把命令卡片撑到几十 KB。
- 作业输出先去 ANSI 再旁路：面板是纯文本终端，不去色会把 `[38;5;250m` 之类转义码原样显示。
