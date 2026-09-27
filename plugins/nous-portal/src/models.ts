import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { type FetchLike, readBoundedTextBody, timedFetch } from "./provider-requests.ts";

export const PROVIDER_ID = "nous-portal";
export const PROVIDER_NAME = "Nous Portal";
export const DEFAULT_INFERENCE_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 128_000;

export type NousProviderModelConfig = ProviderModelConfig;

export class ModelCatalogHttpError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`Nous /models request failed with status ${status}${body ? `: ${body}` : ""}`);
		this.name = "ModelCatalogHttpError";
		this.status = status;
		this.body = body;
	}
}

export type RawCatalogModel =
	| string
	| {
			id?: unknown;
			name?: unknown;
			reasoning?: unknown;
			context_window?: unknown;
			contextWindow?: unknown;
			context_length?: unknown;
			contextLength?: unknown;
			context_length_tokens?: unknown;
			max_tokens?: unknown;
			maxTokens?: unknown;
			max_output_tokens?: unknown;
			maxOutputTokens?: unknown;
			max_completion_tokens?: unknown;
			supported_parameters?: unknown;
			input?: unknown;
			inputs?: unknown;
			modalities?: unknown;
			input_modalities?: unknown;
			output_modalities?: unknown;
			architecture?: unknown;
			top_provider?: unknown;
			pricing?: unknown;
	  };

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PRICE_PER_TOKEN_TO_MTOK = 1_000_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_MODELS = 1000;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_NAME_LENGTH = 256;
const MAX_TOKEN_LIMIT = 10_000_000;
const MAX_PRICE_PER_MILLION = 1_000_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 外部モデルIDの制御文字を拒否するため意図的に使用
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 外部モデル名の制御文字を除去するため意図的に使用
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/gu;
const REASONING_EFFORT_MAP = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
};

export const OPENAI_COMPAT: NonNullable<NousProviderModelConfig["compat"]> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
};

export const OPENROUTER_REASONING_COMPAT: NonNullable<NousProviderModelConfig["compat"]> = {
	...OPENAI_COMPAT,
	thinkingFormat: "openrouter",
	reasoningEffortMap: { ...REASONING_EFFORT_MAP },
};

export function normalizeBaseUrl(value: unknown, fallback = DEFAULT_INFERENCE_BASE_URL): string {
	const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
	return candidate.replace(/\/+$/, "");
}

export function getInferenceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return normalizeBaseUrl(env.NOUS_INFERENCE_BASE_URL, DEFAULT_INFERENCE_BASE_URL);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
		: [];
}

function positiveInteger(value: unknown): number | undefined {
	const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TOKEN_LIMIT
		? Math.floor(parsed)
		: undefined;
}

function pricePerMillion(value: unknown): number {
	const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) return 0;
	const scaled = parsed * PRICE_PER_TOKEN_TO_MTOK;
	return Number.isFinite(scaled) && scaled <= MAX_PRICE_PER_MILLION ? Number(scaled.toFixed(12)) : 0;
}

function architecture(raw: RawCatalogModel): Record<string, unknown> {
	return typeof raw === "string" ? {} : asRecord(raw.architecture);
}

function topProvider(raw: RawCatalogModel): Record<string, unknown> {
	return typeof raw === "string" ? {} : asRecord(raw.top_provider);
}

function supportedParameters(raw: RawCatalogModel): string[] {
	return typeof raw === "string" ? [] : asStringArray(raw.supported_parameters);
}

function modelId(raw: RawCatalogModel): string | undefined {
	const value = typeof raw === "string" ? raw : raw.id;
	if (typeof value !== "string") return undefined;
	const id = value.trim();
	return id && id.length <= MAX_MODEL_ID_LENGTH && !CONTROL_CHARACTERS.test(id) ? id : undefined;
}

function modelName(raw: RawCatalogModel, id: string): string {
	if (typeof raw === "string" || typeof raw.name !== "string") return id;
	const name = raw.name.replace(CONTROL_CHARACTERS_GLOBAL, " ").replace(/\s+/g, " ").trim();
	return name ? name.slice(0, MAX_MODEL_NAME_LENGTH) : id;
}

function outputModalities(raw: RawCatalogModel): string[] {
	if (typeof raw === "string") return [];
	return asStringArray(raw.output_modalities).concat(asStringArray(architecture(raw).output_modalities));
}

function isChatModel(raw: RawCatalogModel): boolean {
	const outputs = outputModalities(raw);
	return outputs.length === 0 || outputs.includes("text");
}

