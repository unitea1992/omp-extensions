import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { checkFreeModelAvailability, formatAvailabilityReport } from "./checker.ts";
import type { AvailabilityReport, ModelView } from "./types.ts";

const USAGE = "Usage: /free-model [status]";

export interface FreeModelCommandOptions {
	status: boolean;
}

export function parseFreeModelArgs(args: string): FreeModelCommandOptions {
	const tokens = args.split(/\s+/u).filter(Boolean);
	if (tokens.length === 0) return { status: false };
	if (tokens.length === 1 && tokens[0]?.toLowerCase() === "status") return { status: true };
	const unknown = tokens.find((token) => token.toLowerCase() !== "status") ?? tokens[0] ?? "";
	throw new Error(`Unknown argument: ${unknown}. ${USAGE}`);
}

export function getFreeModelArgumentCompletions(argumentPrefix: string) {
	const hasTrailingWhitespace = /\s$/u.test(argumentPrefix);
	const tokens = argumentPrefix.trim().split(/\s+/u).filter(Boolean);
	const committed = hasTrailingWhitespace ? tokens : tokens.slice(0, -1);
	const currentPrefix = hasTrailingWhitespace ? "" : (tokens.at(-1) ?? "");
	if (committed.length > 0) return null;
	if (!"status".startsWith(currentPrefix.toLowerCase())) return null;
	return [
		{
			value: "status ",
			label: "status",
			description: "Show full free-model status for all providers",
		},
	];
}

export function getConfirmedFreeSelectors(report: AvailabilityReport): string[] {
	return report.providers
		.flatMap((provider) =>
			provider.rows.filter((row) => row.status === "confirmed").map((row) => `${provider.providerId}/${row.modelId}`),
		)
		.sort((left, right) => left.localeCompare(right));
}

export default function freeModels(pi: ExtensionAPI): void {
	pi.registerCommand("free-model", {
		description: "Pick provider-confirmed free models or inspect their live-source status",
		getArgumentCompletions: getFreeModelArgumentCompletions,
		handler: async (args, ctx) => {
			let options: FreeModelCommandOptions;
			try {
				options = parseFreeModelArgs(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return;
			}

			const catalog = ctx.models.list();
			const models: ModelView[] = catalog.map((model) => ({ provider: model.provider, id: model.id }));
			ctx.ui.setWorkingMessage(
				options.status ? "Checking free-model status…" : "Checking provider-confirmed free models…",
			);
			let report: AvailabilityReport;
			try {
				report = await checkFreeModelAvailability(models);
			} catch (error) {
				ctx.ui.notify(`Free-model check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			} finally {
				ctx.ui.setWorkingMessage();
			}

			if (options.status) {
				ctx.ui.notify(formatAvailabilityReport(report), "info");
				return;
			}

			const confirmedSelectors = new Set(getConfirmedFreeSelectors(report));
			const confirmedModels = catalog
				.filter((model) => confirmedSelectors.has(`${model.provider}/${model.id}`))
				.sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
			if (confirmedModels.length === 0) {
				ctx.ui.notify("No models are currently provider-confirmed free.", "warning");
				return;
			}

			const labels = confirmedModels.map((model) => `${model.provider}/${model.id}`);
			const current = ctx.models.current();
			const currentSelector = current ? `${current.provider}/${current.id}` : undefined;
			const currentIndex = currentSelector ? labels.indexOf(currentSelector) : -1;
			const selected = await ctx.ui.select(
				"Select provider-confirmed free model",
				confirmedModels.map((model) => ({
					label: `${model.provider}/${model.id}`,
					description: "Provider-side catalog/pricing confirms a free listing; account-specific access may still vary",
				})),
				{
					outline: true,
					helpText: "Only provider-confirmed free models are shown; no inference probe is sent",
					...(currentIndex >= 0 ? { initialIndex: currentIndex } : {}),
				},
			);
			if (!selected) return;

			const model = confirmedModels.find((candidate) => `${candidate.provider}/${candidate.id}` === selected);
			if (!model) {
				ctx.ui.notify("Selected model is no longer available in the current OMP catalog.", "warning");
				return;
			}
			const switched = await pi.setModel(model);
			ctx.ui.notify(
				switched ? `Switched to provider-confirmed free model: ${selected}` : `Failed to switch model: ${selected}`,
				switched ? "info" : "error",
			);
		},
	});
}

export { checkFreeModelAvailability, formatAvailabilityReport };
