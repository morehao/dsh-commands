# 技能依赖自举

`/skill-init`、`/skill-install`、`/skill-update` 不是「意图表」：它们要判断文件状态、建软链、拉上游，结果必须确定，所以直接在 handler 内执行，不交给 agent。

- 实现：`lib/skill-setup.js`（检查 / 安装 / 软链 / 校验）；长任务的过程包装在 `lib/job-progress.js`（见 [过程可见](./job-progress.md)）。
- 依赖集合仍从 `COMMANDS` 推导（`skill ?? "git-kit"` 去重，导出为 `REQUIRED_SKILLS`），新增委托型命令后自动跟进。

## 为什么需要软链

dsh **不从 `node_modules` 扫描技能**，技能必须落在 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）下才会进入模型目录。

官方 `skills` CLI（`npx skills`，vercel-labs/skills）支持 80+ agent，但**没有 dsh**：它只能把技能取到自己的 canonical 目录，放进 dsh 技能根必须由插件建软链。实际链路：

```
npx -y skills@<pin> add morehao/ai-kit --skill <缺的> -g -a universal -y
   └─ ~/.agents/skills/<name>            # CLI 的 canonical 拷贝 + lock 记录
        ↑ 软链（本插件创建）
   ~/.dsh/skills/<name>                  # dsh 扫描的技能根
```

## 上游约束（由实现决定，改动前请重读）

- **`-a universal` 必须显式给**：不带 `-a` 且没检测到任何 agent 时，`-y` 会把技能装到**全部** agent 目录。`skills update` 内部正是这么 spawn 的，所以 `/skill-update` 也用 `add` 而不是 `update`。
- **`-a universal -g` 直接落 canonical**：上游对 universal + global 有特例，不会再额外建 `~/.config/agents/skills` 链接。
- **`add` 只有拷贝语义**（`link` 模式仅 `experimental_sync` 用），canonical 是拷贝：改本地 ai-kit clone 不会自动生效，要 `/skill-update`。
- **只替换软链，不做备份、不删真实目录**：覆盖旧条目时只 `unlink` 旧**软链**（含悬空软链）——链接指向的目录（你的本地 ai-kit clone）一字不动，要回滚再 `ln -s` 一次即可；遇到同名**真实目录/文件**则直接报错让你自行移走，避免任何不可回滚的删除。也正因为如此，`skills/` 里不能再出现 `xxx.bak-<时间>` 这种目录：它含 `SKILL.md`，会被当成同名技能扫到。
- dsh 同层同名技能按根 rank 取小者（`$DSH_HOME/skills`=400 胜 `~/.agents/skills`=500），软链与 canonical 并存不会产生重复技能；技能根有 watcher，装完免重启。
- `/skill-install` 不限于插件依赖：装完靠三路取并集决定给谁建软链——用户显式写的技能名、安装前后 canonical 目录的差集、lock 里 source 匹配的技能。

## 环境与限制

- **Node.js ≥ 22.20**（`skills` 包的 engine；插件本身 `engines` 只要求 ≥20）。
- **网络必须能访问来源仓库**：`npx skills` 会真去 `git clone`，GitHub 443 不通时必然失败。命令卡片会给出代理/镜像提示，而不是干等。
- **来源**：默认 `morehao/ai-kit`；`DSH_COMMANDS_SKILL_SOURCE` 可换成可达镜像或本地目录。
- **CLI 版本**：默认 pin（`skills@1.7.4`），用 `DSH_COMMANDS_SKILLS_CLI` 覆盖。`DSH_COMMANDS_SKILL_CLI` 可完全替换命令本体（视为可执行文件 + 固定前缀，用于测试桩或自定义安装方式）。
- **超时**：外层硬超时 `DSH_COMMANDS_SKILL_TIMEOUT_MS`（默认 300s）；CLI 自己的克隆超时 `SKILLS_CLONE_TIMEOUT_MS` 会被压到早 30s，好让它先输出诊断。
- **npx 定位**：PATH 找不到时用登录 shell 反查（GUI 启动的宿主可能缺 per-shell 路径）；仍找不到则报错并给出手工命令。

## `/skill-init`

只装插件依赖的两个技能（`git-kit`、`handoff`）。

