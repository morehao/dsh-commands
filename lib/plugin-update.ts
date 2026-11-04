/**
 * 插件自更新（只读检查 + 本地状态）：查 npm 上本插件的最新版本，判断是否落后。
 *
 * 引擎已经收敛到共享包 `@morehao/dsh-plugin-kit`（semver / registry 计划 / 超时 / 缓存 /
 * `pnpm view` 回退都在包里），本文件只保留 dsh-commands 特有的三件事：
 *   - 从自身 `package.json` 读身份（PLUGIN_META）与安装副本版本（readInstalledVersion）；
 *   - `<home>/dsh-commands/state.json` 的启动提示状态（lastSeenVersion / pendingVersion）；
 *   - 旧调用签名适配（`manualCommand(meta, name)`、`createPluginUpdater(deps).check()`），
 *     让 tool / command / index 不用一起改。
 *
 * 安装与确认仍在 `plugin-update-service.js`：它需要 `ctx.jobs` 与 `userQuestions`，
 * 属于本仓的交互外壳，不放进共享包。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	OFFICIAL_REGISTRY,
	isNewerVersion,
	manualCommand as kitManualCommand,
	parseSemver,
	registryPlan
} from "@morehao/dsh-plugin-kit";
import {
	createPluginUpdater as createKitUpdater,
	createPnpmViewRunner
} from "@morehao/dsh-plugin-kit/update";
import { createPluginMeta, readInstalledVersion as kitReadInstalledVersion } from "@morehao/dsh-plugin-kit/meta";
import { spawnCollect, type ExecOptions, type ExecResult } from "@morehao/dsh-plugin-kit/exec";
import type { PluginCheckResult } from "./types.js";
import { resolveDshHome } from "./skill-paths.js";

export { isNewerVersion, parseSemver, registryPlan, OFFICIAL_REGISTRY };
export const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface PluginMeta {
	name: string;
	version: string;
	repo?: string;
	/** 本插件 `package.json` 的导入地址：供自更新引擎每次现读磁盘已安装版本。 */
	pkgUrl?: URL;
}

/** 插件身份：包名、当前版本与仓库（从 package.json 读一次，避免和命令文案硬编码漂移）。 */
const PKG_URL = new URL("../package.json", import.meta.url);
export const PLUGIN_META: PluginMeta = (() => {
	const meta = createPluginMeta({ pkgUrl: PKG_URL });
	return {
		name: meta.name,
		version: meta.version,
		pkgUrl: PKG_URL,
		...(meta.repo === null ? {} : { repo: meta.repo })
	};
})();

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

/**
 * 本仓的进程策略：spawnCollect 默认继承 process.env（与旧 proc.ts 行为一致）；
 * 包装一层把 kit 的 ExecResult 对齐到 createPnpmViewRunner 的 exec 签名。
 */
function execForPnpmView(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
	return spawnCollect(command, args, options);
}

/**
 * 默认的 `pnpm view`：拿 profile 的包管理器与工作目录，继承 `.npmrc` 的镜像 / 私源 / token。
 * 拿不到 profile 目录就返回 null，由共享包回退到 registry 计划。
 */
function defaultPnpmView(getProfile: (() => any) | undefined): (spec: string) => Promise<string | null> {
	if (typeof getProfile !== "function") return async () => null;
	return createPnpmViewRunner({
		getProfile,
		exec: execForPnpmView,
		timeoutMs: FETCH_TIMEOUT_MS
	});
}

/** 旧签名的适配层：工具 / 命令 / index 只依赖 `.check()`。 */
export function createPluginUpdater({
	getPluginManager,
	getProfileName,
	getProfile,
	fetchImpl,
	runPnpmView,
	now,
	meta = PLUGIN_META
}: PluginUpdaterDeps = {}) {
	const updater = createKitUpdater({
		meta: {
			name: meta.name,
			version: meta.version,
			// pkgUrl：让引擎每次 check 现读磁盘已安装版本（是否落后的唯一真相）。
			...(meta.pkgUrl === undefined ? {} : { pkgUrl: meta.pkgUrl }),
			...(meta.repo === undefined ? {} : { repository: `https://github.com/${meta.repo}` })
		},
		...(getPluginManager === undefined ? {} : { getPluginManager }),
		...(getProfile === undefined ? {} : { getProfile }),
		...(getProfileName === undefined ? {} : { getProfileName }),
		...(fetchImpl === undefined ? {} : { fetchImpl }),
		runPnpmView: runPnpmView ?? defaultPnpmView(getProfile),
		...(now === undefined ? {} : { now }),
		cacheTtlMs: CACHE_TTL_MS
	});

	async function check({ fresh = false }: { fresh?: boolean } = {}): Promise<PluginCheckResult> {
		const view = await updater.check({ fresh });
		return {
			packageName: view.packageName,
			currentVersion: view.currentVersion,
			runtimeVersion: view.runtimeVersion,
			latestVersion: view.latestVersion,
			updateAvailable: view.updateAvailable,
			restartRequired: Boolean(view.restartRequired),
			checkFailed: view.checkFailed,
			manualCommand: view.manualCommand
		};
	}

	return { check };
}

/** 手动更新命令（旧签名：`meta` + profile 名）。 */
export function manualCommand(meta: PluginMeta, profileName: string | null = null): string {
	return kitManualCommand(meta.name, profileName);
}

/** 安装副本的当前版本（每次重新读文件：更新后同一进程内也能读到新值）。 */
export function readInstalledVersion(): string {
	return kitReadInstalledVersion({ pkgUrl: new URL("../package.json", import.meta.url) });
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
