/**
 * Deterministic magic-keyword router.
 *
 * Pure local logic — no LLM calls, no network, no token accounting. The
 * decision separates two orthogonal axes so `ultrathink` can stack onto a
 * delegation mode, while `orchestrate` and `workflowz` stay mutually
 * exclusive:
 *
 * - reasoning: `none | ultrathink`
 * - delegation: `none | orchestrate | workflowz`
 *
 * Delegation is conservative by design: it only fires on high-confidence
 * signals (explicit parallel/independent workstreams or native workflow
 * archetypes, evaluated independently; both candidates resolve to `none`).
 * Ambiguous prompts resolve to `none` so subagent token spend is never
 * triggered by a guess.
 *
 * All signals are evaluated on prose-only text via OMP native
 * `maskNonProse()` (fenced code blocks, inline code spans, and XML sections
 * masked): pasted READMEs or code samples must never trigger routing by
 * themselves. Manual keyword detection uses OMP native `hasMagicKeyword()`
 * on the original transport text.
 */

import { hasMagicKeyword, maskNonProse } from "./omp-compat";

export type MagicKeyword = "ultrathink" | "orchestrate" | "workflowz";
export type ReasoningMode = "none" | "ultrathink";
export type DelegationMode = "none" | "orchestrate" | "workflowz";

export interface RoutingDecision {
	reasoning: ReasoningMode;
	delegation: DelegationMode;
	/** True when the prompt explicitly asks to work alone. */
	vetoSoloIntent: boolean;
	/** True when the prompt already carries a native magic keyword. */
	manualKeyword: boolean;
	/** True for inputs that must never be routed (commands, shortcuts…). */
	skipped: boolean;
	reasons: string[];
}

export interface RoutingResult {
	text: string;
	decision: RoutingDecision;
}

const REASONING_THRESHOLD = 2;

function noneDecision(reasons: string[], extra?: Partial<RoutingDecision>): RoutingDecision {
	return {
		reasoning: "none",
		delegation: "none",
		vetoSoloIntent: false,
		manualKeyword: false,
		skipped: false,
		reasons,
		...extra,
	};
}

/**
 * Inputs that are not plain prompts. The `input` hook runs before OMP's own
 * slash/bash/python/queue/continue handling, so these must pass through
 * untouched to preserve existing input semantics.
 */
export function isRoutableInput(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === "") return false;
	// Manual continue shortcuts (`.` / `c`) resume the agent without a turn.
	if (trimmed === "." || trimmed === "c") return false;
	const head = trimmed.trimStart();
	// Slash/skill commands, bash (`!` / `!!`) and yield-queue (`->` / `=>`).
	if (head.startsWith("/") || head.startsWith("!")) return false;
	if (head.startsWith("->") || head.startsWith("=>")) return false;
	// Python (`$ <code>` / `$$ <code>`). Shell-style `$HOME` stays routable:
	// only a whitespace sigil counts, matching OMP's own prefix rule.
	if (/^\$\$?[ \t\n\r]/.test(head) && !head.startsWith("${")) return false;
	return true;
}

const SOLO_PATTERNS: RegExp[] = [
	/単独で/,
	/一人で/,
	/自分だけで/,
	/サブエージェント(を|は)?使わない/,
	/サブエージェント\s*(なし|禁止|不要)/,
	/委譲しない/,
	/委任しない/,
	/並列化しない/,
	/並列にしない/,
	/\bwork\s+alone\b/i,
	/\bsingle[ -]?agent\b/i,
	/\bwithout\s+sub-?agents?\b/i,
	/\bno\s+sub-?agents?\b/i,
	/\bsub-?agents?\s+(prohibited|forbidden|disabled)\b/i,
	/\bdo\s+not\s+delegate\b/i,
	/\bdon'?t\s+delegate\b/i,
	/\bno\s+delegation\b/i,
	/\bwithout\s+delegation\b/i,
	/\bdo\s+not\s+parallelize\b/i,
	/\bdon'?t\s+parallelize\b/i,
	/\bno\s+parallelization\b/i,
	/\bwithout\s+parallelization\b/i,
];

export function hasSoloIntent(text: string): boolean {
	return SOLO_PATTERNS.some((pattern) => pattern.test(text));
}

