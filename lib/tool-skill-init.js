/**
 * `skill_init` 工具：把 resolve-api / observe / plan / confirm / apply / verify 包成一次 dsh 工具调用。
 *
 * v1.0 起流程（设计 §6.2）：
 *   resolve api（只走包） → 旧 console 守卫 → apiVersion 校验
 *   → observe（api.list + canonical 文件存在性）→ adopt（canonical 有账本没有的）
 *   → plan（install / update / delegate / blocked）→ confirm → apply（api.install / api.update）
 *   → verify（重新 observe + 契约）
 *
 * 本文件是**纯定义**：不 import `@deepseek-ai/*`；测试直接 `createSkillInitTool()` 调 `execute`，
 * 并可注入 `resolveApi` / `observe` / `plan` / `apply` / `verify` / `confirm` / `check` / `runJob`。
 * 服务在 `execute` 时解析（P0 实测：`ctx.get("userQuestions")` 在 apply 阶段是 undefined）。
 */
import { resolveConsoleApi } from "./console-api.js";
import { confirmSkillPlan } from "./skill-confirm.js";
import { runInJob } from "./job-progress.js";
import {
  applyPlan,
  checkContract,
  narrowToMissing,
  observeSkills,
  planOperation,
  referencedSkills,
  verifyPlan,
} from "./skill-setup.js";

