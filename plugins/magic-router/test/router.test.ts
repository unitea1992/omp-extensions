import { describe, expect, test } from "bun:test";
import {
	applyRouting,
	countOutcomes,
	decisionKeywords,
	formatDecision,
	isRoutableInput,
	routeMagicKeywords,
} from "../src/router";

describe("simple prompts stay unchanged", () => {
	// One representative per none-path shape: trivial prompt, review verb
	// without breadth, and few stages on a small scope.
	const cases: Array<[string, string]> = [
		["typo fix", "typoを修正して"],
		["limited review", "この関数をレビューして"],
		["small fix with test", "このtypoを修正してテストを通して"],
	];
	for (const [name, prompt] of cases) {
		test(name, () => {
			const result = applyRouting(prompt);
			expect(result.text).toBe(prompt);
			expect(result.decision.reasoning).toBe("none");
			expect(result.decision.delegation).toBe("none");
		});
	}
});

describe("reasoning signals select ultrathink", () => {
	const cases: Array<[string, string]> = [
		["architecture JA", "新しい決済基盤のアーキテクチャを検討し、トレードオフを整理して"],
		["architecture EN", "Review the payment service architecture and decide the design direction"],
		["root cause JA", "本番で再現しない複雑なバグの根本原因を突き止めて"],
		["root cause EN", "Find the root cause of this production outage"],
		["hard debugging", "解決しないデッドロックの不具合をデバッグして"],
		["tradeoff", "この2案のトレードオフを比較して技術選定をして"],
	];
	for (const [name, prompt] of cases) {
		test(name, () => {
			const result = applyRouting(prompt);
			expect(result.decision.reasoning).toBe("ultrathink");
			expect(result.decision.delegation).toBe("none");
			expect(result.text).toBe(`${prompt}\nultrathink`);
		});
	}
});

describe("independent workstreams select orchestrate", () => {
	test("JA parallel independent tasks", () => {
		const prompt = "以下の3件の独立したタスクを並列に進めて:\n1. 認証APIの調査\n2. 課金APIの調査\n3. 通知APIの調査";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("orchestrate");
		expect(result.decision.reasoning).toBe("none");
		expect(result.text).toBe(`${prompt}\norchestrate`);
	});

	test("EN parallel workstreams", () => {
		const prompt =
			"Handle these 3 tasks as independent workstreams in parallel:\n1. investigate auth\n2. investigate billing\n3. investigate notify";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("orchestrate");
		expect(result.text.endsWith("\norchestrate")).toBe(true);
	});

	test("EN feasibility question stays none", () => {
		const prompt =
			"Can these 3 independent tasks be done in parallel?\n1. Investigate auth\n2. Investigate billing\n3. Investigate notify";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("none");
		expect(result.text).toBe(prompt);
	});

	test("EN imperative parallel tasks select orchestrate", () => {
		const prompt =
			"Handle these 3 independent tasks in parallel:\n1. Investigate auth\n2. Investigate billing\n3. Investigate notify";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("orchestrate");
		expect(result.text).toBe(`${prompt}\norchestrate`);
	});
});

describe("broad multi-stage workflows select workflowz", () => {
	test("JA research to verification pipeline", () => {
		const prompt = "リポジトリ全体を調査して計画を立て、移行を実装して検証まで一気通貫で進めて";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("workflowz");
		expect(result.text).toBe(`${prompt}\nworkflowz`);
	});

	test("EN pipeline", () => {
		const prompt = "Research the entire codebase, propose a plan, implement it, then test and review the result.";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("workflowz");
	});

	test("bare codebase pipeline stays none", () => {
		const prompt = "Research the codebase, propose a plan, implement it, then test and review the result.";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("none");
		expect(result.text).toBe(prompt);
	});

	test("cross-subsystem pipeline with multiple outcomes", () => {
		const prompt =
			"複数のサブシステムを調査して計画を立て、以下2件を実装して検証まで行って:\n1. 認証基盤の改修\n2. 課金基盤の改修";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("workflowz");
	});

	test("weak pipeline phrase alone stays none", () => {
		const prompt = "段階的に進めて。まず現状を調査し、次に実装して";
		const result = applyRouting(prompt);
		expect(result.text).toBe(prompt);
		expect(result.decision.delegation).toBe("none");
	});

	test("single-bug investigate-fix-test stays none", () => {
		const prompt = "このバグの原因を調査して修正し、テストで確認して";
		const result = applyRouting(prompt);
		expect(result.text).toBe(prompt);
		expect(result.decision.reasoning).toBe("none");
		expect(result.decision.delegation).toBe("none");
	});
});

