/**
 * `/skill-init`（含 `--update`）的执行核心：observe → plan → apply → verify。
 *
 * 技能安装 / 更新的唯一执行者是 `@morehao/dsh-skills-console` 的公共 API（`console-api.js`
 * 解析出来）；本模块只做「观测 + 纯函数计划 + 调 API + 契约校验」，不实现安装器、不写 lock。
 * 全部依赖注入，离线冒烟用 fake API。
 */
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { resolveConsoleApi } from "./console-api.js";
import { skillPaths, skillRoots } from "./skill-paths.js";
import type { ObservedSkill, PlanAction, RequirementLike, SkillPlan, SkillSnapshot } from "./types.js";

export { resolveCanonicalSkillsDir, resolveDshHome } from "./skill-paths.js";

export const SKILL_SOURCE = "morehao/agent-skills";

/**
 * `/skill-init`（含 `--update`）使用的来源：默认上游 GitHub 仓，
 * `DSH_COMMANDS_SKILL_SOURCE` 可覆盖（v1 只支持 owner/repo 或 GitHub URL；本地目录源不支持）。
 */
export function resolveSkillSource(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_COMMANDS_SKILL_SOURCE?.trim();
  return raw && raw.length > 0 ? raw : SKILL_SOURCE;
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

/** 命令依赖的技能集合（`skill` 省略即 git-kit），去重后保持声明顺序。 */
export function referencedSkills(commands: any[]): string[] {
  const names: string[] = [];
  for (const def of commands) {
    const skill = def.skill ?? "git-kit";
    if (!names.includes(skill)) names.push(skill);
  }
  return names;
}

/** 命令依赖的分支契约 → 需要存在的文件（与 `scripts/check-skill-contract.mjs` 同规则）。 */
export function requirements(commands: any[]): RequirementLike[] {
  return commands.map((def) => ({
    skill: def.skill ?? "git-kit",
    branch: def.branch,
    command: def.name,
    file: join("references", `${def.branch}.md`),
  }));
}

/** 在 DSH 实际扫描的技能根里找该技能（按 skillRoots 顺序），返回第一个含 SKILL.md 的目录。 */
async function locateInRoots(env: NodeJS.ProcessEnv, name: string): Promise<string | undefined> {
  for (const root of skillRoots(env)) {
    const dir = join(root, name);
    if (await exists(join(dir, "SKILL.md"))) return dir;
  }
  return undefined;
}

const MODE_TEXT: Record<string, string> = Object.freeze({
  off: "技能在技能控制台已停用，请在控制台启用后重试",
  hidden: "技能在技能控制台已完全停用（SKILL.md.disabled），请先在控制台恢复",
  manual: "技能在控制台设为仅手动（模型不可调用），请在控制台切换为自动",
  unknown: "技能控制台状态版本未知，请在控制台检查",
});

/**
 * 只读观测：API list + canonical / 扫描根文件存在性。不联网、不写盘。
 */
export async function observeSkills(
  env: NodeJS.ProcessEnv = process.env,
  commands: any[] = [],
  { api }: { api?: any } = {},
): Promise<SkillSnapshot> {
  const paths = skillPaths(env);
  const names = referencedSkills(commands);
  const records = new Map<string, any>();
  let consoleError: { code: string; message: string } | null = null;
  if (api) {
    try {
      const list = await api.list({ names });
      for (const item of Array.isArray(list) ? list : []) {
        if (item && typeof item.name === "string") records.set(item.name, item);
      }
    } catch (error) {
      consoleError = { code: error?.code ?? "internal", message: error?.message ?? String(error) };
    }
  }
  const skills: ObservedSkill[] = [];
  for (const name of names) {
    const canonicalPath = join(paths.canonicalSkillsDir, name);
    const canonicalOk = await exists(join(canonicalPath, "SKILL.md"));
    const located = canonicalOk ? canonicalPath : await locateInRoots(env, name);
    const record = records.get(name) ?? null;
    skills.push({
      name,
      canonical: { ok: canonicalOk, path: canonicalPath },
      installed: canonicalOk || located !== undefined,
      effectiveDir: located ?? canonicalPath,
      console: { present: Boolean(api), record, mode: record?.mode ?? null },
    });
  }
  return {
    version: 1,
    source: resolveSkillSource(env),
    paths,
    consolePresent: Boolean(api),
    consoleError,
    requirements: requirements(commands),
    warnings: [],
    skills,
  };
}

/** console 记录的 mode → delegate 说明。 */
function delegateText(mode?: string): string {
  return (mode !== undefined ? MODE_TEXT[mode] : undefined) ?? "由技能控制台管理";
}

/**
 * 纯函数计划（设计 §6.2）：同一快照 → 深相等的 actions，顺序固定为 REQUIRED_SKILLS。
 * 动作只有 install / update / delegate / blocked / skip / warn，不再有 relink。
 */
export function planOperation(
  mode: "init" | "update" | "check",
  { names }: { names?: string[] } = {},
  snapshot?: SkillSnapshot,
): SkillPlan {
  if (mode !== "init" && mode !== "update" && mode !== "check") {
    throw new Error(`未知技能模式：${mode}`);
  }
  const snap = snapshot as SkillSnapshot;
  const all = snap.skills.map((skill) => skill.name);
  const requested = (Array.isArray(names) ? names : []).filter((name) => all.includes(name));
  const targets = requested.length > 0 ? requested : all;
  const byName = new Map<string, ObservedSkill>(snap.skills.map((skill): [string, ObservedSkill] => [skill.name, skill]));
  const actions: PlanAction[] = [];
  const warnings = [...(snap.warnings ?? [])];

  for (const name of targets) {
    const skill = byName.get(name)!;
    if (snap.consoleError) {
      actions.push({
        type: "blocked",
        name,
        writes: false,
        detail: `技能控制台不可用：${snap.consoleError.message}`,
        reason: `console-${snap.consoleError.code}`,
      });
      continue;
    }
    const record = skill.console?.record;
    if (record && record.mode !== "auto" && record.mode !== "on") {
      actions.push({ type: "delegate", name, writes: false, detail: delegateText(record.mode), reason: `console-${record.mode}` });
      continue;
    }
    if (mode === "check") {
      if (!skill.installed) actions.push({ type: "warn", name, writes: false, detail: "未安装", reason: "missing" });
      else actions.push({ type: "skip", name, writes: false, detail: "已安装", reason: "installed" });
      continue;
    }
    if (mode === "update") {
      if (!skill.installed) actions.push({ type: "skip", name, writes: false, detail: "未安装，跳过（先执行 /skill-init）", reason: "missing" });
      else actions.push({ type: "update", name, writes: true, detail: "更新到上游最新", reason: "installed" });
      continue;
    }
    // init
    if (skill.installed) actions.push({ type: "skip", name, writes: false, detail: "已安装，跳过", reason: "installed" });
    else actions.push({ type: "install", name, writes: true, detail: "未安装，将安装", reason: "missing" });
  }

  const installs = actions.filter((action) => action.type === "install");
  const updates = actions.filter((action) => action.type === "update");
  const blockedActions = actions.filter((action) => action.type === "blocked");
  const delegates = actions.filter((action) => action.type === "delegate");
  const confirm = {
    installs: installs.length,
    updates: updates.length,
    relinks: 0,
    blocked: blockedActions.length,
    delegated: delegates.length,
    needs: installs.length + updates.length > 0,
  };
  const states = targets.map((name) => {
    const skill = byName.get(name)!;
    return { name, state: skill.installed ? "installed" : "missing" };
  });

  let skipReason: string | undefined;
  if (mode === "init") {
    const passive = actions.length > 0 && actions.every((action) => action.type === "skip" || action.type === "warn");
    if (passive) skipReason = "已全部安装，无需操作";
  } else if (mode === "update") {
    if (targets.length === 0) skipReason = "没有可处理的技能";
    else if (updates.length === 0 && delegates.length === 0 && blockedActions.length === 0) skipReason = "没有可更新的技能";
  }

  return {
    mode,
    kind: mode === "update" ? "skill-update" : mode === "check" ? "skill-check" : "skill-init",
    source: snap.source,
    paths: snap.paths,
    observed: snap,
    actions,
    confirm,
    warnings,
    requested,
    targets,
    states,
    skipReason,
    contract: mode === "init",
    requirements: snap.requirements ?? [],
  };
}

/**
 * 按 COMMANDS 的分支契约校验技能目录：走 effectiveDir（DSH 实际加载的目录）。
 * 只报不抛 —— 契约漂移不该让 init 整体失败。
 */
export async function checkContract(plan: any, commands: any[], snapshot?: SkillSnapshot): Promise<string[]> {
  const observed = snapshot ?? plan.observed;
  const skills = new Map<string, any>((observed?.skills ?? []).map((skill: any) => [skill.name, skill]));
  const reqs = plan.requirements ?? requirements(commands ?? []);
  const failures: string[] = [];
  for (const req of reqs) {
    const skill = skills.get(req.skill);
    const dir = skill?.effectiveDir ?? skill?.canonical?.path;
    if (dir === undefined) {
      failures.push(`${req.skill} 缺失（/${req.command} 无法执行）`);
      continue;
    }
    if (!(await exists(join(dir, "SKILL.md")))) {
      failures.push(`${req.skill} 缺失（/${req.command} 无法执行）`);
      continue;
    }
    if (await exists(join(dir, "references"))) {
      if (!(await exists(join(dir, req.file)))) {
        failures.push(`${req.skill}#${req.branch} 缺 ${req.file}（/${req.command}）`);
      }
    }
  }
  return failures;
}

export interface ApplyPlanOptions {
  api?: any;
  env?: NodeJS.ProcessEnv;
  reporter?: { progress?: (line: string) => void };
  signal?: AbortSignal;
}

/**
 * 执行 plan（设计 §6.2）：install 合并一次 `api.install`，update 合并一次 `api.update`；
 * delegate/blocked/skip/warn 零写。逐项失败进结果，不抛（install 批量失败标记到每个技能）。
 */
export async function applyPlan(plan: any, { api, env = process.env, reporter }: ApplyPlanOptions = {}): Promise<any> {
  void env;
  const mode = plan.mode ?? "init";
  const actions = plan.actions ?? [];
  const installNames = actions.filter((action: any) => action.type === "install").map((action: any) => action.name);
  const updateNames = actions.filter((action: any) => action.type === "update").map((action: any) => action.name);
  const installResults: any[] = [];
  const updateResults: any[] = [];
  const failures: string[] = [];

  if (installNames.length > 0) {
    reporter?.progress?.(`安装技能（${installNames.join("、")}）`);
    if (!api) {
      for (const name of installNames) installResults.push({ name, status: "failed", message: "技能控制台不可用" });
      failures.push("安装失败：技能控制台不可用");
    } else {
      try {
        const result = await api.install({ source: plan.source, skills: installNames, targets: [] });
        const got = new Set((result?.installed ?? []).map((item: any) => item.name));
        for (const name of installNames) {
          if (got.has(name)) installResults.push({ name, status: "installed" });
          else {
            installResults.push({ name, status: "failed", message: "安装结果里没有该技能" });
            failures.push(`${name}：安装结果里没有该技能`);
          }
        }
      } catch (error) {
        const message = error?.message ?? String(error);
        for (const name of installNames) installResults.push({ name, status: "failed", message });
        failures.push(`安装失败：${message}`);
      }
    }
  }

  if (updateNames.length > 0) {
    reporter?.progress?.(`更新技能（${updateNames.join("、")}）`);
    if (!api) {
      for (const name of updateNames) updateResults.push({ name, status: "failed", message: "技能控制台不可用" });
    } else {
      try {
        const result = await api.update({ names: updateNames });
        const byName = new Map((result?.results ?? []).map((item: any) => [item.name, item]));
        for (const name of updateNames) {
          const item: any = byName.get(name);
          if (!item) updateResults.push({ name, status: "failed", message: "更新结果缺失" });
          else updateResults.push({ name, status: item.status, message: item.message ?? null });
        }
      } catch (error) {
        const message = error?.message ?? String(error);
        for (const name of updateNames) updateResults.push({ name, status: "failed", message });
        failures.push(`更新失败：${message}`);
      }
    }
  }

  return {
    mode,
    toInstall: installNames,
    toUpdate: updateNames,
    installResults,
    updateResults,
    failures,
    needsWork: installNames.length + updateNames.length > 0,
  };
}

/** 校验执行结果：涉及写盘技能现在都能在某个扫描根里找到 SKILL.md。 */
export async function verifyPlan(
  plan: any,
  { snapshotAfter }: { snapshotAfter?: SkillSnapshot } = {},
): Promise<{ canonical: string; links: string; state: string; problems: string[] }> {
  const problems: string[] = [];
  if (snapshotAfter === undefined) {
    return { canonical: "?/?", links: "0/0", state: "unchanged", problems: ["缺少执行后的快照，无法校验"] };
  }
  const actions = plan.actions ?? [];
  const verifyNames = actions
    .filter((action: any) => action.type === "install" || action.type === "update")
    .map((action: any) => action.name);
  const byName = new Map(snapshotAfter.skills.map((skill) => [skill.name, skill]));
  const okCount = verifyNames.filter((name: string) => byName.get(name)?.installed === true).length;
  if (okCount < verifyNames.length) {
    for (const name of verifyNames) {
      if (byName.get(name)?.installed !== true) problems.push(`${name}：技能目录不可读`);
    }
  }
  return { canonical: `${okCount}/${verifyNames.length}`, links: "0/0", state: "unchanged", problems };
}

/**
 * canonical 已有、账本还没有的技能先 adopt（只补记账、不下载）。best-effort。
 * 返回可能刷新过的快照。
 */
async function adoptCanonical(api: any, env: NodeJS.ProcessEnv, commands: any[], snapshot: SkillSnapshot): Promise<SkillSnapshot> {
  if (!api || typeof api.adopt !== "function" || snapshot.consoleError) return snapshot;
  const toAdopt = snapshot.skills.filter((skill) => skill.canonical?.ok && !skill.console?.record).map((skill) => skill.name);
  if (toAdopt.length === 0) return snapshot;
  let changed = false;
  for (const name of toAdopt) {
    try {
      const result = await api.adopt({ name });
      if (result && result.already !== true) changed = true;
    } catch {
      // adopt 失败不阻断后续安装/更新（下次会再试）
    }
  }
  return changed ? observeSkills(env, commands, { api }) : snapshot;
}

const elapsedSince = (startedAt: number): string => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]?.trim() ?? "";

