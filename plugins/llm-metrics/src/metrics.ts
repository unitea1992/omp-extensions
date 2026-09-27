/**
 * vLLM / SGLang Prometheus metrics parsing + pure calculations.
 * Only current upstream metric names are accepted; missing metrics stay null.
 */

export type MetricsBackend = "vllm" | "sglang";

export interface VllmMetricsSample {
	kvCacheUsage: number | null;
	specAccepted: number | null;
	specDraft: number | null;
	generationTokens: number | null;
	requestsWaiting: number | null;
}

export interface BackendMetricsSample extends VllmMetricsSample {
	backend: MetricsBackend;
	generationRate: number | null;
	specAcceptRate: number | null;
}

function parseNumber(raw: string): number | null {
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

const VLLM_METRIC_LINE = /^vllm:([a-zA-Z0-9_:]+)(?:\{[^}]*\})?\s+([^\s]+)$/;
const SGLANG_METRIC_LINE = /^sglang:([a-zA-Z0-9_:]+)(?:\{([^}]*)\})?\s+([^\s]+)$/;
const LABEL_PAIR = /(?:^|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"/g;

function parseMetricLabels(raw: string | undefined): Map<string, string> {
	const labels = new Map<string, string>();
	if (!raw) return labels;
	LABEL_PAIR.lastIndex = 0;
	for (let match = LABEL_PAIR.exec(raw); match !== null; match = LABEL_PAIR.exec(raw)) {
		labels.set(match[1] as string, match[2] as string);
	}
	return labels;
}

/** Keep one scheduler series per TP/PP/EP group and only total priority series. */
function isRepresentativeSglangSeries(rawLabels: string | undefined): boolean {
	const labels = parseMetricLabels(rawLabels);
	const priority = labels.get("priority");
	if (priority !== undefined && priority !== "") return false;
	for (const rankLabel of ["tp_rank", "pp_rank", "moe_ep_rank"]) {
		const rank = labels.get(rankLabel);
		if (rank !== undefined && rank !== "0") return false;
	}
	return true;
}

export function parsePrometheusMetrics(text: string): VllmMetricsSample {
	const kv: number[] = [];
	const accepted: number[] = [];
	const draft: number[] = [];
	const generation: number[] = [];
	const waiting: number[] = [];

	for (const line of text.split("\n")) {
		if (line.length === 0 || line.startsWith("#")) continue;
		const match = line.match(VLLM_METRIC_LINE);
		if (!match) continue;
		const value = parseNumber(match[2] as string);
		if (value === null) continue;
		switch (match[1]) {
			case "kv_cache_usage_perc":
				kv.push(value);
				break;
			case "spec_decode_num_accepted_tokens_total":
				accepted.push(value);
				break;
			case "spec_decode_num_draft_tokens_total":
				draft.push(value);
				break;
			case "generation_tokens_total":
				generation.push(value);
				break;
			case "num_requests_waiting":
				waiting.push(value);
				break;
		}
	}

	return {
		kvCacheUsage: kv.length > 0 ? Math.max(...kv) : null,
		specAccepted: accepted.length > 0 ? sum(accepted) : null,
		specDraft: draft.length > 0 ? sum(draft) : null,
		generationTokens: generation.length > 0 ? sum(generation) : null,
		requestsWaiting: waiting.length > 0 ? sum(waiting) : null,
	};
}

function parseSglangMetrics(text: string): BackendMetricsSample {
	const kv: number[] = [];
	const generation: number[] = [];
	const generationRate: number[] = [];
	const waiting: number[] = [];
	const specAcceptRate: number[] = [];

	for (const line of text.split("\n")) {
		if (line.length === 0 || line.startsWith("#")) continue;
		const match = line.match(SGLANG_METRIC_LINE);
		if (!match || !isRepresentativeSglangSeries(match[2])) continue;
		const value = parseNumber(match[3] as string);
		if (value === null) continue;
		switch (match[1]) {
			case "token_usage":
				kv.push(value);
				break;
			case "generation_tokens_total":
				generation.push(value);
				break;
			case "gen_throughput":
				generationRate.push(value);
				break;
			case "num_queue_reqs":
				waiting.push(value);
				break;
			case "spec_accept_rate":
				specAcceptRate.push(value);
				break;
		}
	}

	return {
		backend: "sglang",
		kvCacheUsage: kv.length > 0 ? Math.max(...kv) : null,
		specAccepted: null,
		specDraft: null,
		generationTokens: generation.length > 0 ? sum(generation) : null,
		requestsWaiting: waiting.length > 0 ? sum(waiting) : null,
		generationRate: generationRate.length > 0 ? sum(generationRate) : null,
		// A rate cannot be correctly averaged across DP ranks without its denominator.
		specAcceptRate: specAcceptRate.length === 1 ? (specAcceptRate[0] as number) : null,
	};
}

export function parseBackendMetrics(text: string, backend: MetricsBackend): BackendMetricsSample {
	if (backend === "sglang") return parseSglangMetrics(text);
	return {
		backend: "vllm",
		...parsePrometheusMetrics(text),
		generationRate: null,
		specAcceptRate: null,
	};
}

export function hasVllmSignature(text: string): boolean {
	return text.split("\n").some((line) => line.length > 0 && !line.startsWith("#") && VLLM_METRIC_LINE.test(line));
}

export function hasSglangSignature(text: string): boolean {
	return text.split("\n").some((line) => line.length > 0 && !line.startsWith("#") && SGLANG_METRIC_LINE.test(line));
}

export function detectMetricsBackend(text: string): MetricsBackend | null {
	if (hasVllmSignature(text)) return "vllm";
	if (hasSglangSignature(text)) return "sglang";
	return null;
}

export class DraftDelta {
	private prevAccepted: number | null = null;
	private prevDraft: number | null = null;

	sample(next: VllmMetricsSample): number | null {
		if (next.specAccepted === null || next.specDraft === null) return null;
		if (this.prevAccepted === null || this.prevDraft === null) {
			this.prevAccepted = next.specAccepted;
			this.prevDraft = next.specDraft;
			return null;
		}
		const acceptedDelta = next.specAccepted - this.prevAccepted;
		const draftDelta = next.specDraft - this.prevDraft;
		this.prevAccepted = next.specAccepted;
		this.prevDraft = next.specDraft;
		if (acceptedDelta < 0 || draftDelta <= 0) return null;
		return Math.min(1, Math.max(0, acceptedDelta / draftDelta));
	}

	reset(): void {
		this.prevAccepted = null;
		this.prevDraft = null;
	}
}

export class GenerationRateTracker {
	private prevValue: number | null = null;
	private prevTime = 0;

	sample(value: number | null, now: number): number | null {
		if (value === null) return null;
		if (this.prevValue === null) {
			this.prevValue = value;
			this.prevTime = now;
			return null;
		}
		const elapsed = now - this.prevTime;
		const delta = value - this.prevValue;
		this.prevValue = value;
		this.prevTime = now;
		if (elapsed <= 0 || delta < 0) return null;
		return delta / (elapsed / 1000);
	}

	reset(): void {
		this.prevValue = null;
		this.prevTime = 0;
	}
}

export interface StatusParts {
	queue: number | null;
	genRate: number | null;
	draftPercent: number | null;
	kvPercent: number | null;
}

export function renderStatus(parts: StatusParts, engineLabel = "vLLM"): string | undefined {
	const segments: string[] = [];
	if (parts.queue !== null && parts.queue > 0) segments.push(`Queue ${parts.queue}`);
	if (parts.genRate !== null) segments.push(`Gen ${parts.genRate.toFixed(1)} t/s`);
	if (parts.draftPercent !== null) segments.push(`Draft ${parts.draftPercent}%`);
	if (parts.kvPercent !== null) segments.push(`KV ${parts.kvPercent}%`);
	return segments.length > 0 ? `${engineLabel} │ ${segments.join(" │ ")}` : undefined;
}
