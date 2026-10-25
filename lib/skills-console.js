/**
 * 技能控制台（`@morehao/dsh-skills-console`）的只读探测层。
 *
 * 设计约束（见 `.dsh/docs/specs/2026-10-25-skill-init-design.md` Part A）：
 * - **只读**：只读 console `state.json` 的 `installs[].name` / `mode`，不写 state、不调 HTTP、
 *   不 import console 源码；console 不存在时残留记录一律忽略。
 * - **可降级**：包探测/state 读取失败返回 `null`（未知），由调用方按 A4 矩阵决定走 CLI 还是 blocked。
 * - **可注入**：`detectConsole(env, { resolvePackage })` 与 `resolveOwnership(name, { consolePresent, state })`
 *   都允许测试注入，不依赖真实安装。
 */
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { resolveDshHome } from "./skill-paths.js";

const CONSOLE_PACKAGE = "@morehao/dsh-skills-console/package.json";
/** console state 的上限：超过即视为不可读（防止把日志/数据库误当 state 全量读进内存）。 */
const MAX_STATE_BYTES = 1024 * 1024;
const BACKENDS = new Set(["auto", "console", "cli"]);

const require = createRequire(import.meta.url);

/**
 * console 是否装在当前 DSH profile。
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ resolvePackage?: () => string }} [options]
 * @returns {boolean | null} `null` = 无法判断（解析出了非"找不到包"的错误）
 */
export function detectConsole(env = process.env, { resolvePackage } = {}) {
	const resolve = resolvePackage ?? (() => require.resolve(CONSOLE_PACKAGE));
	try {
		resolve();
		return true;
	} catch (error) {
		const code = error?.code;
		if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
			return false;
		}
		return null;
	}
}

/** `DSH_SKILLS_CONSOLE_HOME/state.json`，未设置时 `$DSH_HOME/skills-console/state.json`。 */
export function consoleStatePath(env = process.env) {
	const home = env.DSH_SKILLS_CONSOLE_HOME?.trim();
	return home && home.length > 0 ? join(home, "state.json") : join(resolveDshHome(env), "skills-console", "state.json");
}

/**
 * 只读 console state。
 *
 * 文件不存在、不可读、JSON 损坏、`installs` 不是数组、超过 1 MiB → `null`（无记录）。
 * 不校验 `version`；只保留 `name` / `mode`（缺失/非法按 `on` 保守处理）。
 *
 * @returns {Promise<{ path: string, installs: Array<{ name: string, mode: "on"|"off" }> } | null>}
 */
export async function readConsoleState(env = process.env) {
	const path = consoleStatePath(env);
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_STATE_BYTES) return null;
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.installs)) return null;
		const installs = [];
		for (const entry of parsed.installs) {
			if (entry === null || typeof entry !== "object" || typeof entry.name !== "string" || entry.name.length === 0) continue;
			installs.push({ name: entry.name, mode: entry.mode === "off" ? "off" : "on" });
		}
		return { path, installs };
	} catch {
		return null;
	}
}

/**
 * `DSH_COMMANDS_SKILL_BACKEND=auto|console|cli`；非法值按 `auto`。
 * @returns {"auto" | "console" | "cli"}
 */
export function backendOf(env = process.env) {
	const raw = env.DSH_COMMANDS_SKILL_BACKEND?.trim().toLowerCase();
	return raw !== undefined && BACKENDS.has(raw) ? raw : "auto";
}

/** 非法 backend 的提示（为空表示配置合法）。 */
export function backendWarning(env = process.env) {
	const raw = env.DSH_COMMANDS_SKILL_BACKEND?.trim().toLowerCase();
	return raw !== undefined && raw.length > 0 && !BACKENDS.has(raw)
		? `DSH_COMMANDS_SKILL_BACKEND=${raw} 不是合法值（auto/console/cli），已按 auto 处理。`
		: "";
}

/**
 * 单个技能的所有权判定（A4 矩阵）。
 *
 * @param {string} name
 * @param {{
 *   backend?: "auto" | "console" | "cli",
 *   consolePresent?: boolean,
 *   state?: { installs: Array<{ name: string, mode: "on"|"off" }> } | null,
 * }} options
 * @returns {{
 *   owner: "console" | "self",
 *   mode: "on" | "off" | null,
 *   evidence: "backend" | "absent" | "package" | "package+state" | "state-unreadable",
 *   reason: string,
 *   blocked: boolean,
 * }}
 */
export function resolveOwnership(name, { backend = "auto", consolePresent = false, state = null } = {}) {
	const record = state?.installs?.find((entry) => entry.name === name) ?? null;
	const mode = record?.mode ?? null;

	if (backend === "cli") {
		return { owner: "self", mode: null, evidence: "backend", reason: "已强制 CLI 后端", blocked: false };
	}

	if (backend === "console") {
		if (consolePresent !== true) {
			return {
				owner: "console",
				mode,
				evidence: "backend",
				reason: "后端设为 console，但未探测到技能控制台；请先安装/启用控制台，或切回 cli",
				blocked: true,
			};
		}
		if (state === null) {
			return {
				owner: "console",
				mode,
				evidence: "state-unreadable",
				reason: "后端设为 console，但控制台状态不可读；请修复控制台状态，或切回 cli",
				blocked: true,
			};
		}
		if (record === null) {
			return {
				owner: "console",
				mode: null,
				evidence: "package+state",
				reason: "后端设为 console，但控制台尚未纳管该技能；请先在控制台安装",
				blocked: true,
			};
		}
		return { owner: "console", mode, evidence: "backend", reason: mode === "off" ? "控制台已停用" : "由控制台管理", blocked: false };
	}

	// auto
	if (consolePresent !== true) {
		return { owner: "self", mode: null, evidence: "absent", reason: "未安装技能控制台", blocked: false };
	}
	if (state === null) {
		return { owner: "self", mode: null, evidence: "state-unreadable", reason: "控制台状态不可读，按 CLI 管理", blocked: false };
	}
	if (record === null) {
		return { owner: "self", mode: null, evidence: "package+state", reason: "控制台未纳管该技能", blocked: false };
	}
	return { owner: "console", mode, evidence: "package+state", reason: mode === "off" ? "控制台已停用" : "由控制台管理", blocked: false };
}
