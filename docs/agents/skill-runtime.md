# 技能运行时（Agent）

> 读这篇的时机：改 `lib/skill-setup.js`、`lib/skill-cache.js`、`lib/skill-paths.js`、`lib/proc.js`、`lib/text.js`、`lib/job-progress.js`，或排查 `/skill-init`（含 `--update`）。
> 完整背景见 [技能自举](../skill-setup.md) 与 [过程可见](../job-progress.md)。

## 1. 模块边界

| 模块 | 职责 | 不要做 |
|---|---|---|
| `lib/skill-setup.js` | plan、安装、软链、契约校验、回执 | 不直接碰 `ctx.jobs`；不复制缓存/路径逻辑 |
| `lib/skill-cache.js` | 来源浅克隆、TTL、lock 回写 | 不决定「要不要建作业」 |
| `lib/skill-paths.js` | `DSH_HOME` / agents home / 本源 / lock 路径；`skillRoots()` 是技能根顺序的唯一真源 | 不让调用方各自拼路径 |
| `lib/proc.js` | 子进程 timeout / abort / 输出上限 | 不经 shell 拼命令 |
| `lib/text.js` | ANSI / 框线 / spinner 清洗、tail 截断 | 不加业务语义 |
| `lib/job-progress.js` | 把 work 挂到 `ctx.jobs`、`wait` 收尾、降级 | 不含技能逻辑 |
| `lib/skill-command.js` | `/skill-init` 的 flags 解析、注入消息、handler 与本地回退 | 不执行安装、不碰 `ctx.jobs` |
| `lib/tool-skill-init.js` | `skill_init` 工具定义（参数/结果 schema/markdown）与 execute 编排；纯定义，不 import `@deepseek-ai/*` | 不复制 observe/plan/apply；不在 `execute` 外解析服务 |

## 2. 调用链

命令层（`lib/skill-command.js`）：

1. `parseSkillInitInput(rawInput)`：`--update` / `--yes` / 技能名；init 带技能名、未知 flag → 用法错误，不注入。
2. 无 `tools`、无 `agent.followup` → `fallback(parsed, invocation)` 直接跑 `runSkillInit` / `runSkillUpdate`，返回文本。
3. `buildSkillInitMessage()` → `createUserMessage()` → `invocation.agent.followup()`；成功返回一行「已开始检查/更新依赖技能」。
4. 注入抛错 → 本地回退，不留半条消息。

`plan` 只算一次是硬约束：命令层不 plan，工具层只 plan 一次并把它用于确认、写盘与回执。

### 2.1 工具链路

`skill_init`（`lib/tool-skill-init.js`）复用同一核心，`execute` 顺序固定：

1. `referencedSkills(commands)` 校验 `names`：未知技能直接 `attention`，零写。
2. `observeSkills()` → `planOperation()`；无写盘且无需只读探针（`check` / 已就绪 / 纯 blocked / 纯 warn）直接出结论。
3. 有写盘且未 `yes`：`confirmSkillPlan()` 用 plan markdown 做 detail；无 `userQuestions`/agent 或确认通道异常 → 返回 `status:"plan"`，零写（**不 pass-through**）。`只补缺失` 会把非 missing 的 install/relink 降级为 skip。
4. 写前再 `observe` 一次做指纹（只比涉及技能的链状态/目标/canonical 存在性）；变化 → `attention`，整次中止。
5. `runInJob({ owner: exec.agent?.session?.id, kind: "skill-init", skip, work })`：work 内先只读探针（缓存过期时），再 `applyPlan`。
6. 复核：`verifyPlan` 比对 canonical/links/state；结果状态优先级：probeError/失败/verify 问题 → `attention`；blocked 且未写 → `blocked`；有写 → `changed`；否则 `ok`。
7. 停止/取消：`runInJob` 返回 `killed` → `status:"cancelled"`，不误报成功。

## 3. 必须保持的不变量