describe("reasoning stacks onto delegation", () => {
	test("ultrathink + orchestrate", () => {
		const prompt =
			"決済基盤のアーキテクチャ再設計のため、以下の3件の独立した調査を並列に進めて:\n1. 認証方式の調査\n2. 課金方式の調査\n3. 監査方式の調査";
		const result = applyRouting(prompt);
		expect(result.decision.reasoning).toBe("ultrathink");
		expect(result.decision.delegation).toBe("orchestrate");
		expect(result.text).toBe(`${prompt}\nultrathink orchestrate`);
	});

	test("ultrathink + workflowz", () => {
		const prompt =
			"大規模な決済基盤のアーキテクチャを見直すため、現状を調査して計画を立て、実装してテストとレビューまで行って";
		const result = applyRouting(prompt);
		expect(result.decision.reasoning).toBe("ultrathink");
		expect(result.decision.delegation).toBe("workflowz");
		expect(result.text).toBe(`${prompt}\nultrathink workflowz`);
	});
});

describe("signals inside code or XML do not route", () => {
	test("fenced block signals are ignored", () => {
		const prompt = "typoを修正して\n```\n以下の3件の独立したタスクを並列に進めて\n1. a\n2. b\n3. c\n```";
		const result = applyRouting(prompt);
		expect(result.text).toBe(prompt);
		expect(result.decision.delegation).toBe("none");
	});

	test("XML section signals are ignored", () => {
		const prompt =
			"typoを修正して\n<attachment>\n独立した3件のタスクを並列に進め、調査・計画・実装・検証まで行う\n</attachment>";
		const result = applyRouting(prompt);
		expect(result.text).toBe(prompt);
		expect(result.decision.delegation).toBe("none");
	});

	test("veto inside code does not block prose routing", () => {
		const prompt =
			"以下の3件の独立したタスクを並列に進めて:\n1. Aの調査\n2. Bの調査\n3. Cの調査\n```\n// do not delegate\n```";
		const result = applyRouting(prompt);
		expect(result.decision.vetoSoloIntent).toBe(false);
		expect(result.decision.delegation).toBe("orchestrate");
	});

	test("broad marker inside code does not qualify a pipeline", () => {
		const prompt = "このバグの原因を調査して修正し、テストで確認して\n```\n大規模 横断的\n```";
		const result = applyRouting(prompt);
		expect(result.text).toBe(prompt);
		expect(result.decision.delegation).toBe("none");
	});
});

describe("orchestrate and workflowz are never combined", () => {
	test("broad multi-stage with explicit independent parallel stays none", () => {
		const prompt =
			"リポジトリ全体を対象に、以下の3件の独立したタスクを並列に進めて。各タスクは調査・計画・実装・検証まで行う:\n1. 認証基盤の調査・計画・実装・検証\n2. 課金基盤の調査・計画・実装・検証\n3. 通知基盤の調査・計画・実装・検証";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("none");
		expect(result.text).toBe(prompt);
		expect(decisionKeywords(result.decision)).toEqual([]);
	});
});

