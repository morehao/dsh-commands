# npm 发包流程与说明（`@morehao/dsh-commands`，OIDC / Trusted Publishing）

> 本文记录把本仓（`@morehao/dsh-commands`，仓根即包根）发布到 npm 的**完整流程**与**踩坑清单**。核心原则同样适用于其他 npm 包：**打 tag + OIDC 免长效 token**。文末「操作手册」是日常发新版的速查。

## 0. 首次建包前自检清单

> 第一次把某个包推到 npm 之前，逐项勾选；有一项没满足就先用第 3 节补上，别急着发版。

**账号与命名**
- [ ] npm 账号可用，`npm whoami` 能返回你的用户名。
- [ ] 用到的 scope 已存在（如 `@morehao`）。核对：`curl -s https://registry.npmjs.org/-/org/<scope>/package` 返回 200（否则 404/报错，说明 scope 未建或包名已被占用）。
- [ ] 包名已定且未占用；`npx npm-check` 或 `npm view <pkg-name>` 确认当前不存在 / 未被他人占。

**发布权限与 2FA**
- [ ] 确认账号是否「发布需 2FA」：是，则非交互发布（`setup-npm-trusted-publish` 等）需要**带 bypass-2FA 的 granular token**；且 classic `npm_` token 无法绕过 2FA。
- [ ] 准备好一次性 granular token（scope 读写 + bypass 2FA，7 天即可），或接受交互式 login（但不能驱动非交互发布）。

**registry 与本地环境**
- [ ] 全局 `~/.npmrc` 的 `registry` 是否指向 npmmirror？是则**所有发包命令一律加 `--registry https://registry.npmjs.org`**，避免被劫持到 npmmirror / 弹 CNPM 注册页。
- [ ] CI 里 Node ≥ 22.13（若用 pnpm 11，`node:sqlite` 需要）；OIDC 发布需 **npm CLI ≥ 11.5.1**（CI 里 `npm i -g npm@latest`）。

**npm 侧一次性设置（第 3 节）**
- [ ] 包在 npm 上已「存在」（用 `setup-npm-trusted-publish` 发过 `0.0.0` 占位包）；否则 Trusted Publisher 配不了。
- [ ] Trusted Publisher 已配置：Provider=GitHub Actions、Owner、Repository、**Workflow=文件名(含 `.yml`)**、Environment 留空。
- [ ] **Allowed actions 允许 `npm publish` 直接发布**（默认只允许 `npm stage publish`，会导致 `permission denied`）。
- [ ] workflow 的 `name:` **等于文件名**（如 `release.yml`），使 OIDC `workflow` claim 与 npm 侧匹配。

**仓库 / workflow 前置**
- [ ] 仓库存在且为 GitHub（GitHub-hosted runner），workflow 文件在 `.github/workflows/<文件名>.yml`。
- [ ] 发布 job 有 `permissions: id-token: write`，且发布命令里**没有** `NODE_AUTH_TOKEN`（会覆盖 OIDC）。
- [ ] `setup-node` **不设** `registry-url`（v7 移除了 dummy `NODE_AUTH_TOKEN` 兜底，`.npmrc` 里的 `${NODE_AUTH_TOKEN}` 占位会和 OIDC 抢凭据），registry 由发布脚本的 `--registry` 显式指定；并显式 `package-manager-cache: false`。
- [ ] `scripts/` 里的发布脚本可执行、`bash -n` 通过；发布用**单一命令**（如 `bash ./scripts/ci-publish.sh`）。

**本仓库特有的命名约定（改包名时）**
- [ ] `package.json` 的 `name` == `cordis.patch.yml` 的 `insert[0].name`（模块标识符）。
- [ ] `lib/index.js` 的 `export const name` == `cordis.patch.yml` 的 `insert[0].id`。
- [ ] `package.json` 有 `publishConfig.access: public`；`repository.url` 指向本仓（单包仓，无需 `repository.directory`）。

**收尾清理**
- [ ] 建包用的临时 bypass-2FA token 已撤销；GitHub `NPM_TOKEN` secret 已删除（发布走 OIDC 不再需要）。

## 1. 总览

