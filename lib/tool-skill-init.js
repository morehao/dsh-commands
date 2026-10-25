/**
 * `skill_init` 工具：把 observe/plan/confirm/apply/verify 包成一次 dsh 工具调用。
 *
 * 设计约束（`.dsh/docs/specs/2026-10-25-skill-init-design.md` Part B/C）：
 * - 本文件是**纯定义**：不 import `@deepseek-ai/*`，测试直接 `createSkillInitTool()` 调 `execute`。
 * - 服务在 `execute` 时解析（P0 实测：`ctx.get("userQuestions")` 在 apply 阶段是 undefined）。
 * - 无确认通道且 `yes !== true` → 只返回 plan，零写（B2）；不再 pass-through 执行。
 * - 写盘只发生在 `applyPlan`；plan/confirm/指纹/verify 都零写。
 */
import { detectConsole, readConsoleState } from "./skills-console.js";
import { confirmSkillPlan } from "./skill-confirm.js";
import { runInJob } from "./job-progress.js";
import {
	EnvironmentChangedError,
	applyPlan,
	checkContract,
	observeSkills,
	planOperation,
	probeUpstream,
	referencedSkills,
	verifyPlan
} from "./skill-setup.js";

const ZERO_VERIFICATION = Object.freeze({ canonical: "0/0", links: "0/0", state: "unchanged", problems: [] });
const STATUS_ICON = Object.freeze({
	ok: "✓",
	changed: "✅",
	attention: "⚠",
	blocked: "⛔",
	cancelled: "·",
	error: "✗",
	plan: "…"
});
const ACTION_LABEL = Object.freeze({
	install: "安装",
	update: "更新",
	relink: "重建软链",
	delegate: "交给控制台",
	blocked: "阻断",
	skip: "跳过",
	warn: "提示"
});

const firstLine = (error) => {
	const message = error instanceof Error ? error.message : String(error);
	return message.split("\n")[0]?.trim() ?? "";
};

const dedupe = (items) => [...new Set(items.filter((item) => typeof item === "string" && item.length > 0))];

/** 写盘范围只由 action 决定；delegate/blocked/skip/warn 永远零写。 */
export function planHasWrites(plan) {
	return (plan?.actions ?? []).some((action) => action.writes === true);
}

/** `只补缺失`：非 missing 的 install / relink 降级为 skip，并重算 confirm。 */
export function narrowToMissing(plan) {
	const actions = (plan.actions ?? []).map((action) => {
		if (action.type === "install" && action.reason === "missing") return action;
		if (action.type === "install" || action.type === "relink") {
			return { ...action, type: "skip", writes: false, detail: "本次只补缺失，跳过", reason: "missing-only" };
		}
		return action;
	});
	const installs = actions.filter((action) => action.type === "install").length;
	const relinks = actions.filter((action) => action.type === "relink").length;
	return {
		...plan,
		actions,
		confirm: {
			...(plan.confirm ?? {}),
			installs,
			relinks,
			needs: installs + relinks > 0
		}
	};
}

/** plan 阶段与执行后快照的指纹：只比写盘涉及的技能（分类/链目标/canonical 存在性）。 */
export function fingerprintDiff(plan, after) {
	const afterByName = new Map((after?.skills ?? []).map((skill) => [skill.name, skill]));
	for (const action of plan.actions ?? []) {
		if (action.writes !== true) continue;
		const before = (plan.observed?.skills ?? []).find((skill) => skill.name === action.name);
		const now = afterByName.get(action.name);
		if (before === undefined || now === undefined) continue;
		if (before.link.kind !== now.link.kind) return `${action.name} 的链状态已变化`;
		if (before.link.target !== now.link.target) return `${action.name} 的链目标已变化`;
		if (before.canonical.ok !== now.canonical.ok) return `${action.name} 的 canonical 状态已变化`;
	}
	return undefined;
}