/** 解析 api / 观测 / adopt / 计划 的一步到位封装（工具与回退共用）。 */
async function prepare(commands: any[], { env, api, plan, resolveApi = resolveConsoleApi }: any = {}): Promise<{ api: any; snapshot: SkillSnapshot }> {
  let resolvedApi = api;
  if (!resolvedApi) {
    ({ api: resolvedApi } = await resolveApi({ env }));
  }
  let snapshot = plan?.observed ?? (await observeSkills(env, commands, { api: resolvedApi }));
  snapshot = await adoptCanonical(resolvedApi, env, commands, snapshot);
  return { api: resolvedApi, snapshot };
}

function contractLine(commands: any[], failures: string[]): string {
  return failures.length === 0
    ? `契约：${commands.length} 条命令的分支文件齐全。技能目录被实时监听，无需重启 dsh。`
    : `契约问题（${failures.length}）：\n${failures.map((f) => `· ${f}`).join("\n")}`;
}

function renderFallbackResult(
  currentPlan: any,
  outcome: any,
  snapshotAfter: SkillSnapshot,
  contractFailures: string[],
  commands: any[],
  elapsed: string,
): string {
  void snapshotAfter;
  const installed = outcome.installResults.filter((item: any) => item.status === "installed").map((item: any) => item.name);
  const updated = outcome.updateResults.filter((item: any) => item.status === "updated").map((item: any) => item.name);
  const current = outcome.updateResults.filter((item: any) => item.status === "current").map((item: any) => item.name);
  const localModified = outcome.updateResults.filter((item: any) => item.status === "locally-modified").map((item: any) => item.name);
  const problems: string[] = [];
  for (const item of outcome.installResults) if (item.status === "failed") problems.push(`${item.name}：安装失败${item.message ? `（${item.message}）` : ""}`);
  for (const item of outcome.updateResults) {
    if (item.status === "failed") problems.push(`${item.name}：更新失败${item.message ? `（${item.message}）` : ""}`);
    if (item.status === "parked") problems.push(`${item.name}：已完全停用，请先在控制台恢复`);
    if (item.status === "no-subscription" || item.status === "not-managed") problems.push(`${item.name}：${item.status === "no-subscription" ? "没有订阅，无法更新" : "没有安装记录"}`);
  }
  const nothing = installed.length === 0 && updated.length === 0 && problems.length === 0;
  const header = nothing
    ? current.length > 0
      ? `✓ 无变更（${current.length} 项已是最新） · ${elapsed}`
      : `✓ 无变更 · ${elapsed}`
    : problems.length > 0
      ? `⚠ 已完成，但有 ${problems.length} 项需处理 · ${elapsed}`
      : `✅ 已完成：${installed.length + updated.length} 项变更 · ${elapsed}`;
  const lines = [header, `技能：${currentPlan.targets.join("、")}`];
  if (installed.length > 0) lines.push(`安装：${installed.join("、")}`);
  if (updated.length > 0) lines.push(`更新：${updated.join("、")}`);
  if (current.length > 0) lines.push(`已最新：${current.join("、")}`);
  if (localModified.length > 0) lines.push(`本地有改动（未覆盖）：${localModified.join("、")}`);
  for (const problem of problems) lines.push(`· ${problem}`);
  lines.push(contractLine(commands, contractFailures));
  return lines.join("\n");
}

