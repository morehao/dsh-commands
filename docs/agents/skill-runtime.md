# 技能运行时（Agent）

> 读这篇的时机：改 `lib/skill-setup.js`、`lib/skill-cache.js`、`lib/skill-paths.js`、`lib/proc.js`、`lib/text.js`、`lib/job-progress.js`，或排查 `/skill-init` / `/skill-install` / `/skill-update`。
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

## 2. 调用链

本地型 handler：

1. `def.plan(COMMANDS, input, options)` → `planSkillOperation()`；纯本地，不联网、不写盘。
2. `runInJob({ jobs, owner, kind, label, signal, skip: plan.skipReason, work })`。
3. `work` 里调 `def.run(...)`；`run*` 只执行 plan，不再重复 inspect / 比对 hash。
4. 结算：成功返回文本 + 「过程：作业 …」/「未创建后台任务（短因）」/「未启用后台任务（原因）」。

`plan` 只算一次是硬约束：handler 与 run 各算一遍会产生两套 skip 文案和不一致的判定。

## 3. 必须保持的不变量

- **不做备份、不删真实目录**：覆盖旧条目时只 unlink 旧软链（含悬空软链）；遇到同名真实目录/文件直接报错，让用户自己移走。
- **软链是托管判定层**：`~/.dsh/skills/<name>` → `~/.agents/skills/<name>`；用 `target === canonical` 判断托管/非托管。不要为了「省一步」删掉软链层。
- **canonical 固定 `~/.agents/skills`**：`skills` CLI 的 universal 全局落点硬编码为 `homedir()/.agents/skills`；不要改成 `$DSH_AGENTS_HOME`，否则 CLI 仍写 canonical，插件会找不到。
- **lock 来源回写**：`skills add <本地缓存>` 会把 lock 写成 local；安装后必须回写 `source` / `sourceType` / `sourceUrl` / `skillPath` / `skillFolderHash`，否则其他 agent 的 `npx skills update` 认不出远端。
- **单一写入锁**：同一 `DSH_HOME` + canonical 目录同时只允许一个技能写操作；第二次直接拒绝，不并行 clone。
- **`-a universal` 必须显式给**；不要用 `skills update`（内部 spawn 可能装到所有 agent 目录），`/skill-update` 也用 `add`。

## 4. 缓存与 TTL

- 路径：`$DSH_HOME/cache/skills-sources/<sha256(url) 前 16 位>`，旁边 `<hash>.meta.json`。
- 首次 `git clone --depth 1`；之后 `git fetch --depth 1`；TTL 内连 fetch 都跳过。
- `DSH_COMMANDS_SKILL_CACHE_TTL_MS`：默认 `600000`；`0` = 每次都 fetch；`<0` = 离线，有缓存就不 fetch。
- 缓存 git 超时由外层 `DSH_COMMANDS_SKILL_TIMEOUT_MS` 派生：clone `min(60s, max(30s, outer-30s))`；fetch `min(20s, max(5s, outer/4))`。
- 首次 clone 前有 `git ls-remote` 连通性预检，默认 8s（`DSH_COMMANDS_SKILL_PROBE_MS`，`0` 关闭；本地路径来源不预检）。
- 安装类命令允许旧缓存并在回执标「离线，未确认上游」；`/skill-update` 必须 fetch 成功，不拿旧缓存冒充更新。

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

- 命令面没有进度通道；过程走 `ctx.jobs`：`reporter.progress()` 更新作业行，`reporter.write()` 写面板。
- **必须 `wait()` 到终态**：`runInJob` 自己切片 `jobs.wait()`，保持 `awaited=true`，结算不投完成通知、不唤醒模型回合。不要改成订阅事件收尾。
- 取消只终止子进程，不提前结束等待；`signal` 中止 → `jobs.kill`，最终返回 `{ killed: true }`。
- `ctx.jobs` 缺失、无控制器、并发上限、无 owner：退回直接执行（`NO_REPORTER`），语义不变；`apply` 不把 `jobs` 写进 `inject`。
- 无事可做时 `plan.skipReason` 有值：不建作业，但工作仍以无 reporter 跑一遍（幂等修复）。

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
- [ ] 没有新增备份目录、没有删真实目录/文件。
- [ ] 软链仍指向 canonical；lock 回写字段完整。
- [ ] 新行为有离线冒烟覆盖；失败路径有可读回执。
- [ ] `npm run check` 通过。

## 10. 相关文档

- [技能自举](../skill-setup.md)
- [过程可见](../job-progress.md)
- [架构与原理](../architecture.md)
