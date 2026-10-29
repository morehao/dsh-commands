# Changelog

## [v0.4.0] - 2026-10-29

### 破坏性变更

- **技能安装 / 更新改为消费 `@morehao/dsh-skills-console` 包 API**：删除 `skills` CLI 依赖、`lib/skill-cache.js`（git 缓存 / TTL）、`lib/skills-console.js`（只读 state.json）、`ensureLinks` / `linkSkill` 与 `~/.dsh/skills` 可见性建链、`DSH_COMMANDS_SKILL_BACKEND`（auto/console/cli）与整套 CLI 参数 / 网络预检。`/skill-init`（含 `--update`）现在通过 `import('@morehao/dsh-skills-console/api')` → `createSkillsConsole()` 调用 `list` / `adopt` / `install` / `update`。
- **不再往 `~/.dsh/skills` 建链**：canonical `~/.agents/skills` 就是 DSH 的扫描根，装好即可见；两份真相（建链）会让摘链不等于不可见。已手工放好的技能按「已安装」识别，控制台账本没有时先 `adopt` 只补记账。
- **`skills` 依赖换成 `@morehao/dsh-skills-console: >=0.7.0 <0.8.0`**（dependency，自动带上）。**不要求启用技能控制台插件**：插件启用时包内部 runtime registry 让 `createSkillsConsole()` 复用插件实例、共享同一个 StateStore（单写者）；未启用时创建 headless 实例单写。
- **旧 console 守卫**：profile 顶层启用的是 <0.7.0 的技能控制台时，`/skill-init` 直接 `blocked` 并提示升级，绝不创建 headless 实例导致双写。
- `DSH_COMMANDS_SKILL_SOURCE` 保留为 `install({ source })` 的来源覆盖，**只支持 GitHub 源**（owner/repo 或 GitHub URL）；本地目录源 v1 不支持。离线安装能力随 git 缓存一并移除（`/skill-init` 需要能访问上游）。

### 修复

- **与 `dsh-skills-console` 0.6.0（state v4）兼容**：`lib/skills-console.js` 的 `readConsoleState` 现在读取 `version` 并归一化 `mode`——v1/v2 `off|on`、v3 `enabled`、v4 `enabled` + `auto|manual|hidden`，未来版本（>4）一律 `unknown`。`resolveOwnership` / `planOperation` / `checkContract` 对 `off/hidden/manual/unknown` 一律只读不写（`writes:false`），不再把「停用/仅手动/完全停用」误当成启用。
- **委托型命令预检补上不可用原因**：控制台把技能设为停用 / 完全停用 / 仅手动 / 版本未知时，`/git-*`、`/handoff`、`/cleanup` 直接给出对应文案，而不是误报「未安装」或让 `skill` 工具加载失败。
- **技能可用性判定改走 `ctx.skills`**：优先 `ctx.get("skills").list({ cwd })`（权威、已校验，能识别 `disable-model-invocation` 等被过滤的技能），目录不可用时回退原有文件探测；`handoff` 的 `readFallback` 兜底保留。
- **`/plugin-update` 版本检查优先走 `pnpm view`**：继承 profile 的镜像 / 私源 / token，私有 registry 不再因裸 `fetch` 不读 `.npmrc` 而失败；拿不到再回退既有 registry 计划 + fetch。

### 变更

- 命令 / 工具流程简化为 **resolve-api → observe（api.list + canonical 文件存在性）→ adopt → plan → confirm → apply（api.install / api.update）→ verify**；计划动作收敛为 `install` / `update` / `delegate` / `blocked`（不再有 `relink` 与链状态字段）。
- `update` 结果按 API 状态区分：`updated` / `current` / `locally-modified`（不覆盖、回执提示）/ `parked` / `no-subscription` / `not-managed` / `failed`。
- 离线冒烟全部改为注入 fake API：`smoke-skill-setup`（安装 / 幂等 / 更新 / 只补缺失 / API 缺失 blocked / 旧 console 守卫）、`smoke-skill-plan`（observe/plan 矩阵）、`smoke-skill-tool`（工具矩阵 + 确认不变量）；删除 `smoke-skill-cache.mjs`。
- **清单规范**：`package.json` 增加 `engines.dsh`（`>=0.2.1-rc.3 <0.3.0-0`）与可选 `peerDependencies`（`@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm`，`peerDependenciesMeta.optional`），`skills` 从 `latest` 固定为 `~1.7.4`，依赖可复现。
- **命令稳定身份**：注册时传 `definitionId`（`dsh-commands:<name>`），命令身份稳定、可被 adapter 定向覆盖。
- **消息构造优先官方实现**：注入的 user / notice 消息优先用 `@deepseek-ai/dsh-llm` 的 `createUserMessage`（`apply()` 里可选加载），无该模块（离线 / 旧宿主）时回退本地契约实现；`lib/` 仍无顶层 `@deepseek-ai/*` 静态 import，离线冒烟不受影响。
- **生态惯例小修**：`cordis.patch.yml` 的 insert 补 `config: {}`；命令注册去掉多余的 `ctx.effect` 包装，直接 `await ctx.commands.register(...)`（`register()` 内部已绑定调用方 fiber，卸载自动注销）。
- **状态文件路径**：`dsh-commands/state.json` 优先取 `profileContext.home`，缺省回退 `$DSH_HOME`。
- 新增 / 扩展离线冒烟：console v1/v3/v4 state 归一化与 `off/hidden/manual/unknown` 均 `writes:false`；技能目录命中 / 缺失 / 回退与 `modelInvocable:false`；官方消息工厂优先；`pnpm view` 命中与回退。

