# 技能依赖自举

`/skill-init`、`/skill-install`、`/skill-update` 不是「意图表」：它们要判断文件状态、建软链、拉上游，结果必须确定，所以直接在 handler 内执行，不交给 agent。

- 实现：`lib/skill-setup.js`（检查 / 安装 / 软链 / 校验）、`lib/skill-cache.js`（来源缓存 / lock 回写）；长任务的过程包装在 `lib/job-progress.js`（见 [过程可见](./job-progress.md)）。
- 依赖集合仍从 `COMMANDS` 推导（`skill ?? "git-kit"` 去重，导出为 `REQUIRED_SKILLS`），新增委托型命令后自动跟进。

## 为什么需要软链

dsh **不从 `node_modules` 扫描技能**，技能必须落在 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）下才会进入模型目录。

官方 `skills` CLI（vercel-labs/skills）支持 80+ agent，但**没有 dsh**：它只能把技能取到自己的 canonical 目录，放进 dsh 技能根必须由插件建软链。实际链路：

```
skills add <本地缓存> --skill <缺的> -g -a universal -y --json
   ├─ 首次：git clone --depth 1 <来源> → $DSH_HOME/cache/skills-sources/<hash>
   ├─ 之后：git fetch --depth 1（默认 10 分钟内直接跳过网络）
   └─ ~/.agents/skills/<name>            # CLI 的 canonical 拷贝 + lock 记录
        ↑ 软链（本插件创建）
   ~/.dsh/skills/<name>                  # dsh 扫描的技能根
```

## 本地缓存：为什么快

旧实现每次 `/skill-init`、`/skill-install`、`/skill-update` 都执行：

```
npx -y skills add morehao/ai-kit …
   ├─ npx 解析/启动：热缓存约 2–3s
   └─ git clone 整个 ai-kit：约 5–10s（网络差时 75s 起）
```

现在拆成两层：

1. **CLI 不再每次走 npx**：`skills` 是插件的依赖，直接 `node <skills>/bin/cli.mjs`；只有依赖缺失（源码目录没装依赖）时才回退 `npx -y skills`。
2. **来源只 clone 一次**：缓存到 `$DSH_HOME/cache/skills-sources/<url-hash>`，后续 `git fetch --depth 1` 增量更新；TTL 内连 fetch 都跳过。安装时把**本地缓存目录**交给 `skills add`，CLI 只做文件拷贝。

实测（本机、GitHub 正常、ai-kit 约 1.7 MB）：

| 场景 | 旧链路 | 新链路 |
|---|---|---|
| 首次 `/skill-init` | 22.9s | 约 8s（预检 + 首次 clone + 安装） |
| 已缓存后补装一个技能 | 10–30s | 约 1.3s |
| 已缓存后修复软链 | 10–30s | 约 1.0s |
| `/skill-update`（强制 fetch） | 10–30s | 约 4.5–5s |
| 已托管的显式 `/skill-install`（TTL 内 + lock hash 一致） | 10–30s | 约 0.3–0.8s（只本地比对 hash） |
| 已托管但 TTL 过期（检查上游） | 10–30s | 约 4–5s；无变化不重装 |

> 数值随网络/机器变化，但量级差异来自「不再整仓 clone + 不再每次 npx 启动」。

**已安装 ≠ 已最新**：`/skill-init`、`/skill-install` 会先比对 lock 的 `skillFolderHash` 与本地缓存的 git tree hash。TTL 内且一致 → 返回「已是最新」，不访问网络；TTL 过期 → fetch 上游，只有 hash 变化才重装。`/skill-update` 永远强制 fetch，不受 TTL 影响。

缓存细节：

- 路径：`$DSH_HOME/cache/skills-sources/<sha256(url) 前 16 位>`；`<hash>.meta.json` 记录 URL、commit、fetch 时间。
- TTL：`DSH_COMMANDS_SKILL_CACHE_TTL_MS`，默认 `600000`（10 分钟）。`0` = 每次都 fetch（适合要求「每次 install 都查上游」）；`<0` = 离线模式，有缓存就不 fetch。
- 超时：clone `DSH_COMMANDS_SKILL_CACHE_CLONE_TIMEOUT_MS`（默认 60s），fetch `DSH_COMMANDS_SKILL_CACHE_FETCH_TIMEOUT_MS`（默认 20s）。
- 删除缓存即可强制重建：`rm -rf "$DSH_HOME/cache/skills-sources"`。
- 首次 clone 仍做一次 8s 连通性预检；有缓存后不再预检，fetch 失败时安装类命令会继续用旧缓存并在回执里标「离线，未确认上游」；`/skill-update` 则明确失败，不假装更新成功。

### 为什么要把 lock 来源回写

`skills add <本地路径>` 会把 `.skill-lock.json` 的 `source` 写成缓存路径、`sourceType: "local"`。其他 agent 再执行 `npx skills update` 时会把它当成本地技能，无法按仓更新。

所以安装完成后，插件把每个技能的 lock 条目回写为远端身份：

