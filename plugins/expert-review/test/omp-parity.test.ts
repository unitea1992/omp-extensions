import { describe, expect, test } from "bun:test";
import { ThinkingLevel as nativeThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { extractExplicitThinkingSelector as nativeExtractExplicitThinkingSelector } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { concreteThinkingLevel as nativeConcreteThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { ThinkingLevel, concreteThinkingLevel, extractExplicitThinkingSelector } from "../src/omp-compat";

const settings = {
	getModelRole: (role: string) =>
		role === "advisor"
			? "openai-codex/gpt-6-astra:xhigh"
			: role === "reviewer"
				? "openai-codex/gpt-6-astra:max"
				: undefined,
};

describe("current OMP SDK manifest parity", () => {
	test("thinking level constants and concrete conversion match the current SDK", () => {
		expect(ThinkingLevel).toEqual(nativeThinkingLevel);
		for (const level of [
			undefined,
			"auto",
			nativeThinkingLevel.Inherit,
			nativeThinkingLevel.Off,
			nativeThinkingLevel.XHigh,
		] as const) {
			expect(concreteThinkingLevel(level)).toBe(nativeConcreteThinkingLevel(level));
		}
	});

	test("explicit thinking selector extraction matches the current SDK", () => {
		for (const value of [
			undefined,
			"",
			"@advisor",
			"@advisor:xhigh",
			"@advisor:auto",
			"openai-codex/gpt-6-astra:xhigh",
			"openai-codex/gpt-6-astra:medium",
			"openai-codex/gpt-6-astra:max",
			"@reviewer",
			"default",
		]) {
			expect(extractExplicitThinkingSelector(value, settings)).toBe(
				nativeExtractExplicitThinkingSelector(value, settings as unknown as Settings),
			);
		}
	});
});