## [v0.3.4] - 2026-10-29

### 变更

- **`/plugin-update` 改为委托式问答 + 一键更新**：命令注入 user 消息，由 agent 调用 `plugin_update` 工具，走 observe → plan → confirm → apply → verify。有更新时先弹问答确认（`更新` / `取消`），更新过程挂后台作业（作业行/面板可见、可停止），完成后提示「重启 DSH 生效」；无 tools / 无 agent 时回退本地只读检查。
- **更新实现**：`pluginManager.installBundle → already-installed → removeBundle → installBundle`（P1 in-process），结果区分 `applied`（热生效） / `restart-required`。
- **新增重启后提示**：更新成功写 `$DSH_HOME/dsh-commands/state.json` 的 `pendingVersion`；重启后 `announcePluginUpdate()` 检测版本变化并向活跃会话补一条「已更新到 vX」的 notice。
- 新增 `lib/plugin-update-service.js`、`lib/tool-plugin-update.js`；`lib/plugin-update.js` 增加安装版本读取与状态读写；`scripts/smoke-plugin-update.mjs` 覆盖确认 / 更新 / 状态。

## [v0.3.3] - 2026-10-29

### 新增

- **新增 `/plugin-update` 维护命令**：只读检查本插件自身在 npm 上的最新版本（当前 / 最新版本），有更新时给出可复制的 `dsh plugin --profile <p> add @morehao/dsh-commands@latest`。**不一键安装**：更新自己会 `remove` + `install` 重载插件，命令卡可能来不及结算；需要更新请退出 dsh 后按命令执行。核心为 `lib/plugin-update.js`（registry 计划继承宿主镜像/私源、8s 超时、5 分钟缓存、手写 semver 比较，零宿主 import），命令层为 `lib/plugin-update-command.js`；新增 `scripts/smoke-plugin-update.mjs` 并接入 `npm test`。

## [v0.3.2] - 2026-10-28

### 新增

- **新增 `/git-checkout-tag` 命令**：适配 agent-skills #61（git-kit 新增 `checkout-tag` 分支，v0.3.4）。切到当前仓库的最新 tag（按版本号取最高，非 semver 退化为最近创建；也可指定 tag 名），默认切到 detached HEAD，**只切不改**、不新建分支/不提交/不推送；要基于该 tag 继续开发才另建分支。至此 git-kit 的 10 个分支（commit-push / commit-message / branch / pr-create / pr-merge / tag / checkout-tag / release / slim / star-classify）均已暴露为 dsh 命令。
- 同步 README 命令表；契约校验冒烟的「条数」断言改为按 `COMMANDS.length` 动态生成，避免后续增删命令时再次漂移。

> 注：`/cleanup`（disk-cleanup #58 新增的 `orphans` 卸载残留扫描等能力）与 `/handoff` 仍在各自既有单一分支内，映射无需改动，升级技能后自动获得。

## [v0.3.1] - 2026-10-26

### 修复

- **契约校验改用与运行期预检同一组技能根**：`scripts/check-skill-contract.mjs` 现在走 `skillRoots()`（`$DSH_HOME/skills` → `$DSH_AGENTS_HOME/skills` → 本源 `~/.agents/skills`）。agent-skills #50 把本源定为真实内容、`$DSH_HOME/skills` 只是 `skills-fanout.sh` 建的软链层；旧脚本只看软链层，在「已发布本源、还没 fanout」的机器上会把 11 条命令全判成技能缺失。缺技能改为按技能去重报一次，并列出查过的所有路径。
- **新增 `scripts/smoke-skill-contract.mjs`**：临时 HOME 下覆盖四类技能根（只有本源 / 只有 `$DSH_HOME/skills` / 只有 `$DSH_AGENTS_HOME/skills` / 软链层指向本源）、缺分支文件与缺技能去重；已并入 `npm test` 与 CI。

### 变更

