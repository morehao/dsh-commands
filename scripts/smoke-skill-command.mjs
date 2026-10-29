#!/usr/bin/env node
/**
 * `/skill-init` 委托命令冒烟（P3a）：
 * - flags/技能名解析与错误文本；
 * - 注入消息 golden（mode/names/yes、自然语言首段、汇报约束）；
 * - user 消息契约（role/source.kind/id/冻结）；
 * - handler：注入成功、无 tools、无 agent、followup 抛错 → 本地回退；非法输入不注入；
 * - 注册形态：recordInput:false、hint、handler 是函数；工具注册失败不影响命令。
 *
 * 不依赖 dsh，也不跑真实安装。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let failures = 0;
function check(ok, label, detail) {
	if (ok) {
		console.log(`✓ ${label}`);
		return;
	}
	failures++;
	console.error(`✗ ${label}${detail === undefined ? "" : `\n  ${String(detail).replace(/\n/g, "\n  ")}`}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const { SKILL_INIT_USAGE, parseSkillInitInput, buildSkillInitMessage, createUserMessage, createNoticeMessage, setUserMessageFactory, makeSkillInitHandler } = await import(
	join(here, "..", "dist", "skill-command.js")
);
const index = await import(join(here, "..", "dist", "index.js"));

// 隔离：apply() 的版本提示会读写状态文件，用临时 HOME/DSH_HOME 避免碰真实 ~/.dsh。
const sandbox = await mkdtemp(join(tmpdir(), "dsh-commands-skill-command-"));
process.env.HOME = join(sandbox, "home");
process.env.DSH_HOME = join(sandbox, "dsh");

// ---- 1) parse ----------------------------------------------------------
{
	const init = parseSkillInitInput("");
	check(init.mode === "init" && init.update === false && init.yes === false && init.names.length === 0, "1. 空输入：init", JSON.stringify(init));
	const yes = parseSkillInitInput(" --yes ");
	check(yes.mode === "init" && yes.yes === true, "1. --yes：init + yes", JSON.stringify(yes));
	const update = parseSkillInitInput("--update");
	check(update.mode === "update" && update.names.length === 0, "1. --update：update 全部", JSON.stringify(update));
	const names = parseSkillInitInput("--update git-kit handoff --yes");
	check(names.mode === "update" && names.yes === true && names.names.join(",") === "git-kit,handoff", "1. --update + names + --yes", JSON.stringify(names));
	const initNames = parseSkillInitInput("git-kit");
	check(initNames.error?.startsWith(SKILL_INIT_USAGE) && initNames.error.includes("只有 --update 接受技能名"), "1. init 带 names：用法错误", initNames.error);
	const unknown = parseSkillInitInput("--force");
	check(unknown.error?.startsWith(SKILL_INIT_USAGE) && unknown.error.includes("--force"), "1. 未知 flag：用法错误", unknown.error);
	const unknownWithUpdate = parseSkillInitInput("--update --dry-run");
	check(unknownWithUpdate.error?.includes("--dry-run"), "1. update + 未知 flag：用法错误", unknownWithUpdate.error);
	const repeated = parseSkillInitInput("--update --update git-kit --yes --yes");
	check(repeated.mode === "update" && repeated.yes === true && repeated.names.join(",") === "git-kit", "1. 重复 flag 幂等", JSON.stringify(repeated));
}

// ---- 2) 注入消息 golden ------------------------------------------------
{
	const init = buildSkillInitMessage({ mode: "init", names: [], yes: false });
	check(init.startsWith("检查本插件依赖的技能（git-kit、handoff、disk-cleanup）"), "2. init 首段是自然语言请求（标题来源）", init.split("\n")[0]);
	check(init.includes("mode=init") && init.includes("names=[]") && init.includes("yes=false"), "2. init：mode/names/yes 具体值", init);
	check(init.includes("调用 skill_init 工具") && init.includes("不要自行运行 skills CLI"), "2. init：调用与禁止事项", init);
	check(init.includes("1–3 句话总结") && init.includes("不要复述工具回执"), "2. init：汇报约束", init);
	check(!/LOCAL_COMMANDS|本地执行|命令行/.test(init), "2. 消息不含旧本地执行说法");

	const update = buildSkillInitMessage({ mode: "update", names: ["git-kit"], yes: true });
	check(update.startsWith("把本插件依赖的技能（git-kit）更新到上游最新"), "2. update 首段说明显式更新", update.split("\n")[0]);
	check(update.includes("mode=update") && update.includes("names=[git-kit]") && update.includes("yes=true"), "2. update：mode/names/yes 具体值", update);
}

// ---- 3) user 消息契约 --------------------------------------------------
{
	const message = createUserMessage("hello");
	check(message.role === "user" && message.source.kind === "user", "3. role=user + source.kind=user", JSON.stringify({ role: message.role, source: message.source }));
	check(Array.isArray(message.content) && message.content[0].type === "text" && message.content[0].text === "hello", "3. content 是 text block");
	check(typeof message.id === "string" && message.id.length > 0 && createUserMessage("hello").id !== message.id, "3. id 非空且唯一");
	check(Object.isFrozen(message) && Object.isFrozen(message.source) && Object.isFrozen(message.content), "3. 消息全深冻结");
	let threw = false;
	try {
		createUserMessage("");
	} catch {
		threw = true;
	}
	check(threw, "3. 空文本拒绝");
}

// ---- 3b) T4：官方消息工厂优先 -----------------------------------------
{
	let called = 0;
	setUserMessageFactory((input) => {
		called += 1;
		return { id: "official", role: "user", source: input.source, content: input.content };
	});
	const message = createUserMessage("hi");
	check(called === 1 && message.id === "official", "3b. 有官方工厂时优先官方实现");
	const notice = createNoticeMessage("notice text");
	check(called === 2 && notice.id === "official" && notice.source.form === "notice", "3b. notice 也走官方实现");
	setUserMessageFactory(null);
	const local = createUserMessage("hi");
	check(typeof local.id === "string" && local.id !== "official", "3b. 传 null 恢复本地实现");
}

// ---- 4) handler --------------------------------------------------------
{
	const followups = [];
	const fallbacks = [];
	const handler = makeSkillInitHandler({
		def: { name: "skill-init" },
		toolReady: () => true,
		fallback: async (parsed) => {
			fallbacks.push(parsed);
			return { kind: "success", text: "fallback" };
		}
	});
	const result = await handler({
		rawInput: "--update git-kit --yes",
		agent: { followup: (message) => followups.push(message) },
		signal: undefined
	});
	check(result.kind === "success" && result.text.includes("更新依赖技能"), "4. 注入成功：返回一行结论", JSON.stringify(result));
	check(followups.length === 1 && followups[0].source.kind === "user", "4. 注入一条 user 消息", String(followups.length));
	check(followups[0].content[0].text.includes("mode=update") && followups[0].content[0].text.includes("names=[git-kit]"), "4. 注入消息带本次参数");
	check(fallbacks.length === 0, "4. 注入成功不走回退");

	const notReady = makeSkillInitHandler({
		toolReady: () => false,
		fallback: async (parsed) => {
			fallbacks.push(parsed);
			return { kind: "success", text: "fallback" };
		}
	});
	const fallbackResult = await notReady({ rawInput: "", agent: { followup: () => {} } });
	check(fallbackResult.text === "fallback" && fallbacks.length === 1, "4. toolReady=false：走本地回退", JSON.stringify(fallbackResult));

	const noAgent = makeSkillInitHandler({
		toolReady: () => true,
		fallback: async () => ({ kind: "success", text: "no-agent-fallback" })
	});
	const noAgentResult = await noAgent({ rawInput: "" });
	check(noAgentResult.text === "no-agent-fallback", "4. 无 agent：走本地回退", JSON.stringify(noAgentResult));

	const throwing = makeSkillInitHandler({
		toolReady: () => true,
		fallback: async () => ({ kind: "success", text: "after-throw" })
	});
	const throwingResult = await throwing({
		rawInput: "",
		agent: {
			followup() {
				throw new Error("session closed");
			}
		}
	});
	check(throwingResult.text === "after-throw", "4. followup 抛错：回退，不留半条消息", JSON.stringify(throwingResult));

	let injected = 0;
	let fallbackCalls = 0;
	const invalid = makeSkillInitHandler({
		toolReady: () => true,
		fallback: async () => {
			fallbackCalls += 1;
			return { kind: "success", text: "x" };
		}
	});
	const invalidResult = await invalid({ rawInput: "git-kit", agent: { followup: () => (injected += 1) } });
	check(invalidResult.kind === "error" && injected === 0 && fallbackCalls === 0, "4. 非法输入：不注入、不回退", JSON.stringify(invalidResult));

	const failingFallback = makeSkillInitHandler({
		toolReady: () => false,
		fallback: async () => {
			throw new Error("install failed");
		}
	});
	const failingResult = await failingFallback({ rawInput: "" });
	check(failingResult.kind === "error" && failingResult.text.includes("install failed"), "4. 回退失败：返回错误", JSON.stringify(failingResult));
}

// ---- 5) 注册形态 + apply 回退 -----------------------------------------
{
	const registered = [];
	let effects = 0;
	const ctx = {
		effect(fn) {
			effects += 1;
			const iterator = fn();
			return (async () => {
				for (;;) {
					const step = iterator.next();
					if (step.done) return;
					await step.value;
				}
			})();
		},
		commands: {
			async register(def) {
				registered.push(def);
			}
		},
		get: (name) => (name === "tools" ? { register() {} } : undefined)
	};
	const pending = index.apply(ctx);
	check(pending !== null && typeof pending?.then === "function", "5. apply 仍返回 Promise");
	await pending;
	await new Promise((resolve) => setTimeout(resolve, 10));
	const skillInit = registered.find((def) => def.name === "skill-init");
	const pluginUpdate = registered.find((def) => def.name === "plugin-update");
	check(
		effects === 0 && registered.length === index.COMMANDS.length + 2,
		"5. 命令只注册一次：COMMANDS + skill-init + plugin-update（无 effect 包装）",
		JSON.stringify({ effects, count: registered.length })
	);
	check(
		registered.every((def) => typeof def.definitionId === "string" && def.definitionId.startsWith("dsh-commands:")),
		"5. 每条命令都有 definitionId（dsh-commands: 前缀）",
		JSON.stringify(registered.map((def) => def.definitionId))
	);
	check(pluginUpdate !== undefined && pluginUpdate.recordInput === false && typeof pluginUpdate.handler === "function", "5. /plugin-update 已注册（recordInput:false）", JSON.stringify(pluginUpdate && { name: pluginUpdate.name, recordInput: pluginUpdate.recordInput }));
	check(skillInit !== undefined && skillInit.recordInput === false, "5. /skill-init recordInput:false", JSON.stringify(skillInit && { recordInput: skillInit.recordInput }));
	check(skillInit.input?.hint === "[--update [技能名...]] [--yes]", "5. hint 保持", JSON.stringify(skillInit.input));
	check(typeof skillInit.handler === "function", "5. handler 是函数");
	check(skillInit.description.includes("--update"), "5. 描述仍说明 --update", skillInit.description);
	// 注意：不在这里调用真实 handler 的 fallback——那会跑 observe/apply，碰到真实 HOME。
	// 回退路径由上面注入 fallback 的用例覆盖。
}

// ---- 6) T3：技能可用性（ctx.skills 优先，文件回退）--------------------
{
	const emptyProfile = { home: join(sandbox, "dsh-empty") };
	const runApply = async (get) => {
		const registered = [];
		const ctx = { commands: { async register(def) { registered.push(def); } }, get: (name) => (name === "profileContext" ? emptyProfile : get(name)) };
		await index.apply(ctx);
		return registered;
	};
	const invoke = async (handler, rawInput = "x") => {
		const messages = [];
		const result = await handler({ rawInput, agent: { followup: (message) => messages.push(message) } });
		return { result, messages };
	};

	// 6.1 registry 命中（可模型调用）：正常委托
	{
		const registered = await runApply((name) =>
			name === "skills" ? { list: async () => [{ name: "git-kit", invocation: { modelInvocable: true, userInvocable: true } }] } : undefined
		);
		const def = registered.find((entry) => entry.name === "git-message");
		const { result, messages } = await invoke(def.handler);
		check(result.kind === "success" && messages.length === 1, "6.1 registry 命中：正常委托", JSON.stringify(result));
	}
	// 6.2 registry 明确没有该技能：报未安装
	{
		const registered = await runApply((name) => (name === "skills" ? { list: async () => [] } : undefined));
		const def = registered.find((entry) => entry.name === "git-message");
		const { result, messages } = await invoke(def.handler);
		check(result.kind === "error" && /未安装/.test(result.text) && messages.length === 0, "6.2 registry 无该技能：报未安装", JSON.stringify(result));
	}
	// 6.3 registry.list 抛错：回退文件探测（临时 HOME 无技能 → 未安装）
	{
		const registered = await runApply((name) =>
			name === "skills" ? { list: async () => { throw new Error("no provider"); } } : undefined
		);
		const def = registered.find((entry) => entry.name === "git-message");
		const { result } = await invoke(def.handler);
		check(result.kind === "error" && /未安装/.test(result.text), "6.3 registry 抛错：回退文件探测（临时 HOME 无技能 → 未安装）", JSON.stringify(result));
	}
	// 6.4 registry 命中但 modelInvocable:false 且非 readFallback：不可由模型调用
	{
		const registered = await runApply((name) =>
			name === "skills" ? { list: async () => [{ name: "git-kit", invocation: { modelInvocable: false, userInvocable: true } }] } : undefined
		);
		const def = registered.find((entry) => entry.name === "git-message");
		const { result } = await invoke(def.handler);
		check(result.kind === "error" && /不可由模型调用/.test(result.text), "6.4 modelInvocable:false：报不可由模型调用", JSON.stringify(result));
	}
	// 6.5 handoff（readFallback:true）+ modelInvocable:false：仍注入
	{
		const registered = await runApply((name) =>
			name === "skills" ? { list: async () => [{ name: "handoff", invocation: { modelInvocable: false, userInvocable: true } }] } : undefined
		);
		const def = registered.find((entry) => entry.name === "handoff");
		const { result, messages } = await invoke(def.handler, "");
		check(result.kind === "success" && messages.length === 1, "6.5 handoff readFallback：modelInvocable:false 仍注入", JSON.stringify(result));
	}
}

await rm(sandbox, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`command 冒烟失败：${failures} 项`);
	process.exit(1);
}
console.log("command 冒烟通过：flags/消息/source/回退符合 P3a 预期");