```json
{
  "source": "morehao/ai-kit",
  "sourceType": "github",
  "sourceUrl": "https://github.com/morehao/ai-kit.git",
  "skillPath": "skills/handoff/SKILL.md",
  "skillFolderHash": "<git tree hash>"
}
```

`skillFolderHash` 用 `git rev-parse HEAD:<skill dir>` 计算，与上游远端安装写出的 40 位 hash 一致。实测在插件安装后直接跑 `npx skills update handoff -g -y` 会返回 `All global skills are up to date`，说明其他 agent 可以无缝接手。

## 上游约束（由实现决定，改动前请重读）

- **`-a universal` 必须显式给**：不带 `-a` 且没检测到任何 agent 时，`-y` 会把技能装到**全部** agent 目录。`skills update` 内部正是这么 spawn 的，所以 `/skill-update` 也用 `add` 而不是 `update`。
- **`-a universal -g` 直接落 canonical**：上游对 universal + global 有特例，不会再额外建 `~/.config/agents/skills` 链接。
- **`add` 只有拷贝语义**（`link` 模式仅 `experimental_sync` 用），canonical 是拷贝：改本地 ai-kit clone 不会自动生效，要 `/skill-update`。
- **只替换软链，不做备份、不删真实目录**：覆盖旧条目时只 `unlink` 旧**软链**（含悬空软链）——链接指向的目录（你的本地 ai-kit clone）一字不动，要回滚再 `ln -s` 一次即可；遇到同名**真实目录/文件**则直接报错让你自行移走，避免任何不可回滚的删除。也正因为如此，`skills/` 里不能再出现 `xxx.bak-<时间>` 这种目录：它含 `SKILL.md`，会被当成同名技能扫到。
- dsh 同层同名技能按根 rank 取小者（`$DSH_HOME/skills`=400 胜 `~/.agents/skills`=500），软链与 canonical 并存不会产生重复技能；技能根有 watcher，装完免重启。
- `/skill-install` 不限于插件依赖：装完靠四路取并集决定给谁建软链——用户显式写的技能名、安装前后 canonical 目录的差集、lock 里 source 匹配的技能、`skills add --json` 返回的技能。

## 环境与限制

- **Node.js ≥ 22.20**（`skills` 包与插件 `engines` 现在一致）。
- **网络**：首次需要能访问来源仓库；TTL 内安装不再联网，TTL 过期会 fetch 检查上游，`/skill-update` 强制 fetch。GitHub 443 不通时首次 clone 前的 `git ls-remote --heads` 预检默认 8s 失败（`DSH_COMMANDS_SKILL_PROBE_MS` 可调，设 0 关闭；本地路径来源不预检），并给代理/镜像提示。
- **来源**：默认 `morehao/ai-kit`；`DSH_COMMANDS_SKILL_SOURCE` 可换成可达镜像或本地目录。
- **CLI 版本**：依赖 `skills`（`package.json` 用 `latest`，安装时取最新，不固定 `1.7.4`），默认直接调用；显式设置 `DSH_COMMANDS_SKILLS_CLI`（如 `skills`）会改走 npx 指定版本。`DSH_COMMANDS_SKILL_CLI` 可完全替换命令本体（视为可执行文件 + 固定前缀，用于测试桩或自定义安装方式；此时跳过缓存、预检与 `--json`）。
- **超时**：外层硬超时 `DSH_COMMANDS_SKILL_TIMEOUT_MS`（默认 120s）；CLI 自己的克隆超时 `SKILLS_CLONE_TIMEOUT_MS` 会被压到早 30s。缓存 git 操作另有 60s/20s 上限。超时的回执直接写「超时（超过 Ns，已强制终止）」，不再显示成 `退出码 SIGKILL`。
- **非交互凭据**：CLI 与缓存 git 子进程固定 `GIT_TERMINAL_PROMPT=0`，并设 `GIT_HTTP_LOW_SPEED_LIMIT=1000` / `GIT_HTTP_LOW_SPEED_TIME=10`，私有仓缺凭据或网络黑洞时会快速失败而不是卡住。
- **并发**：同一 `DSH_HOME` 同时只允许一个技能安装/更新任务。连按两次回车时，第二次直接提示「已有技能安装任务正在进行」，不会并行 clone 同一个仓库。
- **npx 回退定位**：依赖缺失时 PATH 找不到 npx 会用登录 shell 反查（GUI 启动的宿主可能缺 per-shell 路径）；仍找不到则报错并给出手工命令。

## `/skill-init`

只装插件依赖的两个技能（`git-kit`、`handoff`）。

| 现状 | 行为 |
|---|---|
| `~/.dsh/skills` 里没有 | 从缓存安装 `git-kit`、`handoff` → 软链 `~/.dsh/skills/*` → `~/.agents/skills/*` |
| 已手工 `git clone ai-kit && ln -s` | 判定为「非托管软链」→ **替换**软链，clone 目录不动 |
| 已经是托管软链 | 缓存 TTL 内且 hash 一致 → 跳过；TTL 过期 → 检查上游，有变化才重装 |
| 同名位置是真实目录 | 该技能报「拒绝覆盖」，其余照常 |