const ZERO_VERIFICATION = Object.freeze({ canonical: "0/0", links: "0/0", state: "unchanged", problems: [] });
const STATUS_ICON = Object.freeze({
  ok: "✓",
  changed: "✅",
  attention: "⚠",
  blocked: "⛔",
  cancelled: "·",
  error: "✗",
  plan: "…",
});
const ACTION_LABEL = Object.freeze({
  install: "安装",
  update: "更新",
  delegate: "交给控制台",
  blocked: "阻断",
  skip: "跳过",
  warn: "提示",
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

export { narrowToMissing };

/** action → 结果 status；apply 未跑时标 planned。 */
function mergeActions(plan, applied) {
  const installMap = new Map((applied?.installResults ?? []).map((item) => [item.name, item]));
  const updateMap = new Map((applied?.updateResults ?? []).map((item) => [item.name, item]));
  return (plan?.actions ?? []).map((action) => {
    const base = { name: action.name, action: action.type, status: "skipped", detail: action.detail ?? "" };
    if (action.type === "install") {
      if (applied === undefined) return { ...base, status: "planned" };
      const item = installMap.get(action.name);
      if (!item || item.status === "failed") return { ...base, status: "failed", detail: item?.message ?? "安装失败" };
      return { ...base, status: "changed", detail: "已安装" };
    }
    if (action.type === "update") {
      if (applied === undefined) return { ...base, status: "planned" };
      const item = updateMap.get(action.name);
      switch (item?.status) {
        case "updated":
          return { ...base, status: "changed", detail: "已更新到最新" };
        case "current":
          return { ...base, status: "skipped", detail: "已是最新" };
        case "locally-modified":
          return { ...base, status: "warn", detail: "本地有改动，未覆盖（确认后可 overwrite）" };
        case "parked":
          return { ...base, status: "delegated", detail: "已完全停用，请先去控制台恢复" };
        case "no-subscription":
          return { ...base, status: "failed", detail: "没有可用的更新来源（无订阅）" };
        case "not-managed":
          return { ...base, status: "failed", detail: "没有安装记录" };
        default:
          return { ...base, status: "failed", detail: item?.message ?? "更新失败" };
      }
    }
    if (action.type === "delegate") return { ...base, status: "delegated" };
    if (action.type === "blocked") return { ...base, status: "blocked" };
    if (action.type === "warn") return { ...base, status: "warn" };
    return { ...base, status: "skipped" };
  });
}

function finalStatus({ resultActions, writes }) {
  if (resultActions.some((action) => action.status === "failed")) return "attention";
  if (writes) {
    if (resultActions.some((action) => action.status === "warn" || action.status === "delegated")) return "attention";
    return "changed";
  }
  if (resultActions.some((action) => action.status === "blocked")) return "blocked";
  if (resultActions.some((action) => action.status === "warn" || action.status === "delegated")) return "attention";
  return "ok";
}

function buildNext({ resultActions, contract, verification }) {
  const next = [];
  const delegated = resultActions.filter((action) => action.status === "delegated");
  if (delegated.length > 0) next.push(`${delegated.map((action) => action.name).join("、")} 由技能控制台管理，请在控制台启用/切自动后重试`);
  for (const action of resultActions) {
    if (action.status === "blocked") next.push(action.detail);
    if (action.status === "warn") next.push(`${action.name}：${action.detail}`);
  }
  for (const problem of contract?.problems ?? []) next.push(problem);
  for (const problem of verification?.problems ?? []) next.push(problem);
  return dedupe(next).slice(0, 6);
}

function summaryOf(status, { plan, resultActions, applied, next }) {
  if (status === "blocked") return "执行被技能控制台阻断，未写盘";
  if (status === "attention") {
    const changed = resultActions.filter((action) => action.status === "changed").length;
    if (changed === 0 && (applied?.toInstall?.length ?? 0) === 0 && (applied?.toUpdate?.length ?? 0) === 0) {
      const delegated = resultActions.filter((action) => action.status === "delegated").length;
      if (delegated > 0) return `由技能控制台管理：${resultActions.filter((a) => a.status === "delegated").map((a) => a.name).join("、")}`;
    }
    return `已完成，但有 ${next.length} 项需处理`;
  }
  if (status === "changed") {
    const count = (applied?.toInstall?.length ?? 0) + (applied?.toUpdate?.length ?? 0);
    return `已完成：${count} 项变更`;
  }
  const delegated = resultActions.filter((action) => action.status === "delegated");
  if (delegated.length > 0) return `由技能控制台管理：${delegated.map((action) => action.name).join("、")}`;
  return plan?.skipReason ?? "已就绪，无需变更";
}

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
  if (result.verification.canonical !== "0/0") {
    lines.push(`验证：canonical ${result.verification.canonical}`);
  }
  if (result.next.length > 0) {
    lines.push("下一步：");
    for (const item of result.next) lines.push(`· ${item}`);
  }
  return lines.join("\n");
}

function makeResult({ mode, status, plan, actions, contract, verification, warnings, next, commands, summary, requiresConfirmation }) {
  const result = {
    mode,
    status,
    summary,
    actions: actions ?? [],
    contract: contract ?? { ok: true, problems: [], commands },
    verification: verification ?? { ...ZERO_VERIFICATION },
    warnings: dedupe(warnings ?? []),
    next: dedupe(next ?? []),
    markdown: "",
  };
  result.markdown = renderMarkdown({ ...result, plan });
  if (requiresConfirmation === true) result.requiresConfirmation = true;
  return result;
}

function blockedResolveResult(mode, error, commands) {
  const code = error?.code;
  const summary =
    code === "old-console"
      ? "检测到旧版技能控制台，请先升级后再运行 /skill-init"
      : code === "incompatible-api"
        ? "技能控制台 API 版本不兼容"
        : code === "api-failed"
          ? "技能控制台初始化失败"
          : "未找到技能控制台包";
  const next =
    code === "old-console"
      ? ["把技能控制台升级到 0.7.0+ 后重试 /skill-init"]
      : code === "incompatible-api"
        ? ["升级技能控制台或本插件后重试 /skill-init"]
        : ["安装技能控制台包：npm i @morehao/dsh-skills-console", "或启用技能控制台插件后重试 /skill-init"];
  return makeResult({
    mode,
    status: "blocked",
    commands,
    summary,
    actions: [],
    contract: { ok: true, problems: [], commands: commands.length },
    verification: { ...ZERO_VERIFICATION },
    warnings: [error?.message ?? String(error)],
    next,
  });
}

const contractOf = async (plan, commands, check, snapshot) => {
  const problems = dedupe((await check(plan, commands, snapshot)) ?? []);
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
    summary: stopped ? "已停止，未继续写盘" : "已取消，未做任何变更",
  });
}

