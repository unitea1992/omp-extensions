import { expect, test } from "bun:test";
import { parseBackendMetrics } from "../src/metrics.ts";

test("current SGLang scheduler metricsを読む", () => {
	const sample = parseBackendMetrics(
		`sglang:token_usage{dp_rank="0",tp_rank="0"} 0.28
sglang:num_queue_reqs{dp_rank="0",tp_rank="0",priority=""} 3
sglang:gen_throughput{dp_rank="0",tp_rank="0"} 86.5
sglang:generation_tokens_total{model_name="m"} 1000
sglang:spec_accept_rate{dp_rank="0",tp_rank="0"} 0.62`,
		"sglang",
	);
	expect(sample).toMatchObject({
		backend: "sglang",
		kvCacheUsage: 0.28,
		requestsWaiting: 3,
		generationRate: 86.5,
		generationTokens: 1000,
		specAcceptRate: 0.62,
	});
});

test("TP/PP/EP rank重複とpriority内訳を二重加算しない", () => {
	const sample = parseBackendMetrics(
		`sglang:num_queue_reqs{dp_rank="0",tp_rank="0",priority=""} 2
sglang:num_queue_reqs{dp_rank="0",tp_rank="1",priority=""} 2
sglang:num_queue_reqs{dp_rank="0",tp_rank="0",priority="5"} 1
sglang:num_queue_reqs{dp_rank="1",tp_rank="0",priority=""} 4
sglang:gen_throughput{dp_rank="0",tp_rank="0"} 10
sglang:gen_throughput{dp_rank="0",tp_rank="1"} 10
sglang:gen_throughput{dp_rank="1",tp_rank="0"} 20`,
		"sglang",
	);
	expect(sample.requestsWaiting).toBe(6);
	expect(sample.generationRate).toBe(30);
});

test("複数DPのspec_accept_rateは誤平均せず省略する", () => {
	const sample = parseBackendMetrics(
		`sglang:spec_accept_rate{dp_rank="0",tp_rank="0"} 0.4
sglang:spec_accept_rate{dp_rank="1",tp_rank="0"} 0.8`,
		"sglang",
	);
	expect(sample.specAcceptRate).toBeNull();
});