- **发布包**：`@morehao/dsh-commands`（**本仓根即包根**：根 `package.json` 就是包清单，无 workspace、无子包目录）。
- **发布模型**：打 `vX.Y.Z` tag → OIDC（Trusted Publishing）自动发布，**不需要长效 token**。
- **自动发布**：`.github/workflows/release.yml`（tag 触发）→ `scripts/ci-publish.sh`（发布逻辑）。
- **Release**：同一个 job 在 npm 发布**成功后**建 GitHub Release，body = 注记 tag 的正文（`scripts/release-notes.mjs` 原样投影，不重算、不改写；已存在则跳过）。
- **范围**：全仓仅此一个包；技能与 opencode 入口在另一仓（[`morehao/agent-skills`](https://github.com/morehao/agent-skills)），**不入包**。

## 2. 日常发新版（操作手册）

> **稳定分支不接受直接提交，发版升版本也不例外。** 升版本走 `git-kit`：`commit-push`（起点是稳定分支时自动建工作分支）→ `pr-create` → `pr-merge` 合并到 `main`。规则单一定义在 `skills/git-kit/references/stable-branch.md`；打 tag 侧的约束见 `skills/git-kit/references/tag.md`「发版约束」。
>
> **合并之后那一步用 `/git-release`**（git-kit 的 `release` 分支）：它只做 `pr-merge` 之后的部分——只读预检 → 一次计划卡确认 → 打注记 tag → **创建/校验 GitHub Release**（body 复用同一份变更说明：**中文摘要层 + 折叠的原文层**，推送前确认并冻结；**本仓由 CI 创建，流程只校验**）→ 逐个跟踪其他后效并出回执。它不改版本号、不开无关 PR；可选「写 `CHANGELOG.md`」——选了就为这个文件开 `docs/changelog-<tag>` 分支走一次 PR，且必须在打 tag 前合入（不选则完全不碰工作区）。`STATE` 四个值：`READY` 直接进计划卡；`TAGGED` 表示 tag 已在（重跑会补建缺失的 Release 或只做校验，正文从 tag 注记读回、不重算）；`NEEDS_TARGET` 表示这次发哪个版本还没定——先读仓库确认版本源，再带版本重跑，**不是**问你要 tag；`BLOCKED` 表示有阻断项（版本没领先 tag / tag 不在主干 / `tag-version-mismatch` 等），按 `BLOCKERS` 处理——多数情况先走升版本 PR。版本源是**读仓库得出的判断**（本仓就是根 `package.json` 的 `version`，回查用 `--version <v> --version-file package.json`），git-kit 不内置清单表，也不假定仓库发 npm。手动 `git tag` 仍有效，两者共用同一份 `tag.md`「发版约束」。
>
> **后效按仓库探测，不写死**：git-kit 会探测本仓 tag 触发了哪些 workflow、是否发 npm、是否由 CI 建 Release，再逐个校验。本仓的后效是「`release.yml` + npm」，**Release 由 CI 建**（`release.yml` 发布成功后用注记正文创建；`/git-release` 探到后只校验、不重复建），所以回执里会有 Release 行、workflow 行与 npm 行（npm 用 `--npm-pkg @morehao/dsh-commands` 别名，其他产物有公开地址就传 `--probe-url`）；换成 Go/容器/静态站仓库，同一流程只会报告它实际探测到的部分。只想打标签、不建 Release 就用 `/git-tag`。

1. **升版本**：改本仓 `package.json` 的 `version`（如 `0.1.8` → `0.2.0`），如有需要同步 `README.md` / `docs/` / `CHANGELOG.md`；**在分支上提交**并 push，再开 PR 合并到 `main`（`/git-commit-push` → `/git-pr-create` → `/git-pr-merge`）。
2. **打 tag**（在**合并后**的 `main` 最新提交上打；去掉 `v` 前缀，与 package.json 版本一致）：
   ```bash
   git switch main && git pull --ff-only origin main
   git tag -a v0.2.0 -m "release: v0.2.0" origin/main && git push origin v0.2.0
   ```
3. **自动发布**：workflow 收到 tag（`on: push: tags: ['v*']`）后：
   - 读 `RELEASE_TAG=v0.2.0` → 校验 `0.2.0 == package.json.version`（**不一致拒绝发布**）。
   - 若 npmjs 已存在 `0.2.0` → **跳过**（幂等）。
   - 否则 OIDC：`npm publish --provenance --access public --registry https://registry.npmjs.org`。
   - 发布成功后**建 GitHub Release**：正文取自注记 tag（`scripts/release-notes.mjs` 只做投影，不重新生成），已存在则跳过。顺序是「先有包、再有 Release」，发布失败不会留下悬挂的 Release；重跑该 run 即可补建（publish 会幂等跳过）。
   - 失败时**先看 https://status.npmjs.org**：`Package publishing` 降级期间 PUT 会回 `E404 Not found`（令牌交换失败的表现与权限问题相同）。`ci-publish.sh` 已内置 3 次退避重试 + 失败后回读 registry，抖动通常自动过去了；仍失败就等恢复后 `gh run rerun <run-id>`，**不要**为此删 tag 重打。

> 提示：tag 版本与 `package.json` 版本必须一致，否则 `ci-publish.sh` 会以非零退出并阻止发布（这是防误发的守卫）。tag 打在合并后的 `main` 提交上即可——版本号是随 PR 一起进 `main` 的，不需要单独为它破例直推。

## 3. 一次性 npm 侧设置（新建包时）

> 前置：账号 `morehao` 已开通 npm，「发布需 2FA」开启。

### 3.1 先让包「存在」于 npm（鸡生蛋）
Trusted Publisher 要求包**已存在**才能配置。用占位包建出来：

```bash
# 注意：该工具是「非交互」跑 npm publish；若账号发布需 2FA，必须用带 bypass-2FA 的 granular token：
read -s NPM_TOKEN && export NPM_TOKEN
npx --yes setup-npm-trusted-publish @morehao/dsh-commands --registry https://registry.npmjs.org
```

- 会发布一个 `0.0.0` 占位包（只用于建包，无实际功能；`dist-tags.latest` 会被它占位，正式版发布后覆盖）。
- `--registry` **必须**指向 `https://registry.npmjs.org`；本机全局 `~/.npmrc` 若是 npmmirror，会被劫持，务必显式覆盖（否则会弹 CNPM 注册页）。

### 3.2 配置 Trusted Publisher
到 `https://www.npmjs.com/package/@morehao/dsh-commands/access`：

| 字段 | 值 |
|---|---|
| Provider | GitHub Actions |
| Owner | `morehao` |
| Repository | `dsh-commands`（**迁仓前是 `ai-kit`**；npm 一个包只能配一个可信发布者，此字段切换即完成换源） |
| **Workflow** | **`release.yml`**（文件名；且本 workflow 的 `name:` **也必须等于 `release.yml`**） |
| Environment | 留空 |
| **Allowed actions** | **必须允许 `npm publish` 直接发布**（2026-09-03 后新建的默认只允许 `npm stage publish`） |

> **关键匹配**：GitHub OIDC 的 `workflow` claim 取的是 workflow 的 `name:` 字段；而 npm 表单要的是**以 `.yml` 结尾的文件名**。二者要对得上，就把 workflow 的 `name:` 也写成 `release.yml`（否则 OIDC 只报 `E404 not found`，极难定位）。

### 3.3 可选加固
- 发布走 OIDC，无需 token；建包用的临时 bypass-2FA token 用完即撤，GitHub `NPM_TOKEN` secret 也可删除。
- 可进一步收紧包权限（Trusted Publishing 不受影响）。

## 4. 关键文件

| 文件 | 作用 |
|---|---|
| `.github/workflows/release.yml` | `on: push: tags: ['v*']`；job 权限含 `id-token: write`；跑 `bash ./scripts/ci-publish.sh` |
| `scripts/ci-publish.sh` | 读 `RELEASE_TAG` 版本、校验 package.json、跳过已发布、OIDC 发布 |
| `package.json`（仓根） | 包名/版本；`publishConfig.access: public`；`dsh.bundle.patch` 指向 `cordis.patch.yml` |
| `cordis.patch.yml` | 插件注册 patch：`id: dsh-commands`、`name: '@morehao/dsh-commands'` |
| `lib/index.js` | `export const name = "dsh-commands"`；`export const COMMANDS` 供契约校验 |

## 5. dsh 插件命名约定（改包名/插件名时三处同步核对）

- `package.json` 的 `name`（npm 包名）== `cordis.patch.yml` 的 `insert[0].name`（dsh 启动时 `import()` 的**模块标识符**）。
- `lib/index.js` 的 `export const name`（cordis 插件名）== `cordis.patch.yml` 的 `insert[0].id`，与模块标识符**解耦**。
- 仓库根目录即包根，无子包目录特例（迁仓前的 `commands-dsh/` 目录名与 npm 包名刻意不同，该特例已消失）。
- `scripts/check-skill-contract.mjs` 校验「命令 → 技能分支」跨仓契约（技能在 agent-skills，默认读 `$DSH_HOME/skills`）。

## 6. 踩坑清单（排障速查）

| 症状 | 根因 | 解决 |
|---|---|---|
| pnpm `ERR_UNKNOWN_BUILTIN_MODULE` | Node < 22.13（`node:sqlite`） | CI 用 `node-version: 22` |
| publish 绿色但没发 | `@actions/exec` 不做 shell 解析，`a && b` 只执行 `a` | 用**单一命令** `bash ./scripts/ci-publish.sh` |
| `403 Two-factor … bypass 2fa` | classic `npm_` token 不能绕过 2FA | 用**带 bypass-2FA 的 granular token** |
| `npm login` 弹 CNPM/npmmirror | 全局 `~/.npmrc` registry 是 npmmirror | 一律 `--registry https://registry.npmjs.org` |
| Trusted Publisher 配不了 | 包还没在 npm 上存在 | 先 `setup-npm-trusted-publish` 发占位包 |
| OIDC `401/403` | job 缺 `id-token: write` 或设了 `NODE_AUTH_TOKEN` | 加 `id-token: write`；**不要**设 `NODE_AUTH_TOKEN`（会覆盖 OIDC） |
| OIDC `404 Not found` | workflow 名对不上 | workflow `name:` == `release.yml`（文件名） |
| OIDC `404 Not found`（workflow 名已对） | npm registry 降级：`Package publishing` 非 operational 时 PUT 直接 404，与权限问题表现相同 | 查 https://status.npmjs.org；`ci-publish.sh` 已重试 3 次，恢复后 `gh run rerun <run-id>`（**tag 不用动**） |
| OIDC `403 permission denied for this action` | Allowed actions 只允许 stage | 勾选**允许 `npm publish`**（无视「Not recommended」提示） |
| `npm view`/curl 仍显示旧版本 | npm 读端点 CDN 缓存滞后（1–2 分钟，甚至 404） | 看**单版本端点** `.../pkg/0.1.0`，稍等再确认 |