/**
 * 创建 `skill_init` 的工具定义（纯对象）。
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   commands: Array<Record<string, unknown>>,
 *   services?: { userQuestions?: () => unknown, jobs?: () => unknown },
 *   runJob?: Function, resolveApi?: Function, observe?: Function, plan?: Function,
 *   apply?: Function, verify?: Function, confirm?: Function, check?: Function,
 * }} options
 */
export function createSkillInitTool({
  env = process.env,
  commands,
  services = {},
  runJob = runInJob,
  resolveApi = resolveConsoleApi,
  observe = observeSkills,
  plan = planOperation,
  apply = applyPlan,
  verify = verifyPlan,
  confirm = confirmSkillPlan,
  check = checkContract,
} = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("createSkillInitTool() 需要非空的 commands");
  }
  const allNames = referencedSkills(commands);
  const serviceOf = (name) => {
    const value = services?.[name];
    return typeof value === "function" ? value() : value;
  };

  const tool = {
    name: "skill_init",
    description:
      "检查/安装/更新本插件依赖的技能（git-kit、handoff、disk-cleanup），并校验命令分支契约。默认先确认再写盘；由 /skill-init 触发。",
    parameters: {
      mode: {
        type: "string",
        enum: ["init", "update", "check"],
        description: "init=检查并补齐（默认）；update=更新到上游最新；check=只读诊断，不写盘",
      },
      names: {
        type: "array",
        items: { type: "string" },
        description: "只处理这些技能（update 时可省略；不支持的名字会直接报错且不写盘）",
      },
      yes: {
        type: "boolean",
        description: "仅在用户明确同意跳过确认时传 true（对应 /skill-init --yes）；不要自行推断",
      },
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
                detail: { type: "string" },
              },
            },
          },
          contract: {
            type: "object",
            additionalProperties: true,
            properties: {
              ok: { type: "boolean" },
              commands: { type: "number" },
              problems: { type: "array", items: { type: "string" } },
            },
          },
          verification: {
            type: "object",
            additionalProperties: true,
            properties: {
              canonical: { type: "string" },
              links: { type: "string" },
              state: { type: "string" },
              problems: { type: "array", items: { type: "string" } },
            },
          },
          warnings: { type: "array", items: { type: "string" } },
          next: { type: "array", items: { type: "string" } },
          requiresConfirmation: { type: "boolean" },
        },
      },
      render: (_args, value) => [{ type: "text", text: typeof value?.markdown === "string" ? value.markdown : "" }],
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
          next: [`去掉未知技能后重试：${unknown.join("、")}`],
        });
      }

      // 1) 解析 api（只走包）；旧 console / API 缺失 / 版本不兼容 → blocked，零写。
      let api;
      try {
        ({ api } = await resolveApi({ env }));
      } catch (error) {
        return blockedResolveResult(mode, error, commands);
      }

      try {
        let snapshot = await observe(env, commands, { api });
        // canonical 有、账本没有 → adopt（只补记账），再刷新记录。
        if (mode !== "check" && api && typeof api.adopt === "function" && !snapshot.consoleError) {
          const toAdopt = snapshot.skills.filter((skill) => skill.canonical?.ok && !skill.console?.record).map((skill) => skill.name);
          if (toAdopt.length > 0) {
            let changed = false;
            for (const name of toAdopt) {
              try {
                const result = await api.adopt({ name });
                if (result && result.already !== true) changed = true;
              } catch {
                // adopt 失败不阻断后续
              }
            }
            if (changed) snapshot = await observe(env, commands, { api });
          }
        }

        let currentPlan = await plan(mode, { names }, snapshot);
        if (!planHasWrites(currentPlan)) {
          const contract = await contractOf(currentPlan, commands, check, snapshot);
          const resultActions = mergeActions(currentPlan, undefined);
          const status = finalStatus({ resultActions, writes: false });
          const next = buildNext({ resultActions, contract, verification: ZERO_VERIFICATION });
          return makeResult({
            mode,
            status,
            plan: currentPlan,
            actions: resultActions,
            contract,
            verification: { ...ZERO_VERIFICATION },
            warnings: snapshot.warnings ?? [],
            next,
            commands,
            summary: summaryOf(status, { plan: currentPlan, resultActions, applied: undefined, next }),
          });
        }

        let missingOnly = false;
        if (currentPlan.confirm?.needs === true && yes !== true) {
          const answer = await confirm({
            userQuestions: serviceOf("userQuestions"),
            agent: exec.agent,
            plan: currentPlan,
            signal: exec.signal,
            detail: renderPlanDetail(currentPlan),
            onError: "plan",
          });
          if (answer.action === "cancel") return cancelledResult(currentPlan, commands);
          if (answer.action === "plan") {
            const contract = await contractOf(currentPlan, commands, check, snapshot);
            const resultActions = mergeActions(currentPlan, undefined);
            const next = buildNext({ resultActions, contract, verification: ZERO_VERIFICATION });
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
              requiresConfirmation: true,
            });
          }
          if (answer.choice === "missing") {
            currentPlan = narrowToMissing(currentPlan);
            missingOnly = true;
          }
        }
        if (!planHasWrites(currentPlan)) {
          const contract = await contractOf(currentPlan, commands, check, snapshot);
          const resultActions = mergeActions(currentPlan, undefined);
          const status = finalStatus({ resultActions, writes: false });
          const next = buildNext({ resultActions, contract, verification: ZERO_VERIFICATION });
          return makeResult({
            mode,
            status,
            plan: currentPlan,
            actions: resultActions,
            contract,
            verification: { ...ZERO_VERIFICATION },
            warnings: snapshot.warnings ?? [],
            next,
            commands,
            summary: summaryOf(status, { plan: currentPlan, resultActions, applied: undefined, next }),
          });
        }

        const writes = planHasWrites(currentPlan);
        const outcome = await runJob({
          jobs: serviceOf("jobs"),
          owner: exec.agent?.session?.id,
          kind: "skill-init",
          label: mode === "update" ? "更新依赖技能" : "检查依赖技能",
          signal: exec.signal,
          skip: writes ? undefined : currentPlan.skipReason,
          work: async (reporter, registerCancel) => {
            const applied = await apply(currentPlan, { api, env, reporter, signal: exec.signal, registerCancel, commands });
            return { applied };
          },
        });

        if (outcome.killed === true) return cancelledResult(currentPlan, commands, { stopped: true });
        if (outcome.error !== undefined) {
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
            summary: `执行失败：${firstLine(outcome.error)}`,
          });
        }

        const applied = outcome.value?.applied;
        const snapshotAfter = await observe(env, commands, { api });
        const verification = await verify(currentPlan, { snapshotAfter, commands });
        const contract = await contractOf(currentPlan, commands, check, snapshotAfter);
        const resultActions = mergeActions(currentPlan, applied);
        const status = finalStatus({ resultActions, writes });
        const next = buildNext({ resultActions, contract, verification });
        return makeResult({
          mode,
          status,
          plan: currentPlan,
          actions: resultActions,
          contract,
          verification,
          warnings: snapshot.warnings ?? [],
          next,
          commands,
          summary: summaryOf(status, { plan: currentPlan, resultActions, applied, next }),
        });
      } catch (error) {
        return makeResult({
          mode,
          status: "error",
          commands,
          summary: `执行失败：${firstLine(error)}`,
          warnings: [firstLine(error)],
          next: ["根据错误处理后重试 /skill-init"],
        });
      }
    },
  };
  return tool;
}

/** 确认卡 detail：逐技能计划；不写“过程去哪看”。 */
export function renderPlanDetail(plan) {
  const actions = plan.actions ?? [];
  const counts = {
    install: actions.filter((action) => action.type === "install").length,
    update: actions.filter((action) => action.type === "update").length,
  };
  const lines = [`计划：安装 ${counts.install}${counts.update > 0 ? `、更新 ${counts.update}` : ""}`];
  for (const action of actions) {
    if (action.type === "skip") continue;
    const label = ACTION_LABEL[action.type] ?? action.type;
    const detail = typeof action.detail === "string" ? action.detail : "";
    lines.push(`· ${action.name}：${label}${detail.length > 0 ? ` — ${detail}` : ""}`);
  }
  lines.push("取消不会产生任何变更。");
  return lines.join("\n");
}