- **`/handoff` 的 read 兜底改为历史兼容**：agent-skills #51 移除了 `handoff` 的 `disable-model-invocation`，技能恢复模型可见、可自行触发。`readFallback` 保留给装了旧版技能目录的机器，注入文案不再断言「该技能标了该标记」，并补上本源路径（`$DSH_HOME/skills` 不存在时读 `~/.agents/skills`）。
- **`/cleanup` 描述同步 disk-cleanup #52**：说明报告区分「目录总量 / 本次可删量」、清理前先 dry-run 复核、sudo 项交用户终端；`confirm` 明确清理项编码走 `--only`。
- **文档口径对齐「本源 + 分发软链」**：README / 技能自举 / 架构 / agent 手册说明 `/skill-init` 与 agent-skills 的 `skills-install.sh` + `skills-fanout.sh` 同向（共用 skills CLI 与 `.skill-lock.json`），并修正冒烟数量与 CLI 注释。

## [v0.3.0] - 2026-10-25

### 破坏性变更

- **`/skill-init` 改为维护型委托**：命令只解析 `--update` / `--yes` / 技能名，注入一条 `source.kind: "user"` 消息，由 agent 调用 `skill_init` 工具；命令卡只显示一行「已开始检查/更新依赖技能」。确认（处理全部 / 只补缺失 / 取消）、后台作业、停止、结果明细都在工具里。无 `tools`、无 `agent.followup` 或注入失败时回退到本地执行，旧宿主不丢功能。
- **删除 web client half 与旧命令 UX**：`lib/client.js`、命令卡/toast/未读点、执行报告 `reportOutcome()`、`cordis-host-runner` 复核消息、`clientHalfState()` 自证行，以及 `lib/confirm.js`、`LOCAL_COMMANDS` / `makeLocalHandler` 全部移除。进度/停止/完成感知由 dsh 原生作业 UI 提供；`package.json` 去掉 `dsh.client`、`exports["./client"]` 与 `smoke:client`。依赖这些导出或旧卡片格式的下游需要适配。
- **工具结果改为汇报式**：`markdown` 首行结论 + 动作/契约/验证/下一步；agent 用 1–3 句总结，不再被要求「只回无异常」。`/skill-init` 与委托型命令统一 `recordInput: false`（命令行参数不再进 `command/run.args`）。

### 变更

- **新增 `skill_init` 工具**：与命令共享 observe/plan/apply/verify；默认先确认，无 `userQuestions` 时只返回计划且零写；支持 `mode=init/update/check`、`names`、`yes`，未知技能直接拒绝、确认后指纹变化整次中止。工具在 `ctx.get("tools")` 可用时注册，旧宿主自动跳过。
- **作业停止的结算修正**：用户停止时生产者现在标记 `killed`（`cancel` 标志），不再被记成 `failed`；此前 `runInJob` 的 `killed` 分支不可达。
- **plan 已知的上游更新改为只警告、不重装**：`/skill-init` 的写盘集合只剩缺失/待修复项，`changed` 不再触发确认、不再在缓存命中时重装；回执首行仍给 `ℹ 无变更，上游有 N 项更新` 与 `--update` 指引。`/skill-init --update` 仍是唯一重装入口。