- **不做备份、不删真实目录**：覆盖旧条目时只 unlink 旧软链（含悬空软链）；遇到同名真实目录/文件直接报错，让用户自己移走。
- **软链是托管判定层**：`~/.dsh/skills/<name>` → 本源 `~/.agents/skills/<name>`；用 `target === canonical` 判断托管/非托管。不要为了「省一步」删掉软链层。
- **本源固定 `~/.agents/skills`**：`skills` CLI 的 universal 全局落点硬编码为 `homedir()/.agents/skills`；不要改成 `$DSH_AGENTS_HOME`，否则 CLI 仍写本源，插件会找不到。
- **技能根顺序只有一处**：`skillRoots()`（`$DSH_HOME/skills` → `$DSH_AGENTS_HOME/skills` → 本源）。运行期预检与 `scripts/check-skill-contract.mjs` 都必须用它；上游 #50 之后本源才是真实内容，软链层可能不存在，任何「只看 `$DSH_HOME/skills`」的判定都会误报未安装。
- **lock 来源回写**：`skills add <本地缓存>` 会把 lock 写成 local；安装后必须回写 `source` / `sourceType` / `sourceUrl` / `skillPath` / `skillFolderHash`，否则其他 agent 的 `npx skills update` 认不出远端。
- **单一写入锁**：同一 `DSH_HOME` + canonical 目录同时只允许一个技能写操作；第二次直接拒绝，不并行 clone。
- **`-a universal` 必须显式给**；不要用 `skills update`（内部 spawn 可能装到所有 agent 目录），`--update` 也用 `add`。
- **确认只看「是否确定要写盘」**：`plan.confirm.needs`（install/relink）才问；缓存过期只做只读探针，不提问。`yes=true` 完全跳过确认，但**不跳过**所有权、真实目录、指纹检查。无 `userQuestions`/活 agent 或确认通道异常 → 工具返回 `status:"plan"`、零写（不再 pass-through 执行）；只有 `ASK_CANCELLED` / `ASK_ABORTED` 才算用户取消。
- **写盘范围只由 plan 决定**（`installTargets()`）：运行时 `checkSourceSkills()` 发现的上游更新**只报告、不安装**（回执给 `--update` 指引）。不要图省事把 `check.changed` 并进 `toInstall`——那会在用户没确认的情况下覆盖写，破坏「只由写盘触发确认」。
- **choice 只影响执行范围，不改变 plan**：`只补缺失` 把非 missing 的 install/relink 降级为 skip，`applyPlan` 只写 missing 条目；旧命令回退用 `runSkillInit({choice:"missing"})`。
- **任意来源安装不在本插件内**：dsh 扫描本源 `~/.agents/skills`，额外技能用 `npx -y skills add <来源> --skill <名称> -g -a universal -y`，不需要软链，也不要重新引入 `/skill-install` 式的四路并集逻辑。

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
| `DSH_COMMANDS_SKILL_SOURCE` | 来源，默认 `morehao/agent-skills`；可换镜像/本地目录 |
| `DSH_COMMANDS_SKILL_TIMEOUT_MS` | 外层硬超时，默认 120s |
| `DSH_COMMANDS_SKILL_PROBE_MS` | 连通性预检超时，默认 8000ms；`0` 关闭 |
| `DSH_COMMANDS_SKILL_CACHE_TTL_MS` | 来源缓存 TTL |

旧名 `DSH_COMMANDS_SKILLS_CLI` / `DSH_COMMANDS_SKILL_CLI` 只保留一个版本 fallback，不要在新代码/文档里使用。

## 6. 作业与取消

- 工具内过程走 `ctx.jobs`：`reporter.progress()` 更新作业行，`reporter.write()` 写面板；作业行/面板/停止由 dsh 原生 UI 提供，本插件不再有 client half。
- **必须 `wait()` 到终态**：`runInJob` 自己切片 `jobs.wait()`，保持 `awaited=true`，结算不投完成通知、不唤醒模型回合。不要改成订阅事件收尾。
- 作业结束前写一条 `完成：<结论首行>` 的 progress，结算后作业行仍能看到最终结论；但因为 `awaited`，**不会**再投一条完成通知——这是有意的零 token 取舍。
- 取消只终止子进程，不提前结束等待；`signal` 中止 → `jobs.kill`，最终返回 `{ killed: true }`。生产者用 `cancel` 标志决定结算成 `killed` 还是 `failed`：用户停止时 `cancel()` 已置位，`work` 抛出的错误必须记 `killed`（否则 `jobs-local` 的终态是 `failed`，`killed` 分支不可达）。
- `ctx.jobs` 缺失、无控制器、并发上限、无 owner：退回直接执行（`NO_REPORTER`），语义不变；`apply` 不把 `jobs` 写进 `inject`。
- 工具在无写盘且无需探针时直接出结论，不建空作业；需要联网检查上游时（缓存过期）把只读探针放进作业，结束后再 `applyPlan`。
- **结果由工具返回，不再发执行报告**：`markdown` 第一行是结论（`✓/✅/⚠/⛔/…`），agent 按注入消息要求用 1–3 句话总结；命令卡只显示一行「已开始…」。不要再引入 `reportOutcome` / `cordis-host-runner` / client half。

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
- [ ] 确认只在有可执行变更时出现；`yes`、无 userQuestions、无 agent 都不会卡住命令。
- [ ] 工具 markdown 首行是结论；停止/取消/blocked 都有明确 status。
- [ ] 没有新增备份目录、没有删真实目录/文件。
- [ ] 软链仍指向 canonical；lock 回写字段完整。
- [ ] 新行为有离线冒烟覆盖；失败路径有可读回执。
- [ ] `npm run check` 通过。

## 10. 相关文档

- [技能自举](../skill-setup.md)
- [过程可见](../job-progress.md)
- [架构与原理](../architecture.md)
