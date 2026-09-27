import * as os from "node:os";
import * as path from "node:path";

const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;
const FG_RESET = "\x1b[39m";
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;
const FENCE = /^( {0,3})([`~]{3,})/;

export function magicKeywordRegex(keyword: string, flags = ""): RegExp {
	const escaped = keyword.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	return new RegExp(`${LEFT_BOUNDARY}${escaped}${RIGHT_BOUNDARY}`, flags.includes("u") ? flags : `${flags}u`);
}

function backtickRunEnd(text: string, index: number, length: number): number {
	let cursor = index;
	while (cursor < length && text[cursor] === "`") cursor++;
	return cursor;
}

function findBacktickClose(text: string, from: number, length: number, runLength: number, masked: Uint8Array): number {
	let cursor = from;
	while (cursor < length) {
		if (masked[cursor]) {
			cursor++;
			continue;
		}
		if (text[cursor] === "`") {
			const end = backtickRunEnd(text, cursor, length);
			if (end - cursor === runLength) return end;
			cursor = end;
			continue;
		}
		cursor++;
	}
	return -1;
}

function findTagEnd(text: string, from: number, length: number): number {
	let quote = "";
	for (let cursor = from; cursor < length; cursor++) {
		const character = text[cursor];
		if (quote) {
			if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === ">") return cursor;
		if (character === "<") return -1;
	}
	return -1;
}

function findMatchingClose(text: string, start: number, length: number, name: string, masked: Uint8Array): number {
	const lowerName = name.toLowerCase();
	let depth = 1;
	let cursor = start;
	while (cursor < length) {
		if (masked[cursor] || text[cursor] !== "<") {
			cursor++;
			continue;
		}
		let nameStart = cursor + 1;
		let closing = false;
		if (text[nameStart] === "/") {
			closing = true;
			nameStart++;
		}
		TAG_NAME.lastIndex = nameStart;
		const match = TAG_NAME.exec(text);
		if (!match) {
			cursor++;
			continue;
		}
		const end = findTagEnd(text, TAG_NAME.lastIndex, length);
		if (end < 0) {
			cursor++;
			continue;
		}
		if (match[0].toLowerCase() === lowerName) {
			if (closing) {
				depth--;
				if (depth === 0) return end + 1;
			} else if (text[end - 1] !== "/") depth++;
		}
		cursor = end + 1;
	}
	return -1;
}

function maskTagAt(text: string, index: number, length: number, masked: Uint8Array): number {
	if (text.startsWith("<!--", index)) {
		const end = text.indexOf("-->", index + 4);
		const stop = end < 0 ? length : end + 3;
		for (let cursor = index; cursor < stop; cursor++) masked[cursor] = 1;
		return stop;
	}
	let nameStart = index + 1;
	let closing = false;
	if (text[nameStart] === "/") {
		closing = true;
		nameStart++;
	}
	TAG_NAME.lastIndex = nameStart;
	const match = TAG_NAME.exec(text);
	if (!match) return index;
	const end = findTagEnd(text, TAG_NAME.lastIndex, length);
	if (end < 0) return index;
	const tagEnd = end + 1;
	for (let cursor = index; cursor < tagEnd; cursor++) masked[cursor] = 1;
	if (closing || text[end - 1] === "/") return tagEnd;
	const close = findMatchingClose(text, tagEnd, length, match[0], masked);
	if (close < 0) return tagEnd;
	for (let cursor = tagEnd; cursor < close; cursor++) masked[cursor] = 1;
	return close;
}

/** Length-preserving masking compatible with OMP's markdown-prose helper. */
export function maskNonProse(text: string): string {
	if (!text.includes("`") && !text.includes("<") && !text.includes("~~~")) return text;
	const length = text.length;
	const masked = new Uint8Array(length);
	let fenceChar = "";
	let fenceLength = 0;
	let lineStart = 0;
	while (lineStart <= length) {
		let newline = text.indexOf("\n", lineStart);
		if (newline < 0) newline = length;
		const line = text.slice(lineStart, newline);
		const open = FENCE.exec(line);
		if (fenceChar) {
			for (let cursor = lineStart; cursor < newline; cursor++) masked[cursor] = 1;
			const marker = open?.[2];
			if (
				marker?.[0] === fenceChar &&
				marker.length >= fenceLength &&
				line.slice((open?.[1] ?? "").length + marker.length).trim() === ""
			) {
				fenceChar = "";
				fenceLength = 0;
			}
		} else if (open?.[2]) {
			const marker = open[2];
			const character = marker[0] ?? "";
			if (!(character === "`" && line.slice((open[1] ?? "").length + marker.length).includes("`"))) {
				fenceChar = character;
				fenceLength = marker.length;
				for (let cursor = lineStart; cursor < newline; cursor++) masked[cursor] = 1;
			}
		}
		if (newline === length) break;
		lineStart = newline + 1;
	}

	let index = 0;
	while (index < length) {
		if (masked[index]) {
			index++;
			continue;
		}
		if (text[index] === "`") {
			const runEnd = backtickRunEnd(text, index, length);
			const close = findBacktickClose(text, runEnd, length, runEnd - index, masked);
			if (close >= 0) {
				for (let cursor = index; cursor < close; cursor++) masked[cursor] = 1;
				index = close;
			} else index = runEnd;
			continue;
		}
		if (text[index] === "<") {
			const end = maskTagAt(text, index, length, masked);
			index = end > index ? end : index + 1;
			continue;
		}
		index++;
	}

	const output = text.split("");
	for (let index = 0; index < length; index++) {
		if (masked[index] && output[index] !== "\n") output[index] = " ";
	}
	return output.join("");
}

function keywordInProse(text: string, keyword: RegExp): boolean {
	if (!keyword.test(text)) return false;
	return keyword.test(maskNonProse(text));
}

export function hasMagicKeyword(text: string): boolean {
	const keywords = ["ultrathink", "orchestrate", "workflowz", "jevify"];
	if (!keywords.some((keyword) => text.includes(keyword))) return false;
	return keywords.some((keyword) => keywordInProse(text, magicKeywordRegex(keyword)));
}

function usesTrueColor(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (env.WT_SESSION) return true;
	if (
		env.KITTY_WINDOW_ID ||
		env.GHOSTTY_RESOURCES_DIR ||
		env.WEZTERM_PANE ||
		env.ITERM_SESSION_ID ||
		env.VSCODE_PID ||
		env.ALACRITTY_WINDOW_ID
	) {
		return true;
	}
	const terminalProgram = env.TERM_PROGRAM?.toLowerCase();
	if (
		terminalProgram &&
		["kitty", "ghostty", "wezterm", "iterm.app", "vscode", "alacritty", "warpterminal", "orca"].includes(
			terminalProgram,
		)
	) {
		return true;
	}
	if (env.TERM?.toLowerCase().includes("ghostty")) return true;
	const colorTerm = env.COLORTERM?.toLowerCase();
	return colorTerm === "truecolor" || colorTerm === "24bit";
}

function paintKeyword(word: string, hue: (position: number) => number): string {
	let output = "";
	let previous = "";
	const format = usesTrueColor() ? "ansi-16m" : "ansi-256";
	for (let index = 0; index < word.length; index++) {
		const position = Math.floor((index / word.length) * 14) / 14;
		const color = Bun.color(`hsl(${Math.round(hue(position))}, 90%, 62%)`, format) ?? "";
		if (color !== previous) {
			output += color;
			previous = color;
		}
		output += word[index];
	}
	return `${output}${FG_RESET}`;
}

function highlightKeyword(text: string, keyword: string, hue: (position: number) => number): string {
	const masked = maskNonProse(text);
	const matches = magicKeywordRegex(keyword, "g");
	let output = "";
	let last = 0;
	for (const match of masked.matchAll(matches)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		output += text.slice(last, start) + paintKeyword(text.slice(start, end), hue);
		last = end;
	}
	return output + text.slice(last);
}

/**
 * Native-compatible static keyword styling for the plugin's current one-argument usage.
 * resetTo/phase are intentionally outside this local compatibility surface.
 */
export function highlightMagicKeywords(text: string): string {
	return highlightKeyword(
		highlightKeyword(
			highlightKeyword(
				highlightKeyword(text, "ultrathink", (position) => position * 330),
				"orchestrate",
				(position) => 150 + position * 130,
			),
			"workflowz",
			(position) => 30 + position * 120,
		),
		"jevify",
		(position) => 300 + position * 120,
	);
}

export interface LocalProtocolOptions {
	getArtifactsDir?: () => string | null;
	getSessionId?: () => string | null;
}

function localRoot(options: LocalProtocolOptions): string {
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir) return path.resolve(artifactsDir, "local");
	const sessionId = (options.getSessionId?.() ?? "session").replace(/[^a-zA-Z0-9_.-]/g, "_") || "session";
	return path.join(os.tmpdir(), "omp-local", sessionId);
}

/** Resolve local:// paths without importing the OMP internal URL module. */
export function resolveLocalUrlToPath(input: string, options: LocalProtocolOptions): string {
	const root = path.resolve(localRoot(options));
	const raw = input.startsWith("local://") ? input.slice("local://".length) : input;
	let relative: string;
	try {
		relative = decodeURIComponent(raw.split(/[?#]/u, 1)[0] ?? "").replace(/^[/\\]+/u, "");
	} catch {
		throw new Error(`Invalid URL encoding in local:// path: ${input}`);
	}
	if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
		throw new Error("Path traversal (..) is not allowed in local:// URLs");
	}
	const resolved = relative ? path.resolve(root, relative) : root;
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error("local:// URL escapes local root");
	}
	return resolved;
}