function inputModalities(raw: RawCatalogModel): string[] | undefined {
	if (typeof raw === "string") return undefined;
	for (const value of [raw.input, raw.inputs, raw.input_modalities, architecture(raw).input_modalities]) {
		const modalities = asStringArray(value);
		if (modalities.length > 0) return modalities;
	}
	const modalities = raw.modalities;
	if (Array.isArray(modalities)) return asStringArray(modalities);
	const input = asStringArray(asRecord(modalities).input);
	return input.length > 0 ? input : undefined;
}

function modelInputs(raw: RawCatalogModel): ("text" | "image")[] {
	const modalities = inputModalities(raw);
	return modalities?.includes("image") ? ["text", "image"] : ["text"];
}

function modelReasoning(raw: RawCatalogModel): boolean {
	if (typeof raw === "string") return false;
	const parameters = supportedParameters(raw);
	if (parameters.includes("reasoning") || parameters.includes("include_reasoning")) return true;
	return typeof raw.reasoning === "boolean" ? raw.reasoning : false;
}

function modelContextWindow(raw: RawCatalogModel): number {
	if (typeof raw === "string") return DEFAULT_CONTEXT_WINDOW;
	return (
		positiveInteger(topProvider(raw).context_length) ??
		positiveInteger(raw.context_window) ??
		positiveInteger(raw.contextWindow) ??
		positiveInteger(raw.context_length) ??
		positiveInteger(raw.contextLength) ??
		positiveInteger(raw.context_length_tokens) ??
		DEFAULT_CONTEXT_WINDOW
	);
}

function modelMaxTokens(raw: RawCatalogModel, contextWindow: number): number {
	if (typeof raw === "string") return Math.min(contextWindow, DEFAULT_MAX_TOKENS);
	return (
		positiveInteger(topProvider(raw).max_completion_tokens) ??
		positiveInteger(raw.max_completion_tokens) ??
		positiveInteger(raw.max_tokens) ??
		positiveInteger(raw.maxTokens) ??
		positiveInteger(raw.max_output_tokens) ??
		positiveInteger(raw.maxOutputTokens) ??
		Math.min(contextWindow, DEFAULT_MAX_TOKENS)
	);
}

function modelCost(raw: RawCatalogModel): NousProviderModelConfig["cost"] {
	if (typeof raw === "string") return { ...ZERO_COST };
	const pricing = asRecord(raw.pricing);
	return {
		input: pricePerMillion(pricing.prompt),
		output: pricePerMillion(pricing.completion),
		cacheRead: pricePerMillion(pricing.input_cache_read),
		cacheWrite: pricePerMillion(pricing.input_cache_write),
	};
}

export function toNousModelConfig(raw: RawCatalogModel): NousProviderModelConfig | undefined {
	const id = modelId(raw);
	if (!id || !isChatModel(raw)) return undefined;
	const api = "openai-completions";
	const reasoning = modelReasoning(raw);
	const contextWindow = modelContextWindow(raw);
	return {
		id,
		name: modelName(raw, id),
		api,
		reasoning,
		input: modelInputs(raw),
		cost: modelCost(raw),
		contextWindow,
		maxTokens: modelMaxTokens(raw, contextWindow),
		compat: reasoning ? OPENROUTER_REASONING_COMPAT : OPENAI_COMPAT,
	};
}

function isRawCatalogModel(value: unknown): value is RawCatalogModel {
	return typeof value === "string" || (typeof value === "object" && value !== null);
}

export function parseModelCatalog(payload: unknown): NousProviderModelConfig[] {
	const data =
		typeof payload === "object" && payload !== null && "data" in payload && Array.isArray(payload.data)
			? payload.data
			: [];
	const models: NousProviderModelConfig[] = [];
	const seen = new Set<string>();
	for (const raw of data.slice(0, MAX_CATALOG_MODELS)) {
		if (!isRawCatalogModel(raw)) continue;
		const model = toNousModelConfig(raw);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

export async function fetchModelCatalog(
	baseUrl = DEFAULT_INFERENCE_BASE_URL,
	options: { fetchFn?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<NousProviderModelConfig[]> {
	const response = await timedFetch({
		fetchFn: options.fetchFn ?? fetch,
		url: `${normalizeBaseUrl(baseUrl)}/models`,
		init: { method: "GET", headers: { Accept: "application/json" } },
		timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
		timeoutMessage: "Nous model discovery timed out",
		signal: options.signal,
	});
	if (!response.ok) {
		const body = await readBoundedTextBody(response, 8192).catch(() => "");
		throw new ModelCatalogHttpError(response.status, body);
	}
	const body = await readBoundedTextBody(response, MAX_CATALOG_BYTES);
	return parseModelCatalog(JSON.parse(body));
}
