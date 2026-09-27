/** vLLM / SGLang live observer. Telemetry is shown only from current successful samples. */
import {
	type BackendMetricsSample,
	DraftDelta,
	GenerationRateTracker,
	type MetricsBackend,
	detectMetricsBackend,
	parseBackendMetrics,
	renderStatus,
} from "./metrics";

const FETCH_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 1_000;
const STATUS_KEY = "llm-metrics";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LeaseTarget {
	metricsUrl: string;
}

export interface ObserverDeps {
	setInterval: (cb: () => void, ms: number) => unknown;
	clearTimer: (timer: unknown) => void;
	setStatus: (key: string, text: string | undefined) => void;
	now?: () => number;
	fetch?: FetchLike;
}

interface TargetState {
	metricsUrl: string;
	leases: Set<string>;
	backend: MetricsBackend | null;
	fetching: boolean;
	rateTracker: GenerationRateTracker;
	draftTracker: DraftDelta;
	queue: number | null;
	genRate: number | null;
	draftPercent: number | null;
	kvPercent: number | null;
}

export class VllmObserver {
	private targets = new Map<string, TargetState>();
	private leases = new Map<string, string>();
	private timer: unknown | null = null;
	private readonly now: () => number;
	private readonly fetchFn: FetchLike;

	constructor(private readonly deps: ObserverDeps) {
		this.now = deps.now ?? (() => performance.now());
		this.fetchFn = deps.fetch ?? fetch;
	}

	hasLeases(): boolean {
		return this.leases.size > 0;
	}

	addLease(leaseKey: string, target: LeaseTarget): void {
		this.removeLease(leaseKey);
		let state = this.targets.get(target.metricsUrl);
		if (!state) {
			state = this.createTarget(target.metricsUrl);
			this.targets.set(target.metricsUrl, state);
		}
		this.leases.set(leaseKey, target.metricsUrl);
		state.leases.add(leaseKey);
		if (this.timer === null) this.startTimer();
		if (!state.fetching) void this.fetchTarget(state);
	}

	removeLease(leaseKey: string): void {
		const metricsUrl = this.leases.get(leaseKey);
		if (!metricsUrl) return;
		this.leases.delete(leaseKey);
		const state = this.targets.get(metricsUrl);
		if (!state) return;
		state.leases.delete(leaseKey);
		if (state.leases.size === 0) this.targets.delete(metricsUrl);
		if (this.leases.size === 0) this.stopTimer();
		this.recomputeAndRender();
	}

	shutdown(): void {
		this.stopTimer();
		this.leases.clear();
		this.targets.clear();
		this.deps.setStatus(STATUS_KEY, undefined);
	}

	tickNow(): void {
		this.tick();
	}

	private createTarget(metricsUrl: string): TargetState {
		return {
			metricsUrl,
			leases: new Set(),
			backend: null,
			fetching: false,
			rateTracker: new GenerationRateTracker(),
			draftTracker: new DraftDelta(),
			queue: null,
			genRate: null,
			draftPercent: null,
			kvPercent: null,
		};
	}

	private clearTargetTelemetry(state: TargetState): void {
		state.queue = null;
		state.genRate = null;
		state.draftPercent = null;
		state.kvPercent = null;
	}

	private startTimer(): void {
		if (this.timer !== null) return;
		this.timer = this.deps.setInterval(() => this.tick(), POLL_INTERVAL_MS);
	}

	private stopTimer(): void {
		if (this.timer === null) return;
		this.deps.clearTimer(this.timer);
		this.timer = null;
	}

	private tick(): void {
		for (const state of this.targets.values()) {
			if (!state.fetching) void this.fetchTarget(state);
		}
	}

	private async fetchTarget(state: TargetState): Promise<void> {
		if (state.fetching || this.targets.get(state.metricsUrl) !== state) return;
		state.fetching = true;
		try {
			const text = await this.fetchMetrics(state.metricsUrl);
			if (this.targets.get(state.metricsUrl) !== state || state.leases.size === 0) return;
			if (text === null) {
				this.clearTargetTelemetry(state);
				this.recomputeAndRender();
				return;
			}

			const backend = detectMetricsBackend(text);
			if (backend === null) {
				this.dropUnsupportedTarget(state);
				return;
			}
			if (state.backend !== backend) {
				state.backend = backend;
				state.rateTracker.reset();
				state.draftTracker.reset();
				this.clearTargetTelemetry(state);
			}
			this.applySample(state, parseBackendMetrics(text, backend));
			this.recomputeAndRender();
		} catch {
			if (this.targets.get(state.metricsUrl) === state) {
				this.clearTargetTelemetry(state);
				this.recomputeAndRender();
			}
		} finally {
			state.fetching = false;
		}
	}

	private dropUnsupportedTarget(state: TargetState): void {
		for (const leaseKey of state.leases) this.leases.delete(leaseKey);
		this.targets.delete(state.metricsUrl);
		if (this.leases.size === 0) this.stopTimer();
		this.recomputeAndRender();
	}

	private async fetchMetrics(url: string): Promise<string | null> {
		try {
			const response = await this.fetchFn(url, {
				method: "GET",
				headers: { Accept: "text/plain" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!response.ok) return null;
			return await response.text();
		} catch {
			return null;
		}
	}

	private applySample(state: TargetState, sample: BackendMetricsSample): void {
		state.queue = sample.requestsWaiting;
		state.genRate = sample.generationRate ?? state.rateTracker.sample(sample.generationTokens, this.now());
		state.kvPercent = sample.kvCacheUsage === null ? null : Math.round(sample.kvCacheUsage * 100);
		const draftRate = sample.specAcceptRate ?? state.draftTracker.sample(sample);
		state.draftPercent = draftRate === null ? null : Math.round(Math.min(1, Math.max(0, draftRate)) * 100);
	}

	private recomputeAndRender(): void {
		const active = [...this.targets.values()].filter((state) => state.leases.size > 0);
		const queue = this.sum(active.map((state) => state.queue));
		const genRate = this.sum(active.map((state) => state.genRate));
		const kvValues = active.map((state) => state.kvPercent).filter((value): value is number => value !== null);
		const kvPercent = kvValues.length > 0 ? Math.max(...kvValues) : null;
		const draftPercent = active.length === 1 ? (active[0]?.draftPercent ?? null) : null;
		this.deps.setStatus(
			STATUS_KEY,
			renderStatus({ queue, genRate, draftPercent, kvPercent }, this.engineLabel(active)),
		);
	}

	private sum(values: Array<number | null>): number | null {
		const present = values.filter((value): value is number => value !== null);
		return present.length > 0 ? present.reduce((total, value) => total + value, 0) : null;
	}

	private engineLabel(active: TargetState[]): string {
		const backends = new Set(
			active.map((state) => state.backend).filter((value): value is MetricsBackend => value !== null),
		);
		if (backends.size > 1) return "LLM";
		return backends.values().next().value === "sglang" ? "SGLang" : "vLLM";
	}
}