本文件记录 `@morehao/dsh-commands` 的发布历史。`v0.1.0`–`v0.1.7` 由旧仓
[`morehao/ai-kit`](https://github.com/morehao/ai-kit) 的 `commands-dsh/` 目录发布，
2026-10 起在本仓发布；npm 包名未变，版本号连续。

## [v0.2.3] - 2026-10-23

### 变更

- **命令卡按「问答对」重排**：标题显示真实命令行与参数（`/skill-init --update git-kit`），第二行不再重复状态头与耗时，而是按结局给影响面/具体问题（无变更 → `技能：…` 或上游更新；已完成 → 变更规模；`⚠` → 遮蔽/契约问题）。`⚠` 结局新增琥珀色「需处理」态；`后台作业` / `未确认` / `客户端未加载` 改为独立 chips；展开区跳过与标题重复的首行。
- **执行报告的来源改为 `cordis-host-runner`**：唤醒时 dsh 的触发行按 source kind 显示「插件状态更新」，不再是未知来源的「收到执行请求」；`form: "notice"` 与 `summary` 保留（`inject()` 分支仍用 summary）。不用 `tool-jobs`：skip / Usage / 取消出口没有作业，标题会失真。
- **复核指令去重复述**：命令卡已展示命令、参数、结论，agent 不再复述；正常只回「无异常」，有需处理事项才按重要性列 ≤3 条并写明下一步；仍然每次执行都唤醒一轮复核。报告首行带真实命令行（含 `--update` 等参数），便于 agent 与日志核对。

## [v0.2.2] - 2026-10-23

### 修复

- **命令结论交给 agent 复核，不再依赖对话流**：`/skill-init` 每条出口都会发一条 `form: "notice"` 的执行报告（回执全文 + 「只复核、不要重跑/调工具」的指令），默认用 `agent.followup()` 唤醒一轮，由 agent 回 2–3 行结论。原因：命令卡只活在对话流里，而 dsh 的会话 `blank` **只由 `turn/start` 解除**（`dsh-api-session-controller` 的 `applySessionListMetadata`），命令事件与 `inject()` 都不算——所以在新建会话里跑命令，不唤醒一轮就必然什么都看不到（实测：日志有 `command/run` + `command/done`，页面无卡）。命令本体仍是确定性执行，agent 只做复核；**取消**只 `inject()` 记一行不唤醒；`DSH_COMMANDS_SKILL_NOTIFY=notice` 可整体降级为零 token 记录。
- **`/skill-init` 回执自证客户端卡是否加载**：dsh 的客户端模块表在启动时构建，运行中新装/升级的包不会自动进 boot graph（host half 会被 hmr 热加载，client half 不会），此时自绘命令卡、完成提示、未读点全部静默消失，用户只看到一行通用命令。回执现在按 `ctx.get("clientModules").graph().entries` 判断本包行是否存在：未加载时首行标 `· 客户端未加载`、第三行给「重启 dsh 后生效；Settings → Plugins 可看同步状态」；正常时第三行写「客户端：命令卡已加载（web）」；服务不可用写「状态未知」，不假装已加载。
- 文档补充这条排障路径（[过程可见](docs/job-progress.md)），并把回执行号约定改为「第二行过程 / 第三行客户端卡 / 第四行起明细」。

## [v0.2.1] - 2026-10-23

### 变更

- **`/skill-init` 的确认只由「是否确定要写盘」触发**：安装缺失/重建软链（`pending`），或 plan 已从本地缓存比对出上游更新（`changed`）时才弹确认。**上游缓存过期不再提问**——联网检查是只读的，直接执行并在回执里给结论；「会不会弹问题」不再取决于「距上次检查多久」。
- **运行时发现的上游更新只报告、不重装**：写盘范围由 `installTargets()` 在 plan 阶段锁定，`checkSourceSkills()` 在作业里才发现的变化只进回执（首行 `ℹ 无变更，上游有 N 项更新` + 「运行 /skill-init --update 更新」），不再在用户没确认的情况下覆盖写。要把装好的技能跟到最新请用 `--update`。
- **降级未确认在首行标注**：没有问答 UI / 没有活 agent / 命令被委派时，回执首行带 `· 未确认`（原先只在末尾一行说明）。
- 回执措辞：`✓ 已是最新` → `✓ 无变更`；无事可做时第二行改为「过程：本次没有变更，未创建后台任务（原因）」；`plan` 的 skip 原因改为「10 分钟内已检查过上游，本次不重复联网」。

### 修复

- **作业结算时的完成提示改成「一律弹」**：原来用户正看着该会话时 `notify()` 直接 return，只留命令卡一行摘要，用户看不出到底跑完没有；现在当前会话也弹 toast，未读点只在切走后标。
- 命令卡新增 `无变更` 态（不再是笼统的「已完成」），完成/失败/取消/停止/无变更各有独立文案与状态色。

## [v0.2.0] - 2026-10-23

### 破坏性变更

- **删除 `/skill-install`**：任意来源的技能安装不再由插件提供。dsh 会扫描 canonical `~/.agents/skills`，直接执行 `npx -y skills add <来源> --skill <名称> -g -a universal -y` 即可；也可以用自然语言让 agent 执行。附带删除来源询问、四路并集建链、只装缺少的、安装专用 freshness 等逻辑。
- **`/skill-update` 并入 `/skill-init --update`**：`/skill-init --update [技能名...]` 强制更新依赖技能，显式更新不弹确认；原来单独注册的 `/skill-update` 删除。本地命令面从 3 条变为 1 条。
- **委托型命令增加依赖预检**：技能未安装时不再注入委托消息，直接返回 `/skill-init` 与手工 `npx` 指引，避免 agent 拿到一条注定失败的指令。

### 新增

- **命令卡实时状态（web client half）**：`lib/client.js` 注册 `conversation.chat.commandview`，接管 `/skill-init`（含 `--update`）的卡片。执行前显示「等待确认」，执行中显示阶段、计时、可展开日志和停止按钮；完成/失败/取消/停止后保留结论。没有 client half 时仍回退 dsh 通用卡。
- **离开会话的完成感知**：`shell.overlay` 在右下角弹应用级完成/失败提示，带「查看」；`sidebar.session.row.leading` 给「技能维护」会话保留未读点，点开会话即清。tracker 在命令卡卸载后继续 `ctx.jobs.watchRows(sessionId)` 到本次作业结算，所以切到别的会话也能收到。仍然是零 token：不新增 host 事件、不唤醒模型。
- **`/skill-init` 的「只补缺失」**：确认卡按 plan 生成问题、现状清单和范围选项；选「只补缺失」只装 `state=missing` 的条目，跳过上游比对和已有条目。

### 变更

- 确认问题不再复用「执行上述技能维护操作，继续执行？」模板；`/skill-init` 列出逐项现状（未安装/已安装/真实目录/非托管软链），选项按本次 plan 生成。
- `LOCAL_COMMANDS` 的 `run` 新增 `choice`（`all` / `missing`），由确认结果传入；`--yes`、无问答 UI、无活 agent 时默认 `all`。`--update` 走强制更新分支且不打断。
- `package.json` 增加 `exports["./client"]` 与 `dsh.client`（platform `web`、`immediately`）；`lib/client.js` 是预打包 bundle，不引入构建步骤。
- 文档同步命令卡、完成提示、未读点、`choice` 语义、`--update` 与 client half 打包约束。

## [v0.1.14] - 2026-10-23

### 新增

- **`/skill-init`、`/skill-install` 执行前确认**：`plan` 判定有变更（安装/替换软链、真实目录仍需装 canonical、缓存过期需联网检查）或 `/skill-install` 要装整个来源时，通过 dsh 的 `ctx.userQuestions` 弹一次「继续执行 / 取消」；取消直接返回「已取消，未做任何变更」并不建作业。`/skill-install` 不写来源时先问来源；`/skill-update` 是显式更新，不弹确认。`--yes` 跳过确认；没有问答 UI/活 agent/被委派时降级为直接执行并在回执说明。
- **回执首行结论化**：`/skill-init`、`/skill-install`、`/skill-update` 的首行改为 `✓ 已是最新` / `✅ 已安装：N 个技能` / `✅ 已更新：N 个技能` / `⚠ 已完成，但有 N 项需处理`，不再用中性的「技能依赖检查」；部分失败/真实目录遮蔽一眼可见。
- **作业过程更具体**：作业 label 带上本次目标技能（如 `检查依赖技能（git-kit、handoff、disk-cleanup）`）；结算前写一条 `完成：<结论>` progress，作业行保留最终结论。

### 变更

- 「过程：作业 …」不再追加在回执最后一行（折叠时看不到），改为第二行；有作业时首行带 `· 后台作业`，降级时带 `· 未启用后台作业`。
- `LOCAL_COMMANDS` 的 `label` 签名改为 `(input, plan)`，让作业行能显示实际处理范围。
- 文档同步执行前确认、`--yes`、结论式回执与「完成通知仍受 `awaited` 抑制」的边界。

### 修复

- 本地命令「执行成功但用户感知不到」：首行给结论、过程提示上移、无事可做时也明确说明为什么没有作业。
- `release.yml` 建 GitHub Release 时读不到注记正文：tag 事件下 `actions/checkout` 会把
  `refs/tags/<tag>` 重指成轻量 tag，导致 `release-notes.mjs` 拒绝投影。现建 Release 前按
  `refs/tags/<tag>` 显式回拉一次，恢复注记后再投影（v0.1.13 缺失的 Release 已手工补建）。

## [v0.1.13] - 2026-10-23

### 新增

- **`/cleanup`：接入 ai-kit 的 `disk-cleanup` 技能**（macOS 为主）。先只读测量、出带实测大小的
  清单，由用户勾选清理项后只跑 `--only <编码>`；用户数据只报告不代删。**无参数时不执行任何脚本**，
  先给编号选项（只看占用 / 选勾清理 / 只处理本地数据库 / 取消），与 opencode 的 `/cleanup` 同一套流程；
  `COMMANDS` 新增 `noInput` / `confirm` 两个可选字段来承载这条命令的特殊语义。
- `/skill-init`、`/skill-update` 的依赖集合自动包含 `disk-cleanup`（仍由 `COMMANDS` 推导，没有第二份
  清单）；跨仓契约校验新增 `disk-cleanup#cleanup`。

### 变更

- 对齐 ai-kit `git-kit` 的两层变更说明（ai-kit #46）：`/git-release` 与 `/git-tag` 的菜单描述注明 tag 注记 /
  Release body 为「中文摘要 + 折叠原文」；`docs/publishing.md` 补「推送前确认并冻结」与「`TAGGED` 重跑从
  tag 注记读回、不重算」。命令仍只做委托，流程与脚本都在技能里。

### 性能

- **技能安装改为「本地缓存 + 直接调用 skills CLI」**，仍然走官方 `skills add`，产物仍是标准
  `~/.agents/skills` + `.skill-lock.json`，其他 agent 可继续 `npx skills`：
  - 首次把来源 `git clone --depth 1` 到 `$DSH_HOME/cache/skills-sources/<hash>`，之后用
    `git fetch --depth 1` 增量更新；TTL 内（默认 10 分钟）不联网。
  - 安装时把缓存目录交给 `skills add`，不再每次整仓克隆；`skills` 作为依赖直接
    `node bin/cli.mjs`，省掉每次 `npx` 约 2–3s 启动；依赖缺失时才回退 npx。
    显式设置 `DSH_COMMANDS_SKILL_NPX_SPEC` 仍按原样走 npx 指定版本，便于回退/对比。
  - 使用 `skills add --json` 解析安装结果；安装后把 lock 的 `source`/`sourceType`/`sourceUrl`/
    `skillPath`/`skillFolderHash` 回写为远端身份，实测 `npx skills update` 仍能识别为 up to date。
  - 首次 `/skill-init` 约 7–8s，已缓存补装约 1–1.3s、修复软链约 1.0s、`/skill-update` 约 4.5–5s；
    已托管的显式 `/skill-install` 在 TTL 内只做本地 hash 比对（约 0.3–0.8s），TTL 过期会进入作业检查上游。
  - 新增 `DSH_COMMANDS_SKILL_CACHE_TTL_MS`（默认 600000；0=每次刷新，<0=离线）；
    缓存 git 超时由外层 `DSH_COMMANDS_SKILL_TIMEOUT_MS` 派生，不再单独提供变量。
- **已安装不再等于永久跳过**：`/skill-init`、`/skill-install` 先比对 lock 的 `skillFolderHash` 与缓存
  git tree hash；TTL 内一致才返回「已是最新」，TTL 过期会 fetch 上游，有变化才重装。`/skill-update`
  始终强制 fetch。
- 插件 `engines` 与 `skills` 对齐为 Node.js ≥ 22.20；依赖改为 `skills: latest`，npx 回退也不再带
  `@1.7.4`。

### 重构

- **命令判定收敛为一次 `planSkillOperation()`**：`/skill-init`、`/skill-install`、`/skill-update`
  共用同一份 `{ states, pending, freshness, skipReason }`，`run*` 只执行。no-op 路径从「每技能
  3 次 inspect、2 次 hash 比对」降到各 1 次；删除了重复的 `cacheUpToDate` 与三份 lock 来源判断。
- 抽出 `lib/skill-paths.js`（路径）、`lib/text.js`（ANSI/tail）、`lib/proc.js`（子进程 timeout/abort），
  `runCli` / `runGit` / 连通性预检不再各写一套。
- `LOCAL_COMMANDS` 的每条声明改为 `plan` / `label` / `run` 三个函数，handler 不再按命令名 switch，
  也不再 import `jobSkipReason`（兼容层已删除）。
- **回执文案**：无事可做时的「过程」改为「未创建后台任务（短因）」，如「缓存 TTL 内，无需检查上游」，
  不再把回执首行的结论复述一遍。
- **环境变量**：`DSH_COMMANDS_SKILLS_CLI` → `DSH_COMMANDS_SKILL_NPX_SPEC`，
  `DSH_COMMANDS_SKILL_CLI` → `DSH_COMMANDS_SKILL_CLI_OVERRIDE`（旧名保留一个版本 fallback）；
  删除 `DSH_COMMANDS_SKILL_CACHE_CLONE_TIMEOUT_MS` / `..._FETCH_TIMEOUT_MS`。
- `/skill-init` 在软链被真实目录占位时，回执末尾明确提示「会遮蔽 canonical 的托管版本」，而不只是
  「拒绝覆盖」。

### 修复

- **`/skill-init`、`/skill-install` 在 GitHub 443 不通时"回车后没反应"**：克隆前先跑
  `git ls-remote --heads` 连通性预检（默认 8s，`DSH_COMMANDS_SKILL_PROBE_MS` 可调），明确连不上时几秒内失败并
  给出代理/镜像/本地来源提示；认证失败等交给上游 CLI 判断。
- 外层硬超时从 300s 降到 120s；超时回执写「超时（超过 Ns，已强制终止）」，不再显示成容易误读的
  `退出码 SIGKILL`。
- CLI 子进程固定 `GIT_TERMINAL_PROMPT=0`：私有仓缺凭据时快速失败，而不是挂在凭据输入提示上。
- 同一 `DSH_HOME` 同时只允许一个技能安装/更新任务：连按两次回车时第二次直接提示「已有技能安装任务正在进行」，
  不再并行克隆同一个仓库。
- spinner 折叠同时抹掉轮换字形（`◒`/`◐`/`◓`/`◑`…），避免几百帧进度挤掉真正的错误尾行。

### 测试

- 冒烟新增 `/cleanup` 端到端断言：命令注册数 14、无参数时注入第 0 步的「编号选项 / 不要执行任何脚本」、
  不带通用默认措辞、带参数时原样透传范围并提示勾选编码；技能自举覆盖三个依赖技能（80 余项）。
- 冒烟新增连通性预检 URL 归一化、并发拒绝、硬超时措辞与锁释放、轮换字形 spinner 等断言。
- 新增 `scripts/smoke-skill-cache.mjs`（24 项，离线）：cache clone/TTL/refresh/离线模式/fetch 失败回退、
  `--json` 解析、lock 来源/git tree hash 回写、`cacheStatus` 与 `cachedSkillHash`。另用真实 ai-kit 验证首次 8.0s、缓存修复 1.0s、
  补装 1.3s、update 4.7s，以及插件安装后 `npx skills update handoff -g -y` 返回 up to date。

## [v0.1.12] - 2026-10-22

### Docs

- split README into topic docs and harden skill error output (#8)

**Full Changelog**: https://github.com/morehao/dsh-commands/compare/v0.1.11...v0.1.12

## 0.1.11

### 修复

- **"看不到输出"的三条体验问题**（0.1.10 真机复现：`/skill-init` 在已托管环境下 3ms 就结束，头部闪一个
  零输出的空作业行，展开面板一片空白，看起来像命令没跑）：
  - 阶段文案现在**同时写进作业输出**（`log` 通道，只给观察者）：即使本次一步实事没干，展开面板也有可读的
    执行流水，而不是空白。
  - 回执首行改结论式：什么都没发生时是 `✓ 无需操作：git-kit、handoff 均已托管 · 0.0s`，否则仍是
    `技能依赖检查 · …`；`/skill-install` 同理（`✓ 无需操作：<来源> 的 N 个技能均已托管`）。
  - `/skill-init`、`/skill-update` 在**无事可做时不建后台任务**（新增 `jobSkipReason()`），避免会话头部
    闪一个零输出的空作业行；回执末行写明理由：`过程：…没有需要安装或修复的技能，未创建后台任务`。
- 作业面板里的 CLI 输出**先去 ANSI 再旁路**：面板是纯文本终端，不去色会把 `[38;5;250m` 之类转义码原样显示。

### 测试

- 真机验证（真实 `npx`、真实 `morehao/ai-kit`，临时 HOME 隔离）：`/skill-install morehao/ai-kit` 9 条阶段
  文案 + 53 段流式输出 + 6 行回执；`/skill-update git-kit` 42 段输出；`/skill-init` 走"无需操作"分支且
  不建作业；失败路径（npm cache EPERM）在面板里给完整 stderr、卡片给剥框线的错误 + 作业 id。
- 冒烟新增 4 项断言（结论式首行、阶段文案进 log 通道、无事可做不建作业），共 **55** 项全绿。

## 0.1.10

### 新增

- **过程可见**：`/skill-init`、`/skill-install`、`/skill-update` 的长任务改挂 dsh 后台任务
  （`ctx.jobs`；base 组合已含 `dsh-jobs-local` + `dsh-tool-jobs`）——会话头部的作业行实时显示阶段
  （`检查依赖技能 → 安装 git-kit → 链入 dsh → 校验契约`），展开面板里是 `npx skills` 的流式输出，
  行上可两击停止。命令 handler 自己 `wait()` 收掉结算（`awaited`），所以**不投完成通知、不触发模型回合、
  不耗 token**。新增 `lib/job-progress.js`（`runInJob` / `NO_REPORTER`）封装这层适配，`skill-setup.js`
  的三个 `run*` 只认 `reporter.progress/write`。
- 命令结果末尾追加一行「过程：作业 `<id>`（会话头部「作业」可展开看完整输出，进行中可两击停止）」。

### 变更

- 回执整形：命令卡片不再塞 CLI 的原始输出（clack 的 `│ … │` / `Done!  Review skills` / 分隔线），
  完整内容留在作业面板；头部改为「技能依赖检查 · git-kit、handoff · 10.4s」形式并带耗时；
  新装符号由 `+` 统一为 `✓`；失败回执的尾部输出同样剥掉框线与分隔线。
- 过程**只能**落在后台任务里：命令面本身没有进度通道（`@deepseek-ai/dsh-commands` 的 `execute()`
  只 append `command/run` 与 `command/done`，UI 卡片运行期只能渲染「执行中…」）。`ctx.jobs` 缺失、
  无控制器（未加载 `dsh-tool-jobs`）、并发上限或 owner 无活 agent 时自动**退回**原来的
  「转圈 → 一次性回执」，语义不变；`apply` 不把 `jobs` 加进 `inject`，无 jobs 的组合照常加载。

### 测试

- `scripts/smoke-skill-setup.mjs` 增加"过程可见"断言组（假 jobs 注册表）：只启动一个作业、
  kind/owner/label 透传、阶段文案刷新、CLI 输出流入面板、结算前已 `wait`（awaited）、结果带回作业视图、
  回执不含 CLI 原文、作业被停止返回 killed、取消只 kill 作业、jobs 缺失降级、无控制器降级、失败回执剥框线，
  以及 `apply()` 注册的 handler 端到端跑通（13 条命令 + 回执带作业 id）；共 51 项全绿。
- `.github/workflows/check.yml` 增加 `node --check lib/job-progress.js`。

## 0.1.9

### 新增

- `/skill-init`：检查 `COMMANDS` 依赖的技能（`git-kit`、`handoff`），缺失则用 `npx skills` 全局安装
  （`add morehao/ai-kit --skill … -g -a universal -y`）并软链进 `$DSH_HOME/skills`；已由 skills CLI 托管的
  跳过；存在但来自别处（如指向本地 ai-kit clone 的软链）则**替换**为托管软链——只删旧链接本身，
  不做备份、不动链接目标；同名真实目录/文件一律拒绝覆盖并提示用户自行移走。末尾按 `COMMANDS`
  的分支契约逐条校验。
- `/skill-install <来源> [技能名...]`：安装**任意来源**的技能（不限本插件依赖），同样走
  `npx skills add … -g -a universal -y` 并把结果软链进 `$DSH_HOME/skills`。装完用三路并集决定给谁建链：
  显式技能名、canonical 目录安装前后差集、lock 里 source 匹配的技能（`owner/repo` / URL / 本地路径
  都做了来源归一化）。真实目录同样拒绝覆盖。
- `/skill-update`：把依赖技能（或指定子集）幂等重装到上游最新并校验软链仍可解析。不调 `skills update`
  —— 它内部 spawn 的 `add` 不带 `-a`，会把链接撒到其它 agent 目录，未检测到 agent 时甚至装到全部 agent。
- `lib/skill-setup.js`：依赖推导、状态判定（missing / managed / unmanaged / broken）、npx 解析
  （PATH + 登录 shell 反查）、软链替换（真实目录拒绝）、契约校验。`lib/index.js` 新增 `LOCAL_COMMANDS` 与
  `REQUIRED_SKILLS` 导出（`COMMANDS` 与 `apply` 对既有命令行为不变）。
- `scripts/smoke-skill-setup.mjs` + CI 步骤：「技能自举冒烟」，用 `DSH_COMMANDS_SKILL_CLI` 指定的 stub
  顶替 `npx skills`，在临时 HOME 里覆盖安装/跳过/软链替换/真实目录拒绝/任意来源安装/更新六条路径，不联网。

### 变更

- README「安装」：安装技能从"手工 clone + ln"改为推荐 `/skill-init`（手工方式保留为离线/自管场景），
  并补充技能托管链路、"只替换软链、真实目录拒绝覆盖"的覆盖策略与 `-a universal` 等不可改的上游约束。
- 对齐 ai-kit `git-kit` 的 release 流程（ai-kit #41 / #43）：`/git-release` 的描述改为「打 tag → 默认建平台
  Release → 按仓库探测跟踪后效（流水 / 产物）并出校验回执」，并补 `hint: "[版本号或tag]"`（原先无参数提示，
  看不出可带版本）；`locale` 里的「发版验证」改为「发版（打 tag、建平台 Release、校验后效）」。
- README「发布（自动）」补 `/git-release` 推荐路径：本仓 CI 只发 npm、不建 Release，Release 由该流程默认补建，
  只打标签用 `/git-tag`；命令表同步 `/git-release` 的新参数。
- PUBLISHING「日常发新版」：`STATE` 词表更新为 `READY / TAGGED / NEEDS_TARGET / BLOCKED`（`NEEDS_TAG` 已在
  ai-kit #43 改名，含义是「先定目标版本」而非向用户要 tag），补版本源「读仓库判定 + `--version-file` 回查」
  与产物校验（`--npm-pkg` / `--probe-url`），并把命令名统一为本仓的 `/git-release`、`/git-commit-push` 等。

## 0.1.8

### 变更

- 包源码迁至独立仓 `morehao/dsh-commands`：仓库根即包根（不再有 `commands-dsh/` 目录），发布链
  （`release.yml` + `scripts/ci-publish.sh`）随之迁移，npm 包名与模块标识符不变，已装用户无感。
- 插件页标题去掉仓名：`ai-kit 命令 (dsh-commands)` → `dsh 命令集 (dsh-commands)`，
  `ai-kit Commands (dsh-commands)` → `DSH Commands (dsh-commands)`；`description` 改为描述插件本身，
  末尾注明技能由 ai-kit 仓提供。仅展示名变化，`package.json.name` / `cordis.patch.yml` 模块标识符 /
  插件导出名一律不变。

### 新增

- `scripts/check-skill-contract.mjs`：跨仓契约校验（`COMMANDS` 里每条命令的 `skill`/`branch` 是否在
  `$DSH_HOME/skills` 中真实存在），把「技能改分支名 → 命令静默失效」变成可执行的失败。
- `lib/index.js` 导出 `COMMANDS`（纯增量，`apply` 行为不变），供契约校验使用。
- 最小 CI `.github/workflows/check.yml`：发布脚本语法、插件语法、包名/模块标识符/插件名三处一致、
  打包内容白名单。

### 修复

- 无（本版无功能变更，仅迁仓与元信息中性化）。
