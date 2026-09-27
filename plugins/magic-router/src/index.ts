/**
 * magic-router: appends OMP native magic keywords to plain prompts.
 *
 * The extension only routes at the input boundary — it never reimplements
 * orchestration, workflow, or reasoning behavior. OMP native keyword
 * detection and notice injection stay authoritative; this hook only adds the
 * minimal keyword suffix the current turn needs.
 *
 * Boundaries (all pinned by tests):
 * - A prompt that already carries a manual magic keyword passes through
 *   unchanged — user-specified execution policy always wins.
 * - Solo / no-delegation intent hard-vetoes auto `orchestrate` / `workflowz`
 *   (never `ultrathink`, and never by rewriting user input).
 * - OMP wrapped-block and session-local large-paste contents may contribute
 *   classifier signals, but are never reinserted into the user prompt.
 *   Read-only outer requests treat attachments as source material.
 * - `/magic-router` toggles routing for the current session only. Bare
 *   invocation toggles; any arguments warn without mutating state.
 * - Toggle success is reported once via `ctx.ui.notify()` (`info`) plus
 *   persistent status; routine routing turns update status only and never
 *   notify. The status survives turn completion and changes only on the next
 *   routable input (or a session-context transition).
 * - Classifier / attachment failures resolve to the original input
 *   (fail-open). Logging and status are best-effort and never discard an
 *   already-computed routing decision.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildRoutingSignalText } from "./attachments";
import { highlightMagicKeywords } from "./omp-compat";
import { applyRouting, decisionKeywords, formatDecision, isRoutableInput } from "./router";
import type { RoutingResult } from "./router";

const STATUS_KEY = "magic-router";
const STATUS_PREFIX = "Magic Router: ";

function clearStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

/** Keep status styling cosmetic: a theme/highlighter failure must never break routing. */
function highlightStatusKeywords(text: string): string {
	try {
		return highlightMagicKeywords(text);
	} catch {
		return text;
	}
}

function decisionStatusText(manualKeyword: boolean, keywords: string[]): string {
	if (manualKeyword) return `${STATUS_PREFIX}manual`;
	if (keywords.length === 0) return `${STATUS_PREFIX}none`;
	return `${STATUS_PREFIX}${highlightStatusKeywords(keywords.join(" + "))}`;
}

function toggleStatusText(enabled: boolean): string {
	return `${STATUS_PREFIX}${enabled ? "enabled" : "disabled"}`;
}

export default function magicRouter(pi: ExtensionAPI): void {
	const enabledBySession = new Map<string, boolean>();
	const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const isEnabled = (ctx: ExtensionContext): boolean => enabledBySession.get(sessionId(ctx)) ?? true;

	pi.registerCommand("magic-router", {
		description: "Toggle magic-router for the current session",
		handler: async (args, ctx) => {
			const raw = typeof args === "string" ? args : "";
			if (raw.trim() !== "") {
				ctx.ui.notify("Magic Router: unknown argument (this session) — usage: /magic-router", "warning");
				return;
			}
			const id = sessionId(ctx);
			const enabled = !(enabledBySession.get(id) ?? true);
			enabledBySession.set(id, enabled);
			ctx.ui.notify(`Magic Router: ${enabled ? "enabled" : "disabled"} (this session)`, "info");
			ctx.ui.setStatus(STATUS_KEY, toggleStatusText(enabled));
			try {
				pi.logger.debug(`magic-router: session=${id} enabled=${enabled}`);
			} catch {
				// Toggle state and status must not depend on logging.
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		let enabled = true;
		try {
			enabled = isEnabled(ctx);
		} catch {
			enabled = true;
		}
		if (!enabled) {
			try {
				ctx.ui.setStatus(STATUS_KEY, toggleStatusText(false));
			} catch {
				// Status is cosmetic.
			}
			try {
				pi.logger.debug(`magic-router: session=${sessionId(ctx)} disabled`);
			} catch {
				// Logging is best-effort.
			}
			return undefined;
		}

		let routable = false;
		try {
			routable = isRoutableInput(event.text);
		} catch {
			return undefined;
		}
		if (routable) {
			try {
				clearStatus(ctx);
			} catch {
				// Status is cosmetic.
			}
		}

		let signalText = event.text;
		let loadedReferences = 0;
		let wrappedAttachments = 0;
		if (routable) {
			try {
				const signal = await buildRoutingSignalText(event.text, ctx);
				signalText = signal.text;
				loadedReferences = signal.loadedReferences.length;
				wrappedAttachments = signal.wrappedAttachments;
			} catch {
				signalText = event.text;
			}
		}

		let result: RoutingResult;
		try {
			result = applyRouting(event.text, signalText);
		} catch {
			return undefined;
		}

		try {
			pi.logger.debug(
				`magic-router: ${formatDecision(result.decision)} attachments=${loadedReferences + wrappedAttachments} wrapped=${wrappedAttachments} local=${loadedReferences}`,
			);
		} catch {
			// Logging must never discard routing.
		}

		const keywords = decisionKeywords(result.decision);
		if (routable) {
			try {
				ctx.ui.setStatus(STATUS_KEY, decisionStatusText(result.decision.manualKeyword, keywords));
			} catch {
				// Status is cosmetic.
			}
		}

		if (result.text === event.text) return undefined;
		return { text: result.text };
	});

	// Do not clear on turn_end/agent_end: the user wants the just-finished
	// turn's routing visible until the next routable user turn starts.
	pi.on("session_before_switch", (_event, ctx) => clearStatus(ctx));
	pi.on("session_before_branch", (_event, ctx) => clearStatus(ctx));
	pi.on("session_before_tree", (_event, ctx) => clearStatus(ctx));
	pi.on("session_switch", (_event, ctx) => {
		// Restore explicit toggle visibility when returning to a session the
		// user toggled. Sessions without stored state stay cleared until the
		// next routable turn (no stale decision is ever restored).
		try {
			const id = sessionId(ctx);
			if (!enabledBySession.has(id)) return;
			ctx.ui.setStatus(STATUS_KEY, toggleStatusText(enabledBySession.get(id) ?? true));
		} catch {
			// Status is cosmetic.
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		enabledBySession.delete(sessionId(ctx));
		clearStatus(ctx);
	});
}
