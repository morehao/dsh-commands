#!/usr/bin/env node
// 跨仓契约校验：「命令 → 技能分支」在拆仓后变成跨仓隐式关系。
// 技能改分支名而插件没跟，命令还能点、结果不对 —— 这里把这种漂移变成可执行的失败。
//
// 读取 lib/index.js 导出的 COMMANDS，对每条命令检查 $DSH_HOME/skills/<skill>：
//   - 技能目录与 SKILL.md 必须存在（缺技能 = 插件在这个环境里跑不起来）
//   - 多分支技能（有 references/）：references/<branch>.md 必须存在
//   - 单分支技能（无 references/，如 handoff）：只校验 SKILL.md 存在
//     （handoff 的 branch: "print" 是装饰性的，SKILL.md 里没有 print 字样，属既有不对称，
//       不要为了通过校验去改 handoff 的文案）
//
// 技能目录：DSH_HOME 优先，默认 ~/.dsh/skills。
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { COMMANDS } from "../lib/index.js";

const root = process.env.DSH_HOME
	? join(process.env.DSH_HOME, "skills")
	: join(homedir(), ".dsh", "skills");

const exists = (p) => access(p).then(() => true, () => false);

let bad = 0;
for (const c of COMMANDS) {
	const skill = c.skill ?? "git-kit";
	const skillDir = join(root, skill);
	const skillMd = join(skillDir, "SKILL.md");
	let md;
	try {
		md = await readFile(skillMd, "utf8");
	} catch {
		console.error(`✗ 缺少技能：${skill}（${skillMd}）`);
		bad++;
		continue;
	}

	if (await exists(join(skillDir, "references"))) {
		const ref = join(skillDir, "references", `${c.branch}.md`);
		if (!(await exists(ref))) {
			console.error(`✗ /${c.name} → ${skill}#${c.branch}：缺 ${ref}`);
			bad++;
		}
	} else if (!md.includes(c.branch)) {
		// 单分支技能不把 branch 当契约键：handoff 的 branch: "print" 是装饰性的
		// （SKILL.md 里没有 print 字样，整篇就是该分支）。这里只提示、不判失败。
		console.log(`· /${c.name} → ${skill}#${c.branch}：单分支技能，仅校验 SKILL.md 存在`);
	}
}

console.log(
	bad
		? `契约校验失败：${bad} 项（技能根目录：${root}）`
		: `契约校验通过：${COMMANDS.length} 条命令（技能根目录：${root}）`,
);
process.exit(bad ? 1 : 0);
