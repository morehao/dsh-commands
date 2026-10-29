# 技能依赖自举

> **v1.0 变更（2026-10-29）**：技能安装 / 更新已改为消费 `@morehao/dsh-skills-console` 的包 API，
> **不再使用 `skills` CLI、不再维护 git 缓存、不再往 `~/.dsh/skills` 建可见性链**。流程变为
> resolve-api → observe（`api.list` + canonical 文件存在性）→ adopt → plan → confirm →
> apply（`api.install` / `api.update`）→ verify。本文下面仍保留部分 v0.x 的历史描述（CLI /
> 软链 / 缓存）；**以本注记与 [CHANGELOG](../CHANGELOG.md#v100---2026-10-29) 为准**，
> 待后续整篇重写。

`/skill-init` 是**维护型委托**：命令本身只解析参数、注入一条 user 消息，由 agent 调用 `skill_init` 工具；工具内部完成 resolve-api → observe → adopt → plan → confirm → apply → verify。一个命令两个模式：

- `/skill-init`：检查并按需安装/修复插件依赖的技能；
- `/skill-init --update [技能名...]`：强制更新到上游最新（显式更新，不弹确认）。

**任意来源的技能安装不在命令面**：dsh 会扫描 canonical `~/.agents/skills`，所以 `npx -y skills add <来源> --skill <名称> -g -a universal -y` 就够了，交给用户或 agent 直接执行（见 [额外技能](#额外技能不再由插件安装)）。插件只负责自己依赖的 `git-kit`、`handoff`、`disk-cleanup`。

- 实现：`lib/skill-command.ts`（命令 flags / 注入 / 回退）、`lib/tool-skill-init.ts`（工具 execute / 结果）、`lib/skill-confirm.ts`（确认）、`lib/console-api.ts`（解析并校验 `@morehao/dsh-skills-console/api` + 旧 console 版本守卫）、`lib/skill-setup.ts`（observe / plan / apply / verify，经包 API 安装/更新）、`lib/skill-paths.ts`（路径与技能根顺序）；长任务包装在 `lib/job-progress.ts`，进度/停止由 dsh 原生作业 UI 提供（见 [过程可见](./job-progress.md)）。
- 工具与回退共用一次 `planOperation()`：本地判定「要不要建作业 / 处理哪些技能 / 是否已最新」，`applyPlan` 只负责执行。同一条规则只有一处实现。
- 无 `tools`、无 `agent.followup` 或注入失败时，命令回退到 `runSkillInit` / `runSkillUpdate`（本地执行，语义相同，但没有确认卡与工具结果）。
- 依赖集合仍从 `COMMANDS` 推导（`skill ?? "git-kit"` 去重，导出为 `REQUIRED_SKILLS`），新增委托型命令后自动跟进。
- 委托型命令执行前会先查依赖技能是否在 `skillRoots()` 给出的三个根：`$DSH_HOME/skills` → `$DSH_AGENTS_HOME/skills` → 本源 `~/.agents/skills`；缺失时不注入消息，直接返回 `/skill-init` 与手工 `npx` 两条修复路径。

## 与 agent-skills 的发布链同向

agent-skills 自 2026-10-23（#50）起把模型定为「本源 + 分发软链」：

```
agent-skills 仓（编辑源）
  │ ./scripts/skills-install.sh（skills CLI 安装）
  ▼
本源 ~/.agents/skills（真实内容）
  │ ./scripts/skills-fanout.sh
  ▼
~/.config/opencode/skills/*、$DSH_HOME/skills/*（只放软链）
```

本插件的 `/skill-init` 做的是同一件事（只是只针对它依赖的三个技能）：用 `skills add -g -a universal` 把内容装到本源，再建 `$DSH_HOME/skills/<name>` → 本源的软链。两边共用 skills CLI 与 `.skill-lock.json`，所以：

- 已经跑过上游两个脚本的机器，`/skill-init` 会判定为已托管并跳过，不会覆盖或重装；
- 只跑过 `skills-install.sh`、还没 fanout 的机器，dsh 仍能直接扫本源，命令可用；`/skill-init` 会把软链层补成托管（有写盘时先确认）；
- 反过来，`/skill-init` 装好的技能，上游 `skills-fanout.sh` 也认（软链目标同样是本源），不会重复；
- 契约校验（`scripts/check-skill-contract.mjs`）与运行期预检共用这份根顺序，不会再因为「没有软链层」误报技能缺失。

## 执行前确认与结果

`skill_init` 在 plan 判定有可执行变更（install/relink）时，通过 dsh 的 `ctx.userQuestions` 弹一次确认；问题、选项和说明按本次 plan 生成：

- 有缺失技能时给「处理全部 / 只补缺失」；只有上游更新时给「处理全部」。选「只补缺失」只处理 `state=missing` 的条目，已有条目不动。
- **问不问只由「是否确定要写盘」决定**：上游更新只警告、不写盘也不提问；缓存过期需要联网检查时同样不提问（只读，直接做，结果里报告结论）。
- 取消 → `status:"cancelled"`，零写、不建作业；
- 真实目录/文件会跳过链入、不会删除，但来源仍会装到 canonical，所以同样会确认；确认卡会写明这一点；
- `yes=true`（`--yes`）完全跳过确认，适合脚本/自动化，但不跳过所有权/真实目录/写前指纹检查；
- 没有问答 UI、没有活 agent、或确认通道异常 → 返回 `status:"plan"`，零写（不再降级直接执行）；
- `--update` 是用户显式要求更新，不弹确认。

结果由工具返回，不再发「执行报告」：

- `status`：`ok` / `changed` / `attention` / `blocked` / `cancelled` / `error` / `plan`；
- `markdown` 首行是结论（`✓ 无变更` / `✅ 已完成：N 项变更` / `✅ 已更新：…` / `ℹ 无变更，上游有 N 项更新` / `⚠ 已完成，但有 N 项需处理` / `⚠ 已安装，但上游检查失败` / `⛔`），随后是逐项动作、契约/验证、下一步；
- 结果同时带结构化 `actions` / `contract` / `verification` / `warnings` / `next`，供 agent 或上层展示；
- agent 按注入消息的汇报约束用 1–3 句话总结，不复述工具回执；
- 作业行/面板/停止由 dsh 原生 UI 提供；本插件不再有命令卡/toast/未读点，也不再有 `客户端：…` 行。

## 软链的作用（以及为什么不是加载必需）

dsh **不从 `node_modules` 扫描技能**。它默认扫描项目与用户技能根：用户侧是 `$DSH_HOME/skills`（rank 400，默认 `~/.dsh/skills`）与本源 `~/.agents/skills`（rank 500）。`skills add -g -a universal` 写的正是后者，所以**仅为了让 dsh 看见，软链不是必需的**；额外技能也不需要软链。

本插件仍为依赖技能建 `~/.dsh/skills/<name>` → `~/.agents/skills/<name>` 的软链，原因有三：

1. rank 400 优先于本源的 500，同名旧副本不会抢先；
2. 用 `target === 本源` 判定「托管 / 非托管」，才能安全地修复软链、拒绝覆盖真实目录；
3. dsh 自定义 `$DSH_AGENTS_HOME` 时，`$DSH_HOME/skills` 仍是稳定入口。

> 这正是「软链层是否退役」的前提；在迁移与遮蔽检查就位前不要删。上游 `skills-fanout.sh` 建的是同方向、同目标的软链，两边可以共存。

官方 `skills` CLI（vercel-labs/skills）支持 80+ agent，但不认识 dsh 的 `$DSH_HOME`：它只能把技能取到本源 `~/.agents/skills`（上游 `skills-install.sh` 也发布到这里）。dsh 也会扫这个根，但本插件仍建链，以保留上面的优先级与托管判定。实际链路：

```
skills add <本地缓存> --skill <缺的> -g -a universal -y --json
   ├─ 首次：git clone --depth 1 <来源> → $DSH_HOME/cache/skills-sources/<hash>
   ├─ 之后：git fetch --depth 1（默认 10 分钟内直接跳过网络）
   └─ ~/.agents/skills/<name>            # 本源的拷贝 + lock 记录
        ↑ 软链（本插件创建；上游 skills-fanout.sh 建同样的链）
   ~/.dsh/skills/<name>                  # dsh 扫描的技能根
```

## 本地缓存：为什么快

旧实现每次命令都执行：

```
npx -y skills add morehao/agent-skills …
   ├─ npx 解析/启动：热缓存约 2–3s
   └─ git clone 整个 agent-skills：约 5–10s（网络差时 75s 起）
```

现在拆成两层：

1. **CLI 不再每次走 npx**：`skills` 是插件的依赖，直接 `node <skills>/bin/cli.mjs`；只有依赖缺失（源码目录没装依赖）时才回退 `npx -y skills`。
2. **来源只 clone 一次**：缓存到 `$DSH_HOME/cache/skills-sources/<url-hash>`，后续 `git fetch --depth 1` 增量更新；TTL 内连 fetch 都跳过。安装时把**本地缓存目录**交给 `skills add`，CLI 只做文件拷贝。

实测（本机、GitHub 正常、agent-skills 约 1.7 MB）：

| 场景 | 旧链路 | 新链路 |
|---|---|---|
| 首次 `/skill-init` | 22.9s | 约 8s（预检 + 首次 clone + 安装） |
| 已缓存后补装一个技能 | 10–30s | 约 1.3s |
| 已缓存后修复软链 | 10–30s | 约 1.0s |
| `/skill-init --update`（强制 fetch） | 10–30s | 约 4.5–5s |
| 已托管但 TTL 过期（检查上游） | 10–30s | 约 4–5s；有更新只报告，不重装 |

> 数值随网络/机器变化，但量级差异来自「不再整仓 clone + 不再每次 npx 启动」。

**已安装 ≠ 已最新**：`/skill-init` 会先比对 lock 的 `skillFolderHash` 与本地缓存的 git tree hash。TTL 内且一致 → 返回「✓ 无变更」，不访问网络；TTL 过期 → fetch 上游，**更新的只报告**（首行 `ℹ 无变更，上游有 N 项更新`，并给出 `--update` 指引），不写盘。要真正更新用 `--update`：永远强制 fetch，不受 TTL 影响。

缓存细节：

- 路径：`$DSH_HOME/cache/skills-sources/<sha256(url) 前 16 位>`；`<hash>.meta.json` 记录 URL、commit、fetch 时间。
- TTL：`DSH_COMMANDS_SKILL_CACHE_TTL_MS`，默认 `600000`（10 分钟）。`0` = 每次都 fetch；`<0` = 离线模式，有缓存就不 fetch。
- 超时：缓存 git 操作由外层 `DSH_COMMANDS_SKILL_TIMEOUT_MS` 派生——clone 为 `min(60s, max(30s, outer-30s))`，fetch 为 `min(20s, max(5s, outer/4))`；不再单独提供两个环境变量。
- 删除缓存即可强制重建：`rm -rf "$DSH_HOME/cache/skills-sources"`。
- 首次 clone 仍做一次 8s 连通性预检；有缓存后不再预检，fetch 失败时 `/skill-init` 会继续用旧缓存并在回执里标「离线，未确认上游」；`--update` 则明确失败，不假装更新成功。

### 为什么要把 lock 来源回写

`skills add <本地路径>` 会把 `.skill-lock.json` 的 `source` 写成缓存路径、`sourceType: "local"`。其他 agent 再执行 `npx skills update` 时会把它当成本地技能，无法按仓更新。

所以安装完成后，插件把每个技能的 lock 条目回写为远端身份：

```json
{
  "source": "morehao/agent-skills",
  "sourceType": "github",
  "sourceUrl": "https://github.com/morehao/agent-skills.git",
  "skillPath": "skills/handoff/SKILL.md",
  "skillFolderHash": "<git tree hash>"
}
```

`skillFolderHash` 用 `git rev-parse HEAD:<skill dir>` 计算，与上游远端安装写出的 40 位 hash 一致。实测在插件安装后直接跑 `npx skills update handoff -g -y` 会返回 `All global skills are up to date`，说明其他 agent 可以无缝接手。

### 为什么 canonical 固定 `~/.agents/skills`

`skills` CLI 的 universal 全局落点硬编码为 `homedir()/.agents/skills`（上游 `getCanonicalSkillsDir()`），不认识 `$DSH_AGENTS_HOME`。如果插件把 canonical 改成 `$DSH_AGENTS_HOME/skills`，CLI 仍会写到 `~/.agents`，结果是什么都找不到。

因此：canonical 固定 `~/.agents/skills`；dsh 自定义 `$DSH_AGENTS_HOME` 时，靠 `$DSH_HOME/skills` 的软链桥接。简化时不要把这两者合并。

## 上游约束（由实现决定，改动前请重读）

- **`-a universal` 必须显式给**：不带 `-a` 且没检测到任何 agent 时，`-y` 会把技能装到**全部** agent 目录。`skills update` 内部正是这么 spawn 的，所以 `--update` 也用 `add` 而不是 `update`。
- **`-a universal -g` 直接落 canonical**：上游对 universal + global 有特例，不会再额外建 `~/.config/agents/skills` 链接。
- **`add` 只有拷贝语义**（`link` 模式仅 `experimental_sync` 用），canonical 是拷贝：改本地 agent-skills clone 不会自动生效，要 `/skill-init --update`。
- **只替换软链，不做备份、不删真实目录**：覆盖旧条目时只 `unlink` 旧**软链**（含悬空软链）——链接指向的目录（你的本地 agent-skills clone）一字不动，要回滚再 `ln -s` 一次即可；遇到同名**真实目录/文件**则直接报错让你自行移走，避免任何不可回滚的删除。也正因为如此，`skills/` 里不能再出现 `xxx.bak-<时间>` 这种目录：它含 `SKILL.md`，会被当成同名技能扫到。
- dsh 同层同名技能按根 rank 取小者（`$DSH_HOME/skills`=400 胜 `~/.agents/skills`=500），软链与 canonical 并存不会产生重复技能；技能根有 watcher，装完免重启。
- 任意来源的额外技能不经过本插件，因此不需要软链、也不需要四路并集判断；一条 `npx skills add` 即可。

## 环境与限制

- **Node.js ≥ 22.20**（`skills` 包与插件 `engines` 现在一致）。
- **网络**：首次需要能访问来源仓库；TTL 内不再联网，TTL 过期会 fetch 检查上游，`--update` 强制 fetch。GitHub 443 不通时首次 clone 前的 `git ls-remote --heads` 预检默认 8s 失败（`DSH_COMMANDS_SKILL_PROBE_MS` 可调，设 0 关闭；本地路径来源不预检），并给代理/镜像提示。
- **来源**：默认 `morehao/agent-skills`；`DSH_COMMANDS_SKILL_SOURCE` 可换成可达镜像或本地目录。
- **CLI 版本**：依赖 `skills`（`package.json` 用 `latest`，安装时取最新），默认直接调用；显式设置 `DSH_COMMANDS_SKILL_NPX_SPEC`（如 `skills`）会改走 npx 指定版本。`DSH_COMMANDS_SKILL_CLI_OVERRIDE` 可完全替换命令本体（视为可执行文件 + 固定前缀，用于测试桩或自定义安装方式；此时跳过缓存、预检与 `--json`）。
  - 旧名 `DSH_COMMANDS_SKILLS_CLI` / `DSH_COMMANDS_SKILL_CLI` 仍作为 fallback 读取一个版本，但已 deprecated：它们只差一个字母，极易配错。
- **超时**：外层硬超时 `DSH_COMMANDS_SKILL_TIMEOUT_MS`（默认 120s）；CLI 自己的克隆超时 `SKILLS_CLONE_TIMEOUT_MS` 会被压到早 30s。缓存 git 操作由外层派生（见上）。超时的回执直接写「超时（超过 Ns，已强制终止）」，不再显示成 `退出码 SIGKILL`。
- **非交互凭据**：CLI 与缓存 git 子进程固定 `GIT_TERMINAL_PROMPT=0`，并设 `GIT_HTTP_LOW_SPEED_LIMIT=1000` / `GIT_HTTP_LOW_SPEED_TIME=10`，私有仓缺凭据或网络黑洞时会快速失败而不是卡住。
- **并发**：同一 `DSH_HOME` 同时只允许一个技能初始化/更新任务。连按两次回车时，第二次直接提示「已有技能更新任务正在进行」，不会并行 clone 同一个仓库。
- **npx 回退定位**：依赖缺失时 PATH 找不到 npx 会用登录 shell 反查（GUI 启动的宿主可能缺 per-shell 路径）；仍找不到则报错并给出手工命令。

## `/skill-init`

只装插件依赖的三个技能（`git-kit`、`handoff`、`disk-cleanup`）。

| 现状 | 行为 |
|---|---|
| `~/.dsh/skills` 里没有 | 从缓存安装 `git-kit`、`handoff`、`disk-cleanup` → 软链 `~/.dsh/skills/*` → `~/.agents/skills/*` |
| 已手工 `git clone agent-skills && ln -s` | 判定为「非托管软链」→ **替换**软链，clone 目录不动 |
| 已经是托管软链 | 缓存 TTL 内且 hash 一致 → 跳过；TTL 过期 → 检查上游，**发现更新只报告不重装**（写盘要 `--update`） |
| 选了「只补缺失」 | 只装 `state=missing` 的条目，已有条目不动（远端缓存仍可能 fetch 以拿到缺失技能） |
| 同名位置是真实目录 | 该技能报「拒绝覆盖」，其余照常；回执末尾提示它会遮蔽 canonical 的托管版本 |

顺带校验分支契约（`git-kit` 的 9 个分支文件、`disk-cleanup` 的 `cleanup` 分支；`handoff` 是单分支，只校验 `SKILL.md`），技能根按 `skillRoots()` 解析（`$DSH_HOME/skills` → `$DSH_AGENTS_HOME/skills` → 本源），**只有本源、没有软链层时也能通过**；结束提示「无需重启 dsh」。

确定要写盘（安装/替换软链、真实目录仍需装 canonical）时工具先弹一次确认，取消则什么都不做；有缺失时可以选「只补缺失」走最短路径。`/skill-init --yes` 跳过确认。缓存过期只触发只读检查，不弹确认、也不写盘。

缓存 TTL 内确认最新、或测试桩/本地路径下已托管时，不会创建后台任务，结果首行直接给结论；TTL 过期会建作业检查上游，见 [过程可见](./job-progress.md)。

已托管但缓存缺失/上游暂时不可达时，`/skill-init` 会尽量补链并返回「已安装；上游检查失败」而不是把已装好的环境判失败；`--update` 仍要求 fetch 成功，不拿旧缓存冒充更新。

### `--update`

把插件依赖的技能更新到上游最新并校验软链仍可解析；未托管/缺失条目只提示、不动。

```bash
/skill-init --update            # 更新 git-kit + handoff + disk-cleanup
/skill-init --update git-kit    # 只更新一个
```

更新流程：强制 `git fetch --depth 1` 刷新缓存 → 从缓存 `skills add` → 回写 lock → 校验软链。fetch 失败时命令明确失败（不拿旧缓存冒充更新）；普通 init 则允许旧缓存并在回执里标注离线。`--update` 是用户显式要求更新，不弹确认；`--yes` 对它没有额外作用。

候选集只来自 `COMMANDS` 的依赖（`git-kit`、`handoff`、`disk-cleanup`），`/skill-init --update svg-maker` 会报「未知技能」。额外技能用下面的 `npx` 方式更新。

## 额外技能（不再由插件安装）

[`morehao/agent-skills`](https://github.com/morehao/agent-skills) 现提供 7 个技能：`git-kit`、`handoff`、`disk-cleanup`（插件依赖，由 `/skill-init` 管）与 `project-insight`、`project-wiki`、`svg-maker`、`tech-design`（按需手工安装）。

```bash
npx -y skills add morehao/agent-skills --skill tech-design -g -a universal -y
npx -y skills add morehao/agent-skills --skill project-insight project-wiki svg-maker -g -a universal -y
```

| 想要的能力 | 命令 |
|---|---|
| 写技术方案 / 设计文档 | `npx -y skills add morehao/agent-skills --skill tech-design -g -a universal -y` |
| 解读开源项目（带源码行号引用） | `npx -y skills add morehao/agent-skills --skill project-insight -g -a universal -y` |
| 给项目生成可读 Wiki | `npx -y skills add morehao/agent-skills --skill project-wiki -g -a universal -y` |
| 生成独立 SVG 架构图 | `npx -y skills add morehao/agent-skills --skill svg-maker -g -a universal -y` |

装完即可用，无需重启（dsh 扫描 `~/.agents/skills`，不依赖插件软链）。更新同样用 `npx -y skills add …`（或 `npx skills update <名称> -g -y`）。

## 典型组合

```bash
# ① 新机器一次配齐（首次 clone，之后走缓存）
/skill-init
npx -y skills add morehao/agent-skills --skill project-insight project-wiki svg-maker tech-design -g -a universal -y

# ② agent-skills 发新版后：插件依赖强制走 --update，额外技能用 npx 重装
/skill-init --update
npx -y skills add morehao/agent-skills --skill project-insight project-wiki svg-maker tech-design -g -a universal -y

# ③ 边改 agent-skills 边用：想保持改完立刻生效就别跑 /skill-init（手工 ln -s 到 clone）；
#    已切成托管链路后想恢复本地编辑，只换链接、不动文件：
ln -sfn ~/practice/ai/agent-skills/skills/git-kit ~/.dsh/skills/git-kit
```

> `/skill-init` 自 **v0.1.9** 起提供，运行期的作业行 / 流式输出自 **v0.1.10** 起提供；**v0.2.0** 起 `/skill-install` 删除、`/skill-update` 并入 `/skill-init --update`，任意来源安装改走 `npx skills add`。

## 手工准备（不想让插件动 home）

技能由 [`morehao/agent-skills`](https://github.com/morehao/agent-skills) 提供，可以自己 clone 并软链：

```bash
git clone https://github.com/morehao/agent-skills.git
mkdir -p "$HOME/.dsh/skills" && ln -s "$PWD/agent-skills/skills"/* "$HOME/.dsh/skills/"
```

手工软链指向你的本地 clone（改本地文件即时生效），但不归 `skills` CLI 托管，`/skill-init --update` 不会更新它；下次跑 `/skill-init` 会把它**替换**成托管软链——只删那条链接，你的 clone 一个字节都不动，想恢复再 `ln -s` 一次即可。
