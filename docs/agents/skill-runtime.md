# 技能运行时（Agent）

> 读这篇的时机：改 `lib/skill-setup.js`、`lib/skill-cache.js`、`lib/skill-paths.js`、`lib/proc.js`、`lib/text.js`、`lib/job-progress.js`，或排查 `/skill-init`（含 `--update`）。
> 完整背景见 [技能自举](../skill-setup.md) 与 [过程可见](../job-progress.md)。

## 1. 模块边界

| 模块 | 职责 | 不要做 |
|---|---|---|
| `lib/skill-setup.js` | plan、安装、软链、契约校验、回执 | 不直接碰 `ctx.jobs`；不复制缓存/路径逻辑 |
| `lib/skill-cache.js` | 来源浅克隆、TTL、lock 回写 | 不决定「要不要建作业」 |
| `lib/skill-paths.js` | `DSH_HOME` / agents home / canonical / lock 路径 | 不让调用方各自拼路径 |
| `lib/proc.js` | 子进程 timeout / abort / 输出上限 | 不经 shell 拼命令 |
| `lib/text.js` | ANSI / 框线 / spinner 清洗、tail 截断 | 不加业务语义 |
| `lib/job-progress.js` | 把 work 挂到 `ctx.jobs`、`wait` 收尾、降级 | 不含技能逻辑 |
| `lib/confirm.js` | 执行前的 `ctx.userQuestions` 确认、按 plan 生成选项、`--yes`/不可用降级 | 不执行安装、不碰 `ctx.jobs` |

## 2. 调用链

本地型 handler：

1. 解析 `--yes` / `--update`；非 `--update` 时位置参数直接报用法（不再有「来源」概念）。
2. `def.plan(COMMANDS, input, options)` → `planSkillOperation(options.update ? "skill-update" : "skill-init", …)`；纯本地，不联网、不写盘。
3. 有副作用且未 `--yes`/`--update` 时 `confirmSkillOperation()`：把变更/跳过项摊给用户，给出「处理全部 / 只补缺失 / 取消」，返回 `choice`（`all` / `missing`）。没有 userQuestions 或没有活 agent 时**不阻塞**，直接执行并在回执补一行说明。
4. `runInJob({ jobs, owner, kind, label: def.label(input, plan), signal, skip: plan.skipReason, work })`。
5. `work` 里调 `def.run(...)`：init 走 `runSkillInit`，`--update` 走 `runSkillUpdate`；`run*` 只执行 plan，不再重复 inspect / 比对 hash。
6. 结算：`run*` 首行是结论式 `✓/✅/⚠`，handler 把「过程：作业 …」放到第二行，并在有作业时给首行加 `· 后台作业` 标记；无事可做时首行仍是结论，第二行解释为什么没有作业。

`plan` 只算一次是硬约束：handler 与 run 各算一遍会产生两套 skip 文案和不一致的判定。

## 3. 必须保持的不变量

