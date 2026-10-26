#!/usr/bin/env node
// 跨仓契约校验：「命令 → 技能分支」在拆仓后变成跨仓隐式关系。
// 技能改分支名而插件没跟，命令还能点、结果不对 —— 这里把这种漂移变成可执行的失败。
//
// 技能根与运行期预检共用 `skillRoots()`（`lib/skill-paths.js`）：
//   `$DSH_HOME/skills` → `$DSH_AGENTS_HOME/skills` → 本源 `~/.agents/skills`
// agent-skills 自 2026-10-23（#50）起把本源当真实内容、`$DSH_HOME/skills` 只是
// `skills-fanout.sh` 建的软链层；只查软链层会在「发了本源、还没 fanout」的机器上误报缺失。
//
// 规则：
//   - 技能目录与 SKILL.md 必须存在（缺技能 = 插件在这个环境里跑不起来），按技能去重报错
//   - 多分支技能（有 references/）：references/<branch>.md 必须存在
//   - 单分支技能（无 references/，如 handoff）：只校验 SKILL.md 存在
//     （handoff 的 branch: "print" 是装饰性的，SKILL.md 里没有 print 字样，属既有不对称，
//       不要为了通过校验去改 handoff 的文案）
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { COMMANDS } from "../lib/index.js";
import { skillRoots } from "../lib/skill-paths.js";

const roots = skillRoots(process.env);

const exists = (p) => access(p).then(() => true, () => false);

/** 按技能归组，保持 COMMANDS 的声明顺序（git-kit 的 9 条命令只报一次缺技能）。 */
const bySkill = new Map();
for (const command of COMMANDS) {
	const skill = command.skill ?? "git-kit";
	if (!bySkill.has(skill)) bySkill.set(skill, []);
	bySkill.get(skill).push(command);
}

/** 在 dsh 实际扫描的技能根里找该技能；返回第一个含 SKILL.md 的目录。 */
async function locate(skill) {
	for (const root of roots) {
		const dir = join(root, skill);
		try {
			await access(join(dir, "SKILL.md"));
			return dir;
		} catch (error) {
			// 只有"确实不存在"才继续找下一个根；权限等异常按已安装放行（与运行期预检一致），
			// 读取失败会在下面报成明确错误。
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return dir;
		}
	}
	return undefined;
}

let bad = 0;
const resolved = [];

for (const [skill, commands] of bySkill) {
	const dir = await locate(skill);
	if (dir === undefined) {
		bad += 1;
		console.error(`✗ 缺少技能：${skill}（已查 ${roots.length} 个根）`);
		for (const root of roots) console.error(`    ${join(root, skill, "SKILL.md")}`);
		continue;
	}
	resolved.push({ skill, dir, commands: commands.length });

	let md;
	try {
		md = await readFile(join(dir, "SKILL.md"), "utf8");
	} catch (error) {
		bad += 1;
		console.error(`✗ 无法读取技能文件：${join(dir, "SKILL.md")}（${error instanceof Error ? error.message : String(error)}）`);
		continue;
	}

	let hasReferences = false;
	try {
		hasReferences = (await stat(join(dir, "references"))).isDirectory();
	} catch {
		hasReferences = false;
	}

	if (!hasReferences) {
		for (const command of commands) {
			// 单分支技能不把 branch 当契约键：只提示、不判失败（见文件头）。
			if (!md.includes(command.branch)) {
				console.log(`· /${command.name} → ${skill}#${command.branch}：单分支技能，仅校验 SKILL.md 存在`);
			}
		}
		continue;
	}

	for (const command of commands) {
		const ref = join(dir, "references", `${command.branch}.md`);
		if (!(await exists(ref))) {
			bad += 1;
			console.error(`✗ /${command.name} → ${skill}#${command.branch}：缺 ${ref}`);
		}
	}
}

for (const entry of resolved) {
	console.log(`· ${entry.skill} → ${entry.dir}（${entry.commands} 条命令）`);
}

console.log(
	bad
		? `契约校验失败：${bad} 项（已查技能根：${roots.join(" → ")}）`
		: `契约校验通过：${COMMANDS.length} 条命令 / ${bySkill.size} 个技能（技能根：${roots.join(" → ")}）`,
);
process.exit(bad ? 1 : 0);
