# 验证与发布（Agent）

> 读这篇的时机：提交前、改 CI/脚本、改 `package.json` / `exports` / `files`、打包、发版。
> 完整人类向流程见 [开发与测试](../development.md) 与 [发布说明](../publishing.md)；这里只给 agent 的检查矩阵与门禁。

## 1. 提交前验证矩阵

| 改动 | 必跑 | 说明 |
|---|---|---|
| `lib/**/*.ts` | `npm run check` | `check` = `check:syntax`（扫 `scripts/` 与 locale JSON）+ `npm run build`（tsc）+ 产物自检 + 命名 + 打包 + Release 投影 + `npm test`；CI 跑的就是同一串 npm script |
| `COMMANDS` / `branch` | 上面 + `npm run check:contract` | 契约校验依赖技能已安装，不在 CI |
| `package.json` / `exports` / `files` / 命名 | `npm run check:naming` + `npm run check:pack` | CI 也跑；工具/命令源码必须全部入包；已不再有 `dsh.client` / `./client` |
| `scripts/*.mjs` | `npm run check:syntax` + 对应冒烟 | 语法已由目录扫描覆盖，不用逐个 `node --check`；`release-notes` 有自己的冒烟 |
| CI / release workflow | 本地跑对应 npm script；`bash -n scripts/ci-publish.sh` | 不要只改 YAML 不验证 |
| 纯文档 | 链接与事实核对 | 不跑代码检查 |

`npm test` 跑五个冒烟（技能自举 + plan + 工具 + 命令 + 缓存），不等于全量检查；交付前优先 `npm run check`。

## 2. CI 实际跑什么（check.yml）

PR 与 push `main` 触发，机械校验：

1. `bash -n scripts/ci-publish.sh`
2. `npm ci` + `npm run build`（`tsc` 把 `lib/*.ts` 编译到 `dist/`）
3. `npm run check:syntax`（`scripts/check-syntax.mjs`：扫 `scripts/` 与 `locale/*.json`；TS 类型/语法由 tsc 负责）
3. `npm run check:release-notes`（注记 tag → Release body 投影）
4. `npm run check:naming`
5. `npm run check:pack`
6. `npm test`（五个离线冒烟：技能自举、plan、`skill_init` 工具、`/skill-init` 命令、技能缓存）

CI 的每一步都调 `package.json` 里的 npm script，不在 YAML 里另列文件清单——CI 与本地跑的是同一串脚本。

注意：

- **跨仓契约校验不在 CI**（依赖 agent-skills 技能目录），需要本地跑。
- `npm run check` 与 CI 覆盖同一组检查，只差 `bash -n`（shell 语法）与契约校验；新增 `lib/*.js` / `scripts/*.mjs` 不需要改 workflow。
- CI 装 devDependencies（`typescript` / `@types/node`）并先构建；冒烟本身离线，用 stub / 本地 git。
- **两个 workflow 的镜像与 action 版本是显式钉住的**，别顺手改回浮动值：
  - `runs-on: ubuntu-24.04`（不是 `ubuntu-latest`）：`ubuntu-latest` 自 2026-10-19 起分批迁到 26.04（11-19 完成），校验/发布结果不该随镜像漂移。要试新镜像就单独改成 `ubuntu-26.04` 跑一轮再切。
  - `actions/checkout@v7` / `actions/setup-node@v7`：v4 跑在 node20 上，GitHub 已提示弃用并强制在 node24 上运行；v5 起改用 node24，v7 是当前主版本。
  - 两个 job 的 `setup-node` 都显式 `package-manager-cache: false`：v6 起只要 `package.json` 有 `packageManager` 字段就会自动开 npm 缓存，发布链路尤其不该让缓存接触 OIDC 令牌。
  - `release.yml` **不设 `registry-url`**：v7 移除了 dummy `NODE_AUTH_TOKEN` 兜底，registry 由 `ci-publish.sh` 的 `--registry` 指定，避免 `.npmrc` 的 `${NODE_AUTH_TOKEN}` 占位与 OIDC 抢凭据（姊妹仓 dsh-skills-console 同款取舍）。