- **不做备份、不删真实目录**：覆盖旧条目时只 unlink 旧软链（含悬空软链）；遇到同名真实目录/文件直接报错，让用户自己移走。
- **软链是托管判定层**：`~/.dsh/skills/<name>` → `~/.agents/skills/<name>`；用 `target === canonical` 判断托管/非托管。不要为了「省一步」删掉软链层。
- **canonical 固定 `~/.agents/skills`**：`skills` CLI 的 universal 全局落点硬编码为 `homedir()/.agents/skills`；不要改成 `$DSH_AGENTS_HOME`，否则 CLI 仍写 canonical，插件会找不到。
- **lock 来源回写**：`skills add <本地缓存>` 会把 lock 写成 local；安装后必须回写 `source` / `sourceType` / `sourceUrl` / `skillPath` / `skillFolderHash`，否则其他 agent 的 `npx skills update` 认不出远端。
- **单一写入锁**：同一 `DSH_HOME` + canonical 目录同时只允许一个技能写操作；第二次直接拒绝，不并行 clone。
- **`-a universal` 必须显式给**；不要用 `skills update`（内部 spawn 可能装到所有 agent 目录），`--update` 也用 `add`。
- **确认只看「是否确定要写盘」**：`pending`（缺失/待修复）或 `plan.freshness.changed`（缓存已知的上游更新）才问；**缓存过期不提问**（联网检查只读）。真实目录/文件虽然不会替换链接，但来源仍会装进 canonical，所以同样会问。`--yes` 完全跳过；`ctx.userQuestions`/活 agent 缺失时降级执行并在回执首行标 `· 未确认`，不能把命令卡死。只有 `ASK_CANCELLED` / `ASK_ABORTED` 才算用户取消。
- **写盘范围只由 plan 决定**（`installTargets()`）：运行时 `checkSourceSkills()` 发现的上游更新**只报告、不安装**（回执给 `--update` 指引）。不要图省事把 `check.changed` 并进 `toInstall`——那会在用户没确认的情况下覆盖写，破坏「只由写盘触发确认」。
- **choice 只影响执行范围，不改变 plan**：`choice=missing` 时 `runSkillInit` 只处理 `state=missing`，跳过上游比对和已有条目。
- **任意来源安装不在本插件内**：dsh 扫描 canonical `~/.agents/skills`，额外技能用 `npx -y skills add <来源> --skill <名称> -g -a universal -y`，不需要软链，也不要重新引入 `/skill-install` 式的四路并集逻辑。

## 4. 缓存与 TTL

- 路径：`$DSH_HOME/cache/skills-sources/<sha256(url) 前 16 位>`，旁边 `<hash>.meta.json`。
- 首次 `git clone --depth 1`；之后 `git fetch --depth 1`；TTL 内连 fetch 都跳过。
- `DSH_COMMANDS_SKILL_CACHE_TTL_MS`：默认 `600000`；`0` = 每次都 fetch；`<0` = 离线，有缓存就不 fetch。
- 缓存 git 超时由外层 `DSH_COMMANDS_SKILL_TIMEOUT_MS` 派生：clone `min(60s, max(30s, outer-30s))`；fetch `min(20s, max(5s, outer/4))`。
- 首次 clone 前有 `git ls-remote` 连通性预检，默认 8s（`DSH_COMMANDS_SKILL_PROBE_MS`，`0` 关闭；本地路径来源不预检）。
- 普通 init 允许旧缓存并在回执标「离线，未确认上游」；`--update` 必须 fetch 成功，不拿旧缓存冒充更新。

## 5. 环境变量（只列会改行为的）

| 变量 | 作用 |
|---|---|
| `DSH_COMMANDS_SKILL_CLI_OVERRIDE` | 完全替换 CLI 命令本体；用于测试桩/自定义安装；跳过缓存、预检与 `--json` |
| `DSH_COMMANDS_SKILL_NPX_SPEC` | 显式走 `npx -y <spec>`；不设时优先用依赖里的 `skills` |
| `DSH_COMMANDS_SKILL_SOURCE` | 来源，默认 `morehao/ai-kit`；可换镜像/本地目录 |
| `DSH_COMMANDS_SKILL_TIMEOUT_MS` | 外层硬超时，默认 120s |
| `DSH_COMMANDS_SKILL_PROBE_MS` | 连通性预检超时，默认 8000ms；`0` 关闭 |
| `DSH_COMMANDS_SKILL_CACHE_TTL_MS` | 来源缓存 TTL |

旧名 `DSH_COMMANDS_SKILLS_CLI` / `DSH_COMMANDS_SKILL_CLI` 只保留一个版本 fallback，不要在新代码/文档里使用。

## 6. 作业与取消

