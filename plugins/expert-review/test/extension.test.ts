import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import expertReview, {
	FOLLOW_UP_PROMPT,
	REVIEW_PROMPT,
	buildReviewPrompt,
	getAdvisorConfiguredThinking,
	getExpertReviewCompletions,
	parseExpertReviewArgs,
	resolveReviewThinkingLevel,
} from "../src/index";

interface FakeCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: unknown) => void | Promise<void>;
}

interface Snapshot {
	model: unknown;
	thinking: string | undefined;
	tools: string[];
}

interface FakePi {
	pi: ExtensionAPI;
	commands: Map<string, FakeCommand>;
	handlers: Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>;
	messages: string[];
	snapshotsAtSend: Snapshot[];
	notifications: Array<{ message: string; type?: string }>;
	originalModel: unknown;
	selectedModel: unknown;
	thinking: string | undefined;
	activeTools: string[];
	failNextSetActiveTools: boolean;
	failRestoreModel: boolean;
	failRestoreTools: boolean;
	resolveReviewer: boolean;
	advisorRoleValue: string | undefined;
	waitForIdleImpl: (() => Promise<void>) | undefined;
}

function makeFakePi(): FakePi {
	const commands = new Map<string, FakeCommand>();
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const originalModel = { provider: "test", id: "normal" };
	const fake: FakePi = {
		pi: undefined as unknown as ExtensionAPI,
		commands,
		handlers,
		messages: [],
		snapshotsAtSend: [],
		notifications: [],
		originalModel,
		selectedModel: originalModel,
		thinking: "medium",
		activeTools: ["task", "bash", "read", "grep", "glob", "write", "edit"],
		failNextSetActiveTools: false,
		failRestoreModel: false,
		failRestoreTools: false,
		resolveReviewer: true,
		advisorRoleValue: "openai-codex/gpt-6-astra:xhigh",
		waitForIdleImpl: undefined,
	};

	fake.pi = {
		registerCommand: (name: string, command: FakeCommand) => commands.set(name, command),
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getActiveTools: () => fake.activeTools,
		setActiveTools: async (tools: string[]) => {
			if (fake.failNextSetActiveTools) {
				fake.failNextSetActiveTools = false;
				throw new Error("tool switch failed");
			}
			if (fake.failRestoreTools && tools.includes("task")) {
				fake.failRestoreTools = false;
				throw new Error("restore tools failed");
			}
			fake.activeTools = [...tools];
		},
		setModel: async (model: unknown) => {
			if (fake.failRestoreModel && model === fake.originalModel) {
				return false;
			}
			fake.selectedModel = model;
			return true;
		},
		getThinkingLevel: () => fake.thinking,
		setThinkingLevel: (level: unknown) => {
			fake.thinking = typeof level === "string" ? level : undefined;
		},
		sendUserMessage: (content: string | unknown[]) => {
			if (typeof content !== "string") throw new Error("expected string prompt");
			fake.snapshotsAtSend.push({
				model: fake.selectedModel,
				thinking: fake.thinking,
				tools: [...fake.activeTools],
			});
			fake.messages.push(content);
		},
		logger: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
		pi: {
			settings: {
				getModelRole: (role: string) => (role === "advisor" ? fake.advisorRoleValue : undefined),
			},
		},
	} as unknown as ExtensionAPI;
	return fake;
}
const ADVISOR_THINKING_SUFFIXES: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
	inherit: true,
	auto: true,
};

function advisorBaseModel(roleValue: string | undefined): { provider: string; id: string } | undefined {
	if (!roleValue) return undefined;
	const trimmed = roleValue.trim();
	if (!trimmed) return undefined;
	let base = trimmed;
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0 && ADVISOR_THINKING_SUFFIXES[trimmed.slice(colon + 1).toLowerCase()] === true) {
		base = trimmed.slice(0, colon);
	}
	const slash = base.indexOf("/");
	if (slash <= 0) return undefined;
	return { provider: base.slice(0, slash), id: base.slice(slash + 1) };
}

