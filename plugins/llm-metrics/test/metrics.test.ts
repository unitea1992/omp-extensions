import { expect, test } from "bun:test";
import {
	DraftDelta,
	GenerationRateTracker,
	detectMetricsBackend,
	parsePrometheusMetrics,
	renderStatus,
} from "../src/metrics.ts";

test("current vLLM metricsを集約する", () => {
	const sample = parsePrometheusMetrics(`
# HELP ignored
vllm:kv_cache_usage_perc{engine="0"} 0.25
vllm:kv_cache_usage_perc{engine="1"} 0.40
vllm:spec_decode_num_accepted_tokens_total{engine="0"} 10
vllm:spec_decode_num_accepted_tokens_total{engine="1"} 20
vllm:spec_decode_num_draft_tokens_total{engine="0"} 20
vllm:spec_decode_num_draft_tokens_total{engine="1"} 40
vllm:generation_tokens_total{engine="0"} 100
vllm:generation_tokens_total{engine="1"} 200
vllm:num_requests_waiting{engine="0"} 2
vllm:num_requests_waiting{engine="1"} 3
`);
	expect(sample).toEqual({
		kvCacheUsage: 0.4,
		specAccepted: 30,
		specDraft: 60,
		generationTokens: 300,
		requestsWaiting: 5,
	});
});

test("deprecated vLLM metric namesはcurrent contractとして読まない", () => {
	const sample = parsePrometheusMetrics(`
vllm:gpu_cache_usage_perc 0.9
vllm:spec_decode_num_accepted_tokens 10
vllm:spec_decode_num_draft_tokens 20
vllm:generation_tokens 100
`);
	expect(sample).toEqual({
		kvCacheUsage: null,
		specAccepted: null,
		specDraft: null,
		generationTokens: null,
		requestsWaiting: null,
	});
});

test("backend namespaceを判定する", () => {
	expect(detectMetricsBackend("vllm:num_requests_waiting 0")).toBe("vllm");
	expect(detectMetricsBackend("sglang:num_queue_reqs 0")).toBe("sglang");
	expect(detectMetricsBackend("process_cpu_seconds_total 1")).toBeNull();
});

test("vLLM speculative counter差分からacceptance rateを計算する", () => {
	const delta = new DraftDelta();
	expect(
		delta.sample({
			kvCacheUsage: null,
			specAccepted: 10,
			specDraft: 20,
			generationTokens: null,
			requestsWaiting: null,
		}),
	).toBeNull();
	expect(
		delta.sample({
			kvCacheUsage: null,
			specAccepted: 15,
			specDraft: 30,
			generationTokens: null,
			requestsWaiting: null,
		}),
	).toBe(0.5);
	// counter resetはcurrent値を新baselineとして保持する。
	expect(
		delta.sample({ kvCacheUsage: null, specAccepted: 1, specDraft: 2, generationTokens: null, requestsWaiting: null }),
	).toBeNull();
	expect(
		delta.sample({ kvCacheUsage: null, specAccepted: 3, specDraft: 6, generationTokens: null, requestsWaiting: null }),
	).toBe(0.5);
});

test("generation counter差分をtok/sへ変換する", () => {
	const tracker = new GenerationRateTracker();
	expect(tracker.sample(100, 1_000)).toBeNull();
	expect(tracker.sample(150, 2_000)).toBe(50);
	expect(tracker.sample(10, 3_000)).toBeNull();
	expect(tracker.sample(30, 4_000)).toBe(20);
});

test("statusは取得できたsegmentだけを表示する", () => {
	expect(renderStatus({ queue: 2, genRate: 42.25, draftPercent: 50, kvPercent: 75 })).toBe(
		"vLLM │ Queue 2 │ Gen 42.3 t/s │ Draft 50% │ KV 75%",
	);
	expect(renderStatus({ queue: 0, genRate: null, draftPercent: null, kvPercent: null })).toBeUndefined();
});