const REASONING_SIGNALS: Array<{ test: (text: string) => boolean; score: number; reason: string }> = [
	{
		// Architecture mention alone is not reasoning (e.g. "アーキテクチャ図の
		// ファイル名を教えて"). Only architecture decisions/design work count.
		test: (text) => {
			const mentions = /architect(?:ure|ural)?s?/i.test(text) || text.includes("アーキテクチャ");
			if (!mentions) return false;
			return /検討|判断|選定|設計|見直|再設計|方針|決定|decide|decision|design/i.test(text);
		},
		score: 2,
		reason: "architecture-decision",
	},
	{
		test: (text) => /root[-\s]?causes?/i.test(text) || /根本原因|原因分析|原因究明|原因特定|真因/.test(text),
		score: 2,
		reason: "root-cause",
	},
	{
		test: (text) => {
			const debug =
				/debug(?:ging)?/i.test(text) ||
				/デバッグ|不具合|バグ|障害|不調|race[-\s]?conditions?|競合状態|deadlocks?|デッドロック|bottlenecks?|ボトルネック|memory leaks?|メモリリーク|パフォーマンス劣化|performance (?:degradation|regression)|intermittent|flaky|再現しない|再現性が低い/.test(
					text,
				);
			if (!debug) return false;
			return (
				/difficult|hard|complex|tricky|elusive|stubborn/i.test(text) ||
				/難しい|困難|複雑|深刻|厄介|解決しない|解消しない|長期化/.test(text)
			);
		},
		score: 2,
		reason: "hard-debugging",
	},
	{
		test: (text) => /trade-?offs?/i.test(text) || text.includes("トレードオフ"),
		score: 2,
		reason: "tradeoff",
	},
	{
		// Adversarial / thorough verification is multi-step reasoning, not a
		// casual mention. Covers 敵対監査 / 敵対検証 / 敵対レビュー which the
		// previous 敵対的-only pattern missed.
		test: (text) =>
			/敵対的|敵対監査|敵対検証|敵対レビュー|adversarial|徹底的.{0,8}(検証|レビュー|監査)|網羅的.{0,8}(検証|レビュー|監査)|rigorous|thorough (?:reviews?|verification|audits?)/i.test(
				text,
			),
		score: 2,
		reason: "deep-verification",
	},
	{
		test: (text) => /設計判断|設計方針|技術選定|design decisions?|architecture decisions?/.test(text),
		score: 1,
		reason: "design-judgment",
	},
	{
		test: (text) =>
			/(曖昧|あいまい|不明確|ambiguous|unclear|vague).{0,24}(要件|仕様|要求|requirements?|specs?(?:ification)?)/i.test(
				text,
			),
		score: 1,
		reason: "ambiguity",
	},
	{
		test: (text) => /migrat(?:e|ion|ing)s?/i.test(text) || /移行|マイグレーション/.test(text),
		score: 1,
		reason: "migration",
	},
];

/**
 * Explicit parallel execution intent (not a mere "can we parallelize?"
 * question): 並列に/で + execution verb, or `in parallel` with an execution
 * verb nearby. Used with multiple requested units as a strong orchestrate
 * signal (P1-6).
 */
const PARALLEL_EXECUTION_RE = /(並列に|並列で).{0,16}(進め|実行|調査|対応|作業|処理|実施)|in parallel/i;
const FEASIBILITY_QUESTION_RE = /\b(can|could)\b[^.!?]*\bin parallel[^.!?]*\?/i;
const INDEPENDENT_RE = /独立(した|している|して|性)?|independent(?:ly)?|independence/i;
const WORKSTREAM_RE = /work-?streams?/i;
const CROSS_SCOPE_RE =
	/複数(の)?(ファイル|リポジトリ|サブシステム|サービス|モジュール|パッケージ)|cross-(?:file|repo(?:sitory)?|subsystem|service|package)s?|multiple (?:files|repositories|repos|subsystems|services|packages|modules)|数ファイル/i;

const STAGE_TESTS: Array<{ test: (text: string) => boolean; reason: string }> = [
	{
		test: (text) => /調査|リサーチ|research|investigat(?:e|ion|ing)|探索|exploratory/i.test(text),
		reason: "stage:research",
	},
	{
		test: (text) => /計画|プラン|\bplans?\b|\bplanning\b|設計書|proposals?/i.test(text),
		reason: "stage:plan",
	},
	{
		test: (text) => /実装|implement(?:ation|ing)?|修正|改修|移行|マイグレーション|migrat(?:e|ion|ing)s?/i.test(text),
		reason: "stage:implement",
	},
	{
		test: (text) =>
			/検証|テスト|\btests?\b|\btesting\b|レビュー|reviews?|監査|audits?|確認|verif(?:y|ication)/i.test(text),
		reason: "stage:verify",
	},
];

