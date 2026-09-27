import { expect, test } from "bun:test";
import { checkFreeModelAvailability, classifyProvider, formatAvailabilityReport } from "../src/checker.ts";
import { SUPPORTED_PROVIDER_IDS } from "../src/types.ts";
import type { AvailabilityReport, ProviderSnapshot } from "../src/types.ts";

function snapshot(available: string[], free: string[]): ProviderSnapshot {
	return { availableIds: new Set(available), freeIds: new Set(free), warnings: [] };
}

test("live free / stale / not-free / live-only を区別する", () => {
	const report = classifyProvider(
		"openrouter",
		[
			{ provider: "openrouter", id: "vendor/live:free" },
			{ provider: "openrouter", id: "vendor/gone:free" },
			{ provider: "openrouter", id: "vendor/paid-now:free" },
		],
		snapshot(["vendor/live:free", "vendor/paid-now:free", "vendor/new:free"], ["vendor/live:free", "vendor/new:free"]),
	);
	expect(report.rows.map((row) => [row.modelId, row.status])).toEqual([
		["vendor/gone:free", "stale"],
		["vendor/paid-now:free", "not-free"],
		["vendor/new:free", "live-only"],
		["vendor/live:free", "confirmed"],
	]);
});

test("OpenCode Zen の suffix なしモデルを local heuristic で候補化しない", () => {
	const report = classifyProvider(
		"opencode-zen",
		[
			{ provider: "opencode-zen", id: "big-pickle" },
			{ provider: "opencode-zen", id: "mimo-v2.5-free" },
		],
		snapshot(["big-pickle", "mimo-v2.5-free"], ["mimo-v2.5-free"]),
	);
	expect(report.rows.map((row) => [row.modelId, row.status])).toEqual([["mimo-v2.5-free", "confirmed"]]);
});

test("provider live source が suffix なしモデルを無料と明示した場合は confirmed-free にする", () => {
	const report = classifyProvider(
		"openrouter",
		[{ provider: "openrouter", id: "openrouter/free" }],
		snapshot(["openrouter/free"], ["openrouter/free"]),
	);
	expect(report.rows).toHaveLength(1);
	expect(report.rows[0]?.status).toBe("confirmed");
});

test("live source failure は candidate を UNKNOWN に倒す", () => {
	const report = classifyProvider(
		"nous-portal",
		[{ provider: "nous-portal", id: "vendor/model:free" }],
		undefined,
		"timeout",
	);
	expect(report.rows).toHaveLength(1);
	expect(report.rows[0]?.status).toBe("unknown");
});

test("status report は OK を含む全件をモデル名込みで表示する", () => {
	const report: AvailabilityReport = {
		providers: [
			{
				providerId: "openrouter",
				providerLabel: "OpenRouter",
				warnings: [],
				rows: [
					{
						providerId: "openrouter",
						providerLabel: "OpenRouter",
						modelId: "ok:free",
						status: "confirmed",
						reason: "ok",
					},
					{
						providerId: "openrouter",
						providerLabel: "OpenRouter",
						modelId: "gone:free",
						status: "stale",
						reason: "gone",
					},
					{
						providerId: "openrouter",
						providerLabel: "OpenRouter",
						modelId: "paid-now:free",
						status: "not-free",
						reason: "paid",
					},
					{
						providerId: "openrouter",
						providerLabel: "OpenRouter",
						modelId: "mystery:free",
						status: "unknown",
						reason: "unavailable",
					},
					{
						providerId: "openrouter",
						providerLabel: "OpenRouter",
						modelId: "new:free",
						status: "live-only",
						reason: "provider-only",
					},
				],
			},
		],
	};
	const text = formatAvailabilityReport(report);
	expect(text).toContain("Free model status");
	expect(text).toContain("OK ok:free");
	expect(text).toContain("STALE gone:free");
	expect(text).toContain("NOT-FREE paid-now:free");
	expect(text).toContain("UNKNOWN mystery:free");
	expect(text).toContain("LIVE-ONLY new:free");
	expect(text).toContain("No inference requests were sent");
});

test("status は OMP 側にない provider の live free も対象にする", async () => {
	const payload = (body: unknown) =>
		({
			ok: true,
			headers: { get: () => null },
			arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
		}) as unknown as Response;
	const fetchFn = (async (url: string | URL | Request) => {
		const raw = String(url);
		if (raw.includes("opencode.ai")) return payload({ data: [{ id: "mimo-v2.5-free" }] });
		if (raw.includes("openrouter")) return payload({ data: [] });
		if (raw.includes("portal.nousresearch")) return payload({ freeRecommendedModels: [] });
		return payload({ data: [] });
	}) as unknown as typeof fetch;
	const report = await checkFreeModelAvailability([{ provider: "openrouter", id: "vendor/live:free" }], { fetchFn });
	expect(report.providers.map((provider) => provider.providerId).sort()).toEqual([...SUPPORTED_PROVIDER_IDS].sort());
	const zen = report.providers.find((provider) => provider.providerId === "opencode-zen");
	expect(zen?.rows.map((row) => [row.modelId, row.status])).toContainEqual(["mimo-v2.5-free", "live-only"]);
});
