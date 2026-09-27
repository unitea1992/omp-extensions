import type { ModelView, ProviderSnapshot, SupportedProviderId } from "./types.ts";

export type FetchLike = typeof fetch;

export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 4_000;
const MAX_MODEL_ID_LENGTH = 512;

export const NOUS_MODELS_URL = "https://inference-api.nousresearch.com/v1/models";
export const NOUS_RECOMMENDED_URL = "https://portal.nousresearch.com/api/nous/recommended-models";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

const PROVIDER_LABELS: Record<SupportedProviderId, string> = {
	"nous-portal": "Nous Portal",
	openrouter: "OpenRouter",
	"opencode-zen": "OpenCode Zen",
};

interface CatalogParseResult {
	availableIds: Set<string>;
	freeIds: Set<string>;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function validModelId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const id = value.trim();
	return id && id.length <= MAX_MODEL_ID_LENGTH ? id : undefined;
}

function dataRows(payload: unknown): Record<string, unknown>[] {
	const rows = asRecord(payload).data;
	if (!Array.isArray(rows)) return [];
	return rows
		.slice(0, MAX_MODELS)
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function explicitZero(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value) && value === 0;
	if (typeof value !== "string" || !value.trim()) return false;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed === 0;
}

function hasExplicitZeroTokenPricing(row: Record<string, unknown>): boolean {
	const pricing = asRecord(row.pricing);
	return explicitZero(pricing.prompt) && explicitZero(pricing.completion);
}

export function parsePricedCatalog(payload: unknown): CatalogParseResult {
	const availableIds = new Set<string>();
	const freeIds = new Set<string>();
	for (const row of dataRows(payload)) {
		const id = validModelId(row.id);
		if (!id) continue;
		availableIds.add(id);
		if (hasExplicitZeroTokenPricing(row)) freeIds.add(id);
	}
	return { availableIds, freeIds };
}

export function parseNousFreeRecommendations(payload: unknown): Set<string> {
	const result = new Set<string>();
	const rows = asRecord(payload).freeRecommendedModels;
	if (!Array.isArray(rows)) return result;
	for (const row of rows.slice(0, MAX_MODELS)) {
		const id = validModelId(asRecord(row).modelName);
		if (id) result.add(id);
	}
	return result;
}

export function parseOpenRouterCatalog(payload: unknown): CatalogParseResult {
	return parsePricedCatalog(payload);
}

export function parseOpenCodeZenCatalog(payload: unknown): CatalogParseResult {
	const availableIds = new Set<string>();
	const freeIds = new Set<string>();
	for (const row of dataRows(payload)) {
		const id = validModelId(row.id);
		if (!id) continue;
		availableIds.add(id);
		// Zen /models does not expose pricing. Only the provider-defined free SKU
		// marker is machine-readable enough to use without maintaining a local list.
		if (id.endsWith("-free")) freeIds.add(id);
	}
	return { availableIds, freeIds };
}

async function fetchJson(
	url: string,
	options: { fetchFn?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException(`Timed out fetching ${url}`, "TimeoutError")),
		options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
	);
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	try {
		const response = await (options.fetchFn ?? fetch)(url, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal,
		});
		if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
			throw new Error(`${url} response is too large`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error(`${url} response is too large`);
		return JSON.parse(new TextDecoder().decode(bytes));
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchNousSnapshot(
	options: { fetchFn?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProviderSnapshot> {
	const [catalogResult, recommendedResult] = await Promise.allSettled([
		fetchJson(NOUS_MODELS_URL, options),
		fetchJson(NOUS_RECOMMENDED_URL, options),
	]);
	if (catalogResult.status === "rejected") throw catalogResult.reason;

	const catalog = parsePricedCatalog(catalogResult.value);
	const freeIds = new Set(catalog.freeIds);
	const warnings: string[] = [];
	if (recommendedResult.status === "fulfilled") {
		for (const id of parseNousFreeRecommendations(recommendedResult.value)) freeIds.add(id);
	} else {
		const error = recommendedResult.reason;
		warnings.push(`freeRecommendedModels unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { availableIds: catalog.availableIds, freeIds, warnings };
}

export async function fetchOpenRouterSnapshot(
	options: { fetchFn?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProviderSnapshot> {
	const catalog = parseOpenRouterCatalog(await fetchJson(OPENROUTER_MODELS_URL, options));
	return { availableIds: catalog.availableIds, freeIds: catalog.freeIds, warnings: [] };
}

export async function fetchOpenCodeZenSnapshot(
	options: { fetchFn?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProviderSnapshot> {
	const catalog = parseOpenCodeZenCatalog(await fetchJson(OPENCODE_ZEN_MODELS_URL, options));
	return { availableIds: catalog.availableIds, freeIds: catalog.freeIds, warnings: [] };
}

export function isFreeCandidate(model: ModelView): boolean {
	if (model.provider === "nous-portal" || model.provider === "openrouter") return model.id.endsWith(":free");
	if (model.provider === "opencode-zen") return model.id.endsWith("-free");
	return false;
}

export function providerLabel(providerId: SupportedProviderId): string {
	return PROVIDER_LABELS[providerId];
}

export function snapshotLoader(
	providerId: SupportedProviderId,
	options: { fetchFn?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {},
): () => Promise<ProviderSnapshot> {
	switch (providerId) {
		case "nous-portal":
			return () => fetchNousSnapshot(options);
		case "openrouter":
			return () => fetchOpenRouterSnapshot(options);
		case "opencode-zen":
			return () => fetchOpenCodeZenSnapshot(options);
	}
}