| 现状 | 行为 |
|---|---|
| `~/.dsh/skills` 里没有 | 安装 `git-kit`、`handoff` → 软链 `~/.dsh/skills/*` → `~/.agents/skills/*` |
| 已手工 `git clone ai-kit && ln -s` | 判定为「非托管软链」→ **替换**软链，clone 目录不动 |
| 已经是托管软链 | 跳过，且**不再调用 CLI** |
| 同名位置是真实目录 | 该技能报「拒绝覆盖」，其余照常 |

顺带校验分支契约（`git-kit` 的 9 个分支文件是否齐），结束提示「无需重启 dsh」。

无事可做时不会创建后台任务，回执首行直接给结论，见 [过程可见](./job-progress.md)。

## `/skill-install <来源> [技能名...]`

安装**任意来源**的技能（`owner/repo`、git/HTTPS URL 或本地路径，与 `npx skills add` 的来源语法一致）并软链进 dsh；不给技能名则装该来源发现的全部技能。

```bash
/skill-install morehao/ai-kit tech-design                       # 单个
/skill-install morehao/ai-kit project-insight project-wiki svg-maker   # 多个
/skill-install morehao/ai-kit                                  # 全部（已托管的自动跳过）
/skill-install ~/practice/ai/ai-kit/skills/svg-maker           # 本地路径（装的是拷贝）
```

[`morehao/ai-kit`](https://github.com/morehao/ai-kit) 现提供 6 个技能：`git-kit`、`handoff`（插件依赖，由 `/skill-init` 管）与 `project-insight`、`project-wiki`、`svg-maker`、`tech-design`（按需 `/skill-install`）。

| 想要的能力 | 命令 |
|---|---|
| 写技术方案 / 设计文档 | `/skill-install morehao/ai-kit tech-design` |
| 解读开源项目（带源码行号引用） | `/skill-install morehao/ai-kit project-insight` |
| 给项目生成可读 Wiki | `/skill-install morehao/ai-kit project-wiki` |
| 生成独立 SVG 架构图 | `/skill-install morehao/ai-kit svg-maker` |

装完即可用，无需重启。

## `/skill-update [技能名...]`

把插件依赖的技能重装到上游最新（`npx skills add … -g -a universal -y`）并校验软链仍可解析；未托管/缺失条目只提示、不动。

```bash
/skill-update            # 重装 git-kit + handoff 到上游最新
/skill-update git-kit    # 只更新一个
```

候选集只来自 `COMMANDS` 的依赖（`git-kit`、`handoff`），`/skill-update svg-maker` 会报「未知技能」。用 `/skill-install` 装进来的额外技能用以下任一方式更新：

```bash
/skill-install morehao/ai-kit tech-design          # 重装即更新（推荐）
npx -y skills@1.7.4 update tech-design -g -y       # 绕过插件，用上游 hash 比对
```

## 典型组合

```bash
# ① 新机器一次配齐
/skill-init
/skill-install morehao/ai-kit project-insight project-wiki svg-maker tech-design

# ② ai-kit 发新版后
/skill-update
/skill-install morehao/ai-kit project-insight project-wiki svg-maker tech-design

# ③ 边改 ai-kit 边用：想保持改完立刻生效就别跑 /skill-init（手工 ln -s 到 clone）；
#    已切成托管链路后想恢复本地编辑，只换链接、不动文件：
ln -sfn ~/practice/ai/ai-kit/skills/git-kit ~/.dsh/skills/git-kit
```

> 这三个命令自 **v0.1.9** 起提供；运行期的作业行 / 流式输出自 **v0.1.10** 起提供。

## 手工准备（不想让插件动 home）

技能由 [`morehao/ai-kit`](https://github.com/morehao/ai-kit) 提供，可以自己 clone 并软链：

```bash
git clone https://github.com/morehao/ai-kit.git
mkdir -p "$HOME/.dsh/skills" && ln -s "$PWD/ai-kit/skills"/* "$HOME/.dsh/skills/"
```

手工软链指向你的本地 clone（改本地文件即时生效），但不归 `npx skills` 托管，`/skill-update` 不会更新它；下次跑 `/skill-init` 会把它**替换**成托管软链——只删那条链接，你的 clone 一个字节都不动，想恢复再 `ln -s` 一次即可。