/** Native workflowz breadth (v2): stages>=3 plus one breadth signal. Never bare mentions. */
const RESEARCH_VERB_RE = /調査|リサーチ|research|investigat(?:e|ion|ing)|探索/i;
const RESEARCH_BROAD_RE = /広範|幅広|包括|徹底|横断|大規模/i;
const REVIEW_AUDIT_RE = /レビュー|監査|audit|review/i;
const REVIEW_BREADTH_RE = /多観点|\d+\s*観点|網羅|徹底|multi-?lens/i;
const MIGRATION_RE = /migrat(?:e|ion|ing)s?|移行|マイグレーション/i;
const MIGRATION_SCOPE_RE = /全リポジトリ|リポジトリ全体|コードベース全体|横断|大規模/i;
const OPEN_ENDED_RE = /open-?ended|やりたいことリスト|タスクリスト|やることリスト|work[ -]?list|backlog/i;
const BREADTH_BARE_RE =
	/広範|幅広|包括|横断|大規模|全体的|全面的|リポジトリ全体|コードベース全体|entire codebase|whole codebase|codebase-wide|large-scale|broad/i;
const WHOLE_SCOPE_RE = /全体(の|を)?(調査|見直し|改修|移行|設計|把握|テスト)/;
function detectBreadth(prose: string, outcomes: number): string | null {
	if (BREADTH_BARE_RE.test(prose)) return "breadth:bare";
	if (WHOLE_SCOPE_RE.test(prose)) return "breadth:whole-scope";
	if (CROSS_SCOPE_RE.test(prose)) return "breadth:cross-scope";
	if (OPEN_ENDED_RE.test(prose) && outcomes >= 2) return "breadth:open-ended-list";
	if (RESEARCH_VERB_RE.test(prose) && RESEARCH_BROAD_RE.test(prose)) return "breadth:broad-research";
	if (REVIEW_AUDIT_RE.test(prose) && REVIEW_BREADTH_RE.test(prose)) return "breadth:review";
	if (MIGRATION_RE.test(prose) && MIGRATION_SCOPE_RE.test(prose)) return "breadth:migration";
	return null;
}

/** Distinct requested outcomes: enumerated items or `N件/つ/個/tasks` mentions. */
export function countOutcomes(text: string): number {
	let items = 0;
	for (const line of text.split("\n")) {
		if (/^[\s>]*?(?:\d+[.)、:]|[-*•・])\s+\S/.test(line)) items++;
	}
	let mentioned = 0;
	for (const match of text.matchAll(
		/(\d+)\s*(?:件|つ|個|tasks?|work-?streams?|projects?|repos(?:itories)?|files?)/gi,
	)) {
		const value = Number(match[1]);
		if (Number.isSafeInteger(value)) mentioned = Math.max(mentioned, Math.min(value, 9));
	}
	return Math.max(items, mentioned);
}

function scoreReasoning(text: string, reasons: string[]): number {
	let score = 0;
	for (const signal of REASONING_SIGNALS) {
		let hit = false;
		try {
			hit = signal.test(text);
		} catch {
			hit = false;
		}
		if (hit) {
			score += signal.score;
			reasons.push(signal.reason);
		}
	}
	return score;
}

function collectStages(text: string, reasons: string[]): number {
	let stages = 0;
	for (const stage of STAGE_TESTS) {
		if (stage.test(text)) {
			stages++;
			reasons.push(stage.reason);
		}
	}
	return stages;
}

/**
 * Core decision. Transport semantics use `text`; optional `signalText` only
 * contributes classification signals (for example session-local paste files).
 */
