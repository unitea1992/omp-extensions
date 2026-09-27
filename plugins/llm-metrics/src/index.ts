/**
 * vLLM / SGLang telemetry in the OMP status line (Main UI only).
 * Polling exists only while Main or Task subagent leases reference a supported server.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent/task/types";
import { VllmObserver } from "./observer";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "./omp-compat";

const CANONICAL_PROVIDERS = new Set(["vllm", "sglang"]);
const MAIN_LEASE = "main-turn";

export function deriveEndpoints(baseUrl: string): { metricsUrl: string; isHttp: boolean } | null {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const path = url.pathname.replace(/\/+$/, "");
	if (path !== "" && path !== "/v1") return null;
	return { metricsUrl: `${url.origin}/metrics`, isHttp: url.protocol === "http:" };
}

export function isProbeEligible(provider: string, endpoints: { isHttp: boolean }): boolean {
	return CANONICAL_PROVIDERS.has(provider) || endpoints.isHttp;
}

interface ModelView {
	provider: string;
	id: string;
	baseUrl: string;
}

export function resolveModel(resolvedModel: string, models: readonly ModelView[]): ModelView | undefined {
	let best: ModelView | undefined;
	let bestLen = 0;
	for (const model of models) {
		const key = `${model.provider}/${model.id}`;
		if ((resolvedModel === key || resolvedModel.startsWith(`${key}:`)) && key.length > bestLen) {
			best = model;
			bestLen = key.length;
		}
	}
	return best;
}

export default function vllmMetrics(pi: ExtensionAPI): void {
	let observer: VllmObserver | null = null;
	let ctxRef: ExtensionContext | null = null;
	const unsubscribers: Array<() => void> = [];
	const subagentModels = new Map<string, string>();

	function ensureObserver(ctx: ExtensionContext): VllmObserver {
		observer ??= new VllmObserver({
			setInterval: ctx.setInterval.bind(ctx),
			clearTimer: (timer) => ctx.clearTimer(timer as never),
			setStatus: (key, text) => {
				try {
					ctx.ui.setStatus(key, text);
				} catch (error) {
					pi.logger.debug(String(error));
				}
			},
		});
		return observer;
	}

	function handleSubagentProgress(payload: SubagentProgressPayload): void {
		if (ctxRef === null || observer === null) return;
		const { id: subagentId, resolvedModel } = payload.progress;
		if (!resolvedModel || subagentModels.get(subagentId) === resolvedModel) return;

		observer.removeLease(subagentId);
		const model = resolveModel(resolvedModel, ctxRef.models.list());
		if (!model) return;
		const endpoints = deriveEndpoints(model.baseUrl);
		if (!endpoints || !isProbeEligible(model.provider, endpoints)) return;

		subagentModels.set(subagentId, resolvedModel);
		observer.addLease(subagentId, { metricsUrl: endpoints.metricsUrl });
	}

	function handleSubagentLifecycle(payload: SubagentLifecyclePayload): void {
		if (observer === null || payload.status === "started") return;
		observer.removeLease(payload.id);
		subagentModels.delete(payload.id);
	}

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		try {
			if (!ctx.hasUI) return;
			ensureObserver(ctx);
			const events = pi.events;
			if (!events || typeof events.on !== "function") return;
			unsubscribers.push(
				events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data: unknown) =>
					handleSubagentProgress(data as SubagentProgressPayload),
				),
				events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data: unknown) =>
					handleSubagentLifecycle(data as SubagentLifecyclePayload),
				),
			);
		} catch (error) {
			pi.logger.debug(String(error));
		}
	});

	pi.on("turn_start", (_event, ctx) => {
		ctxRef = ctx;
		try {
			if (!ctx.hasUI || observer === null) return;
			observer.removeLease(MAIN_LEASE);
			const model = ctx.model;
			if (!model) return;
			const endpoints = deriveEndpoints(model.baseUrl);
			if (!endpoints || !isProbeEligible(model.provider, endpoints)) return;
			observer.addLease(MAIN_LEASE, { metricsUrl: endpoints.metricsUrl });
		} catch (error) {
			pi.logger.debug(String(error));
		}
	});

	pi.on("turn_end", () => {
		try {
			observer?.removeLease(MAIN_LEASE);
		} catch (error) {
			pi.logger.debug(String(error));
		}
	});

	pi.on("session_shutdown", () => {
		try {
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
			observer?.shutdown();
			observer = null;
			subagentModels.clear();
			ctxRef = null;
		} catch (error) {
			pi.logger.debug(String(error));
		}
	});
}