/**
 * `/skill-init` 的本地回退（无 tools / 无 agent 时）：走同一套 observe → plan → apply。
 * 返回文本回执（不抛 api 解析错误，改为 blocked 文案）。
 */
export async function runSkillInit(
  commands: any[],
  { signal, env = process.env, reporter, plan, choice = "all", api, resolveApi }: any = {},
): Promise<string> {
  const startedAt = Date.now();
  let prepared: any;
  try {
    prepared = await prepare(commands, { env, api, plan, resolveApi });
  } catch (error) {
    return `⛔ ${firstLine(error)}\n技能控制台不可用，无法安装/更新技能。`;
  }
  let currentPlan = plan ?? planOperation("init", {}, prepared.snapshot);
  if (choice === "missing") currentPlan = narrowToMissing(currentPlan);
  reporter?.progress?.(`检查依赖技能（${currentPlan.targets.join("、")}）`);
  const outcome = await applyPlan(currentPlan, { api: prepared.api, env, reporter, signal });
  const snapshotAfter = await observeSkills(env, commands, { api: prepared.api });
  const contractFailures = await checkContract({ ...currentPlan, observed: snapshotAfter }, commands, snapshotAfter);
  return renderFallbackResult(currentPlan, outcome, snapshotAfter, contractFailures, commands, elapsedSince(startedAt));
}