export function routeMagicKeywords(text: string, signalText: string = text): RoutingDecision {
	try {
		if (!isRoutableInput(text)) return noneDecision(["skipped"], { skipped: true });
		if (hasMagicKeyword(text)) return noneDecision(["manual-keyword"], { manualKeyword: true });

		// Signals run on native prose-only text: code fences, inline code, and
		// XML sections are masked so pasted docs/samples never route alone.
		const prose = maskNonProse(signalText);
		const reasons: string[] = [];
		const vetoSoloIntent = hasSoloIntent(prose);
		if (vetoSoloIntent) reasons.push("veto:solo-intent");

		const reasoningScore = scoreReasoning(prose, reasons);
		const reasoning: ReasoningMode = reasoningScore >= REASONING_THRESHOLD ? "ultrathink" : "none";
		if (reasoning !== "none") reasons.push(`reasoning-score:${reasoningScore}`);

		let delegation: DelegationMode = "none";
		if (!vetoSoloIntent) {
			const stageReasons: string[] = [];
			const stages = collectStages(prose, stageReasons);
			const outcomes = countOutcomes(prose);
			const orchestrateCandidate =
				outcomes >= 2 &&
				PARALLEL_EXECUTION_RE.test(prose) &&
				(INDEPENDENT_RE.test(prose) || WORKSTREAM_RE.test(prose)) &&
				!FEASIBILITY_QUESTION_RE.test(prose);
			const breadth = detectBreadth(prose, outcomes);
			const workflowzCandidate = stages >= 3 && breadth !== null;
			reasons.push(
				...stageReasons,
				`stages:${stages}`,
				`outcomes:${outcomes}`,
				`orchestrate-candidate:${orchestrateCandidate}`,
				`workflowz-candidate:${workflowzCandidate}`,
			);
			if (orchestrateCandidate && !workflowzCandidate) {
				delegation = "orchestrate";
				reasons.push("explicit-parallel");
				if (INDEPENDENT_RE.test(prose)) reasons.push("independent");
				if (WORKSTREAM_RE.test(prose)) reasons.push("workstream");
			} else if (workflowzCandidate && !orchestrateCandidate) {
				delegation = "workflowz";
				if (breadth !== null) reasons.push(breadth);
			} else if (orchestrateCandidate && workflowzCandidate) {
				reasons.push("conflict:both-candidates");
				if (breadth !== null) reasons.push(breadth);
			}
		} else {
			// Solo veto kills delegation only; record what was suppressed for debug.
			const suppressed: string[] = [];
			const stages = collectStages(prose, suppressed);
			const outcomes = countOutcomes(prose);
			const orchestrateSuppressed =
				outcomes >= 2 &&
				PARALLEL_EXECUTION_RE.test(prose) &&
				(INDEPENDENT_RE.test(prose) || WORKSTREAM_RE.test(prose)) &&
				!FEASIBILITY_QUESTION_RE.test(prose);
			const breadth = detectBreadth(prose, outcomes);
			const workflowzSuppressed = stages >= 3 && breadth !== null;
			if (orchestrateSuppressed) suppressed.push("orchestrate-candidate");
			if (workflowzSuppressed) {
				suppressed.push("workflowz-candidate");
				if (breadth !== null) suppressed.push(breadth);
			}
			suppressed.push(`stages:${stages}`, `outcomes:${outcomes}`);
			if (orchestrateSuppressed || workflowzSuppressed) reasons.push(`suppressed:[${suppressed.join(",")}]`);
		}

		if (reasons.length === 0) reasons.push("none");
		return { reasoning, delegation, vetoSoloIntent, manualKeyword: false, skipped: false, reasons };
	} catch {
		return noneDecision(["error"]);
	}
}

/** Keywords to append, in stable order. Never contains both delegation modes. */
export function decisionKeywords(decision: RoutingDecision): MagicKeyword[] {
	const keywords: MagicKeyword[] = [];
	if (decision.reasoning === "ultrathink") keywords.push("ultrathink");
	if (decision.delegation === "orchestrate" || decision.delegation === "workflowz") keywords.push(decision.delegation);
	return keywords;
}

/**
 * Apply routing to transport text while optionally classifying richer signal
 * text. Only the transport text is ever returned to OMP.
 */
export function applyRouting(text: string, signalText: string = text): RoutingResult {
	const decision = routeMagicKeywords(text, signalText);
	const keywords = decisionKeywords(decision);
	if (keywords.length === 0) return { text, decision };
	return { text: `${text}\n${keywords.join(" ")}`, decision };
}

/** Single-line debug rendering of a decision (see README for an example). */
export function formatDecision(decision: RoutingDecision): string {
	const veto = decision.vetoSoloIntent ? "solo-intent" : "none";
	const manual = decision.manualKeyword ? "manual" : "auto";
	return `reasoning=${decision.reasoning} delegation=${decision.delegation} veto=${veto} via=${manual} reasons=[${decision.reasons.join(",")}]`;
}
