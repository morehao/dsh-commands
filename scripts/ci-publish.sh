#!/usr/bin/env bash
# tag 触发发布（git tag vX.Y.Z -> 发布 @morehao/dsh-commands@X.Y.Z，经 OIDC）。
# 本仓根即包根：无 pnpm workspace、无子包目录，`package.json` 就在脚本的上一级。
# 由 .github/workflows/release.yml 的 publish 步骤调用（action 用 @actions/exec 执行单一命令，
# 不做 shell 解析，所以是 `bash <此脚本>` 这种单命令，逻辑都在本脚本里）。
set -euo pipefail

# 从 CI 传入的 tag（如 v1.2.3）取版本；本地跑可用 RELEASE_TAG=... 或 GIT_TAG=vX.Y.Z。
TAG="${RELEASE_TAG:-${GIT_TAG:-}}"
if [ -z "$TAG" ]; then
  echo "错误：未设置 RELEASE_TAG（应为 push 的 tag，如 v1.2.3）" >&2
  exit 1
fi
PKG_VERSION="${TAG#v}"   # v1.2.3 -> 1.2.3

# 新仓根 = 包根（迁仓前此处还有 PKG_DIR="commands-dsh"; cd "$PKG_DIR" 两行，已删除）
cd "$(dirname "$0")/.."

name="@morehao/dsh-commands"
PKG_JSON_VERSION="$(node -p "require('./package.json').version")"

echo "Publish check: ${name}@${PKG_JSON_VERSION} (tag=${TAG})"

# 1) tag 版本必须与 package.json 版本一致，避免误发。
if [ "$PKG_JSON_VERSION" != "$PKG_VERSION" ]; then
  echo "错误：tag 版本 ${PKG_VERSION} 与 package.json 版本 ${PKG_JSON_VERSION} 不一致，拒绝发布" >&2
  exit 1
fi

# 2) 该版本已发布则跳过（幂等）。
published="$(npm view "${name}@${PKG_VERSION}" version --registry https://registry.npmjs.org 2>/dev/null || true)"
if [ -n "$published" ]; then
  echo "${name}@${PKG_VERSION} already published on npmjs; skip"
  exit 0
fi

# 3) OIDC 可信发布：job 提 id-token: write，npm CLI(>=11.5.1) 自动换取短时令牌，无需 NODE_AUTH_TOKEN。
#
# 为什么要重试：npm registry 偶发降级（https://status.npmjs.org 的 Package publishing / OIDC 端点）
# 时，PUT 会直接回 `E404 Not found`（令牌交换失败时的表现与权限问题一模一样）。这类 404 不是配置问题，
# 等几十秒重试往往就过了；把重试放在这里，避免为一次 registry 抖动去 rerun 整个 workflow 或重新打 tag。
#   - 每次失败后先回读 registry：请求可能已被受理、只是响应丢了，此时已可见即视为成功（幂等）。
#   - 重试耗尽才失败，并打印排查路径（registry 状态 → Trusted Publisher 配置 → rerun）。
#   - `RETRY_BASE_SECONDS` 只给本地测试用（默认 30 秒，第 n 次失败等 n×base）。
echo "npm version: $(npm --version)"
echo "Publishing ${name}@${PKG_VERSION}"

RETRY_BASE_SECONDS="${RETRY_BASE_SECONDS:-30}"
MAX_ATTEMPTS=3
attempt=1
while :; do
  if npm publish --provenance --access public --registry https://registry.npmjs.org; then
    exit 0
  fi

  # 请求可能已被受理但响应丢失 → 回读确认，已可见即成功，避免重复发布报「已存在」。
  if npm view "${name}@${PKG_VERSION}" version --registry https://registry.npmjs.org >/dev/null 2>&1; then
    echo "${name}@${PKG_VERSION} 已出现在 registry，视为发布成功（首次响应丢失）"
    exit 0
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "错误：npm publish 连续 ${attempt} 次失败" >&2
    echo "排查顺序：" >&2
    echo "  1) https://status.npmjs.org 的 Package publishing 是否 degraded（降级期间的 404 属正常现象）" >&2
    echo "  2) 状态正常时：核对 Trusted Publisher（workflow=release.yml、Allowed actions 允许 npm publish）" >&2
    echo "  3) 故障恢复后重跑该 run：gh run rerun <run-id>" >&2
    exit 1
  fi

  wait_seconds=$((attempt * RETRY_BASE_SECONDS))
  echo "第 ${attempt} 次 publish 失败，${wait_seconds}s 后重试（registry 瞬时故障常见，见 https://status.npmjs.org）" >&2
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
