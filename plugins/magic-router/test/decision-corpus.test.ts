import { describe, expect, test } from "bun:test";
import { applyRouting } from "../src/router";

describe("reference handoff", () => {
	// Reference + closure intent alone never qualifies as workflowz; the
	// task body behind the indirection is unscoped until stated.
	const cases: Array<[string, string, "none", "none" | "ultrathink?"]> = [
		["issue work", "Issue #65 を読んで対応して", "none", "none"],
		["plan handoff", "plan.md を読んで作業して", "none", "none"],
	];
	for (const [name, prompt, delegation] of cases) {
		test(name, () => {
			const result = applyRouting(prompt);
			expect(result.decision.delegation).toBe(delegation);
			expect(result.text).toBe(prompt);
		});
	}
	test("read-only issue summary stays none", () => {
		expect(applyRouting("Issue #123 を要約して").decision.delegation).toBe("none");
		expect(applyRouting("Issue #123 を読んで").decision.delegation).toBe("none");
		expect(applyRouting("PR #45 の内容を説明して").decision.delegation).toBe("none");
		expect(applyRouting("Issue #123 は何が問題？").decision.delegation).toBe("none");
	});

	test("solo veto beats reference handoff", () => {
		const result = applyRouting("Issue #123 を読んでサブエージェントなしで対応");
		expect(result.decision.vetoSoloIntent).toBe(true);
		expect(result.decision.delegation).toBe("none");
		expect(result.text).not.toContain("workflowz");
	});
});

describe("attachment authority", () => {
	test("bare long instruction attachment routes on its body", () => {
		const body = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";
		const prompt = `<attachment>\n${body}\n</attachment>`;
		// Router alone masks the wrapper; the extension supplement carries it.
		// Here we emulate the supplemented signal directly.
		const result = applyRouting(prompt, `${prompt}\n\n${body}`);
		expect(result.decision.delegation).toBe("workflowz");
	});
});

describe("precision", () => {
	test("single bug plus acceptance bullets stays none", () => {
		const prompt = "このバグを調査して修正し、テストで確認して。\n受入条件:\n- 既存API互換\n- 新規依存なし";
		const result = applyRouting(prompt);
		expect(result.decision.delegation).toBe("none");
		expect(result.text).toBe(prompt);
	});

	test("weak phrase plus single function stays none", () => {
		const prompt = "step-by-stepでこの関数を調査して修正して";
		expect(applyRouting(prompt).decision.delegation).toBe("none");
	});

	test("ambiguous parallelizability question stays none", () => {
		expect(applyRouting("並列化できるか確認して").decision.delegation).toBe("none");
	});

	test("broad-worded research without stages stays none", () => {
		expect(applyRouting("最新の推論手法を広範に調査して比較して").decision.delegation).toBe("none");
	});

	test("adversarial multi-lens audit without stages stays none with reasoning", () => {
		const result = applyRouting("このPRを5観点から敵対監査して");
		expect(result.decision.delegation).toBe("none");
		expect(result.decision.reasoning).toBe("ultrathink");
		expect(result.text).toBe("このPRを5観点から敵対監査して\nultrathink");
	});

	test("migration mention without stages stays none", () => {
		expect(applyRouting("全リポジトリのmigration箇所を洗い出して安全に移行して").decision.delegation).toBe("none");
	});

	test("architecture filename lookup stays none", () => {
		expect(applyRouting("このアーキテクチャ図のファイル名を教えて").decision.reasoning).toBe("none");
	});

	test("architecture design decision routes ultrathink", () => {
		expect(applyRouting("決済基盤のアーキテクチャ再設計のため方針を決定して").decision.reasoning).toBe("ultrathink");
	});

	test("adversarial audit and verification route ultrathink without delegation", () => {
		for (const prompt of ["この設計を敵対検証して", "懸念が残らないまで敵対検証して"]) {
			const result = applyRouting(prompt);
			expect(result.decision.reasoning).toBe("ultrathink");
			expect(result.decision.delegation).toBe("none");
			expect(result.text).toBe(`${prompt}\nultrathink`);
		}
	});
});
