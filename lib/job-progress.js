/**
 * 把本地执行型命令（`/skill-init`、`/skill-install`、`/skill-update`）的长任务挂到
 * dsh 后台任务（`ctx.jobs`）上，让「过程」实时可见 —— 且**不触发模型回合、不耗 token**。
 *
 * 为什么必须走这条路（已核对 dsh 0.2.1 源码，重读成本很高，改动前先看这段）：
 * - 命令面只有 `command/run` 与 `command/done` 两个事件
 *   （`@deepseek-ai/dsh-commands/lib/index.js:334` / `:341`，都在 `execute()` 里一次性 append），
 *   `invocation` 也只有 `{commandId, agent, rawInput, attachments, signal}` —— **没有进度通道**。
 *   UI 的命令卡片因此只有两态：`outcome === null` 渲染「执行中…」，否则渲染结果文本
 *   （`@deepseek-ai/dsh-client-ui-chat/lib/client.js:9491` / `:6417`）。一方命令 `/compact` 同样如此。
 * - 后台任务提供两个用户可见面（`@deepseek-ai/dsh-jobs-local`）：
 *   `handle.updateProgress(line)` → 作业行旁那一行实时文案
 *   （`@deepseek-ai/dsh-client-ui-jobs/lib/client.js:88`）；
 *   `handle.append(text, {channel})` → 展开面板里的流式输出（保留 256 KB / 结算后 16 KB）。
 *   用户还能在行上两击停止（`ctx.jobs.kill`）。
 * - **结算会投完成通知**：`@deepseek-ai/dsh-tool-jobs` 收到 `settled` 后给 owner 注入一条
 *   `form:'notice'` 消息，空闲且 `completionDelivery='wakeup'` 时还会 `followup()` **开一轮**
 *   （`tool-jobs/lib/index.js:269` / `:285`）。但 `event.awaited` 为真时直接跳过，而
 *   `awaited = waitResolvers.length > 0`（`jobs-local/lib/index.js:793`）—— 所以这里必须
 *   自己 `wait()` 到终态，绝不能改成订阅事件收尾。
 *
 * 本模块只负责「要不要用作业 / 怎么等 / 怎么收尾」，不含任何技能逻辑；`ctx.jobs` 缺失、
 * 无控制器（未加载 `dsh-tool-jobs`）、并发上限、owner 无活 agent 时一律**退回**直接执行的
 * 老路径，语义不变。
 */

const WAIT_SLICE_MS = 60_000;
const TERMINAL_STATUSES = new Set(["completed", "killed", "failed"]);

/**
 * 空 reporter：降级路径用。`progress` 是作业行的一行实时文案，`write` 是输出流的一段。
 */
export const NO_REPORTER = Object.freeze({
	progress() {},
	write() {},
});

const isTerminal = (status) => TERMINAL_STATUSES.has(status);

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

const firstLine = (error) => messageOf(error).split("\n")[0]?.trim() ?? "";

/** 取回保留输出（不消耗任何东西，也不惊动模型），用于失败回执的"最后输出"。 */
async function readOutputTail(jobs, id, owner) {
	try {
		const read = await jobs.readAt(id, 0, owner);
		const chunks = read?.chunks ?? [];
		return chunks.map((chunk) => (typeof chunk?.text === "string" ? chunk.text : "")).join("");
	} catch {
		return "";
	}
}

/**
 * 在后台任务里执行 `work`，并把过程实时送到会话头部的作业行/面板。
 *
 * `work(reporter, registerCancel)`：
 * - `reporter.progress(line)`：覆盖作业行那行实时文案（阶段名）。
 * - `reporter.write(text, channel)`：追加一段输出（`stdout` / `stderr` / `log`）。
 * - `registerCancel(fn)`：登记"用户停止作业 / 命令被取消"时要执行的终止动作（杀子进程）。
 *
 * 返回：
 * - `{ value, job }`：正常完成，`value` 是 `work` 的返回值。
 * - `{ error, job, outputTail }`：`work` 抛错（作业已结算为 failed）。
 * - `{ killed: true, job, outputTail }`：用户停止或 `signal` 中止。
 * - `{ value, fallbackReason }`：没启用作业（降级），`work` 已经在无 reporter 的情况下跑完。
 */
export async function runInJob({ jobs, owner, kind, label, signal, work }) {
	if (jobs === undefined || jobs === null || typeof jobs.start !== "function") {
		return { value: await work(NO_REPORTER), fallbackReason: "jobs 服务未组合" };
	}
	if (typeof owner !== "string" || owner.length === 0) {
		return { value: await work(NO_REPORTER), fallbackReason: "当前会话没有可用的 owner" };
	}

	let id;
	let workPromise;
	let cancelChild;
	let settleOutcome;
	// `hooks.done` 必须 resolve（不能 reject）：注册表会把 reject 当生产方违约只记日志，
	// 但那样拿不到准确的终态 detail。
	const outcome = new Promise((resolve) => {
		settleOutcome = resolve;
	});

	try {
		id = jobs.start({
			owner,
			kind,
			label,
			run(handle) {
				const reporter = {
					progress(line) {
						if (typeof line === "string" && line.length > 0) handle.updateProgress(line);
					},
					write(text, channel = "log") {
						if (typeof text === "string" && text.length > 0) handle.append(text, { channel });
					},
				};
				workPromise = (async () => {
					try {
						const value = await work(reporter, (cancel) => {
							cancelChild = cancel;
						});
						settleOutcome({ status: "completed" });
						return { value };
					} catch (error) {
						settleOutcome({ status: "failed", detail: firstLine(error) });
						return { error };
					}
				})();
				return {
					done: outcome,
					cancel(reason) {
						try {
							cancelChild?.(reason);
						} catch {
							// 子进程可能已退出：取消是尽力而为
						}
					},
				};
			},
		});
	} catch (error) {
		if (workPromise !== undefined) {
			// 极少见：`run()` 已启动工作、`start()` 随后才失败。绝不能退回再跑一遍（会重复执行）。
			throw error;
		}
		// 无控制器 / 并发上限 / owner 无活 agent：工作尚未开始，安全地退回老路径。
		return { value: await work(NO_REPORTER), fallbackReason: firstLine(error) };
	}

	// 中止只终止工作，**不结束等待**：保住 `awaited`，否则结算会投通知、可能白开一个模型回合。
	const onAbort = () => {
		try {
			jobs.kill(id, owner, "cancelled by the user");
		} catch {
			// 作业可能已结算
		}
	};
	if (signal?.aborted === true) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	let view = await jobs.get(id, owner);
	// 切片等待：单次超时不会失去 awaiter（下一次立刻接上），也能让 `invocation.signal` 生效。
	while (!isTerminal(view.status)) view = await jobs.wait(id, WAIT_SLICE_MS, owner);

	signal?.removeEventListener("abort", onAbort);

	const settled = await workPromise;
	const outputTail = view.status === "completed" ? "" : await readOutputTail(jobs, id, owner);

	if (view.status === "killed") return { killed: true, job: view, outputTail };
	if (settled?.error !== undefined) return { error: settled.error, job: view, outputTail };
	return { value: settled?.value, job: view };
}
