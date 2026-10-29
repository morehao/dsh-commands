# 过程可见：后台作业与确认

`/skill-init` 的安装/更新可能真下上游（首次 clone 约 8 秒；之后 TTL 内约 0.4–1 秒，TTL 过期检查上游约 4–5 秒）。`skill_init` 工具把这些工作挂到 dsh 的**后台任务**上（`lib/job-progress.ts`，用 `ctx.jobs`；base 组合已含 `dsh-jobs-local` + `dsh-tool-jobs`）。

从 0.3.0 起，本插件不再自带 web client half：作业行、作业面板、停止控件、完成感知都由 dsh 原生 UI 提供。插件只负责三件事：

1. 把工作切成作业，持续写 `reporter.progress` / `reporter.write`；
2. 在工具结果里返回结论、动作明细、验证与下一步；
3. 保证停止/取消/失败都结算成明确状态，不误报成功。

## 用户看到什么

| 位置 | 行为 |
|---|---|
| 会话头部作业行 | `skill-init` 作业，实时显示当前阶段与耗时；进行中可两击停止 |
| 作业面板 | `skills` CLI 的流式输出（ANSI/spinner 已清洗）；停止按钮同样走 `jobs.kill` |
| 命令卡 | 只有一行「已开始检查依赖技能 / 已开始更新依赖技能」；它不等安装完成 |
| agent 回复 | 工具返回后，agent 用 1–3 句总结；需要用户处理的事项列下一步 |
| 工具结果展开 | `markdown`：首行结论 + 逐项动作 + 契约/验证 + 下一步 |

没有作业时（`✓ 无变更`、纯 blocked、用法错误）不建空作业，结果直接由工具返回。

## 执行前确认

有安装/修链（`plan.confirm.needs === true`）且未 `yes=true` 时，`skill_init` 通过 `ctx.userQuestions` 问一次：

- `处理全部` → `choice=all`；
- `只补缺失` → `choice=missing`，非 missing 的 install/relink 降级为 skip；
- `取消` → `status:"cancelled"`，零写、不建作业；
- 问题 detail 是 plan markdown：逐项列出将安装/跳过/阻断的原因。

边界：

- **只在确定要写盘时问**：缓存过期只做只读探针，不提问；`--update` 是显式更新，不弹确认。
- **无确认通道不执行**：没有 `userQuestions`、没有活 agent、或确认通道异常 → 返回 `status:"plan"`，零写；不再「降级直接执行」。
- `yes=true` 只跳过确认，**不跳过**所有权、真实目录、写前指纹检查。
- 真实目录/文件会拒绝链入、不会删除，但来源仍会装进 canonical，所以同样会问；detail 会说明。

## 写前指纹

工具在确认后、写盘前重新 `observe` 一次，只比较涉及技能的链状态/目标/canonical 存在性：

- 指纹变化（例如用户在确认卡停留时手动改了软链）→ `status:"attention"`，整次中止，零写；
- 这一步避免「确认时看到的是 A，写的是 B」。

## 无事可做 / 上游有更新时不写盘

- 缓存 TTL 内且 lock 的 `skillFolderHash` 与缓存 git tree hash 一致 → 不建作业，结论 `✓ 无变更`；
- 已安装但 TTL 过期时仍会**检查**；检查失败但技能已托管时结论是「已安装，但上游检查失败」，不把环境判失败；
- 运行时检查发现的上游更新**只报告、不安装**，结论 `changed` 或 `attention`，并给「运行 `/skill-init --update`」下一步；真正重装只在 `--update` 或缺失/修链时发生。

`plan` 一次算出 `skipReason` 与动作；工具把同一个 plan 用于确认、作业和回执，不重复 inspect。

## 耗时与失败

网络不通时首次 clone 前的 `git ls-remote` 预检会在 8 秒内失败，结果直接给「连不上技能来源 …」和代理/镜像提示，不需要等 clone。

失败时：

- 作业保留输出；工具返回 `status:"attention"`（或 `error`），`next` 给 `--update` 重试或查看作业；
- 停止/取消返回 `status:"cancelled"`，不写成功结论；
- 生产者用 `cancel` 标志决定结算成 `killed` 还是 `failed`：用户两击停止时 `cancel()` 已置位，`work` 抛出的错误必须记 `killed`，否则 `jobs-local` 的终态是 `failed`，`killed` 分支不可达。

`runInJob` 自己 `wait()` 到终态（`awaited=true`），`dsh-tool-jobs` 不会再投一条完成通知；零 token 取舍不变。

## 降级

- `ctx.jobs` 缺失、无控制器、并发上限、无 owner → 退回直接执行（`NO_REPORTER`），语义不变；
- 工具注册失败（旧宿主 / 没有 `@deepseek-ai/dsh-tools`）→ `/skill-init` 回退到 `runSkillInit` / `runSkillUpdate`，命令仍可用，只是没有工具结果与确认卡；
- `apply()` 不把 `jobs` 写进 `inject`，按需 `ctx.get("jobs")`。

## 代码位置

- `lib/job-progress.ts`：`runInJob` / `NO_REPORTER` / `cancel` 结算；
- `lib/tool-skill-init.ts`：确认 → 指纹 → 作业 → verify；
- `lib/skill-setup.ts`：`applyPlan` / `probeUpstream` / `verifyPlan`，只认 `reporter.progress` / `reporter.write`，不直接碰 `ctx.jobs`；
- `lib/skill-confirm.ts`：确认问题/选项；
- 已删除：`lib/client.js`（命令卡/toast/未读点）与 `lib/confirm.js`（旧命令确认适配）。
