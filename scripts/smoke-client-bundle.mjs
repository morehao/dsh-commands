/**
 * Client half 的离线接线冒烟：加载 `lib/client.js` 的 module-loader 外壳，用假的
 * React / slots / jobs 调 `apply()`，确认三个命令卡、完成提示、未读点都注册到了
 * 约定的槽上，并且 locale / inject 完整。
 *
 * 不渲染组件（没有 React renderer）；视觉验证仍要在真实 dsh web 里做。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let definition;
globalThis.window = {
	__ModuleLoader__: {
		load(value) {
			definition = value;
		},
	},
};
const source = await readFile(join(root, "lib", "client.js"), "utf8");
new Function("window", source)(globalThis.window);

assert.equal(definition?.id, "@morehao/dsh-commands", "client bundle id 必须是包名");
assert.equal(typeof definition?.factory, "function", "client bundle 缺少 factory");

const React = {
	createElement() {},
	useEffect() {},
	useMemo() {},
	useState() {},
	useSyncExternalStore() {},
};
const module = definition.factory((id) => {
	assert.equal(id, "react", `只允许 require(\"react\")，实际：${id}`);
	return React;
});
assert.deepEqual(module.inject, ["jobs", "slots", "locale", "uiWorkspace"], "client inject 不完整");

const registrations = [];
let locale;
const ctx = {
	effect(fn) {
		const dispose = fn();
		assert.equal(typeof dispose, "function", "locale effect 应返回 disposer");
	},
	locale: {
		register(namespace, dictionaries) {
			locale = { namespace, dictionaries };
			return () => {};
		},
	},
	slots: {
		inject(_name, callback) {
			return callback();
		},
		register(options, component) {
			registrations.push({ options, component });
			return () => {};
		},
	},
	jobs: {
		state: () => {},
		watchRows: () => () => {},
		observe: () => () => {},
		kill: async () => ({ ok: true }),
	},
	uiWorkspace: { openSession() {} },
};
module.apply(ctx);

assert.equal(locale?.namespace, "dsh-commands");
for (const key of ["card.waiting", "card.running", "card.done", "card.failed", "card.stopped", "card.cancelled", "toast.done", "toast.failed", "toast.stopped", "unread"]) {
	assert.equal(typeof locale.dictionaries.zh[key], "string", `缺少 zh.${key}`);
	assert.equal(typeof locale.dictionaries.en[key], "string", `缺少 en.${key}`);
}

const commandviews = registrations.filter((item) => item.options.name === "conversation.chat.commandview");
assert.deepEqual(
	commandviews.map((item) => item.options.key).sort(),
	["skill-init", "skill-install", "skill-update"],
	"三个 skill 命令都要接管 commandview",
);
for (const item of commandviews) {
	assert.equal(item.options.locale, "dsh-commands");
	const props = item.options.inject();
	assert.equal(typeof props.watchRows, "function");
	assert.equal(typeof props.observe, "function");
	assert.equal(typeof props.killJob, "function");
	assert.equal(typeof props.hooks.jobs, "function");
}

const overlay = registrations.find((item) => item.options.name === "shell.overlay");
assert.equal(overlay?.options.id, "dsh-commands-completion");
assert.equal(typeof overlay.options.inject().openSession, "function");
assert.equal(typeof overlay.options.inject().hooks.jobs, "function");

const unread = registrations.find((item) => item.options.name === "sidebar.session.row.leading");
assert.equal(unread?.options.id, "dsh-commands-unread");
assert.equal(unread.options.locale, "dsh-commands");

console.log(`✓ client bundle：${registrations.length} 个槽注册、${Object.keys(locale.dictionaries.zh).length} 条中文文案`);
