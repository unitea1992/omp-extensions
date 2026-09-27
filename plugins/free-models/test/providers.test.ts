import { expect, test } from "bun:test";
import {
	isFreeCandidate,
	parseNousFreeRecommendations,
	parseOpenCodeZenCatalog,
	parseOpenRouterCatalog,
	parsePricedCatalog,
} from "../src/providers.ts";

test("Nous/OpenRouter pricing は prompt と completion の明示的な 0 のみ無料証拠にする", () => {
	const parsed = parsePricedCatalog({
		data: [
			{ id: "a:free", pricing: { prompt: "0", completion: "0" } },
			{ id: "missing", pricing: {} },
			{ id: "paid", pricing: { prompt: "0.1", completion: "0" } },
		],
	});
	expect([...parsed.availableIds]).toEqual(["a:free", "missing", "paid"]);
	expect([...parsed.freeIds]).toEqual(["a:free"]);
});

test("Nous freeRecommendedModels から modelName を抽出する", () => {
	const free = parseNousFreeRecommendations({
		freeRecommendedModels: [{ modelName: "stepfun/step-3.7-flash:free" }, { modelName: "" }, null],
	});
	expect([...free]).toEqual(["stepfun/step-3.7-flash:free"]);
});

test("OpenRouter の free 判定は pricing 根拠で suffix に依存しない", () => {
	const parsed = parseOpenRouterCatalog({
		data: [
			{ id: "openrouter/free", pricing: { prompt: "0", completion: "0" } },
			{ id: "vendor/stale-label:free", pricing: { prompt: "0.1", completion: "0.2" } },
		],
	});
	expect([...parsed.freeIds]).toEqual(["openrouter/free"]);
});

test("OpenCode Zen は live catalog の -free SKU だけを confirmed-free source にする", () => {
	const parsed = parseOpenCodeZenCatalog({
		object: "list",
		data: [{ id: "mimo-v2.5-free" }, { id: "big-pickle" }, { id: "minimax-m3" }],
	});
	expect([...parsed.availableIds]).toEqual(["mimo-v2.5-free", "big-pickle", "minimax-m3"]);
	expect([...parsed.freeIds]).toEqual(["mimo-v2.5-free"]);
});

test("provider candidate marker は machine-readable SKU marker のみに限定する", () => {
	expect(isFreeCandidate({ provider: "nous-portal", id: "a/b:free" })).toBe(true);
	expect(isFreeCandidate({ provider: "opencode-zen", id: "mimo-v2.5-free" })).toBe(true);
	expect(isFreeCandidate({ provider: "opencode-zen", id: "big-pickle" })).toBe(false);
	expect(isFreeCandidate({ provider: "nous-portal", id: "paid/model" })).toBe(false);
});
