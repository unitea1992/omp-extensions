import { beforeAll, describe, expect, test } from "bun:test";
import { resolveLocalUrlToPath as nativeResolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import {
	hasMagicKeyword as nativeHasMagicKeyword,
	highlightMagicKeywords as nativeHighlightMagicKeywords,
	setMagicKeywords,
} from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { maskNonProse as nativeMaskNonProse } from "@oh-my-pi/pi-tui/prompt/markdown-prose";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";
import { hasMagicKeyword, highlightMagicKeywords, maskNonProse, resolveLocalUrlToPath } from "../src/omp-compat";

const CORPUS = [
	"workflowz を使う",
	"jevify で分類する",
	"`jevify` はコード中の語",
	"`workflowz` はコード中の語",
	"```\nworkflowz\n```",
	"<attachment>workflowz</attachment>",
	"orchestrate と ultrathink",
	"path/to/workflowz.ts",
	"日本語の prose <tag>orchestrate</tag> の後",
	"未終了の `workflowz はそのまま",
];

function stripAnsi(value: string): string {
	return value
		.split(String.fromCharCode(27))
		.join("")
		.replace(/\[[0-9;]*m/g, "");
}

describe("current OMP SDK manifest parity", () => {
	beforeAll(() => {
		initThemeSync();
		setMagicKeywords(MAGIC_KEYWORDS.map(({ word, hue }) => ({ word, hue })));
	});

	test("masking and keyword detection match the current SDK", () => {
		for (const text of CORPUS) {
			expect(maskNonProse(text)).toBe(nativeMaskNonProse(text));
			expect(hasMagicKeyword(text)).toBe(nativeHasMagicKeyword(text));
		}
	});

	test("current one-argument usage parity preserves native prose boundaries", () => {
		for (const text of CORPUS) {
			expect(stripAnsi(highlightMagicKeywords(text))).toBe(stripAnsi(nativeHighlightMagicKeywords(text)));
		}
	});

	test("local URL resolution matches the current SDK session-local contract", () => {
		const options = {
			getArtifactsDir: () => "/tmp/omp-parity-artifacts",
			getSessionId: () => "parity/session",
		};
		for (const input of ["local://paste-1.md", "local://nested/paste-2.md", "local://"]) {
			expect(resolveLocalUrlToPath(input, options)).toBe(nativeResolveLocalUrlToPath(input, options));
		}
		expect(() => resolveLocalUrlToPath("local://a/../b", options)).toThrow(
			"Path traversal (..) is not allowed in local:// URLs",
		);
		expect(() => nativeResolveLocalUrlToPath("local://a/../b", options)).toThrow(
			"Path traversal (..) is not allowed in local:// URLs",
		);
		expect(() => resolveLocalUrlToPath("local://bad%ZZ", options)).toThrow(
			"Invalid URL encoding in local:// path: local://bad%ZZ",
		);
		expect(() => nativeResolveLocalUrlToPath("local://bad%ZZ", options)).toThrow(
			"Invalid URL encoding in local:// path: local://bad%ZZ",
		);
	});
});
