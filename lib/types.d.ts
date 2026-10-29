// 共享领域类型（纯声明，不 emit）。
// 字段以 lib/*.js 现有实现为准；核对锚点写在注释里。执行迁移时若类型与实现不一致，
// 以实现为准修正本文件，不要为迁就类型去改实现。

/** COMMANDS 一行（锚点：lib/index.js COMMANDS 表 / buildInstruction）。 */
export interface CommandDef {
  name: string;
  branch: string;
  skill?: string;
  hint?: string;
  required?: boolean;
  description: string;
  noInput?: string;
  confirm?: string;
  readFallback?: boolean;
}

/** 命令/工具 handler 的返回（锚点：各 handler 的 `{ kind, text }`）。 */
export interface HandlerResult {
  kind: 'error' | 'success' | string;
  text: string;
}

/** 命令注入的执行上下文（锚点：makeHandler(invocation)）。 */
export interface InvocationLike {
  rawInput: string;
  signal?: AbortSignal;
  agent?: { followup(message: any): void; session?: { id?: string } };
}

/** 宿主 cordis ctx 的最小结构（不给类型新增 peerDependency）。 */
export interface HostContext {
  get(name: string): any;
  effect?(fn: () => void | (() => void), label?: string): void;
  on?(event: string, handler: (...args: any[]) => void): void;
  commands: { register(def: any): Promise<unknown> };
}

/** 宿主工具定义（锚点：@deepseek-ai/dsh-tools defineTool 的入参）。 */
export interface ToolDefinitionLike {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  output?: Record<string, any>;
  execute(args?: any, exec?: any): Promise<any>;
}

/** observeSkills 返回（锚点：skill-setup.observeSkills）。 */
export interface SkillConsoleRecord {
  name: string;
  mode?: string;
  [extra: string]: unknown;
}

export interface ObservedSkill {
  name: string;
  canonical: { ok: boolean; path: string };
  installed: boolean;
  effectiveDir: string;
  console: { present: boolean; record: SkillConsoleRecord | null; mode: string | null };
}

export interface RequirementLike {
  skill: string;
  branch: string;
  command: string;
  file: string;
}

export interface SkillSnapshot {
  version: number;
  source: string;
  paths: Record<string, any>;
  consolePresent: boolean;
  consoleError: { code: string; message: string } | null;
  requirements: RequirementLike[];
  warnings: string[];
  skills: ObservedSkill[];
}

/** planOperation 的动作 / 计划（锚点：skill-setup.planOperation）。 */
export type PlanActionType = 'install' | 'update' | 'delegate' | 'blocked' | 'skip' | 'warn';

export interface PlanAction {
  type: PlanActionType;
  name: string;
  writes: boolean;
  detail: string;
  reason: string;
}

export interface PlanConfirm {
  installs: number;
  updates: number;
  relinks: number;
  blocked: number;
  delegated: number;
  needs: boolean;
}

export interface SkillPlan {
  mode: 'init' | 'update' | 'check';
  kind: string;
  source: string;
  paths: Record<string, any>;
  observed: SkillSnapshot;
  actions: PlanAction[];
  confirm: PlanConfirm;
  warnings: string[];
  requested: string[];
  targets: string[];
  states: Array<{ name: string; state: string }>;
  skipReason?: string;
  contract: boolean;
  requirements: RequirementLike[];
}

/** 版本检查结果（锚点：plugin-update.createPluginUpdater().check()）。 */
export interface PluginCheckResult {
  packageName: string;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkFailed: boolean;
  manualCommand: string;
}

/** 自更新计划（锚点：tool-plugin-update 里的 plan = { ...base, manualCommand }）。 */
export interface PluginUpdatePlan {
  currentVersion: string | null;
  latestVersion: string | null;
  manualCommand: string;
}

/** 工具结果（锚点：tool-plugin-update.makeResult）。 */
export interface PluginToolResult {
  mode: 'check' | 'apply';
  status: string;
  summary: string;
  currentVersion: string | null;
  latestVersion: string | null;
  updatedVersion?: string;
  restartRequired?: boolean;
  warnings: string[];
  next: string[];
  markdown: string;
}

/** 长任务作业（锚点：job-progress.runInJob / ctx.jobs）。 */
export interface JobReporter {
  progress?(line: string): void;
}

export interface JobOutcome<T = any> {
  value?: T;
  killed?: boolean;
  skippedReason?: string;
  fallbackReason?: string;
  error?: unknown;
  outputTail?: string;
  job?: unknown;
}