/** `/skill-init --update` 的本地回退。 */
export async function runSkillUpdate(
  commands: any[],
  rawInput: string,
  { signal, env = process.env, reporter, plan, api, resolveApi }: any = {},
): Promise<string> {
  const startedAt = Date.now();
  const all = referencedSkills(commands);
  const requested = String(rawInput ?? "").split(/\s+/).filter((token) => token.length > 0);
  const unknown = requested.filter((name) => !all.includes(name));
  if (unknown.length > 0) throw new Error(`未知技能：${unknown.join("、")}。本插件依赖：${all.join("、")}`);
  let prepared: any;
  try {
    prepared = await prepare(commands, { env, api, plan, resolveApi });
  } catch (error) {
    return `⛔ ${firstLine(error)}\n技能控制台不可用，无法更新技能。`;
  }
  const currentPlan = plan ?? planOperation("update", { names: requested }, prepared.snapshot);
  reporter?.progress?.(`更新依赖技能（${currentPlan.targets.join("、")}）`);
  const outcome = await applyPlan(currentPlan, { api: prepared.api, env, reporter, signal });
  const snapshotAfter = await observeSkills(env, commands, { api: prepared.api });
  const contractFailures = await checkContract({ ...currentPlan, observed: snapshotAfter }, commands, snapshotAfter);
  return renderFallbackResult(currentPlan, outcome, snapshotAfter, contractFailures, commands, elapsedSince(startedAt));
}

/**
 * 「只补缺失」：把 update 动作降级为 skip，只保留 install，重算 confirm。
 * 供确认卡「只补缺失」选项使用。
 */
export function narrowToMissing(plan: any): any {
  const actions = (plan.actions ?? []).map((action: any) => {
    if (action.type === "install") return action;
    if (action.type === "update") return { ...action, type: "skip", writes: false, detail: "本次只补缺失，跳过", reason: "missing-only" };
    return action;
  });
  const installs = actions.filter((action: any) => action.type === "install").length;
  const updates = actions.filter((action: any) => action.type === "update").length;
  return {
    ...plan,
    actions,
    confirm: { ...(plan.confirm ?? {}), installs, updates, relinks: 0, needs: installs > 0 },
  };
}