describe("solo intent hard-vetoes delegation", () => {
	const vetoCases: Array<[string, string]> = [
		["JA 単独", "単独で作業して。以下の3件の独立したタスクを並列に進めて:\n1. Aの調査\n2. Bの調査\n3. Cの調査"],
		[
			"JA サブエージェント禁止",
			"サブエージェントを使わないで一人で作業して。このリポジトリを調査して計画を立て、実装してテストまで行って",
		],
		["JA 委譲禁止", "委譲しないで自分だけで対応して。以下2件の独立した調査を並列に進めて:\n1. A\n2. B"],
		["EN work alone", "Work alone, do not delegate. Handle these 3 independent workstreams in parallel: A, B, C."],
		["EN no subagents", "Without subagents, as a single agent, research the repo, plan, implement, test and review."],
	];
	for (const [name, prompt] of vetoCases) {
		test(name, () => {
			const result = applyRouting(prompt);
			expect(result.decision.vetoSoloIntent).toBe(true);
			expect(result.decision.delegation).toBe("none");
			expect(result.text).toBe(prompt);
		});
	}

	test("solo veto still allows ultrathink for difficult tasks", () => {
		const prompt = "単独で作業して。サブエージェントは使わないで。この再現しない複雑なバグの根本原因を突き止めて";
		const result = applyRouting(prompt);
		expect(result.decision.vetoSoloIntent).toBe(true);
		expect(result.decision.reasoning).toBe("ultrathink");
		expect(result.decision.delegation).toBe("none");
		expect(result.text).toBe(`${prompt}\nultrathink`);
	});
});

describe("manual keywords pass through untouched", () => {
	const cases: Array<[string, string]> = [
		["ultrathink prefix", "ultrathink この設計をレビューして"],
		["stacked manual", "ultrathink orchestrate この並列調査を進めて"],
		["jevify manual", "jevify この一覧を分類して"],
	];
	for (const [name, prompt] of cases) {
		test(name, () => {
			const result = applyRouting(prompt);
			expect(result.text).toBe(prompt);
			expect(result.decision.manualKeyword).toBe(true);
		});
	}

	test("keyword inside code is not a manual keyword", () => {
		const prompt = "以下の独立タスクを並列に進めて(コード内の `orchestrate` 関数を使うこと):\n1. Aの調査\n2. Bの調査";
		const result = applyRouting(prompt);
		expect(result.decision.manualKeyword).toBe(false);
		expect(result.decision.delegation).toBe("orchestrate");
	});
});

describe("non-prompt inputs are never rewritten", () => {
	const cases: Array<[string, string]> = [
		["empty", ""],
		["slash command", "/review this file"],
		["skill command", "/skill:devHandlers do it"],
		["bash", "!git status"],
		["bash excluded", "!!ls -la"],
		["python", "$ print(1)"],
		["python excluded", "$$ print(1)"],
		["queue shorthand", "-> do this after the turn"],
		["queue alt", "=> do this after the turn"],
		["continue dot", "."],
		["continue c", "c"],
	];
	for (const [name, prompt] of cases) {
		test(name, () => {
			expect(isRoutableInput(prompt)).toBe(false);
			const result = applyRouting(prompt);
			expect(result.text).toBe(prompt);
			expect(result.decision.skipped).toBe(true);
		});
	}

	test("shell-style $HOME stays routable prose", () => {
		expect(isRoutableInput("Why is $HOME/bin missing from PATH?")).toBe(true);
	});
});

describe("decision helpers", () => {
	test("countOutcomes counts lists and N件 mentions", () => {
		expect(countOutcomes("以下3件のタスク")).toBe(3);
		expect(countOutcomes("1. a\n2. b\n3. c")).toBe(3);
		expect(countOutcomes("- a\n- b")).toBe(2);
		expect(countOutcomes("handle 2 tasks")).toBe(2);
		expect(countOutcomes("plain prompt")).toBe(0);
	});

	test("formatDecision renders the debug shape from the issue", () => {
		const decision = routeMagicKeywords("単独で作業して。この複雑なバグの根本原因を突き止めて");
		const line = formatDecision(decision);
		expect(line).toContain("reasoning=ultrathink");
		expect(line).toContain("delegation=none");
		expect(line).toContain("veto=solo-intent");
		expect(line).toMatch(/reasons=\[.+\]/);
	});

	test("router never throws on hostile input", () => {
		for (const prompt of ["�\u0000 selection", "<\uD800", "`".repeat(5000), "<a>".repeat(2000)]) {
			const result = applyRouting(prompt);
			expect(typeof result.text).toBe("string");
		}
	});
});