/** action → 结果 status；apply 未跑时标 planned。 */
function mergeActions(plan, applied) {
	const linkResults = new Map((applied?.linkResults ?? []).map((result) => [result.name, result]));
	const updated = new Map((applied?.updated ?? []).map((item) => [item.name, item]));
	const installed = new Set(applied?.toInstall ?? []);
	return (plan?.actions ?? []).map((action) => {
		const detail = action.detail ?? "";
		const base = { name: action.name, action: action.type, status: "skipped", detail };
		if (action.type === "install") {
			if (applied === undefined) return { ...base, status: "planned" };
			if (!installed.has(action.name)) return { ...base, status: "skipped" };
			const link = linkResults.get(action.name);
			if (link?.kind === "no-canonical") return { ...base, status: "failed", detail: "canonical 缺失，安装未完成" };
			if (link?.kind === "refused") return { ...base, status: "warn", detail: "真实目录/文件保留，未覆盖" };
			if (link?.kind === "linked-new") return { ...base, status: "changed", detail: "已安装并链入" };
			if (link?.kind === "linked-replaced") return { ...base, status: "changed", detail: "已安装并替换为托管链" };
			return { ...base, status: "changed", detail: "已安装（链未变）" };
		}
		if (action.type === "update") {
			if (applied === undefined) return { ...base, status: "planned" };
			const item = updated.get(action.name);
			if (item?.error !== undefined) return { ...base, status: "failed", detail: `软链重建失败：${item.error}` };
			if (item?.rebuilt === true) return { ...base, status: "changed", detail: `已更新，软链已重建 → ${item.canonical}` };
			return { ...base, status: "changed", detail: "已更新到最新" };
		}
		if (action.type === "relink") {
			if (applied === undefined) return { ...base, status: "planned" };
			const link = linkResults.get(action.name);
			if (link?.kind === "linked-new" || link?.kind === "linked-replaced") {
				return { ...base, status: "changed", detail: "软链已重建" };
			}
			if (link?.kind === "refused" || link?.kind === "no-canonical") return { ...base, status: "failed", detail: "软链重建失败" };
			return { ...base, status: "changed", detail: "软链已就绪" };
		}
		if (action.type === "delegate") return { ...base, status: "delegated" };
		if (action.type === "blocked") return { ...base, status: "blocked" };
		if (action.type === "warn") return { ...base, status: "warn" };
		return { ...base, status: "skipped" };
	});
}

/** 结果状态优先级：取消/plan/error 由调用方直接给出，这里是执行后的判定。 */
function finalStatus({ resultActions, applied, probeError, probeChanged = [], contract, verification, writes }) {
	if (probeError !== undefined) return "attention";
	if (writes !== true && probeChanged.length > 0) return "attention";
	if (resultActions.some((action) => action.status === "failed")) return "attention";
	if ((verification?.problems ?? []).length > 0) return "attention";
	const blocked = resultActions.filter((action) => action.status === "blocked");
	if (blocked.length > 0) return writes === true ? "attention" : "blocked";
	if (writes === true) return "changed";
	if (resultActions.some((action) => action.status === "warn" || action.status === "blocked")) return "attention";
	if ((contract?.problems ?? []).length > 0) return "attention";
	return "ok";
}

function buildNext({ plan, resultActions, applied, probeError, probeChanged = [], contract, verification, fallbackReason }) {
	const next = [];
	const delegated = (resultActions ?? []).filter((action) => action.status === "delegated");
	if (delegated.length > 0) {
		const off = delegated.filter((action) => /停用/.test(action.detail));
		const on = delegated.filter((action) => !/停用/.test(action.detail));
		if (on.length > 0) next.push(`${on.map((action) => action.name).join("、")} 由技能控制台管理，请在控制台更新/启停`);
		if (off.length > 0) {
			next.push(`${off.map((action) => action.name).join("、")} 已在控制台停用；如需 CLI 管理请设 DSH_COMMANDS_SKILL_BACKEND=cli`);
		}
	}
	for (const action of resultActions) {
		if (action.status === "blocked") next.push(action.detail);
	}
	const changedWarn = (plan?.actions ?? []).some((action) => action.type === "warn" && action.reason === "changed");
	if (changedWarn) next.push("运行 /skill-init --update 更新上游变更（或调用 skill_init mode=update）");
	if (probeChanged.length > 0) {
		next.push(`运行 /skill-init --update ${probeChanged.join(" ")} 更新上游变更（或 skill_init mode=update + names）`);
	}
	if (probeError !== undefined) next.push(`上游检查失败：${firstLine(probeError)}；可稍后重试 /skill-init --update`);
	for (const problem of contract?.problems ?? []) next.push(problem);
	for (const problem of verification?.problems ?? []) next.push(problem);
	if (fallbackReason !== undefined) next.push(`未启用后台作业（${fallbackReason}）；本次同步执行，结果不受影响`);
	if (applied?.installOutcome?.lockWarning !== undefined) next.push(`lock 来源回写失败：${applied.installOutcome.lockWarning}`);
	return dedupe(next).slice(0, 6);
}