## 3. 打包与命名

- [check-pack.mjs](../../scripts/check-pack.mjs) 调 `npm pack --dry-run --json`，检查白名单与必备文件：
  - 允许：`package.json`、`README.md`、`LICENSE`、`cordis.patch.yml`、`icon.svg`、`dist/`、`locale/`
  - 不允许：`.dsh/`、`docs/`、`scripts/`、`node_modules`、`*.tgz`
- 三处命名：
  - `package.json.name` == `cordis.patch.yml` 的 `insert[0].name`
  - `lib/index.ts` 的 `export const name` == `cordis.patch.yml` 的 `insert[0].id`
  - `publishConfig.access === "public"`
- 插件页元信息：`locale/{zh,en}.json` 的 `meta.title` / `meta.description`，图标取 `icon` 或 `./icon`；这些资源必须同时出现在 `exports` 与 `files`，且 `package.json` 本身也要导出。
- `docs/` 不入包；README 里指向 `docs/` 的相对链接在 npm 页面没有对应文件，不要新增依赖这类链接的内容。

## 4. 发版清单

> 稳定分支不直推；升版本也走 PR。优先用 `/git-release`，它只做 `pr-merge` 之后的发布段。

- [ ] 改 `package.json.version`（如 `0.2.0`），同步 README / `docs/` / `CHANGELOG.md`。
- [ ] 走分支 + PR 合并到 `main`，不在 `main` 直接提交。
- [ ] 在合并后的 `main` 最新提交上打注记 tag `vX.Y.Z`；去掉 `v` 后必须等于 `package.json.version`。
- [ ] 推送 tag → `release.yml`：校验版本 → 若 npm 已存在则跳过发布（幂等），否则 OIDC 发布 → 成功后用注记正文建 GitHub Release（已存在跳过）。
- [ ] 发布失败先看 https://status.npmjs.org；`ci-publish.sh` 有 3 次退避重试。恢复后 `gh run rerun <run-id>`，**不要删 tag 重打**。
- [ ] 不要设置 `NODE_AUTH_TOKEN`（会覆盖 OIDC）；job 需要 `id-token: write` 与 `contents: write`。
- [ ] `release.yml` 的 `name:` 必须是 `release.yml`，与 npm Trusted Publisher 的 Workflow 字段匹配。
- [ ] `gh release create` 必须留在 `release.yml`：git-kit 的 `/git-release` 预检靠 grep workflow 判定 Release 后效；挪进 `scripts/` 会让它误判。
- [ ] tag 推送、npm 发布、Release 创建都需要用户明确确认后再执行。

## 5. 常见失败对照

| 症状 | 先查 |
|---|---|
| 契约校验失败 | 技能未安装、`DSH_HOME` 不对、agent-skills 分支改名 |
| `check-pack` 多出文件 | 本地 `npm pack` 产物、`.dsh/`、`node_modules` 或新增目录未加白名单 |
| 命名校验失败 | `package.json.name` / patch `name` / plugin `name` 三处不一致 |
| OIDC `404` | workflow `name:` 是否等于 `release.yml`；npm registry 是否降级 |
| OIDC `403 permission denied` | Trusted Publisher 的 Allowed actions 是否允许 `npm publish` |
| 发布成功但无 Release | `release.yml` 的 Release 步骤是否被删/改名；注记 tag 是否有正文 |
| Release body 为空/报错 | tag 是否为轻量 tag、注记是否只有首行；用 `node scripts/release-notes.mjs <tag>` 复现 |
| npm 上版本已存在 | 正常幂等跳过；不要改 tag 重发同版本 |

## 6. 相关文档

- [开发与测试](../development.md)
- [发布说明](../publishing.md)
- [命令契约](./command-contract.md)
- [技能运行时](./skill-runtime.md)