顺带校验分支契约（`git-kit` 的 9 个分支文件是否齐），结束提示「无需重启 dsh」。

缓存 TTL 内确认最新、或测试桩/本地路径下已托管时，不会创建后台任务，回执首行直接给结论；TTL 过期会建作业检查上游，见 [过程可见](./job-progress.md)。

已托管但缓存缺失/上游暂时不可达时，`/skill-init`、`/skill-install` 会尽量补链并回执「已安装；上游检查失败」而不是把已装好的环境判失败；`/skill-update` 仍要求 fetch 成功，不拿旧缓存冒充更新。

## `/skill-install <来源> [技能名...]`

安装**任意来源**的技能（`owner/repo`、git/HTTPS URL 或本地路径，与 `npx skills add` 的来源语法一致）并软链进 dsh；不给技能名则装该来源发现的全部技能。

```bash
/skill-install morehao/ai-kit tech-design                       # 单个
/skill-install morehao/ai-kit project-insight project-wiki svg-maker   # 多个
/skill-install morehao/ai-kit                                  # 全部（按 CLI 结果链入）
/skill-install ~/practice/ai/ai-kit/skills/svg-maker           # 本地路径（不建缓存，直接读目录）
```

**安装不是盲目 no-op**：显式技能名已由同一来源托管时，先比对缓存与 lock；TTL 内且 hash 一致返回「已是最新」，不调 CLI；TTL 过期会 fetch 检查，有变化才重装。拉插件依赖技能的新版本用 `/skill-update`；额外技能用 `/skill-install` 重新检查（或 `npx skills update`，见下节）。不指定技能名时仍会确保缓存可用（TTL 过期才 fetch）并发现新技能。

[`morehao/ai-kit`](https://github.com/morehao/ai-kit) 现提供 6 个技能：`git-kit`、`handoff`（插件依赖，由 `/skill-init` 管）与 `project-insight`、`project-wiki`、`svg-maker`、`tech-design`（按需 `/skill-install`）。

| 想要的能力 | 命令 |
|---|---|
| 写技术方案 / 设计文档 | `/skill-install morehao/ai-kit tech-design` |
| 解读开源项目（带源码行号引用） | `/skill-install morehao/ai-kit project-insight` |
| 给项目生成可读 Wiki | `/skill-install morehao/ai-kit project-wiki` |
| 生成独立 SVG 架构图 | `/skill-install morehao/ai-kit svg-maker` |

装完即可用，无需重启。

## `/skill-update [技能名...]`

把插件依赖的技能更新到上游最新并校验软链仍可解析；未托管/缺失条目只提示、不动。

```bash
/skill-update            # 更新 git-kit + handoff
/skill-update git-kit    # 只更新一个
```

更新流程：强制 `git fetch --depth 1` 刷新缓存 → 从缓存 `skills add` → 回写 lock → 校验软链。fetch 失败时命令明确失败（不拿旧缓存冒充更新）；安装类命令则允许旧缓存并在回执里标注离线。

候选集只来自 `COMMANDS` 的依赖（`git-kit`、`handoff`），`/skill-update svg-maker` 会报「未知技能」。用 `/skill-install` 装进来的额外技能用以下任一方式更新：

```bash
/skill-install morehao/ai-kit tech-design          # 已托管时先检查缓存；TTL 过期才 fetch
npx -y skills update tech-design -g -y       # 绕过插件，直接用上游 hash 比对
```

## 典型组合

```bash
# ① 新机器一次配齐（首次 clone，之后走缓存）
/skill-init
/skill-install morehao/ai-kit project-insight project-wiki svg-maker tech-design

# ② ai-kit 发新版后：插件依赖强制走 /skill-update，额外技能走 /skill-install（TTL 过期会 fetch）
/skill-update
/skill-install morehao/ai-kit project-insight project-wiki svg-maker tech-design

# ③ 边改 ai-kit 边用：想保持改完立刻生效就别跑 /skill-init（手工 ln -s 到 clone）；
#    已切成托管链路后想恢复本地编辑，只换链接、不动文件：
ln -sfn ~/practice/ai/ai-kit/skills/git-kit ~/.dsh/skills/git-kit
```

> 这三个命令自 **v0.1.9** 起提供；运行期的作业行 / 流式输出自 **v0.1.10** 起提供；本地缓存与直接调用 CLI 为当前未发布改动。

## 手工准备（不想让插件动 home）

技能由 [`morehao/ai-kit`](https://github.com/morehao/ai-kit) 提供，可以自己 clone 并软链：

```bash
git clone https://github.com/morehao/ai-kit.git
mkdir -p "$HOME/.dsh/skills" && ln -s "$PWD/ai-kit/skills"/* "$HOME/.dsh/skills/"
```

手工软链指向你的本地 clone（改本地文件即时生效），但不归 `skills` CLI 托管，`/skill-update` 不会更新它；下次跑 `/skill-init` 会把它**替换**成托管软链——只删那条链接，你的 clone 一个字节都不动，想恢复再 `ln -s` 一次即可。