function summaryOf(status, { plan, resultActions, applied, probeError, probeChanged = [], next }) {
	if (status === "blocked") return "执行被技能控制台阻断，未写盘";
	if (status === "attention") {
		const changed = (plan?.actions ?? []).filter((action) => action.type === "warn" && action.reason === "changed").length;
		if (probeError !== undefined) return "已安装，但上游检查失败";
		if (probeChanged.length > 0 && (applied?.toInstall?.length ?? 0) === 0) {
			return `上游有 ${probeChanged.length} 项更新（本次未安装）`;
		}
		if (changed > 0 && (applied?.toInstall?.length ?? 0) === 0) return `上游有 ${changed} 项更新（本次未安装）`;
		return `已完成，但有 ${next.length} 项需处理`;
	}
	if (status === "changed") {
		const count = (applied?.toInstall?.length ?? 0) + (applied?.updated?.length ?? 0);
		return `已完成：${count} 项变更`;
	}
	const delegated = (resultActions ?? []).filter((action) => action.status === "delegated");
	if (delegated.length > 0) return `由技能控制台管理：${delegated.map((action) => action.name).join("、")}`;
	return plan?.skipReason ?? "已就绪，无需变更";
}

/** 逐项 action 的紧凑行；routine skip 不刷屏。 */
function actionLines(resultActions, plan) {
	const lines = [];
	for (const action of resultActions) {
		if (action.status === "skipped" && action.action === "skip") continue;
		const label = ACTION_LABEL[action.action] ?? action.action;
		const suffix = action.detail.length > 0 ? ` — ${action.detail}` : "";
		lines.push(`· ${action.name}：${label}${suffix}`);
	}
	if (lines.length === 0 && (plan?.actions ?? []).length === 0) lines.push("· 无需处理任何技能");
	return lines;
}

function renderMarkdown(result) {
	const lines = [`${STATUS_ICON[result.status] ?? "·"} ${result.summary}`];
	lines.push(...actionLines(result.actions, result.plan));
	if (result.contract.problems.length > 0) {
		lines.push("契约问题：");
		for (const problem of result.contract.problems) lines.push(`· ${problem}`);
	} else {
		lines.push(`契约：${result.contract.commands} 条命令的分支文件齐全`);
	}
	if (result.verification.canonical !== "0/0" || result.verification.links !== "0/0") {
		lines.push(
			`验证：canonical ${result.verification.canonical} · links ${result.verification.links} · state ${result.verification.state}`
		);
	}
	if (result.next.length > 0) {
		lines.push("下一步：");
		for (const item of result.next) lines.push(`· ${item}`);
	}
	return lines.join("\n");
}

function makeResult({
	mode,
	status,
	plan,
	actions,
	contract,
	verification,
	warnings,
	next,
	commands,
	summary,
	requiresConfirmation
}) {
	const result = {
		mode,
		status,
		summary,
		actions: actions ?? [],
		contract: contract ?? { ok: true, problems: [], commands },
		verification: verification ?? { ...ZERO_VERIFICATION },
		warnings: dedupe(warnings ?? []),
		next: dedupe(next ?? []),
		markdown: ""
	};
	// `plan` 只用于内部组装 markdown，不属于输出协议。
	result.markdown = renderMarkdown({ ...result, plan });
	if (requiresConfirmation === true) result.requiresConfirmation = true;
	return result;
}

const contractOf = async (plan, commands, check) => {
	const problems = dedupe((await check(plan, commands)) ?? []);
	return { ok: problems.length === 0, problems, commands: commands.length };
};

function cancelledResult(plan, commands, { stopped = false } = {}) {
	return makeResult({
		mode: plan.mode ?? "init",
		status: "cancelled",
		plan,
		actions: mergeActions(plan, undefined),
		contract: { ok: true, problems: [], commands: commands.length },
		verification: { ...ZERO_VERIFICATION },
		warnings: [],
		next: stopped ? ["作业已停止；已完成的步骤保留在作业面板里，可重跑 /skill-init 续做。"] : [],
		commands,
		summary: stopped ? "已停止，未继续写盘" : "已取消，未做任何变更"
	});
}

/**
 * 创建 `skill_init` 的工具定义（纯对象）。
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   commands: Array<Record<string, unknown>>,
 *   services?: { userQuestions?: () => unknown, jobs?: () => unknown },
 *   runJob?: Function, observe?: Function, plan?: Function, apply?: Function,
 *   verify?: Function, confirm?: Function, probe?: Function, check?: Function,
 *   console?: { present: boolean, state: unknown } | (() => unknown | Promise<unknown>),
 * }} options
 */
