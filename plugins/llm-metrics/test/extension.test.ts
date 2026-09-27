import { expect, test } from "bun:test";
import { deriveEndpoints, isProbeEligible, resolveModel } from "../src/index.ts";
import { VllmObserver } from "../src/observer.ts";

test("metrics endpointはcleanなOpenAI-compatible base URLからだけ導出する", () => {
	expect(deriveEndpoints("http://127.0.0.1:8000/v1")).toEqual({
		metricsUrl: "http://127.0.0.1:8000/metrics",
		isHttp: true,
	});
	expect(deriveEndpoints("https://example.test/api/v1")).toBeNull();
	expect(deriveEndpoints("file:///tmp/model")).toBeNull();
});

test("canonical backendまたはself-hosted HTTPだけをprobeする", () => {
	expect(isProbeEligible("vllm", { isHttp: false })).toBe(true);
	expect(isProbeEligible("sglang", { isHttp: false })).toBe(true);
	expect(isProbeEligible("custom", { isHttp: true })).toBe(true);
	expect(isProbeEligible("custom", { isHttp: false })).toBe(false);
});

test("subagent resolvedModelは最長のprovider/model selectorへ解決する", () => {
	const models = [
		{ provider: "vllm", id: "vendor/model", baseUrl: "http://a/v1" },
		{ provider: "vllm", id: "vendor/model:variant", baseUrl: "http://b/v1" },
	];
	expect(resolveModel("vllm/vendor/model:variant:high", models)?.baseUrl).toBe("http://b/v1");
});

async function settle(): Promise<void> {
	await Bun.sleep(0);
}

test("active telemetryはlive sampleだけを表示し、fetch failureでstale値を消す", async () => {
	let tick: (() => void) | undefined;
	const statuses: Array<string | undefined> = [];
	let request = 0;
	const observer = new VllmObserver({
		setInterval: (cb) => {
			tick = cb;
			return 1;
		},
		clearTimer: () => {},
		setStatus: (_key, text) => statuses.push(text),
		fetch: async () => {
			request += 1;
			if (request === 1) return new Response("vllm:kv_cache_usage_perc 0.5");
			return new Response("unavailable", { status: 503 });
		},
	});

	observer.addLease("main", { metricsUrl: "http://127.0.0.1:8000/metrics" });
	await settle();
	expect(statuses.at(-1)).toBe("vLLM │ KV 50%");

	tick?.();
	await settle();
	expect(statuses.at(-1)).toBeUndefined();
});

test("最後のlease解放でtimerとstatusを即座にclearする", async () => {
	let cleared = 0;
	const statuses: Array<string | undefined> = [];
	const observer = new VllmObserver({
		setInterval: () => 1,
		clearTimer: () => {
			cleared += 1;
		},
		setStatus: (_key, text) => statuses.push(text),
		fetch: async () => new Response("sglang:token_usage 0.25"),
	});

	observer.addLease("main", { metricsUrl: "http://127.0.0.1:30000/metrics" });
	await settle();
	expect(statuses.at(-1)).toBe("SGLang │ KV 25%");
	observer.removeLease("main");
	expect(cleared).toBe(1);
	expect(statuses.at(-1)).toBeUndefined();
});
