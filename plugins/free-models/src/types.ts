export const SUPPORTED_PROVIDER_IDS = ["nous-portal", "openrouter", "opencode-zen"] as const;

export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

export type AvailabilityStatus = "confirmed" | "stale" | "not-free" | "unknown" | "live-only";

export interface ModelView {
	provider: string;
	id: string;
}

export interface ProviderSnapshot {
	availableIds: ReadonlySet<string>;
	freeIds: ReadonlySet<string>;
	warnings: readonly string[];
}

export interface AvailabilityRow {
	providerId: SupportedProviderId;
	providerLabel: string;
	modelId: string;
	status: AvailabilityStatus;
	reason: string;
}

export interface ProviderAvailabilityReport {
	providerId: SupportedProviderId;
	providerLabel: string;
	rows: AvailabilityRow[];
	warnings: readonly string[];
	error?: string;
}

export interface AvailabilityReport {
	providers: ProviderAvailabilityReport[];
}
