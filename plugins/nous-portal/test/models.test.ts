import { expect, test } from "bun:test";
import { fetchModelCatalog, parseModelCatalog } from "../src/models.ts";

test("Nous /models を OMP model metadata に変換する", () => {
	const models = parseModelCatalog({
		data: [
			{
				id: "meituan/longcat-2",
				name: "Meituan: LongCat 2.0",
				context_length: 262144,
				max_completion_tokens: 32768,
				input_modalities: ["text"],
				output_modalities: ["text"],
				pricing: { prompt: "0", completion: "0" },
			},
			{
				id: "google/gemini-test",
				architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
				supported_parameters: ["reasoning"],
				pricing: { prompt: "0.000001", completion: "0.000004" },
			},
			{ id: "meituan/longcat-2", pricing: { prompt: "9", completion: "9" } },
			{ id: "image-only", output_modalities: ["image"] },
		],
	});

	expect(models).toHaveLength(2);
	expect(models[0]).toMatchObject({
		id: "meituan/longcat-2",
		name: "Meituan: LongCat 2.0",
		contextWindow: 262144,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	expect(models[1]).toMatchObject({
		id: "google/gemini-test",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
	});
});

test("live metadata が無い場合は model ID から能力を推測しない", () => {
	const models = parseModelCatalog({ data: [{ id: "google/gemini-test" }, { id: "openai/gpt-5-test" }] });
	expect(models).toHaveLength(2);
	for (const model of models) {
		expect(model.reasoning).toBe(false);
		expect(model.input).toEqual(["text"]);
	}
});

test("live catalog は credential を送らず取得する", async () => {
	const calls: Array<{ input: string; authorization?: string }> = [];
	const models = await fetchModelCatalog("https://example.test/v1/", {
		fetchFn: async (input, init) => {
			const headers = new Headers(init?.headers);
			calls.push({ input: String(input), authorization: headers.get("Authorization") ?? undefined });
			return new Response(
				JSON.stringify({ data: [{ id: "poolside/laguna", pricing: { prompt: "0", completion: "0" } }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	});

	expect(calls).toEqual([{ input: "https://example.test/v1/models", authorization: undefined }]);
	expect(models[0]?.id).toBe("poolside/laguna");
});

test("価格欠落を free model の根拠としてフィルタしない", () => {
	const models = parseModelCatalog({ data: [{ id: "unknown-price-model" }] });
	expect(models).toHaveLength(1);
	expect(models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
