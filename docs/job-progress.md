# 过程可见（后台任务）

首次 `/skill-init` 要真下上游（实测 10 秒上下），而 dsh 的命令面**没有进度通道**：`@deepseek-ai/dsh-commands` 的 `execute()` 只 append `command/run` 和 `command/done` 两个事件，UI 的命令卡片在运行期只能渲染「执行中…」（一方命令 `/compact` 同样如此）。

所以「过程」放在 dsh 的**后台任务**上（`lib/job-progress.js`，用 `ctx.jobs`；base 组合已含 `dsh-jobs-local` + `dsh-tool-jobs`）：

| 面 | 内容 |
|---|---|
| 会话头部的作业行 | 实时阶段文案：`检查依赖技能 → 安装 git-kit → 链入 dsh → 校验契约` |
| 展开的面板 | 阶段流水（`log` 通道）+ `npx skills` 的**流式输出**（去 ANSI 的纯文本，clack 的下载/进度/Done 都在），保留 256 KB，结算后留 16 KB |
| 行上的停止控件 | 两击停止：先 SIGTERM 再 SIGKILL 子进程，命令卡片结算为「已停止」 |
| 命令卡片 | 结构化回执（逐技能结论 + 耗时）+ 一行「过程：作业 `skill-init-…`」 |

阶段文案同时写进作业输出（`log` 通道，只给观察者）：即使本次一步实事没干，展开面板也有可读的执行流水，而不是空白。

## 无事可做时不建作业

`/skill-init`、`/skill-update` 会先判定「有没有需要装/修的技能」，没有就直接跑完并在回执首行给结论——`✓ 无需操作：git-kit、handoff 均已托管 · 0.0s`，末行写明 `过程：…没有需要安装或修复的技能，未创建后台任务`。

这样不会在会话头部闪一个零输出的空作业行（0.1.10 的实测问题：已托管环境下 `/skill-init` 3ms 结束，头部空作业 + 面板空白，看起来像没执行）。

| 场景 | 作业 | 回执首行 |
|---|---|---|
| `/skill-init`，技能已托管 | 不建 | `✓ 无需操作：git-kit、handoff 均已托管 · 0.0s` |
| `/skill-init`，需要装/换软链 | 建 | `技能依赖检查 · git-kit、handoff · 10.4s` |
| `/skill-install <来源>`，全部已托管 | 建（总要调 CLI） | `✓ 无需操作：<来源> 的 N 个技能均已托管 · 10.2s` |
| `/skill-install <来源>`，有新装 | 建 | `技能安装 · 来源 <来源> · … · 6.9s` |

## 为什么不耗 token

命令 handler 自己 `wait()` 到作业终态，结算时 `awaited` 为真，`dsh-tool-jobs` 便跳过完成通知——既不注入消息，也不会唤醒一个模型回合（这一点在冒烟里有断言）。

反过来若改成「订阅结算事件」收尾，就会走通知路径、可能白开一轮，所以代码里固定用 `wait` 循环。

## 降级

`ctx.jobs` 缺失（headless 组合）、没控制器（未加载 `dsh-tool-jobs`）、并发上限、或当前会话没有活 agent 时，命令自动退回原来的「转圈 → 一次性回执」，回执末尾会写「过程：未启用后台任务（原因）」。

`apply` 不把 `jobs` 写进 `inject`，所以没有 jobs 的组合照常加载。

## 实现约束

- `lib/skill-setup.js` 的三个 `run*` 只认 `reporter.progress` / `reporter.write`，不直接接触 `ctx.jobs`；这层适配全在 `lib/job-progress.js` 的 `runInJob` / `NO_REPORTER`。
- 失败回执会剥掉 ANSI、框线与 CLI 的 ASCII logo（`tail()`），完整输出留在作业面板里；只保留最后 15 行、单行 240 字符、整段 1200 字符，避免 clack 的进度重绘把命令卡片撑到几十 KB。
- 作业输出先去 ANSI 再旁路：面板是纯文本终端，不去色会把 `[38;5;250m` 之类转义码原样显示。
