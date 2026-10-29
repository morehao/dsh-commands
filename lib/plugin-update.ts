/**
 * 插件自更新（只读检查部分）：查 npm 上本插件的最新版本，判断是否落后。
 *
 * 与 `skill-setup.js` 的区别：那是「技能」的上游检测（GitHub / skills CLI）；这里是
 * 「插件包自身」的版本检查（npm registry），两条链路互不相干。
 *
 * 设计取舍（借鉴同目录 `dsh-skills-console` 的 `lib/core/plugin-update.js`，但只取只读半边）：
 * - 不 import 任何 `@deepseek-ai/*`：`pluginManager` 由调用方用 `ctx.get("pluginManager")` 惰性取得，
 *   拿不到就退回官方 registry；本模块只依赖 Node 内置能力。
 * - 为什么不用宿主 `pluginManager.inspect` 查最新版：`inspect` 对**已安装的包名**会直接返回
 *   `already-installed`（它答「马上要装的 spec 指向什么」，不是「已装包的最新版」），
 *   所以最新版只能自己查 registry —— 但优先走宿主 `registries()` 给出的 registry 计划
 *   （继承 profile 的镜像 / 私源 / token），拿不到才回退官方 registry。
 * - 依次问 registry 计划里的 `<base><pkg>/latest`，8s 超时，只取 `version` 字段；失败不抛，返回 null。
 * - 版本比较手写（本仓运行时依赖只有 skills，不引入 semver）；非法版本一律判「不更新」。
 * - 本模块只做**版本检查 + 本地状态**（不安装、不 import 宿主包）；安装与确认在
 *   `plugin-update-service.js`，工具壳在 `tool-plugin-update.js`。
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveDshHome } from "./skill-paths.js";
import { spawnCollect } from "./proc.js";
import type { PluginCheckResult } from "./types.js";

export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
export const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface PluginMeta {
  name: string;
  version: string;
  repo: string | null;
}

export interface Semver {
  core: number[];
  prerelease: string[];
}

/** 插件身份：包名、当前版本与仓库（从 package.json 读一次，避免和命令文案硬编码漂移）。 */
export const PLUGIN_META: PluginMeta = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(String(repo || ""));
    return {
      name: String(pkg.name || ""),
      version: String(pkg.version || ""),
      repo: match ? match[1] : null
    };
  } catch {
    return { name: "", version: "", repo: null };
  }
})();