function expectedReviewerModel(fake: FakePi): { provider: string; id: string } | undefined {
	if (!fake.resolveReviewer) return undefined;
	return advisorBaseModel(fake.advisorRoleValue);
}

function commandContext(fake: FakePi): Record<string, unknown> {
	return {
		waitForIdle: fake.waitForIdleImpl ?? (async () => {}),
		models: {
			current: () => fake.selectedModel,
			resolve: (spec: string) => (spec === "@advisor" ? expectedReviewerModel(fake) : undefined),
		},
		ui: {
			notify: (message: string, type?: string) => fake.notifications.push({ message, type }),
		},
	};
}

async function runCommand(fake: FakePi, args = ""): Promise<void> {
	const command = fake.commands.get("expert-review");
	if (!command) throw new Error("expert-review command was not registered");
	await command.handler(args, commandContext(fake));
}

async function emit(fake: FakePi, eventName: string, event: unknown = {}): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of fake.handlers.get(eventName) ?? []) results.push(await handler(event, commandContext(fake)));
	return results;
}

describe("expert-review", () => {
	test("default sends the reviewer prompt once on advisor/advisor-thinking/safe tools", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);

		await runCommand(fake, "特に rollback 条件を確認");

		expect(fake.selectedModel).toEqual(expectedReviewerModel(fake));
		expect(fake.thinking).toBe("xhigh");
		expect(fake.activeTools).toEqual(["read", "grep", "glob"]);
		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0]).toContain("サブエージェント、Task、作業委譲、オーケストレーションを使わず");
		expect(fake.messages[0]).toContain("特に rollback 条件を確認");
	});

	test("terminal reviewer agent_end restores first, then sends the follow-up exactly once", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);
		const originalTools = [...fake.activeTools];

		await runCommand(fake, "focus text");
		await emit(fake, "agent_end", { type: "agent_end", messages: [] });

		expect(fake.messages).toHaveLength(2);
		expect(fake.messages[1]).toBe(FOLLOW_UP_PROMPT);
		// The follow-up turn must already run on the restored original state.
		expect(fake.snapshotsAtSend[1]?.model).toBe(fake.originalModel);
		expect(fake.snapshotsAtSend[1]?.thinking).toBe("medium");
		expect(fake.snapshotsAtSend[1]?.tools).toEqual(originalTools);
		expect(fake.selectedModel).toBe(fake.originalModel);
		expect(fake.thinking).toBe("medium");
		expect(fake.activeTools).toEqual(originalTools);
	});

	test("follow-up agent_end settles without sending again and frees the command", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);

		await runCommand(fake);
		await emit(fake, "agent_end", { type: "agent_end", messages: [] });
		expect(fake.messages).toHaveLength(2);

		await emit(fake, "agent_end", { type: "agent_end", messages: [] });
		expect(fake.messages).toHaveLength(2);

		await runCommand(fake, "next");
		expect(fake.messages).toHaveLength(3);
		expect(fake.messages[2]).toContain("敵対レビュアー");
	});

	test("--review-only restores and stops without a follow-up", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);
		const originalTools = [...fake.activeTools];

		await runCommand(fake, "--review-only rollback 条件を確認");

		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0]).toContain("rollback 条件を確認");
		expect(fake.messages[0]).not.toContain("--review-only");

		await emit(fake, "agent_end", { type: "agent_end", messages: [] });

		expect(fake.selectedModel).toBe(fake.originalModel);
		expect(fake.thinking).toBe("medium");
		expect(fake.activeTools).toEqual(originalTools);
		expect(fake.messages).toHaveLength(1);
	});

	test("parse keeps free-text focus while stripping --review-only anywhere", () => {
		expect(parseExpertReviewArgs("")).toEqual({ reviewOnly: false, focus: "" });
		expect(parseExpertReviewArgs("rollback を確認")).toEqual({ reviewOnly: false, focus: "rollback を確認" });
		expect(parseExpertReviewArgs("--review-only")).toEqual({ reviewOnly: true, focus: "" });
		expect(parseExpertReviewArgs("--review-only rollback を確認")).toEqual({
			reviewOnly: true,
			focus: "rollback を確認",
		});
		expect(parseExpertReviewArgs("rollback --review-only 確認")).toEqual({
			reviewOnly: true,
			focus: "rollback 確認",
		});
		expect(parseExpertReviewArgs("rollback 確認 --review-only")).toEqual({
			reviewOnly: true,
			focus: "rollback 確認",
		});
	});

	test("completion suggests --review-only once without polluting focus text", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);
		const completions = fake.commands.get("expert-review")?.getArgumentCompletions as (
			prefix: string,
		) => Array<{ value: string; label: string }> | null;

		expect(typeof completions).toBe("function");
		expect(completions("")?.[0]?.value).toContain("--review-only");
		expect(completions("--rev")?.[0]?.value).toContain("--review-only");
		expect(completions("rollback --rev")?.[0]?.value).toBe("rollback --review-only ");
		expect(completions("--review-only")).toBeNull();
		expect(completions("rollback --review-only")).toBeNull();
		expect(completions("rollback 条件")).toBeNull();
		expect(getExpertReviewCompletions("--unknown")).toBeNull();
	});

	test("blocks any non-review tool only while the reviewer is active", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);
		await runCommand(fake);

		const blocked = (await emit(fake, "tool_call", { toolName: "task" })).at(-1) as {
			block: boolean;
			reason: string;
		};
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain("read-only");
		expect((await emit(fake, "tool_call", { toolName: "read" })).at(-1)).toBeUndefined();

		await emit(fake, "agent_end", { type: "agent_end", messages: [] });
		expect((await emit(fake, "tool_call", { toolName: "task" })).at(-1)).toBeUndefined();

		await emit(fake, "agent_end", { type: "agent_end", messages: [] });
		expect((await emit(fake, "tool_call", { toolName: "task" })).at(-1)).toBeUndefined();
	});

	test("restores immediately when activation fails after model selection", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);
		const originalTools = [...fake.activeTools];
		fake.failNextSetActiveTools = true;

		await runCommand(fake);

		expect(fake.selectedModel).toBe(fake.originalModel);
		expect(fake.thinking).toBe("medium");
		expect(fake.activeTools).toEqual(originalTools);
		expect(fake.messages).toEqual([]);
		expect(fake.notifications.at(-1)?.type).toBe("error");

		await emit(fake, "agent_end", { type: "agent_end", messages: [] });
		expect(fake.messages).toEqual([]);
	});

	test("fails closed before changing state when advisor role cannot resolve", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);
		fake.resolveReviewer = false;
		const originalTools = [...fake.activeTools];

		await runCommand(fake);

		expect(fake.selectedModel).toBe(fake.originalModel);
		expect(fake.thinking).toBe("medium");
		expect(fake.activeTools).toEqual(originalTools);
		expect(fake.messages).toEqual([]);
		expect(fake.notifications.at(-1)?.message).toContain("modelRoles.advisor");
	});

	test("restore failure skips the follow-up instead of starting a degraded turn", async () => {
		const modelFailure = makeFakePi();
		expertReview(modelFailure.pi);
		modelFailure.failRestoreModel = true;
		await runCommand(modelFailure);
		await emit(modelFailure, "agent_end", { type: "agent_end", messages: [] });
		expect(modelFailure.messages).toHaveLength(1);
		expect(modelFailure.notifications.at(-1)?.type).toBe("error");

		const toolFailure = makeFakePi();
		expertReview(toolFailure.pi);
		toolFailure.failRestoreTools = true;
		await runCommand(toolFailure);
		await emit(toolFailure, "agent_end", { type: "agent_end", messages: [] });
		expect(toolFailure.messages).toHaveLength(1);
		expect(toolFailure.notifications.at(-1)?.type).toBe("error");
	});

	test("session transitions restore without starting a follow-up", async () => {
		for (const eventName of [
			"session_before_switch",
			"session_before_branch",
			"session_before_tree",
			"session_shutdown",
		] as const) {
			const fake = makeFakePi();
			expertReview(fake.pi);
			const originalTools = [...fake.activeTools];
			await runCommand(fake);

			await emit(fake, eventName, { type: eventName });

			expect(fake.selectedModel).toBe(fake.originalModel);
			expect(fake.thinking).toBe("medium");
			expect(fake.activeTools).toEqual(originalTools);
			expect(fake.messages).toHaveLength(1);

			await emit(fake, "agent_end", { type: "agent_end", messages: [] });
			expect(fake.messages).toHaveLength(1);
		}
	});

	test("stays in review mode across a scheduled continuation until the terminal settle", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);
		const originalTools = [...fake.activeTools];
		await runCommand(fake);

		await emit(fake, "agent_end", { type: "agent_end", messages: [], willContinue: true });

		expect(fake.selectedModel).toEqual(expectedReviewerModel(fake));
		expect(fake.thinking).toBe("xhigh");
		expect(fake.activeTools).toEqual(["read", "grep", "glob"]);
		expect(fake.messages).toHaveLength(1);

		await emit(fake, "agent_end", { type: "agent_end", messages: [] });

		expect(fake.selectedModel).toBe(fake.originalModel);
		expect(fake.thinking).toBe("medium");
		expect(fake.activeTools).toEqual(originalTools);
		expect(fake.messages).toHaveLength(2);
		expect(fake.messages[1]).toBe(FOLLOW_UP_PROMPT);
	});

	test("a second invocation during activation bails instead of overwriting the snapshot", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);
		let releaseIdle!: () => void;
		const idleGate = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		fake.waitForIdleImpl = () => idleGate;

		const first = runCommand(fake, "first focus");
		const second = runCommand(fake, "second focus");
		releaseIdle();
		await Promise.all([first, second]);

		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0]).toContain("first focus");
		expect(fake.notifications.filter((n) => n.type === "warning")).toHaveLength(1);
		expect(fake.selectedModel).toEqual(expectedReviewerModel(fake));

		await emit(fake, "agent_end", { type: "agent_end", messages: [] });
		expect(fake.selectedModel).toBe(fake.originalModel);
		expect(fake.thinking).toBe("medium");
		expect(fake.messages).toHaveLength(2);
	});

	test("a second invocation during the follow-up turn bails without breaking the flow", async () => {
		const fake = makeFakePi();
		expertReview(fake.pi);
		await runCommand(fake);
		await emit(fake, "agent_end", { type: "agent_end", messages: [] });
		expect(fake.messages).toHaveLength(2);

		await runCommand(fake, "interrupting focus");
		expect(fake.messages).toHaveLength(2);
		expect(fake.notifications.filter((n) => n.type === "warning").length).toBeGreaterThan(0);

		await emit(fake, "agent_end", { type: "agent_end", messages: [] });
		expect(fake.messages).toHaveLength(2);
	});
	test("uses the advisor-configured thinking level for the review turn", async () => {
		const fake = makeFakePi();
		fake.advisorRoleValue = "openai-codex/gpt-6-astra:high";
		expertReview(fake.pi);

		await runCommand(fake);

		expect(fake.selectedModel).toEqual(expectedReviewerModel(fake));
		expect(fake.thinking).toBe("high");
	});

	test("keeps the current thinking when the advisor has no explicit level", async () => {
		const fake = makeFakePi();
		fake.advisorRoleValue = "openai-codex/gpt-6-astra";
		expertReview(fake.pi);

		await runCommand(fake);

		expect(fake.selectedModel).toEqual(expectedReviewerModel(fake));
		expect(fake.thinking).toBe("medium");
	});

	test("keeps the current thinking when the advisor is auto or inherit", async () => {
		for (const advisorRoleValue of ["openai-codex/gpt-6-astra:auto", "openai-codex/gpt-6-astra:inherit"]) {
			const fake = makeFakePi();
			fake.advisorRoleValue = advisorRoleValue;
			expertReview(fake.pi);

			await runCommand(fake);

			expect(fake.selectedModel).toEqual(expectedReviewerModel(fake));
			expect(fake.thinking).toBe("medium");
		}
	});

	test("resolves thinking after a colon in the model id", async () => {
		const fake = makeFakePi();
		fake.advisorRoleValue = "openrouter/liquid/lfm-2.5-2.6b:free:high";
		expertReview(fake.pi);

		await runCommand(fake);

		expect(fake.selectedModel).toEqual(expectedReviewerModel(fake));
		expect(fake.thinking).toBe("high");
	});
	test("resolveReviewThinkingLevel keeps concrete levels and skips auto/inherit/unset", () => {
		expect(resolveReviewThinkingLevel(ThinkingLevel.Low)).toBe(ThinkingLevel.Low);
		expect(resolveReviewThinkingLevel(ThinkingLevel.XHigh)).toBe(ThinkingLevel.XHigh);
		expect(resolveReviewThinkingLevel(ThinkingLevel.Max)).toBe(ThinkingLevel.Max);
		expect(resolveReviewThinkingLevel(ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
		expect(resolveReviewThinkingLevel(undefined)).toBeUndefined();
		expect(resolveReviewThinkingLevel("auto")).toBeUndefined();
		expect(resolveReviewThinkingLevel(ThinkingLevel.Inherit)).toBeUndefined();
	});

	test("getAdvisorConfiguredThinking reads the advisor role without throwing on missing settings", () => {
		const fake = makeFakePi();
		expect(getAdvisorConfiguredThinking(fake.pi)).toBe(ThinkingLevel.XHigh);

		fake.advisorRoleValue = undefined;
		expect(getAdvisorConfiguredThinking(fake.pi)).toBeUndefined();

		const withoutSettings = { ...fake.pi, pi: undefined } as unknown as ExtensionAPI;
		expect(getAdvisorConfiguredThinking(withoutSettings)).toBeUndefined();
	});

	test("review prompt keeps the査定可能な指摘 contract without over-pinning wording", () => {
		expect(REVIEW_PROMPT).toContain("独立したread-only敵対レビュアー");
		expect(REVIEW_PROMPT).toContain("現在のユーザー要件・repo正本");
		expect(REVIEW_PROMPT).toContain("具体的な破綻条件または根拠のある指摘");
		expect(REVIEW_PROMPT).toContain("念のため");
		expect(REVIEW_PROMPT).toContain("事実として断定せず");
		expect(REVIEW_PROMPT).toContain("好みの設計差を欠陥扱いしない");
		expect(REVIEW_PROMPT).toContain("重大度");
		expect(REVIEW_PROMPT).toContain("重大な懸念なし");
		expect(REVIEW_PROMPT).toContain("サブエージェント、Task");
		expect(REVIEW_PROMPT).toContain("書き込み、編集、実装、コミット、設定変更は行わず");
		expect(buildReviewPrompt("  ").trim()).toBe(REVIEW_PROMPT.trim());
	});

	test("follow-up prompt keeps independent adjudication without unconditional apply", () => {
		expect(FOLLOW_UP_PROMPT).toContain("独立に査定");
		expect(FOLLOW_UP_PROMPT).toContain("鵜呑みにせず");
		expect(FOLLOW_UP_PROMPT).toContain("成立する指摘だけ採用");
		expect(FOLLOW_UP_PROMPT).toContain("最小変更");
		expect(FOLLOW_UP_PROMPT).toContain("必要な検証");
		expect(FOLLOW_UP_PROMPT).toContain("変更を作らない");
		expect(FOLLOW_UP_PROMPT).toContain("/expert-review を再帰的に実行しない");
	});
});
