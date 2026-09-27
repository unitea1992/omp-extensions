import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	type ConfiguredThinkingLevel,
	ThinkingLevel,
	concreteThinkingLevel,
	extractExplicitThinkingSelector,
} from "./omp-compat";

const REVIEW_MODEL_ROLE = "@advisor";
const SAFE_REVIEW_TOOLS: Record<string, true> = { read: true, grep: true, glob: true };

export const REVIEW_ONLY_FLAG = "--review-only";

export const REVIEW_PROMPT = `現在の会話コンテキストにある設計・実装結果を、独立したread-only敵対レビュアーとして1回だけ徹底レビューしてください。

目的は褒めることや作業を進めることではなく、現在のユーザー要件・repo正本（AGENTS.md、README、対象仕様）と実装を照合し、提案・設計・実装が破綻する具体的な条件を見つけることです。必要なら read / grep / glob で対象を確認し、それ以外の手段は使わないでください。

次を重点的に検証してください。
- 誤った前提、暗黙の前提、未確認の依存条件
- 要件・制約・既存仕様の見落とし
- 設計内または実装との矛盾
- 不要な複雑性と、同じ目的を満たすより単純な代替案
- 現実的な失敗条件、境界条件、切り戻し / 復旧の欠落
- 連携 / 互換性 / 移行上の具体的リスク
- 検証不能、または曖昧な完了条件

制約:
- サブエージェント、Task、作業委譲、オーケストレーションを使わず、あなた単独で完結してください。
- 書き込み、編集、実装、コミット、設定変更は行わず、レビュー結果だけを返してください。
- 現在の依頼を満たすために必要な指摘だけ返してください。好みの設計差を欠陥扱いしないでください。
- 具体的な破綻条件または根拠のある指摘だけ返してください。「一般論として危険」「念のため」だけの指摘はしないでください。
- read / grep / glob と現在のコンテキストで確認できない事項は事実として断定せず、不確実性を明示してください。確認不能を即「問題」とは扱わないでください。
- 指摘は重大度順にし、各指摘で「重大度」「問題」「成立条件/根拠」「影響」「最小の修正または判断」を簡潔に示してください。対象ファイル / symbol / 観測した仕様・要件を可能な範囲で根拠に添えてください。
- 長い総評や称賛は不要です。後段の元モデルが各指摘を独立に採用 / 棄却できる粒度にしてください。
- 重大な懸念が残らない場合は「重大な懸念なし」と明記してください。`;

export const FOLLOW_UP_PROMPT = `直前の敵対レビュー結果を独立に査定し、必要な反映だけ行ってください。
- 各指摘を鵜呑みにせず、現在のユーザー要件・repo正本（AGENTS.md、README、対象仕様）・実装と照合し、成立する指摘だけ採用してください。
- 採用する指摘は現在の目的に必要な最小変更で反映し、変更に関連する必要な検証を実行してください。
- 誤指摘・証拠不足・過剰設計・好みの設計差は棄却してください。
- 重大な懸念なし、または採用すべき指摘がなければ変更を作らないでください。
- /expert-review を再帰的に実行しないでください。`;

export interface ExpertReviewOptions {
	reviewOnly: boolean;
	focus: string;
}

export function parseExpertReviewArgs(args: string): ExpertReviewOptions {
	const tokens = (typeof args === "string" ? args : "").split(/\s+/u).filter(Boolean);
	const focusTokens: string[] = [];
	let reviewOnly = false;
	for (const token of tokens) {
		if (token === REVIEW_ONLY_FLAG) {
			reviewOnly = true;
			continue;
		}
		focusTokens.push(token);
	}
	return { reviewOnly, focus: focusTokens.join(" ") };
}

export function buildReviewPrompt(focus: string): string {
	const trimmed = focus.trim();
	if (!trimmed) return REVIEW_PROMPT;
	return `${REVIEW_PROMPT}\n\n今回の重点確認事項:\n${trimmed}`;
}

export function getExpertReviewCompletions(argumentPrefix: string) {
	const prefix = typeof argumentPrefix === "string" ? argumentPrefix : "";
	const tokens = prefix.split(/\s+/u).filter(Boolean);
	if (tokens.includes(REVIEW_ONLY_FLAG)) return null;
	if (prefix.trim() === "") {
		return [
			{
				value: `${REVIEW_ONLY_FLAG} `,
				label: REVIEW_ONLY_FLAG,
				description: "Review only; restore without automatic adjudication",
			},
		];
	}
	const hasTrailingWhitespace = /\s$/u.test(prefix);
	const committed = hasTrailingWhitespace ? tokens : tokens.slice(0, -1);
	if (committed.includes(REVIEW_ONLY_FLAG)) return null;
	const current = hasTrailingWhitespace ? "" : (tokens.at(-1) ?? "");
	if (!current.startsWith("-")) return null;
	if (!REVIEW_ONLY_FLAG.startsWith(current)) return null;
	const base = committed.length > 0 ? `${committed.join(" ")} ` : "";
	return [
		{
			value: `${base}${REVIEW_ONLY_FLAG} `,
			label: REVIEW_ONLY_FLAG,
			description: "Review only; restore without automatic adjudication",
		},
	];
}
export function getAdvisorConfiguredThinking(pi: ExtensionAPI): ConfiguredThinkingLevel | undefined {
	try {
		// ExtensionAPI.pi.settings is typed, but unit-test doubles omit pi; read via a named host.
		type AdvisorSettingsHost = { pi?: { settings?: Parameters<typeof extractExplicitThinkingSelector>[1] } };
		const host = pi as unknown as AdvisorSettingsHost;
		const settings = host.pi?.settings;
		if (!settings) return undefined;
		return extractExplicitThinkingSelector(REVIEW_MODEL_ROLE, settings);
	} catch {
		return undefined;
	}
}

