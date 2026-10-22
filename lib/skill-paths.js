/**
 * 路径解析：把 `$DSH_HOME` / `$DSH_AGENTS_HOME` / `$XDG_STATE_HOME` 收敛成一处。
 *
 * 注意 canonical 技能目录固定是 `<home>/.agents/skills`，**不读** `$DSH_AGENTS_HOME`：
 * `skills` CLI 的 universal 全局落点由 `getCanonicalSkillsDir()` 硬编码为
 * `homedir()/.agents/skills`（上游 dist 已核对），本插件只是它的适配层。
 * dsh 侧若自定义了 `$DSH_AGENTS_HOME`，技能仍通过 `$DSH_HOME/skills` 的软链被看见。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveDshHome(env = process.env) {
	const raw = env.DSH_HOME?.trim();
	return raw && raw.length > 0 ? raw : join(homedir(), ".dsh");
}

/** 共享 agent 配置根；与 dsh 的 `agentsHome` 对齐，仅用于定位/诊断，不用于装 CLI。 */
export function resolveAgentsHome(env = process.env) {
	const raw = env.DSH_AGENTS_HOME?.trim();
	return raw && raw.length > 0 ? raw : join(homedir(), ".agents");
}

/** `skills` CLI 的 canonical 全局技能目录（`-g -a universal` 的落点）。 */
export function resolveCanonicalSkillsDir() {
	return join(homedir(), ".agents", "skills");
}

/** `skills` CLI 的全局 lock 文件路径（与上游 getSkillLockPath 一致）。 */
export function resolveLockPath(env = process.env) {
	const stateHome = env.XDG_STATE_HOME?.trim();
	return stateHome && stateHome.length > 0
		? join(stateHome, "skills", ".skill-lock.json")
		: join(homedir(), ".agents", ".skill-lock.json");
}

/** 一次解析出所有技能路径，避免各流程重复拼 `join(home, "skills")`。 */
export function skillPaths(env = process.env) {
	const dshHome = resolveDshHome(env);
	return {
		dshHome,
		agentsHome: resolveAgentsHome(env),
		dshSkillsDir: join(dshHome, "skills"),
		canonicalSkillsDir: resolveCanonicalSkillsDir(),
		lockPath: resolveLockPath(env),
	};
}
