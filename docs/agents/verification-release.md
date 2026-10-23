# 验证与发布（Agent）

> 读这篇的时机：提交前、改 CI/脚本、改 `package.json` / `exports` / `files`、打包、发版。
> 完整人类向流程见 [开发与测试](../development.md) 与 [发布说明](../publishing.md)；这里只给 agent 的检查矩阵与门禁。

## 1. 提交前验证矩阵

| 改动 | 必跑 | 说明 |
|---|---|---|
| `lib/*.js` | `npm run check` + `node --check` | `npm run check` 先 `node --check lib/client.js`，再命名 + 打包 + 两个技能冒烟；CI 另对全部 `lib/*.js` 做语法检查 |
| `COMMANDS` / `branch` | 上面 + `node scripts/check-skill-contract.mjs` | 契约校验依赖技能已安装 |
| `package.json` / `exports` / `files` / 命名 | `node scripts/check-naming.mjs` + `node scripts/check-pack.mjs` | CI 也跑；`dsh.client` 与 `./client` 必须在 `exports` 中，`lib/client.js` 必须入包 |
| `scripts/*.mjs` | `node --check <file>` + 对应冒烟 | `release-notes` 有自己的冒烟 |
| CI / release workflow | 本地跑对应脚本；`bash -n scripts/ci-publish.sh` | 不要只改 YAML 不验证 |
| 纯文档 | 链接与事实核对 | 不跑代码检查 |

`npm test` 只跑两个技能冒烟，不等于全量检查；交付前优先 `npm run check`。

## 2. CI 实际跑什么（check.yml）

PR 与 push `main` 触发，机械校验：

1. `bash -n scripts/ci-publish.sh`
2. `node --check` 所有 `lib/*.js`（含 `lib/client.js`）、两个技能冒烟脚本、`smoke-client-bundle.mjs`、`release-notes.mjs`
3. `node scripts/smoke-release-notes.mjs`（注记 tag → Release body 投影）
4. `node scripts/check-naming.mjs`
5. `node scripts/check-pack.mjs`
6. `node scripts/smoke-client-bundle.mjs`（client half 槽注册 / locale / inject）
7. `node scripts/smoke-skill-setup.mjs`
8. `node scripts/smoke-skill-cache.mjs`

注意：

- **跨仓契约校验不在 CI**（依赖 agent-skills 技能目录），需要本地跑。
- `npm run check` 含 client 语法/接线冒烟、命名、打包与两个技能冒烟；不含 `release-notes` 冒烟和其余 `lib/*.js` 的 `node --check`，本地全量按矩阵补。
- CI 不装依赖、不联网；冒烟用 stub / 本地 git。

## 3. 打包与命名

- [check-pack.mjs](../../scripts/check-pack.mjs) 调 `npm pack --dry-run --json`，检查白名单与必备文件：
  - 允许：`package.json`、`README.md`、`LICENSE`、`cordis.patch.yml`、`icon.svg`、`lib/`、`locale/`
  - 不允许：`.dsh/`、`docs/`、`scripts/`、`node_modules`、`*.tgz`
- 三处命名：
  - `package.json.name` == `cordis.patch.yml` 的 `insert[0].name`
  - `lib/index.js` 的 `export const name` == `cordis.patch.yml` 的 `insert[0].id`
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