export function resolveReviewThinkingLevel(configured: ConfiguredThinkingLevel | undefined): ThinkingLevel | undefined {
	const concrete = concreteThinkingLevel(configured);
	if (concrete === undefined) return undefined;
	if (concrete === ThinkingLevel.Inherit) return undefined;
	return concrete;
}

type ActiveReview = {
	phase: "review";
	reviewOnly: boolean;
	restore: () => Promise<void>;
};

type SessionState = ActiveReview | { phase: "followup" } | undefined;

export default function expertReview(pi: ExtensionAPI): void {
	let state: SessionState;

	async function restoreReview(reason: string): Promise<boolean> {
		const active = state;
		if (!active || active.phase !== "review") return true;
		state = undefined;
		try {
			await active.restore();
			pi.logger.debug(`expert-review: restored session after ${reason}`);
			return true;
		} catch (error) {
			pi.logger.warn("expert-review: failed to fully restore session", {
				reason,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	function clearFollowUp(reason: string): void {
		if (!state || state.phase !== "followup") return;
		state = undefined;
		pi.logger.debug(`expert-review: follow-up settled after ${reason}`);
	}

	pi.registerCommand("expert-review", {
		description:
			"Advisor review then original-model adjudication; use --review-only for review without automatic follow-up",
		getArgumentCompletions: getExpertReviewCompletions,
		handler: async (args, ctx) => {
			if (state) {
				ctx.ui.notify("Expert review is already running.", "warning");
				return;
			}

			await ctx.waitForIdle();
			// Re-check after the await: a second invocation may have activated
			// while this one was waiting. Everything below runs synchronously
			// until state is assigned, so no interleave is possible here.
			if (state) {
				ctx.ui.notify("Expert review is already running.", "warning");
				return;
			}

			const options = parseExpertReviewArgs(args);
			const reviewerModel = ctx.models.resolve(REVIEW_MODEL_ROLE);
			if (!reviewerModel) {
				ctx.ui.notify("Expert review model is unresolved. Configure modelRoles.advisor first.", "error");
				return;
			}

			const originalModel = ctx.models.current();
			const originalThinking = pi.getThinkingLevel();
			const originalTools = [...pi.getActiveTools()];
			const safeTools = originalTools.filter((name) => SAFE_REVIEW_TOOLS[name] === true);

			const restore = async () => {
				const errors: string[] = [];
				try {
					if (originalModel && !(await pi.setModel(originalModel))) errors.push("model");
				} catch {
					errors.push("model");
				}
				try {
					if (originalThinking !== undefined) pi.setThinkingLevel(originalThinking);
				} catch {
					errors.push("thinking level");
				}
				try {
					await pi.setActiveTools(originalTools);
				} catch {
					errors.push("active tools");
				}
				if (errors.length > 0) throw new Error(`failed to restore: ${errors.join(", ")}`);
			};
			state = { phase: "review", reviewOnly: options.reviewOnly, restore };

			try {
				if (!(await pi.setModel(reviewerModel))) {
					throw new Error("configured advisor model could not be selected");
				}
				const reviewThinking = resolveReviewThinkingLevel(getAdvisorConfiguredThinking(pi));
				if (reviewThinking !== undefined) {
					pi.setThinkingLevel(reviewThinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
				}
				await pi.setActiveTools(safeTools);
				pi.sendUserMessage(buildReviewPrompt(options.focus));
				ctx.ui.notify(
					options.reviewOnly
						? "Expert review started (one turn, read-only, no subagents)."
						: "Expert review started (read-only review, then original-model adjudication).",
					"info",
				);
			} catch (error) {
				await restoreReview("activation failure");
				ctx.ui.notify(
					`Expert review could not start: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("tool_call", (event) => {
		if (!state || state.phase !== "review" || SAFE_REVIEW_TOOLS[event.toolName]) return undefined;
		return {
			block: true,
			reason: `expert-review is read-only; tool '${event.toolName}' is disabled for this turn`,
		};
	});
	pi.on("agent_end", async (event, ctx) => {
		// The host sets willContinue when a continuation is already scheduled
		// (auto-retry, compaction, plan/todo enforcement, ...). Restoring here
		// would hand the continuation back to the original model with full
		// tools, so stay in review mode until the terminal settle.
		if (event.willContinue) return;
		const active = state;
		if (!active) return;
		if (active.phase === "followup") {
			clearFollowUp("agent end");
			return;
		}
		const reviewOnly = active.reviewOnly;
		const restored = await restoreReview("agent end");
		if (!restored) {
			ctx.ui.notify("Expert review restore failed. Automatic adjudication skipped.", "error");
			return;
		}
		if (reviewOnly) return;
		// A second invocation may have started a new review while the restore
		// was in flight. Do not hijack it with a follow-up turn.
		if (state) {
			pi.logger.warn("expert-review: skipping follow-up because a new review started during restore");
			return;
		}
		try {
			pi.sendUserMessage(FOLLOW_UP_PROMPT);
		} catch (error) {
			ctx.ui.notify(
				`Expert review follow-up could not start: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		state = { phase: "followup" };
		ctx.ui.notify("Expert review restored; original-model adjudication started.", "info");
	});
	pi.on("session_before_switch", async () => {
		await restoreReview("session switch");
	});
	pi.on("session_before_branch", async () => {
		await restoreReview("session branch");
	});
	pi.on("session_before_tree", async () => {
		await restoreReview("session tree");
	});
	pi.on("session_shutdown", async () => {
		await restoreReview("session shutdown");
	});
}