- host 命令面没有进度通道；过程走 `ctx.jobs`：`reporter.progress()` 更新作业行，`reporter.write()` 写面板。web client half（`lib/client.js`）再把 `ctx.jobs` 快照渲染回命令卡，并在作业结算时补完成提示（当前会话也弹，切走时才额外标未读）。
- **必须 `wait()` 到终态**：`runInJob` 自己切片 `jobs.wait()`，保持 `awaited=true`，结算不投完成通知、不唤醒模型回合。不要改成订阅事件收尾。
- 作业结束前写一条 `完成：<结论首行>` 的 progress，结算后作业行仍能看到最终结论；但因为 `awaited`，**不会**再投一条完成通知——这是有意的零 token 取舍。
- 取消只终止子进程，不提前结束等待；`signal` 中止 → `jobs.kill`，最终返回 `{ killed: true }`。
- `ctx.jobs` 缺失、无控制器、并发上限、无 owner：退回直接执行（`NO_REPORTER`），语义不变；`apply` 不把 `jobs` 写进 `inject`。
- 无事可做时 `plan.skipReason` 有值：不建作业，但工作仍以无 reporter 跑一遍（幂等修复）；这类路径没有作业事件，完成感由命令卡的 `无变更` 态 + 回执第二行承担。
- **每条出口都要 `emitNotice()`**：本地命令的结果用 `agent.inject()` 写成一行 `form: "notice"` 消息（完成 / 取消 / 失败 / 已停止都要写）。原因是命令卡只活在对话流里，空会话（新建后直接跑命令）根本没有对话流，不写这一行就等于"执行了但什么都没发生"。**不要改成 `followup()`**：那会唤醒模型跑一轮。
- **回执必须自证 client half 是否加载**：`clientHalfState(ctx)` 读 `ctx.get("clientModules").graph().entries` 判断本包行是否在 boot graph 里。dsh 的客户端模块表只在启动时构建，运行中新装的包不会自动进表（host half 会被 hmr 热加载，client half 不会），此时所有自绘 UI 静默消失。未加载时首行标 `· 客户端未加载`、第三行给「重启 dsh 后生效」——不要删这行，它是这种失败唯一的用户可见线索。

## 7. 子进程与文本

- `spawnCollect`：argv 直传、不经 shell；timeout 先 SIGTERM，宽限后 SIGKILL；输出上限默认 120k 字符，超出保留后半段。
- 固定 `GIT_TERMINAL_PROMPT=0`、`GIT_HTTP_LOW_SPEED_LIMIT=1000`、`GIT_HTTP_LOW_SPEED_TIME=10`，避免私有仓/网络黑洞挂死。
- `tail()`：先剥 ANSI，再折叠 spinner、去框线/纯装饰行，最后按行/字符预算从尾部截断；CLI 失败回执用 15 行 / 单行 240 字符 / 整段 1200 字符。
- 作业面板输出先去 ANSI 再旁路；命令卡片只放摘要，完整输出留在作业面板。

## 8. 安全与测试

- 所有测试必须：临时 HOME、临时缓存、`DSH_COMMANDS_SKILL_CLI_OVERRIDE` 指 stub、不联网、不碰真实 `~/.dsh` / `~/.agents`。
- 不要用真实 `skills add` 跑冒烟；需要真实 git 时用临时仓库 / `file://`。
- 改 `lib/job-progress.js` 前先读 [smoke-skill-setup.mjs](../../scripts/smoke-skill-setup.mjs) 顶部注释（记录了 `wait` 的必要性与 dsh 侧行号证据）。
- 新增路径/清洗/超时逻辑时，优先扩展现有模块与冒烟，不新开一套。

## 9. 修改检查清单

- [ ] `plan` 仍然只算一次；`run*` 没有重复 inspect / hash。
- [ ] 确认只在有可执行变更时出现；`--yes`、无 userQuestions、无 agent 都不会卡住命令。
- [ ] 回执首行是 `✓/✅/⚠` 结论；「过程：作业 …」不再放在最后一行。
- [ ] 没有新增备份目录、没有删真实目录/文件。
- [ ] 软链仍指向 canonical；lock 回写字段完整。
- [ ] 新行为有离线冒烟覆盖；失败路径有可读回执。
- [ ] `npm run check` 通过。

## 10. 相关文档

- [技能自举](../skill-setup.md)
- [过程可见](../job-progress.md)
- [架构与原理](../architecture.md)
