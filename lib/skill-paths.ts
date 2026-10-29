/**
 * 路径解析：把 `$DSH_HOME` / `$DSH_AGENTS_HOME` / `$XDG_STATE_HOME` 收敛成一处。
 *
 * 注意 canonical 技能目录固定是 `<home>/.agents/skills`，**不读** `$DSH_AGENTS_HOME`：
 * `skills` CLI 的 universal 全局落点由 `getCanonicalSkillsDir()` 硬编码为
 * `homedir()/.agents/skills`（上游 dist 已核对），本插件只是它的适配层。
 * agent-skills 自 2026-10-23 起把这里当「本源」：`skills-install.sh` 用 skills CLI
 * 从编辑源发布到这里，`skills-fanout.sh` 再把它软链进各 agent 目录（含 `$DSH_HOME/skills`）。
 * 所以「dsh 看得见」至少有两条路径，读取技能时必须按同一个根顺序找，不能只看软链层。
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

/**
 * dsh 实际会扫描的用户技能根，按「本地优先」排列：
 * `$DSH_HOME/skills` → `$DSH_AGENTS_HOME/skills` → 本源 `~/.agents/skills`。
 *
 * 委托型命令的预检（`lib/index.js`）与契约校验（`scripts/check-skill-contract.mjs`）
 * 必须共用这份顺序：本源安装（只跑过 `skills-install.sh`、没有 fanout 软链）时，
 * 技能只存在于最后一个根，任何只看 `$DSH_HOME/skills` 的判定都会误报「未安装」。
 */
export function skillRoots(env = process.env) {
	const paths = skillPaths(env);
	// `$DSH_AGENTS_HOME` 未设置时第二个根就是本源，去重避免重复检查/重复报路径。
	return [...new Set([paths.dshSkillsDir, join(paths.agentsHome, "skills"), paths.canonicalSkillsDir])];
}
