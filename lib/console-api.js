/**
 * `@morehao/dsh-skills-console/api` 的解析层（设计 §5.1 / §6.2）。
 *
 * 本插件（dsh-commands）**只**通过这个包接入技能安装 / 更新：
 * - 动态 import `@morehao/dsh-skills-console/api`（不静态依赖，包缺失时能优雅报错）；
 * - 调 `createSkillsConsole()`（插件启用时命中进程级 registry，未启用时 headless）；
 * - 校验 `apiVersion`。
 *
 * 旧版 console（<0.7.0）没有 registry / 服务，若它作为 bundle 启用会与本插件的 headless
 * 实例**双写** state。因此这里先用 profile 顶层版本做守卫：版本 < 0.7.0 且 bundle 启用 →
 * 直接 blocked，绝不创建 headless 实例。拿不到 `DSH_PROFILE_DIR` 时守卫失效（非 profile 启动）。
 *
 * 约束：不 import console 源码，不读其 state.json，不调 HTTP。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

export const CONSOLE_API_SPECIFIER = "@morehao/dsh-skills-console/api";
export const CONSOLE_PACKAGE_NAME = "@morehao/dsh-skills-console";
export const CONSOLE_PACKAGE_JSON = "@morehao/dsh-skills-console/package.json";
/** 第一个带 runtime registry / 服务的版本。 */
export const MIN_CONSOLE_VERSION = "0.7.0";
/** 本插件支持的公共 API 硬版本。 */
export const EXPECTED_API_VERSION = 1;

/** 解析失败的结构化错误：调用方据 `code` 给出可执行回执，绝不静默降级到 CLI。 */
export class ConsoleResolveError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ConsoleResolveError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 解析 `x.y.z`（忽略前缀与预发布标签），失败返回 null。 */
function parseVersion(value) {
  if (typeof value !== "string") return null;
  const core = value.trim().split(/[-+]/)[0].replace(/^[^0-9]*/, "");
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  while (parts.length < 3) parts.push(0);
  return parts;
}

/** a < b → -1，a == b → 0，a > b → 1（无法解析时按相等处理）。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 读取 profile 顶层安装的 console 版本与是否启用。
 * 返回 `null` 表示拿不到 profile（非 profile 启动 / 读失败），守卫失效。
 *
 * @returns {Promise<{ dir: string, enabled: boolean, version: string | null } | null>}
 */
export async function readProfileConsole(env = process.env) {
  const dir = typeof env.DSH_PROFILE_DIR === "string" ? env.DSH_PROFILE_DIR.trim() : "";
  if (!dir) return null;
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const enabled = bundles.includes(CONSOLE_PACKAGE_NAME);
  let version = null;
  try {
    const req = createRequire(join(dir, "package.json"));
    const pkgPath = req.resolve(CONSOLE_PACKAGE_JSON);
    version = JSON.parse(await readFile(pkgPath, "utf8"))?.version ?? null;
  } catch {
    // 解析不到实物包时，退回 profile dependencies 里声明的版本（可能带范围符号）。
    const declared = pkg?.dependencies?.[CONSOLE_PACKAGE_NAME];
    version = typeof declared === "string" ? declared : null;
  }
  return { dir, enabled, version };
}

/**
 * 解析出可用的 console api。
 *
 * @param {{ env?: Record<string,string|undefined>, importer?: (specifier: string) => Promise<any>,
 *           createSkillsConsole?: (() => any) }} [options]
 *   `importer` / `createSkillsConsole` 仅供测试注入。
 * @returns {Promise<{ api: any, mod: any }>}
 * @throws {ConsoleResolveError} code ∈ {old-console, api-missing, api-failed, incompatible-api}
 */
export async function resolveConsoleApi({ env = process.env, importer, createSkillsConsole } = {}) {
  // 1) 旧 console 守卫：版本 < 0.8 且 bundle 启用 → 直接 blocked，绝不建 headless。
  const profile = await readProfileConsole(env);
  if (profile && profile.enabled && profile.version && compareVersions(profile.version, MIN_CONSOLE_VERSION) < 0) {
    throw new ConsoleResolveError(
      "old-console",
      `检测到已启用的旧版技能控制台（v${profile.version}），请先升级到 v${MIN_CONSOLE_VERSION}+ 再运行 /skill-init`,
      { version: profile.version },
    );
  }

  // 2) 动态 import 公共 API 子路径。
  let mod;
  try {
    const load = importer ?? ((specifier) => import(specifier));
    mod = await load(CONSOLE_API_SPECIFIER);
  } catch (error) {
    throw new ConsoleResolveError(
      "api-missing",
      "未找到 @morehao/dsh-skills-console/api：请先安装技能控制台包（npm i @morehao/dsh-skills-console），或启用技能控制台插件",
      { cause: error?.message ?? String(error) },
    );
  }

  const factory = createSkillsConsole ?? mod?.createSkillsConsole;
  if (typeof factory !== "function") {
    throw new ConsoleResolveError("api-missing", "技能控制台包未导出 createSkillsConsole（版本过旧？）");
  }

  // 3) 创建 api（命中 registry 或 headless）。
  let api;
  try {
    api = factory();
  } catch (error) {
    throw new ConsoleResolveError("api-failed", error?.message ?? String(error), { code: error?.code ?? null });
  }

  // 4) 版本校验（不猜、不回退）。
  const expected = typeof mod?.API_VERSION === "number" ? mod.API_VERSION : EXPECTED_API_VERSION;
  if (!api || api.apiVersion !== expected || api.apiVersion !== EXPECTED_API_VERSION) {
    throw new ConsoleResolveError(
      "incompatible-api",
      `技能控制台 API 版本不兼容（期望 ${EXPECTED_API_VERSION}，实际 ${api?.apiVersion ?? "未知"}）；请升级对应一方`,
      { apiVersion: api?.apiVersion ?? null, expected },
    );
  }
  return { api, mod };
}
