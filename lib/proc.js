/**
 * 子进程执行：argv 直传（不经 shell），统一 timeout / abort / 输出上限。
 *
 * 三个调用方原来各写一套（runCli / runGit / 连通性预检），差异只在
 * 「是否分 stdout/stderr」「输出上限」「超时后是否抛错」。这里用 option 保留差异。
 */
import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_CHARS = 120_000;

/**
 * @param {object} options
 * @param {string} options.command 可执行文件
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] 超时后先 SIGTERM，宽限后 SIGKILL
 * @param {number} [options.abortGraceMs=2000]
 * @param {number} [options.maxOutputChars] 单个缓冲区的上限；超出后保留后半段
 * @param {boolean} [options.collectStdout=false] 是否单独保留 stdout/stderr
 * @param {(text: string, channel: "stdout" | "stderr") => void} [options.onData] 原始分片旁路（去 ANSI 由调用方决定）
 * @param {(cancel: () => void) => void} [options.onCancelReady] 把「用户停止」接到同一个终止动作
 * @returns {Promise<{code: number|null, signal: NodeJS.Signals|null, output: string, stdout: string, stderr: string, timedOut: boolean, aborted: boolean, error?: Error}>}
 */
export function spawnCollect({
	command,
	args = [],
	cwd,
	env,
	signal,
	timeoutMs,
	abortGraceMs = 2_000,
	maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
	collectStdout = false,
	onData,
	onCancelReady,
} = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({
				code: null,
				signal: null,
				output: String(error),
				stdout: "",
				stderr: "",
				timedOut: false,
				aborted: false,
				error,
			});
			return;
		}

		let output = "";
		let stdout = "";
		let stderr = "";
		const trim = (text) => {
			if (!(maxOutputChars > 0) || text.length <= maxOutputChars) return text;
			return text.slice(-Math.max(1, Math.floor(maxOutputChars / 2)));
		};
		const collect = (chunk, channel) => {
			const text = String(chunk);
			output = trim(output + text);
			if (collectStdout) {
				if (channel === "stdout") stdout = trim(stdout + text);
				else stderr = trim(stderr + text);
			}
			try {
				onData?.(text, channel);
			} catch {
				// 旁路观察者（作业面板）不能影响采集
			}
		};
		child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
		child.stderr.on("data", (chunk) => collect(chunk, "stderr"));

		let settled = false;
		let timedOut = false;
		let timer;
		const hardKill = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				// 进程可能已退出
			}
		};
		const abortChild = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// 进程可能已退出
			}
			setTimeout(hardKill, abortGraceMs).unref?.();
		};
		const onAbort = () => abortChild();
		const finish = (extra = {}) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (extra.error !== undefined && output.length === 0) output = String(extra.error);
			resolve({
				code: extra.code ?? null,
				signal: extra.signal ?? null,
				output,
				stdout,
				stderr,
				timedOut,
				aborted: signal?.aborted === true,
				...extra,
			});
		};

		if (signal?.aborted === true) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				abortChild();
			}, timeoutMs);
		}
		onCancelReady?.(abortChild);
		child.on("error", (error) => finish({ error }));
		child.on("close", (code, signalName) => finish({ code, signal: signalName }));
	});
}