export function createSkillInitTool({
	env = process.env,
	commands,
	services = {},
	runJob = runInJob,
	observe = observeSkills,
	plan = planOperation,
	apply = applyPlan,
	verify = verifyPlan,
	confirm = confirmSkillPlan,
	probe = probeUpstream,
	check = checkContract,
	console: consoleOption
} = {}) {
	if (!Array.isArray(commands) || commands.length === 0) {
		throw new Error("createSkillInitTool() 需要非空的 commands");
	}
	const allNames = referencedSkills(commands);
	const serviceOf = (name) => {
		const value = services?.[name];
		return typeof value === "function" ? value() : value;
	};
	const defaultConsole = async () => {
		const detected = detectConsole(env);
		const state = await readConsoleState(env);
		return { present: detected === true, state, unknown: detected === null };
	};
	const resolveConsole =
		consoleOption === undefined
			? defaultConsole
			: typeof consoleOption === "function"
				? consoleOption
				: async () => consoleOption;
	const noWriteResult = async (currentPlan, snapshot) => {
		const contract = await contractOf(currentPlan, commands, check);
		const resultActions = mergeActions(currentPlan, undefined);
		const status = finalStatus({
			resultActions,
			applied: undefined,
			probeError: undefined,
			contract,
			verification: ZERO_VERIFICATION,
			writes: false
		});
		const next = buildNext({
			plan: currentPlan,
			resultActions,
			applied: undefined,
			probeError: undefined,
			contract,
			verification: ZERO_VERIFICATION
		});
		return makeResult({
			mode: currentPlan.mode ?? "init",
			status,
			plan: currentPlan,
			actions: resultActions,
			contract,
			verification: { ...ZERO_VERIFICATION },
			warnings: snapshot?.warnings ?? [],
			next,
			commands,
			summary: summaryOf(status, { plan: currentPlan, resultActions, applied: undefined, probeError: undefined, next })
		});
	};
	const observeSnapshot = async () => {
		const hint = await resolveConsole();
		const snapshot = await observe(env, commands, {
			console: hint === undefined || hint === null ? undefined : { present: hint.present === true, state: hint.state ?? null }
		});
		if (hint?.unknown === true) snapshot.warnings.push("无法判断技能控制台是否安装，本次按 CLI 管理。");
		return snapshot;
	};

	const tool = {
		name: "skill_init",
		description:
			"检查/安装/修复本插件依赖的技能（git-kit、handoff、disk-cleanup），并校验命令分支契约。默认先确认再写盘；由 /skill-init 触发。",
		parameters: {
			mode: {
				type: "string",
				enum: ["init", "update", "check"],
				description: "init=检查并补齐（默认）；update=强制更新到上游最新；check=只读诊断，不联网"
			},
			names: {
				type: "array",
				items: { type: "string" },
				description: "只处理这些技能（update 时可省略；不支持的名字会直接报错且不写盘）"
			},
			yes: {
				type: "boolean",
				description: "仅在用户明确同意跳过确认时传 true（对应 /skill-init --yes）；不要自行推断"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					mode: { type: "string", required: true },
					status: { type: "string", required: true },
					summary: { type: "string", required: true },
					markdown: { type: "string", required: true },
					actions: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								name: { type: "string" },
								action: { type: "string" },
								status: { type: "string" },
								detail: { type: "string" }
							}
						}
					},
					contract: {
						type: "object",
						additionalProperties: true,
						properties: {
							ok: { type: "boolean" },
							commands: { type: "number" },
							problems: { type: "array", items: { type: "string" } }
						}
					},
					verification: {
						type: "object",
						additionalProperties: true,
						properties: {
							canonical: { type: "string" },
							links: { type: "string" },
							state: { type: "string" },
							problems: { type: "array", items: { type: "string" } }
						}
					},
					warnings: { type: "array", items: { type: "string" } },
					next: { type: "array", items: { type: "string" } },
					requiresConfirmation: { type: "boolean" }
				}
			},
			render: (_args, value) => [{ type: "text", text: typeof value?.markdown === "string" ? value.markdown : "" }]
		},
		async execute(args = {}, exec = {}) {
			const mode = args?.mode === "update" ? "update" : args?.mode === "check" ? "check" : "init";
			const names = Array.isArray(args?.names)
				? args.names.filter((name) => typeof name === "string" && name.trim().length > 0).map((name) => name.trim())
				: [];
			const yes = args?.yes === true;

			const unknown = names.filter((name) => !allNames.includes(name));
			if (unknown.length > 0) {
				return makeResult({
					mode,
					status: "attention",
					commands,
					summary: `未知技能：${unknown.join("、")}`,
					contract: { ok: true, problems: [], commands: commands.length },
					warnings: [`本插件只依赖：${allNames.join("、")}`],
					next: [`去掉未知技能后重试：${unknown.join("、")}`]
				});
			}

			try {
				let snapshot = await observeSnapshot();
				let currentPlan = await plan(mode, { names }, snapshot);
				const needsProbe = mode === "init" && snapshot.cache?.cacheSource === true && snapshot.cache?.stale === true;

				// 无写盘、也不需要只读探针：直接给结论（check / 已就绪 / blocked / 只有 warn）。
				if (!planHasWrites(currentPlan) && needsProbe !== true) {
					return await noWriteResult(currentPlan, snapshot);
				}

				let missingOnly = false;
				if (currentPlan.confirm?.needs === true && yes !== true) {
					const answer = await confirm({
						userQuestions: serviceOf("userQuestions"),
						agent: exec.agent,
						plan: currentPlan,
						signal: exec.signal,
						detail: renderPlanDetail(currentPlan),
						onError: "plan"
					});
					if (answer.action === "cancel") return cancelledResult(currentPlan, commands);
					if (answer.action === "plan") {
						const contract = await contractOf(currentPlan, commands, check);
						const resultActions = mergeActions(currentPlan, undefined);
						const next = buildNext({ plan: currentPlan, resultActions, applied: undefined, probeError: undefined, contract, verification: ZERO_VERIFICATION });
						return makeResult({
							mode,
							status: "plan",
							plan: currentPlan,
							actions: resultActions,
							contract,
							verification: { ...ZERO_VERIFICATION },
							warnings: [answer.note ?? "当前会话没有可用的确认通道"],
							next: dedupe(["在支持交互确认的会话中重试；或用户明确同意后传 yes=true。", ...next]),
							commands,
							summary: "需要确认，未写盘",
							requiresConfirmation: true
						});
					}
					if (answer.choice === "missing") {
						currentPlan = narrowToMissing(currentPlan);
						missingOnly = true;
					}
				}

				const effectiveProbe = needsProbe && missingOnly !== true;
				if (!planHasWrites(currentPlan) && effectiveProbe !== true) {
					return await noWriteResult(currentPlan, snapshot);
				}

				// 写前指纹：确认后、建作业前再观察一次，任何涉及技能变了就整次中止。
				if (planHasWrites(currentPlan)) {
					const after = await observeSnapshot();
					const diff = fingerprintDiff(currentPlan, after);
					if (diff !== undefined) {
						const resultActions = mergeActions(currentPlan, undefined);
						return makeResult({
							mode,
							status: "attention",
							plan: currentPlan,
							actions: resultActions,
							contract: { ok: true, problems: [], commands: commands.length },
							verification: { ...ZERO_VERIFICATION },
							warnings: [`环境已变化：${diff}`],
							next: ["请重新运行 /skill-init。"],
							commands,
							summary: "环境已变化，未写盘"
						});
					}
				}

				const writes = planHasWrites(currentPlan);
				const outcome = await runJob({
					jobs: serviceOf("jobs"),
					owner: exec.agent?.session?.id,
					kind: "skill-init",
					label: mode === "update" ? "更新依赖技能" : "检查依赖技能",
					signal: exec.signal,
					skip: writes || effectiveProbe ? undefined : currentPlan.skipReason,
					work: async (reporter, registerCancel) => {
						let probeResult;
						if (effectiveProbe) {
							reporter.progress("检查上游");
							probeResult = await probe(currentPlan, { env, reporter, signal: exec.signal });
						}
						const applied = writes
							? await apply(currentPlan, {
									env,
									reporter,
									signal: exec.signal,
									registerCancel,
									choice: missingOnly ? "missing" : "all",
									commands,
									probe: probeResult
								})
							: undefined;
						return { probe: probeResult, applied };
					}
				});

				if (outcome.killed === true) return cancelledResult(currentPlan, commands, { stopped: true });
				if (outcome.error !== undefined) {
					if (outcome.error instanceof EnvironmentChangedError) {
						return makeResult({
							mode,
							status: "attention",
							plan: currentPlan,
							actions: mergeActions(currentPlan, undefined),
							contract: { ok: true, problems: [], commands: commands.length },
							verification: { ...ZERO_VERIFICATION },
							warnings: [firstLine(outcome.error)],
							next: ["请重新运行 /skill-init。"],
							commands,
							summary: "环境已变化，未写盘"
						});
					}
					const tail = typeof outcome.outputTail === "string" ? outcome.outputTail.trim().slice(-1200) : "";
					return makeResult({
						mode,
						status: "error",
						plan: currentPlan,
						actions: mergeActions(currentPlan, undefined),
						contract: { ok: true, problems: [], commands: commands.length },
						verification: { ...ZERO_VERIFICATION },
						warnings: [firstLine(outcome.error), ...(tail.length > 0 ? [`最后输出：${tail}`] : [])],
						next: ["根据错误处理后重试 /skill-init --update（或 skill_init mode=update）"],
						commands,
						summary: `执行失败：${firstLine(outcome.error)}`
					});
				}

				const { probe: probeResult, applied } = outcome.value ?? {};
				const warnings = [...(snapshot.warnings ?? [])];
				if (outcome.fallbackReason !== undefined) warnings.push(`未启用后台作业：${outcome.fallbackReason}`);
				if (probeResult?.error !== undefined) warnings.push(`上游检查失败：${firstLine(probeResult.error)}`);
				if (applied?.installOutcome?.lockWarning !== undefined) {
					warnings.push(`lock 来源回写失败：${applied.installOutcome.lockWarning}`);
				}

				const contract =
					applied === undefined
						? await contractOf(currentPlan, commands, check)
						: {
								ok: (applied.failures?.length ?? 0) === 0,
								problems: dedupe(applied.failures ?? []),
								commands: commands.length
							};
				let verification = { ...ZERO_VERIFICATION };
				if (applied !== undefined) {
					const after = await observeSnapshot();
					verification = await verify(currentPlan, { env, snapshotAfter: after, commands });
				}
				const resultActions = mergeActions(currentPlan, applied);
				const probeChanged = probeResult?.changed ?? [];
				if (probeChanged.length > 0) {
					warnings.push(`上游有 ${probeChanged.length} 项更新：${probeChanged.join("、")}（本次未安装）`);
				}
				const status = finalStatus({
					resultActions,
					applied,
					probeError: probeResult?.error,
					probeChanged,
					contract,
					verification,
					writes
				});
				const next = buildNext({
					plan: currentPlan,
					resultActions,
					applied,
					probeError: probeResult?.error,
					probeChanged,
					contract,
					verification,
					fallbackReason: outcome.fallbackReason
				});
				return makeResult({
					mode,
					status,
					plan: currentPlan,
					actions: resultActions,
					contract,
					verification,
					warnings,
					next,
					commands,
					summary: summaryOf(status, { plan: currentPlan, resultActions, applied, probeError: probeResult?.error, probeChanged, next })
				});
			} catch (error) {
				if (error instanceof EnvironmentChangedError) {
					return makeResult({
						mode,
						status: "attention",
						commands,
						summary: "环境已变化，未写盘",
						warnings: [firstLine(error)],
						next: ["请重新运行 /skill-init。"]
					});
				}
				return makeResult({
					mode,
					status: "error",
					commands,
					summary: `执行失败：${firstLine(error)}`,
					warnings: [firstLine(error)],
					next: ["根据错误处理后重试 /skill-init --update（或 skill_init mode=update）"]
				});
			}
		}
	};
	return tool;
}

/** 确认卡 detail：逐技能计划 + 上游提示；不写“过程去哪看”。 */
export function renderPlanDetail(plan) {
	const actions = plan.actions ?? [];
	const counts = {
		install: actions.filter((action) => action.type === "install").length,
		relink: actions.filter((action) => action.type === "relink").length,
		update: actions.filter((action) => action.type === "update").length
	};
	const lines = [`计划：安装 ${counts.install}、修链 ${counts.relink}${counts.update > 0 ? `、更新 ${counts.update}` : ""}`];
	for (const action of actions) {
		if (action.type === "skip" && action.reason === "managed") continue;
		const label = ACTION_LABEL[action.type] ?? action.type;
		const detail = typeof action.detail === "string" ? action.detail : "";
		lines.push(`· ${action.name}：${label}${detail.length > 0 ? ` — ${detail}` : ""}`);
	}
	const changed = actions.filter((action) => action.type === "warn" && action.reason === "changed");
	if (changed.length > 0) {
		lines.push(`上游更新（本次不安装）：${changed.map((action) => action.name).join("、")}；要更新请运行 /skill-init --update`);
	}
	lines.push("取消不会产生任何变更。");
	return lines.join("\n");
}
