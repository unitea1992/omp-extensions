import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import freeModels, {
	getConfirmedFreeSelectors,
	getFreeModelArgumentCompletions,
	parseFreeModelArgs,
} from "../src/index.ts";
import type { AvailabilityReport } from "../src/types.ts";

test("free-model は引数なしを picker として解釈する", () => {
	expect(parseFreeModelArgs("")).toEqual({ status: false });
	expect(parseFreeModelArgs("   ")).toEqual({ status: false });
});

test("free-model status を診断として解釈する", () => {
	expect(parseFreeModelArgs("status")).toEqual({ status: true });
	expect(parseFreeModelArgs("  STATUS  ")).toEqual({ status: true });
});

test("free-model は撤廃した引数を拒否する", () => {
	for (const args of [
		"all",
		"nous",
		"nous-portal",
		"openrouter",
		"zen",
		"opencode-zen",
		"refresh",
		"status all",
		"status openrouter",
	]) {
		expect(() => parseFreeModelArgs(args)).toThrow("Unknown argument");
		expect(() => parseFreeModelArgs(args)).toThrow("Usage: /free-model [status]");
	}
});

test("free-model は初期状態で status のみサジェストする", () => {
	const items = getFreeModelArgumentCompletions("");
	expect(items?.map((item) => item.label)).toEqual(["status"]);
	expect(items?.[0]?.value).toBe("status ");
});

test("free-model は status の入力途中でも status のみサジェストする", () => {
	expect(getFreeModelArgumentCompletions("st")?.map((item) => item.label)).toEqual(["status"]);
	expect(getFreeModelArgumentCompletions("status")?.map((item) => item.label)).toEqual(["status"]);
});

test("free-model は status 確定後や撤廃引数では追加サジェストしない", () => {
	expect(getFreeModelArgumentCompletions("status ")).toBeNull();
	expect(getFreeModelArgumentCompletions("status all ")).toBeNull();
	expect(getFreeModelArgumentCompletions("nous ")).toBeNull();
	expect(getFreeModelArgumentCompletions("all ")).toBeNull();
	expect(getFreeModelArgumentCompletions("wat ")).toBeNull();
});

test("free-model の補完候補に撤廃引数が出ない", () => {
	const labels = getFreeModelArgumentCompletions("")?.map((item) => item.label) ?? [];
	for (const removed of ["all", "nous", "nous-portal", "openrouter", "zen", "opencode-zen"]) {
		expect(labels).not.toContain(removed);
	}
});

test("confirmed-free selector は provider-qualified 形式で confirmed のみ返す", () => {
	const report: AvailabilityReport = {
		providers: [
			{
				providerId: "nous-portal",
				providerLabel: "Nous Portal",
				warnings: [],
				rows: [
					{
						providerId: "nous-portal",
						providerLabel: "Nous Portal",
						modelId: "vendor/ok:free",
						status: "confirmed",
						reason: "ok",
					},
					{
						providerId: "nous-portal",
						providerLabel: "Nous Portal",
						modelId: "vendor/stale:free",
						status: "stale",
						reason: "stale",
					},
				],
			},
		],
	};

	expect(getConfirmedFreeSelectors(report)).toEqual(["nous-portal/vendor/ok:free"]);
});

test("status は session message を作らず UI-only で全 provider を表示する", async () => {
	type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
	type CommandContext = Parameters<Command["handler"]>[1];
	let command: Command | undefined;
	const sentMessages: unknown[] = [];
	const notifications: string[] = [];
	const pi = {
		registerCommand: (_name: string, definition: Command) => {
			command = definition;
		},
		sendMessage: (...args: unknown[]) => {
			sentMessages.push(args);
		},
	} as unknown as ExtensionAPI;
	freeModels(pi);

	const originalFetch = globalThis.fetch;
	const emptyCatalog = () =>
		({
			ok: true,
			headers: { get: () => null },
			arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ data: [] })).buffer,
		}) as unknown as Response;
	globalThis.fetch = (async () => emptyCatalog()) as unknown as typeof fetch;
	try {
		const ctx = {
			models: { list: () => [], current: () => undefined },
			ui: {
				notify: (message: string) => notifications.push(message),
				setWorkingMessage: () => {},
			},
		} as unknown as CommandContext;
		await command?.handler("status", ctx);
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(sentMessages).toHaveLength(0);
	expect(notifications).toHaveLength(1);
	expect(notifications[0]).toContain("Free model status");
	expect(notifications[0]).toContain("Nous Portal");
	expect(notifications[0]).toContain("OpenRouter");
	expect(notifications[0]).toContain("OpenCode Zen");
});
