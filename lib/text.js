/**
 * 终端文本清洗：ANSI、clack 框线/spinner 重绘、尾部截断。
 *
 * 两处调用方的取舍不同：
 * - 命令回执要折叠 spinner、去掉 logo/框线，并同时受行数与字符预算约束；
 * - 缓存错误只需要「最后几行」，不折叠也不去装饰。
 * 所以这里用 option 保留差异，而不是写两份实现。
 */

const ANSI_OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripAnsi(text) {
	return String(text ?? "")
		.replace(ANSI_OSC, "")
		.replace(ANSI_CSI, "")
		.replace(CONTROL_CHARS, "");
}

/** 表格/框线的左右边框：`│ → ~/.agents/skills/x  │` 去掉边缘后才是正文。 */
const BOX_EDGE = /^[\s│┃|]+|[\s│┃]+$/gu;

/** 只剩装饰（框线、分隔线、ASCII 大标题的块字符）的行：整行丢掉。 */
const DECORATION_ONLY = /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝═║█▀▄▌▐░▒▓|\-+_=~*<>]+$/u;

/** 进度重绘的尾缀：clack spinner 每次重绘追加 `.`/`…`/`·`。 */
const SPINNER_TAIL = /[\s.…·]+$/u;

/** 进度帧的头部字形：`◒`/`◐`/`◓`/`◑`、braille、`-`/`|`。只在计算 dedupe key 时抹掉。 */
const SPINNER_LEAD = /^[\s]*(?:[◐◓◑◒◜◝◞◟◴◵◶◷]|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|[|/\\-])\s*/u;

/**
 * 取输出尾部，按需剥 ANSI、折叠 spinner、去装饰线与框线，并施加行/字符上限。
 *
 * @param {string} text 原始输出
 * @param {object} [options]
 * @param {number} [options.lines=15] 最多保留多少行
 * @param {number} [options.maxLineChars=0] 单行字符上限；0 = 不限制
 * @param {number} [options.maxChars=0] 整段字符上限；0 = 不限制
 * @param {boolean} [options.foldSpinner=true] 是否按 spinner 字形/尾缀去重
 * @param {boolean} [options.stripDecorations=true] 是否丢弃纯装饰行
 * @param {boolean} [options.stripBoxEdges=true] 是否剥掉表格左右边框
 */
export function tail(text, options = {}) {
	const {
		lines = 15,
		maxLineChars = 0,
		maxChars = 0,
		foldSpinner = true,
		stripDecorations = true,
		stripBoxEdges = true,
	} = options;

	const kept = [];
	let previousKey;
	for (const raw of stripAnsi(text).split(/\r\n|\r|\n/)) {
		const line = (stripBoxEdges ? raw.replace(BOX_EDGE, "") : raw).trimEnd();
		if (line.length === 0 || (stripDecorations && DECORATION_ONLY.test(line))) continue;
		if (foldSpinner) {
			const key = line.replace(SPINNER_LEAD, "").replace(SPINNER_TAIL, "");
			if (key === previousKey) continue;
			previousKey = key;
		}
		kept.push(maxLineChars > 0 && line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line);
	}

	const selected = kept.slice(-lines);
	if (maxChars <= 0) return selected.join("\n");

	// 字符预算从尾部往前算：宁可少几行，也不能让命令卡片被几百 KB 的进度帧撑爆。
	const out = [];
	let budget = maxChars;
	for (let i = selected.length - 1; i >= 0; i -= 1) {
		const line = selected[i];
		if (line.length + 1 > budget) {
			if (out.length === 0) out.push(`${line.slice(0, Math.max(0, budget - 1))}…`);
			break;
		}
		out.unshift(line);
		budget -= line.length + 1;
	}
	return out.join("\n");
}
