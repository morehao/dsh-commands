/**
 * Web 半：让 `/skill-init`（含 `--update`）的执行过程与完成回执
 * 在命令卡之外也有落点。
 *
 * 两层：
 * - `conversation.chat.commandview`：按命令名接管命令卡，读 `ctx.jobs` 的作业快照，
 *   显示等待确认 / 执行中 / 完成 / 失败、阶段文案、计时、日志和停止按钮。
 * - `shell.overlay` + `sidebar.session.row.leading`：离开会话后仍能看到完成提示和未读点。
 *
 * 边界：不新增 host 协议，不改变 `runInJob` 的 `wait()` 语义，不唤醒模型回合。
 * 作业结算后由 client 自己从 `ctx.jobs` 快照推导提示；host 仍是唯一的事实来源。
 */

window.__ModuleLoader__.load({
	id: "@morehao/dsh-commands",
	factory(require) {
		const React = require("react");
		const { useEffect, useMemo, useState, useSyncExternalStore } = React;
		const h = React.createElement;

		// 本地命令只剩一个；`--update` 的作业 kind 仍是 skill-init。
		const SKILL_KINDS = new Set(["skill-init"]);
		const LIVE = new Set(["running", "stopping"]);
		const MAX_TOASTS = 3;
		const TOAST_MS = 6500;
		const RELEASE_AFTER_MS = 30 * 60 * 1000;
		const EMPTY_JOBS = [];

		const zh = {
			"card.waiting": "等待确认",
			"card.waitingHint": "确认后开始执行；可随时停止",
			"card.running": "执行中",
			"card.runningHint": "正在执行，阶段与日志会持续更新",
			"card.done": "已完成",
			"card.unchanged": "无变更",
			"card.failed": "失败",
			"card.stopped": "已停止",
			"card.cancelled": "已取消",
			"card.expand": "展开日志",
			"card.collapse": "收起日志",
			"card.stop": "停止",
			"card.stopping": "停止中…",
			"card.noOutput": "等待输出…",
			"card.background": "后台作业",
			"toast.done": "/{name} 完成",
			"toast.failed": "/{name} 失败",
			"toast.stopped": "/{name} 已停止",
			"toast.view": "查看",
			"toast.dismiss": "关闭",
			"unread": "技能维护已完成，点开查看",
			"unread.aria": "技能维护已完成，打开会话查看",
		};
		const en = {
			"card.waiting": "Waiting for confirmation",
			"card.waitingHint": "Execution starts after confirmation; you can stop it anytime",
			"card.running": "Running",
			"card.runningHint": "Running; stages and logs update as it goes",
			"card.done": "Done",
			"card.unchanged": "No changes",
			"card.failed": "Failed",
			"card.stopped": "Stopped",
			"card.cancelled": "Cancelled",
			"card.expand": "Show log",
			"card.collapse": "Hide log",
			"card.stop": "Stop",
			"card.stopping": "Stopping…",
			"card.noOutput": "Waiting for output…",
			"card.background": "Background job",
			"toast.done": "/{name} completed",
			"toast.failed": "/{name} failed",
			"toast.stopped": "/{name} stopped",
			"toast.view": "View",
			"toast.dismiss": "Dismiss",
			"unread": "Skill maintenance finished; open to inspect",
			"unread.aria": "Skill maintenance finished; open the session to inspect",
		};

		// ---------------------------------------------------------------------
		// cross-session completion tracker
		// ---------------------------------------------------------------------
		// 命令卡挂载时把 session 注册进来；卡片卸载后 tracker 仍持有 watchRows 的
		// release，直到本次 skill 作业结算。这样用户切到别的会话也能收到完成提示。
		const tracked = new Map();
		const unread = new Set();
		const toastTimers = new Map();
		let toasts = [];
		let snapshot = { unread: new Set(), toasts: [], version: 0 };
		let version = 0;
		const listeners = new Set();

		function publish() {
			version += 1;
			snapshot = { unread: new Set(unread), toasts: toasts.slice(), version };
			for (const listener of listeners) listener();
		}

		function subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}

		function getSnapshot() {
			return snapshot;
		}

		function trackSession(sessionId, watchRows) {
			if (sessionId === undefined || sessionId === null || tracked.has(sessionId)) return;
			let release;
			try {
				release = watchRows(sessionId);
			} catch {
				return;
			}
			const state = {
				release,
				since: Date.now(),
				seen: new Map(),
				notified: new Set(),
				timer: setTimeout(() => releaseSession(sessionId), RELEASE_AFTER_MS),
			};
			tracked.set(sessionId, state);
			publish();
		}

		function releaseSession(sessionId) {
			const state = tracked.get(sessionId);
			if (state === undefined) return;
			clearTimeout(state.timer);
			try {
				state.release?.();
			} catch {
				// 作业服务已卸载时 release 可能抛错；忽略即可。
			}
			tracked.delete(sessionId);
			publish();
		}

		function clearUnread(sessionId) {
			if (sessionId === undefined || !unread.has(sessionId)) return;
			unread.delete(sessionId);
			publish();
		}

		function dismissToast(key) {
			const timer = toastTimers.get(key);
			if (timer !== undefined) {
				clearTimeout(timer);
				toastTimers.delete(key);
			}
			if (!toasts.some((toast) => toast.key === key)) return;
			toasts = toasts.filter((toast) => toast.key !== key);
			publish();
		}

		function notify(sessionId, job, currentId) {
			// 只有切到别的会话时才需要未读点；toast 一律弹——「跑完没有」不能靠用户自己盯卡片。
			const inCurrent = sessionId === currentId;
			if (!inCurrent) unread.add(sessionId);
			const key = `${sessionId}:${String(job.id)}`;
			const failed = job.status === "failed";
			const stopped = job.status === "killed";
			const detail = String(job.progress ?? job.detail ?? job.label ?? "").trim();
			toasts = [
				...toasts.filter((toast) => toast.key !== key),
				{ key, sessionId, kind: job.kind, label: job.label, detail, failed, stopped, inCurrent, at: Date.now() },
			].slice(-MAX_TOASTS);
			const oldTimer = toastTimers.get(key);
			if (oldTimer !== undefined) clearTimeout(oldTimer);
			toastTimers.set(key, setTimeout(() => dismissToast(key), TOAST_MS));
			publish();
		}

		function openToast(key, sessionId, openSession) {
			clearUnread(sessionId);
			dismissToast(key);
			openSession(sessionId);
		}

		function scan(rows, currentId) {
			for (const [sessionId, state] of [...tracked]) {
				const jobs = rows?.[sessionId] ?? [];
				let hasSkill = false;
				let live = false;
				for (const job of jobs) {
					if (!SKILL_KINDS.has(job.kind)) continue;
					hasSkill = true;
					const key = String(job.id);
					const previous = state.seen.get(key);
					state.seen.set(key, job.status);
					if (LIVE.has(job.status)) {
						live = true;
						continue;
					}
					const justFinished =
						typeof job.finishedAt === "number" && job.finishedAt >= state.since - 1500;
					if (!state.notified.has(key) && (previous === undefined ? justFinished : LIVE.has(previous))) {
						state.notified.add(key);
						notify(sessionId, job, currentId);
					}
				}
				// 一次命令只会有一个作业；结算后就可以释放，不必等 30 分钟兜底。
				if (hasSkill && !live) releaseSession(sessionId);
			}
		}

		function useCompletionStore() {
			return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		function StatusDot({ state }) {
			const color =
				state === "error"
					? "var(--dsw-alias-state-error-primary)"
					: state === "waiting"
						? "var(--dsw-alias-state-warn-primary)"
						: state === "running"
							? "var(--dsw-alias-brand-primary)"
							: state === "stopped"
								? "var(--dsw-alias-state-idle-primary)"
								: state === "unchanged"
									? "var(--dsw-alias-label-secondary)"
									: state === "cancelled"
										? "var(--dsw-alias-state-warn-primary)"
										: "var(--dsw-alias-state-success-primary)";
			return h("span", {
				"aria-hidden": true,
				style: {
					width: 6,
					height: 6,
					borderRadius: "50%",
					background: color,
					display: "inline-block",
					flex: "0 0 auto",
				},
			});
		}

		function formatDuration(ms) {
			const value = Math.max(0, ms);
			if (value < 1000) return "0.0s";
			const seconds = value / 1000;
			if (seconds < 60) return `${seconds.toFixed(1)}s`;
			const minutes = Math.floor(seconds / 60);
			return `${minutes}m ${Math.round(seconds % 60)}s`;
		}

		function firstLine(text) {
			return String(text ?? "")
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? "";
		}

		function nodeTime(node) {
			const value = node.time;
			if (typeof value === "number") return value;
			const parsed = Date.parse(String(value ?? ""));
			return Number.isFinite(parsed) ? parsed : 0;
		}

		function findJob(jobs, node) {
			const at = nodeTime(node);
			const candidates = jobs.filter((job) => job.kind === node.name && job.startedAt >= at - 2000);
			if (at === 0) return candidates.sort((left, right) => right.startedAt - left.startedAt)[0];
			// 取离命令时间最近的一条；不能按最新排序，否则历史卡片会匹配到后来同名的作业。
			return candidates.sort((left, right) => Math.abs(left.startedAt - at) - Math.abs(right.startedAt - at))[0];
		}

		function SkillCommandCard({ node, sessionId, useJobs, watchRows, observe, killJob, t }) {
			const jobs = useJobs((state) => state.rows[sessionId]) ?? EMPTY_JOBS;
			const job = useMemo(() => findJob(jobs, node), [jobs, node]);
			const view = useJobs((state) => (job === undefined ? undefined : state.observed[String(job.id)]));
			const [expanded, setExpanded] = useState(false);
			const [now, setNow] = useState(() => Date.now());
			const [stopping, setStopping] = useState(false);
			const live = job !== undefined && LIVE.has(job.status);
			const observable = live || (job?.output?.total ?? 0) > 0;
			const outcome = node.outcome;
			const outcomeText = String(outcome?.text ?? "");
			const killed = job?.status === "killed" || /已停止|stopped/i.test(outcomeText);
			const cancelled = !killed && /已取消|cancelled/i.test(outcomeText);
			// 「检查过、没动任何文件」是一个独立结局：既不是"执行中"，也不该显示成"已完成"。
			const unchanged =
				!killed && !cancelled && outcome != null && outcome.kind !== "error" && /无变更/u.test(outcomeText);
			const waiting = outcome === null && job === undefined;
			const state = killed
				? "stopped"
				: cancelled
					? "cancelled"
					: outcome != null
						? outcome.kind === "error"
							? "error"
							: unchanged
								? "unchanged"
								: "ok"
						: job?.status === "failed"
							? "error"
							: live
								? "running"
								: waiting
									? "waiting"
									: "ok";

			useEffect(() => {
				if (node.outcome !== null) return;
				trackSession(sessionId, watchRows);
			}, [node.outcome, sessionId, watchRows]);

			useEffect(() => {
				// 取消/无需作业时没有结算事件；卡片还在时给 tracker 一个短的释放窗口，
				// 但不早于 overlay 的 scan 读到结算作业。
				if (node.outcome === null || live) return;
				const timer = setTimeout(() => releaseSession(sessionId), 5000);
				return () => clearTimeout(timer);
			}, [node.outcome, live, sessionId]);

			useEffect(() => {
				if (outcome?.kind === "error") setExpanded(true);
			}, [outcome?.kind]);

			useEffect(() => {
				if (!live) return;
				setNow(Date.now());
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [live]);

			useEffect(() => {
				if (!expanded || !observable || job === undefined) return;
				return observe(sessionId, job.id);
			}, [expanded, observable, job?.id, sessionId, observe]);

			const progress = String(job?.progress ?? job?.detail ?? "").trim();
			const summary = firstLine(outcomeText) || progress || job?.label || (waiting ? t("card.waitingHint") : t("card.runningHint"));
			const body = expanded ? outcomeText || view?.text || progress || t("card.noOutput") : "";
			const startedAt = job?.startedAt;
			const finishedAt = job?.finishedAt ?? (live ? now : undefined);
			const duration = startedAt === undefined ? "" : formatDuration((finishedAt ?? now) - startedAt);
			const label = t(
				state === "error"
					? "card.failed"
					: state === "running"
						? "card.running"
						: state === "waiting"
							? "card.waiting"
							: state === "stopped"
								? "card.stopped"
								: state === "cancelled"
									? "card.cancelled"
									: state === "unchanged"
										? "card.unchanged"
										: "card.done",
			);

			const stop = async (event) => {
				event.stopPropagation();
				if (job === undefined || stopping) return;
				setStopping(true);
				try {
					const ok = await killJob(sessionId, job.id);
					if (!ok) setStopping(false);
				} catch {
					setStopping(false);
				}
			};

			return h(
				"div",
				{
					"data-dsh-commands-card": node.name,
					"data-state": state,
					role: "group",
					"aria-label": `/${node.name} ${label}`,
					style: {
						width: "100%",
						minWidth: 0,
						margin: "2px 0",
						border: `1px solid ${state === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-border-l1)"}`,
						borderRadius: 8,
						background: "var(--dsw-alias-bg-layer-1)",
						overflow: "hidden",
						color: "var(--dsw-alias-label-primary)",
					},
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px" } },
					h(
						"button",
						{
							type: "button",
							onClick: () => setExpanded((value) => !value),
							"aria-expanded": expanded,
							"aria-label": expanded ? t("card.collapse") : t("card.expand"),
							style: {
								flex: "1",
								minWidth: 0,
								padding: 0,
								border: 0,
								background: "transparent",
								color: "inherit",
								textAlign: "left",
								cursor: "pointer",
							},
						},
						h(
							"span",
							{ style: { display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" } },
							h(StatusDot, { state }),
							h("span", { style: { fontWeight: 600, fontSize: 13 } }, `/${node.name}`),
							h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, label),
							duration.length > 0
								? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, `· ${duration}`)
								: null,
						),
						h(
							"span",
							{
								title: summary,
								style: {
									display: "block",
									marginTop: 3,
									fontSize: 12,
									color: "var(--dsw-alias-label-secondary)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								},
							},
							summary,
						),
					),
					live
						? h(
								"button",
								{
									type: "button",
									onClick: stop,
									disabled: stopping,
									title: t("card.stop"),
									style: {
										flex: "0 0 auto",
										padding: "3px 8px",
										border: "1px solid var(--dsw-alias-border-l1)",
										borderRadius: 5,
										background: "transparent",
										color: "var(--dsw-alias-label-secondary)",
										fontSize: 11,
										cursor: stopping ? "default" : "pointer",
									},
								},
								stopping ? t("card.stopping") : t("card.stop"),
							)
						: null,
					h(
						"span",
						{
							"aria-hidden": true,
							style: { flex: "0 0 auto", color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "20px" },
						},
						expanded ? "▾" : "▸",
					),
				),
				expanded
					? h(
							"div",
							{
								style: {
									borderTop: "1px solid var(--dsw-alias-border-l1)",
									background: "var(--dsw-alias-bg-layer-2)",
									padding: "8px 10px",
								},
							},
							view?.error
								? h(
										"div",
										{
											style: {
												marginBottom: 6,
												fontSize: 12,
												color: "var(--dsw-alias-state-error-primary)",
											},
										},
										String(view.error),
									)
								: null,
							h(
								"pre",
								{
									style: {
										margin: 0,
										maxHeight: 320,
										overflow: "auto",
										whiteSpace: "pre-wrap",
										wordBreak: "break-word",
										fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
										fontSize: 12,
										lineHeight: 1.55,
										color: "var(--dsw-alias-label-primary)",
									},
								},
								body,
							),
						)
					: null,
			);
		}

		function CompletionToast({ toast, t, openSession }) {
			const title = toast.failed
				? t("toast.failed", { name: toast.kind })
				: toast.stopped
					? t("toast.stopped", { name: toast.kind })
					: t("toast.done", { name: toast.kind });
			return h(
				"div",
				{
					role: "status",
					style: {
						pointerEvents: "auto",
						width: 330,
						maxWidth: "calc(100vw - 48px)",
						border: "1px solid var(--dsw-alias-border-l1)",
						borderRadius: 8,
						background: "var(--dsw-alias-bg-overlay)",
						boxShadow: "0 8px 28px rgba(0, 0, 0, 0.22)",
						padding: "10px 12px",
						color: "var(--dsw-alias-label-primary)",
					},
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "flex-start", gap: 8 } },
					h(StatusDot, { state: toast.failed ? "error" : toast.stopped ? "stopped" : "ok" }),
					h(
						"div",
						{ style: { flex: "1", minWidth: 0 } },
						h("div", { style: { fontSize: 12, fontWeight: 600 } }, title),
						h(
							"div",
							{
								title: toast.detail,
								style: {
									marginTop: 3,
									fontSize: 11,
									color: "var(--dsw-alias-label-secondary)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								},
							},
							toast.detail || toast.label,
						),
					),
					h(
						"button",
						{
							type: "button",
							onClick: () => dismissToast(toast.key),
							"aria-label": t("toast.dismiss"),
							title: t("toast.dismiss"),
							style: {
								flex: "0 0 auto",
								border: 0,
								background: "transparent",
								color: "var(--dsw-alias-label-secondary)",
								fontSize: 14,
								lineHeight: 1,
								cursor: "pointer",
								padding: 0,
							},
						},
						"×",
					),
				),
				// 当前会话里的 toast 不需要「查看」（已经在这里了）。
				toast.inCurrent === true
					? null
					: h(
							"div",
							{ style: { display: "flex", justifyContent: "flex-end", marginTop: 8 } },
							h(
								"button",
								{
									type: "button",
									onClick: () => openToast(toast.key, toast.sessionId, openSession),
									style: {
										padding: "3px 9px",
										border: "1px solid var(--dsw-alias-border-l1)",
										borderRadius: 5,
										background: "transparent",
										color: "var(--dsw-alias-brand-primary)",
										fontSize: 11,
										cursor: "pointer",
									},
								},
								t("toast.view"),
							),
						),
			);
		}

		function CompletionLayer({ useJobs, useSessions, openSession, t }) {
			const store = useCompletionStore();
			const rows = useJobs((state) => state.rows);
			const currentId = useSessions((state) =>
				Object.values(state.byId).find((session) => (session.retainedBy?.mainView ?? 0) > 0)?.id,
			);

			useEffect(() => {
				if (currentId !== undefined) clearUnread(currentId);
			}, [currentId]);

			useEffect(() => {
				scan(rows, currentId);
			}, [rows, currentId, store.version]);

			if (store.toasts.length === 0) return null;
			return h(
				"div",
				{
					"aria-live": "polite",
					style: {
						position: "fixed",
						right: 24,
						bottom: 24,
						zIndex: 30,
						display: "flex",
						flexDirection: "column",
						gap: 10,
						pointerEvents: "none",
					},
				},
				store.toasts.map((toast) =>
					h(CompletionToast, { key: toast.key, toast, t, openSession }),
				),
			);
		}

		function UnreadDot({ sessionId, t }) {
			const store = useCompletionStore();
			if (!store.unread.has(sessionId)) return null;
			return h(
				"span",
				{
					title: t("unread"),
					"aria-label": t("unread.aria"),
					"data-dsh-commands-unread": String(sessionId),
					style: {
						width: 16,
						height: 16,
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
					},
				},
				h("span", {
					"aria-hidden": true,
					style: {
						width: 6,
						height: 6,
						borderRadius: "50%",
						background: "var(--dsw-alias-state-success-primary)",
						boxShadow: "0 0 0 2px var(--dsw-specific-sidebar-fill)",
					},
				}),
			);
		}

		const inject = ["jobs", "slots", "locale", "uiWorkspace"];

		function apply(ctx) {
			ctx.effect(
				() => ctx.locale.register("dsh-commands", { zh, en }),
				"dsh-commands: dictionaries",
			);

			for (const name of SKILL_KINDS) {
				ctx.slots.inject("conversation.chat.commandview", () =>
					ctx.slots.register(
						{
							name: "conversation.chat.commandview",
							key: name,
							locale: "dsh-commands",
							inject: () => ({
								hooks: { jobs: ctx.jobs.state },
								watchRows: (sessionId) => ctx.jobs.watchRows(sessionId),
								observe: (sessionId, jobId) => ctx.jobs.observe(sessionId, jobId),
								killJob: async (sessionId, jobId) => (await ctx.jobs.kill(sessionId, jobId)).ok,
							}),
						},
						SkillCommandCard,
					),
				);
			}

			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "dsh-commands-completion",
						order: 100,
						locale: "dsh-commands",
						inject: () => ({
							hooks: { jobs: ctx.jobs.state },
							openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
						}),
					},
					CompletionLayer,
				),
			);

			ctx.slots.inject("sidebar.session.row.leading", () =>
				ctx.slots.register(
					{
						name: "sidebar.session.row.leading",
						id: "dsh-commands-unread",
						order: 20,
						locale: "dsh-commands",
					},
					UnreadDot,
				),
			);
		}

		return { inject, apply };
	},
});
