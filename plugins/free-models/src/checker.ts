import { type FetchLike, isFreeCandidate, providerLabel, snapshotLoader } from "./providers.ts";
import {
	type AvailabilityReport,
	type AvailabilityRow,
	type ModelView,
	type ProviderAvailabilityReport,
	type ProviderSnapshot,
	SUPPORTED_PROVIDER_IDS,
	type SupportedProviderId,
} from "./types.ts";

export function classifyProvider(
	providerId: SupportedProviderId,
	models: readonly ModelView[],
	snapshot?: ProviderSnapshot,
	error?: string,
): ProviderAvailabilityReport {
	const label = providerLabel(providerId);
	const providerModels = models.filter((model) => model.provider === providerId);
	const ompIds = new Set(providerModels.map((model) => model.id));
	const candidates = providerModels.filter(
		(model) => isFreeCandidate(model) || snapshot?.freeIds.has(model.id) === true,
	);

	if (!snapshot) {
		return {
			providerId,
			providerLabel: label,
			rows: candidates.map((model) => ({
				providerId,
				providerLabel: label,
				modelId: model.id,
				status: "unknown",
				reason: `live source unavailable${error ? `: ${error}` : ""}`,
			})),
			warnings: [],
			error,
		};
	}

	const rows: AvailabilityRow[] = [];
	for (const model of candidates) {
		if (!snapshot.availableIds.has(model.id)) {
			rows.push({
				providerId,
				providerLabel: label,
				modelId: model.id,
				status: "stale",
				reason: "free candidate is absent from the provider live catalog",
			});
			continue;
		}
		if (snapshot.freeIds.has(model.id)) {
			rows.push({
				providerId,
				providerLabel: label,
				modelId: model.id,
				status: "confirmed",
				reason: "present in the live catalog with provider-side free evidence",
			});
			continue;
		}
		rows.push({
			providerId,
			providerLabel: label,
			modelId: model.id,
			status: "not-free",
			reason: "free-marked SKU is live, but current provider pricing/free evidence does not confirm free access",
		});
	}

	for (const id of snapshot.freeIds) {
		if (!snapshot.availableIds.has(id) || ompIds.has(id)) continue;
		rows.push({
			providerId,
			providerLabel: label,
			modelId: id,
			status: "live-only",
			reason: "provider currently advertises this model as free, but it is missing from the OMP session catalog",
		});
	}

	rows.sort((left, right) => {
		const order = { stale: 0, "not-free": 1, unknown: 2, "live-only": 3, confirmed: 4 } as const;
		return order[left.status] - order[right.status] || left.modelId.localeCompare(right.modelId);
	});
	return {
		providerId,
		providerLabel: label,
		rows,
		warnings: snapshot.warnings,
	};
}

export async function checkFreeModelAvailability(
	models: readonly ModelView[],
	options: {
		fetchFn?: FetchLike;
		timeoutMs?: number;
	} = {},
): Promise<AvailabilityReport> {
	const providers = await Promise.all(
		SUPPORTED_PROVIDER_IDS.map(async (providerId) => {
			try {
				const snapshot = await snapshotLoader(providerId, {
					fetchFn: options.fetchFn,
					timeoutMs: options.timeoutMs,
				})();
				return classifyProvider(providerId, models, snapshot);
			} catch (error) {
				return classifyProvider(providerId, models, undefined, error instanceof Error ? error.message : String(error));
			}
		}),
	);
	return { providers };
}

const STATUS_LABELS = {
	confirmed: "OK",
	stale: "STALE",
	"not-free": "NOT-FREE",
	unknown: "UNKNOWN",
	"live-only": "LIVE-ONLY",
} as const;

export function formatAvailabilityReport(report: AvailabilityReport): string {
	const lines = ["Free model status"];
	if (report.providers.length === 0) {
		lines.push("Supported providers are not available in the current OMP session.");
		return lines.join("\n");
	}

	for (const provider of report.providers) {
		const counts = {
			confirmed: provider.rows.filter((row) => row.status === "confirmed").length,
			stale: provider.rows.filter((row) => row.status === "stale").length,
			"not-free": provider.rows.filter((row) => row.status === "not-free").length,
			unknown: provider.rows.filter((row) => row.status === "unknown").length,
			"live-only": provider.rows.filter((row) => row.status === "live-only").length,
		};
		lines.push(
			"",
			`${provider.providerLabel}: OK ${counts.confirmed} / STALE ${counts.stale} / NOT-FREE ${counts["not-free"]} / UNKNOWN ${counts.unknown} / LIVE-ONLY ${counts["live-only"]}`,
		);
		if (provider.error) lines.push(`  source warning: ${provider.error}`);
		for (const warning of provider.warnings) lines.push(`  source warning: ${warning}`);
		for (const row of provider.rows) lines.push(`  ${STATUS_LABELS[row.status]} ${row.modelId} — ${row.reason}`);
		if (provider.rows.length === 0 && !provider.error)
			lines.push("  No free-model candidates detected in the OMP session catalog.");
	}
	lines.push("", "No inference requests were sent; only live provider catalog/pricing endpoints were checked.");
	return lines.join("\n");
}