/** 解析 semver：`v1.2.3` / `1.2.3-beta.1` / `1.2.3+build`。非法返回 undefined。 */
export function parseSemver(value: unknown): Semver | undefined {
  const text = String(value ?? "").trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (match === null) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : []
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const an = BigInt(a);
      const bn = BigInt(b);
      if (an !== bn) return an > bn ? 1 : -1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

/** `candidate` 是否严格新于 `current`。任一方不是合法 semver 都判 false（宁可不更新）。 */
export function isNewerVersion(current: unknown, candidate: unknown): boolean {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (a === undefined || b === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (b.core[index] !== a.core[index]) return b.core[index] > a.core[index];
  }
  return comparePrerelease(b.prerelease, a.prerelease) > 0;
}

/** npm 包名转成 registry 路径：`@scope/name` → `@scope%2Fname`。 */
function encodePackageName(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/** registry 归一成 `https://host/` 形式；非法返回 null。 */
function normalizeRegistry(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(`${text}/`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 由宿主 `registries()` 结果拼出要问的 registry 顺序：
 * `resolved`（pnpm 实际用的）→ `registry` → `fallbackRegistries`，去重；空则回退官方 registry。
 */
export function registryPlan(registries: any): string[] {
  const ordered: string[] = [];
  const push = (value: unknown) => {
    const normalized = normalizeRegistry(value);
    if (normalized && !ordered.includes(normalized)) ordered.push(normalized);
  };
  if (registries && typeof registries === "object") {
    push(registries.resolved);
    push(registries.registry);
    for (const item of Array.isArray(registries.fallbackRegistries) ? registries.fallbackRegistries : []) push(item);
  }
  if (ordered.length === 0) ordered.push(OFFICIAL_REGISTRY);
  return ordered;
}

/** 手动更新命令（回执里给用户复制用），按已发布包 + 当前 profile 拼。 */
export function manualCommand(meta: { name: string }, profileName: string | null): string {
  const spec = `${meta.name}@latest`;
  return profileName ? `dsh plugin --profile ${profileName} add ${spec}` : `dsh plugin add ${spec}`;
}

export interface PluginUpdaterDeps {
  /** 取宿主 `pluginManager`（可能 undefined） */
  getPluginManager?: () => any;
  /** 取当前 profile 名（仅用于手动命令） */
  getProfileName?: () => string | null;
  /** 取宿主 `profileContext`（提供 `dir` / `packageManager`） */
  getProfile?: () => any;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  /** 测试注入：pnpm view 结果 */
  runPnpmView?: (spec: string) => Promise<string | null>;
  /** 测试注入 */
  now?: () => number;
  /** 测试注入 */
  meta?: PluginMeta;
}

interface CacheEntry {
  version: string;
  expiresAt: number;
  registry: string;
}

export function createPluginUpdater({
  getPluginManager,
  getProfileName,
  getProfile,
  fetchImpl = globalThis.fetch,
  runPnpmView,
  now = Date.now,
  meta = PLUGIN_META
}: PluginUpdaterDeps = {}) {
  let cache: CacheEntry | null = null;

  /** 宿主的 `pluginManager` 服务（任意能力）；拿不到返回 null。 */
  function rawService(): any {
    try {
      const value = typeof getPluginManager === "function" ? getPluginManager() : undefined;
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  /** 从宿主 `pluginManager.registries()` 取 registry 配置；拿不到返回 null（走官方 registry）。 */
  async function readRegistries(): Promise<any> {
    const service = rawService();
    if (service === null || typeof service.registries !== "function") return null;
    try {
      return await service.registries();
    } catch {
      return null;
    }
  }

  function profileName(): string | null {
    try {
      const value = typeof getProfileName === "function" ? getProfileName() : null;
      return typeof value === "string" && value ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * 优先走 `pnpm view <pkg>@latest version --json`：继承 profile 的镜像 / 私源 / token，
   * 裸 `fetch` 不读 `.npmrc`，私有 registry 会失败。拿不到 profile / 命令失败返回 null（回退 fetch）。
   */
  async function latestViaPnpm(): Promise<string | null> {
    if (typeof runPnpmView === "function") return runPnpmView(`${meta.name}@latest`);
    const profile = typeof getProfile === "function" ? getProfile() : undefined;
    const dir = typeof profile?.dir === "string" ? profile.dir : undefined;
    if (dir === undefined) return null;
    const pm = profile?.packageManager;
    const command = typeof pm?.command === "string" ? pm.command : "pnpm";
    const prefix = Array.isArray(pm?.args) ? pm.args : [];
    const result = await spawnCollect({
      command,
      args: [...prefix, "view", `${meta.name}@latest`, "version", "--json"],
      cwd: dir,
      timeoutMs: FETCH_TIMEOUT_MS,
      collectStdout: true
    });
    if (result.code !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout.trim() || "null");
      const version = Array.isArray(parsed) ? parsed.at(-1) : parsed;
      return typeof version === "string" && parseSemver(version) !== undefined ? version.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * 先问 pnpm view（继承 profile 配置），拿不到再依次问 registry 计划里的 `<base><pkg>/latest`；
   * 第一个给出合法版本的为准。全部失败返回 null（不抛，交给视图标 checkFailed）。
   */
  async function latestVersion(fresh = false): Promise<string | null> {
    if (!meta.name) return null;
    if (fresh) cache = null;
    if (cache && now() < cache.expiresAt) return cache.version;
    let viaPnpm: string | null = null;
    try {
      viaPnpm = await latestViaPnpm();
    } catch {
      viaPnpm = null;
    }
    if (viaPnpm !== null) {
      cache = { version: viaPnpm, expiresAt: now() + CACHE_TTL_MS, registry: "pnpm" };
      return viaPnpm;
    }
    const plan = registryPlan(await readRegistries());
    for (const base of plan) {
      try {
        const response = await fetchImpl(`${base}${encodePackageName(meta.name)}/latest`, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (!response.ok) continue;
        const value: any = await response.json();
        const version = typeof value?.version === "string" ? value.version.trim() : "";
        if (parseSemver(version) === undefined) continue;
        cache = { version, expiresAt: now() + CACHE_TTL_MS, registry: base };
        return version;
      } catch {
        // 这个 registry 不通 / 超时 / 响应非法：试下一个
      }
    }
    return null;
  }

  /**
   * 只读检查：返回当前版本 / 最新版本 / 是否可更新。
   * 网络失败不抛，用 `checkFailed` 标记；`manualCommand` 始终给出可复制的更新方式。
   */
  async function check({ fresh = false }: { fresh?: boolean } = {}): Promise<PluginCheckResult> {
    const latest = await latestVersion(fresh);
    return {
      packageName: meta.name,
      currentVersion: meta.version,
      latestVersion: latest,
      updateAvailable: latest !== null && isNewerVersion(meta.version, latest),
      checkFailed: latest === null,
      manualCommand: manualCommand(meta, profileName())
    };
  }

  return { check };
}

/** 安装副本的当前版本（每次重新读文件：更新后同一进程内也能读到新值）。 */
export function readInstalledVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version.trim() : "";
  } catch {
    return "";
  }
}

/**
 * 本地状态文件：`<home>/dsh-commands/state.json`（记录 lastSeenVersion / pendingVersion）。
 * `home` 优先取宿主 profileContext.home（与 DSH 解析一致），缺省回退 `$DSH_HOME`。
 */
export function pluginStatePath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return join(home ?? resolveDshHome(env), "dsh-commands", "state.json");
}

/** 读状态；不存在/损坏一律返回 `{}`（启动提示不能因为状态文件坏了而报错）。 */
export async function readPluginState(env: NodeJS.ProcessEnv = process.env, home?: string): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(await readFile(pluginStatePath(env, home), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 写状态（尽力而为）：只在启动提示里用，失败不抛。 */
export async function writePluginState(
  env: NodeJS.ProcessEnv,
  state: Record<string, any>,
  home?: string
): Promise<boolean> {
  try {
    const path = pluginStatePath(env, home);
    await mkdir(dirname(path), { recursive: true });
    const payload = { ...state, updatedAt: new Date().toISOString() };
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
