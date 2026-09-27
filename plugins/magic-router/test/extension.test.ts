import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { highlightMagicKeywords, setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";
import magicRouter from "../src/index";

interface FakeCommand {
	handler: (args: string, ctx: ExtensionContext) => unknown;
}

interface FakePi {
	pi: ExtensionAPI;
	handlers: Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>;
	commands: Map<string, FakeCommand>;
	debugLines: string[];
	throwOnDebug: boolean;
	messages: Array<unknown>;
}

interface FakeContext {
	ctx: ExtensionContext;
	statusCalls: Array<[string, string | undefined]>;
	notifyCalls: Array<{ message: string; type: string | undefined }>;
	throwOnStatus: boolean;
}

function latestStatus(context: FakeContext): string | undefined {
	return context.statusCalls.at(-1)?.[1];
}

function gradientStatus(keywords: string): string {
	return `Magic Router: ${highlightMagicKeywords(keywords)}`;
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const commands = new Map<string, FakeCommand>();
	const debugLines: string[] = [];
	const messages: Array<unknown> = [];
	const fake: FakePi = {
		pi: undefined as unknown as ExtensionAPI,
		handlers,
		commands,
		debugLines,
		throwOnDebug: false,
		messages,
	};
	fake.pi = {
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, command: FakeCommand) => {
			commands.set(name, command);
		},
		sendMessage: (message: unknown) => {
			messages.push(message);
		},
		sendUserMessage: (message: unknown) => {
			messages.push(message);
		},
		logger: {
			debug: (message: unknown) => {
				if (fake.throwOnDebug) throw new Error("logger unavailable");
				debugLines.push(String(message));
			},
			warn: () => {},
			info: () => {},
			error: () => {},
		},
	} as unknown as ExtensionAPI;
	return fake;
}

function makeContext(artifactsDir?: string, sessionId = "test-session"): FakeContext {
	const statusCalls: Array<[string, string | undefined]> = [];
	const notifyCalls: Array<{ message: string; type: string | undefined }> = [];
	const fakeContext: FakeContext = {
		ctx: {
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					if (fakeContext.throwOnStatus) throw new Error("status unavailable");
					statusCalls.push([key, text]);
				},
				notify: (message: string, type?: string) => notifyCalls.push({ message, type }),
			},
			sessionManager: {
				getSessionId: () => sessionId,
			},
			localProtocolOptions: artifactsDir
				? {
						getArtifactsDir: () => artifactsDir,
						getSessionId: () => sessionId,
					}
				: undefined,
		} as unknown as ExtensionContext,
		statusCalls,
		notifyCalls,
		throwOnStatus: false,
	};
	return fakeContext;
}

async function emitInput(fake: FakePi, context: FakeContext, text: string): Promise<unknown> {
	const handler = fake.handlers.get("input")?.[0];
	if (!handler) throw new Error("input handler not registered");
	return handler({ type: "input", text, source: "interactive" }, context.ctx);
}

async function emit(fake: FakePi, context: FakeContext, event: string): Promise<void> {
	const handler = fake.handlers.get(event)?.[0];
	if (!handler) throw new Error(`${event} handler not registered`);
	await handler({ type: event }, context.ctx);
}

async function emitCommand(fake: FakePi, context: FakeContext, name: string, args = ""): Promise<void> {
	const command = fake.commands.get(name);
	if (!command) throw new Error(`${name} command not registered`);
	await command.handler(args, context.ctx);
}

beforeAll(() => {
	initThemeSync();
	setMagicKeywords(MAGIC_KEYWORDS.map(({ word, hue }) => ({ word, hue })));
});

describe("input hook", () => {
	test("registers command, input and session-context cleanup events, but no turn-end cleanup", () => {
		const fake = makeFakePi();
		magicRouter(fake.pi);
		expect([...fake.commands.keys()]).toEqual(["magic-router"]);
		expect([...fake.handlers.keys()]).toEqual([
			"input",
			"session_before_switch",
			"session_before_branch",
			"session_before_tree",
			"session_switch",
			"session_shutdown",
		]);
		expect(fake.handlers.has("turn_end")).toBe(false);
		expect(fake.handlers.has("agent_end")).toBe(false);
	});

	test("routes Paste inline and renders the status with the native workflowz gradient", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		const prompt = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";
		const result = (await emitInput(fake, context, prompt)) as { text?: string } | undefined;
		expect(result).toEqual({ text: `${prompt}\nworkflowz` });
		expect(fake.debugLines.some((line) => line.includes("delegation=workflowz"))).toBe(true);
		expect(context.statusCalls[0]).toEqual(["magic-router", undefined]);
		expect(latestStatus(context)).toBe(gradientStatus("workflowz"));
	});

	test("routes Attach as a wrapped block while preserving the wrapper in the transport prompt", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		const attachment = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";
		const prompt = `<attachment>\n${attachment}\n</attachment>`;
		const result = (await emitInput(fake, context, prompt)) as { text?: string } | undefined;

		expect(result).toEqual({ text: `${prompt}\nworkflowz` });
		expect(result?.text).toContain(`<attachment>\n${attachment}\n</attachment>`);
		expect(fake.debugLines.at(-1)).toContain("wrapped=1 local=0");
		expect(latestStatus(context)).toBe(gradientStatus("workflowz"));
	});

	test("wrapped attachment text cannot masquerade as a transport-level manual keyword", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		const attachment =
			"workflowz という語も含む。リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";
		const prompt = `<attachment>\n${attachment}\n</attachment>`;
		const result = (await emitInput(fake, context, prompt)) as { text?: string } | undefined;

		expect(result?.text).toBe(`${prompt}\nworkflowz`);
		expect(fake.debugLines.at(-1)).toContain("via=auto");
	});

	test("shows plain none when classifier runs without choosing a keyword", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		const result = await emitInput(fake, context, "typoを修正して");
		expect(result).toBeUndefined();
		expect(latestStatus(context)).toBe("Magic Router: none");
	});

	test("shows plain manual when a native keyword bypasses auto-routing", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		const result = await emitInput(fake, context, "ultrathink この設計を見て");
		expect(result).toBeUndefined();
		expect(latestStatus(context)).toBe("Magic Router: manual");
	});

	test("keeps the previous status through skipped input and replaces it on the next routable turn", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);

		await emitInput(fake, context, "難しいアーキテクチャ判断をして");
		const afterRouted = context.statusCalls.length;
		await emitInput(fake, context, "/review this");
		expect(context.statusCalls.length).toBe(afterRouted);

		await emitInput(fake, context, "typoを修正して");
		expect(latestStatus(context)).toBe("Magic Router: none");
	});

	test("clears stale status when the session context changes", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		await emitInput(fake, context, "難しいアーキテクチャ判断をして");
		await emit(fake, context, "session_before_switch");
		expect(context.statusCalls.at(-1)).toEqual(["magic-router", undefined]);
	});

	test("toggles routing per session and restores the same session state after switching contexts", async () => {
		const fake = makeFakePi();
		const sessionA = makeContext(undefined, "session-a");
		const sessionB = makeContext(undefined, "session-b");
		magicRouter(fake.pi);
		const prompt = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";

		await emitCommand(fake, sessionA, "magic-router");
		expect(latestStatus(sessionA)).toBe("Magic Router: disabled");
		expect(await emitInput(fake, sessionA, prompt)).toBeUndefined();
		expect(latestStatus(sessionA)).toBe("Magic Router: disabled");
		expect(fake.debugLines.at(-1)).toContain("session=session-a disabled");

		const sessionBResult = (await emitInput(fake, sessionB, prompt)) as { text?: string } | undefined;
		expect(sessionBResult?.text).toBe(`${prompt}\nworkflowz`);
		expect(latestStatus(sessionB)).toBe(gradientStatus("workflowz"));

		// Returning to A keeps its session-scoped disabled state.
		expect(await emitInput(fake, sessionA, prompt)).toBeUndefined();
		expect(latestStatus(sessionA)).toBe("Magic Router: disabled");

		await emitCommand(fake, sessionA, "magic-router");
		expect(latestStatus(sessionA)).toBe("Magic Router: enabled");
		const sessionAResult = (await emitInput(fake, sessionA, prompt)) as { text?: string } | undefined;
		expect(sessionAResult?.text).toBe(`${prompt}\nworkflowz`);
		expect(latestStatus(sessionA)).toBe(gradientStatus("workflowz"));
	});
	test("toggle notifies exactly once with session-local info and keeps footer state", async () => {
		const fake = makeFakePi();
		const context = makeContext(undefined, "notify-session");
		magicRouter(fake.pi);
		const prompt = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";

		await emitCommand(fake, context, "magic-router");
		expect(context.notifyCalls).toEqual([{ message: "Magic Router: disabled (this session)", type: "info" }]);
		expect(latestStatus(context)).toBe("Magic Router: disabled");
		expect(fake.messages).toEqual([]);

		// Routing turns while disabled stay silent and keep the disabled footer.
		await emitInput(fake, context, prompt);
		expect(context.notifyCalls.length).toBe(1);
		expect(latestStatus(context)).toBe("Magic Router: disabled");

		await emitCommand(fake, context, "magic-router");
		expect(context.notifyCalls).toEqual([
			{ message: "Magic Router: disabled (this session)", type: "info" },
			{ message: "Magic Router: enabled (this session)", type: "info" },
		]);
		expect(latestStatus(context)).toBe("Magic Router: enabled");
		const result = (await emitInput(fake, context, prompt)) as { text?: string } | undefined;
		expect(result?.text).toBe(`${prompt}\nworkflowz`);
		expect(latestStatus(context)).toBe(gradientStatus("workflowz"));
		expect(context.notifyCalls.length).toBe(2);
		expect(fake.messages).toEqual([]);
	});

	test("toggle state stays session-local for notifications", async () => {
		const fake = makeFakePi();
		const sessionA = makeContext(undefined, "notify-a");
		const sessionB = makeContext(undefined, "notify-b");
		magicRouter(fake.pi);

		await emitCommand(fake, sessionA, "magic-router");
		expect(sessionA.notifyCalls).toEqual([{ message: "Magic Router: disabled (this session)", type: "info" }]);
		expect(sessionB.notifyCalls).toEqual([]);
		expect(fake.messages).toEqual([]);
	});

	test("disabled mode bypasses local attachment inspection and prompt rewriting", async () => {
		const artifactsDir = await mkdtemp(path.join(tmpdir(), "magic-router-"));
		try {
			await mkdir(path.join(artifactsDir, "local"), { recursive: true });
			await writeFile(
				path.join(artifactsDir, "local", "paste-1.md"),
				"リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って",
				"utf8",
			);
			const fake = makeFakePi();
			const context = makeContext(artifactsDir, "disabled-attachment-session");
			magicRouter(fake.pi);
			await emitCommand(fake, context, "magic-router");
			const debugBefore = fake.debugLines.length;

			const result = await emitInput(fake, context, "local://paste-1.md");
			expect(result).toBeUndefined();
			expect(fake.debugLines.length).toBe(debugBefore + 1);
			expect(fake.debugLines.at(-1)).toContain("disabled");
			expect(fake.debugLines.at(-1)).not.toContain("attachments=");
			expect(latestStatus(context)).toBe("Magic Router: disabled");
		} finally {
			await rm(artifactsDir, { recursive: true, force: true });
		}
	});

	test("session shutdown drops the stored toggle state", async () => {
		const fake = makeFakePi();
		const context = makeContext(undefined, "session-to-shutdown");
		magicRouter(fake.pi);
		await emitCommand(fake, context, "magic-router");
		expect(latestStatus(context)).toBe("Magic Router: disabled");
		await emit(fake, context, "session_shutdown");
		expect(context.statusCalls.at(-1)).toEqual(["magic-router", undefined]);

		const prompt = "難しいアーキテクチャ判断をして";
		const result = (await emitInput(fake, context, prompt)) as { text?: string } | undefined;
		expect(result?.text).toBe(`${prompt}\nultrathink`);
	});

	test("routes Attach as local file without reinserting the attachment body", async () => {
		const artifactsDir = await mkdtemp(path.join(tmpdir(), "magic-router-"));
		try {
			await mkdir(path.join(artifactsDir, "local"), { recursive: true });
			const attachment = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";
			await writeFile(path.join(artifactsDir, "local", "paste-1.md"), attachment, "utf8");

			const fake = makeFakePi();
			const context = makeContext(artifactsDir);
			magicRouter(fake.pi);
			const prompt = "この指示に従ってください: local://paste-1.md";
			const result = (await emitInput(fake, context, prompt)) as { text?: string } | undefined;
			expect(result).toEqual({ text: `${prompt}\nworkflowz` });
			expect(result?.text).not.toContain(attachment);
			expect(fake.debugLines.at(-1)).toContain("wrapped=0 local=1");
		} finally {
			await rm(artifactsDir, { recursive: true, force: true });
		}
	});

	test("local attachment text cannot masquerade as a transport-level manual keyword", async () => {
		const artifactsDir = await mkdtemp(path.join(tmpdir(), "magic-router-"));
		try {
			await mkdir(path.join(artifactsDir, "local"), { recursive: true });
			await writeFile(
				path.join(artifactsDir, "local", "paste-1.md"),
				"workflowz という語も含む。リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って",
				"utf8",
			);

			const fake = makeFakePi();
			const context = makeContext(artifactsDir);
			magicRouter(fake.pi);
			const result = (await emitInput(fake, context, "local://paste-1.md")) as { text?: string } | undefined;
			expect(result?.text).toBe("local://paste-1.md\nworkflowz");
			expect(fake.debugLines.at(-1)).toContain("via=auto");
		} finally {
			await rm(artifactsDir, { recursive: true, force: true });
		}
	});

	test("missing local paste fails open to the original prompt", async () => {
		const artifactsDir = await mkdtemp(path.join(tmpdir(), "magic-router-"));
		try {
			const fake = makeFakePi();
			const context = makeContext(artifactsDir);
			magicRouter(fake.pi);
			const result = await emitInput(fake, context, "確認して local://paste-999.md");
			expect(result).toBeUndefined();
			expect(fake.debugLines.at(-1)).toContain("attachments=0");
			expect(latestStatus(context)).toBe("Magic Router: none");
		} finally {
			await rm(artifactsDir, { recursive: true, force: true });
		}
	});

	test("leaves simple, manual, and command inputs unmodified", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		for (const prompt of ["typoを修正して", "ultrathink この設計を見て", "/review this", "!git status", "."]) {
			const result = await emitInput(fake, context, prompt);
			expect(result).toBeUndefined();
		}
	});

	test("logger failure preserves already-computed routing output", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		fake.throwOnDebug = true;
		const prompt = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";
		const result = (await emitInput(fake, context, prompt)) as { text?: string } | undefined;
		expect(result).toEqual({ text: `${prompt}\nworkflowz` });
	});

	test("status failure preserves already-computed routing output", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		context.throwOnStatus = true;
		magicRouter(fake.pi);
		const prompt = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";
		const result = (await emitInput(fake, context, prompt)) as { text?: string } | undefined;
		expect(result).toEqual({ text: `${prompt}\nworkflowz` });
	});

	test("unknown command args warn without mutating toggle state", async () => {
		const fake = makeFakePi();
		const context = makeContext(undefined, "args-session");
		magicRouter(fake.pi);
		const prompt = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";
		await emitCommand(fake, context, "magic-router", "status");
		expect(context.notifyCalls).toHaveLength(1);
		expect(context.notifyCalls[0]?.type).toBe("warning");
		expect(context.notifyCalls[0]?.message).toContain("unknown argument");
		expect(context.statusCalls).toEqual([]);
		const result = (await emitInput(fake, context, prompt)) as { text?: string } | undefined;
		expect(result?.text).toBe(`${prompt}\nworkflowz`);
	});

	test("session resume restores explicit toggle status without stale decisions", async () => {
		const fake = makeFakePi();
		const sessionA = makeContext(undefined, "resume-a");
		magicRouter(fake.pi);
		await emitCommand(fake, sessionA, "magic-router");
		expect(latestStatus(sessionA)).toBe("Magic Router: disabled");
		await emit(fake, sessionA, "session_before_switch");
		expect(sessionA.statusCalls.at(-1)).toEqual(["magic-router", undefined]);
		await emit(fake, sessionA, "session_switch");
		expect(latestStatus(sessionA)).toBe("Magic Router: disabled");
	});

	test("session resume without explicit toggle stays cleared", async () => {
		const fake = makeFakePi();
		const context = makeContext(undefined, "fresh-session");
		magicRouter(fake.pi);
		await emit(fake, context, "session_switch");
		expect(context.statusCalls).toEqual([]);
	});

	test("read-only outer request does not route on source attachment verbs", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		const source = "リポジトリ全体を横断的に調査して計画を立て、実装してテストとレビューまで行って";
		const prompt = `このIssue本文を要約して\n<attachment>\n${source}\n</attachment>`;
		const result = await emitInput(fake, context, prompt);
		expect(result).toBeUndefined();
		expect(latestStatus(context)).toBe("Magic Router: none");
	});

	test("code-fenced pseudo transports are not inspected", async () => {
		const fake = makeFakePi();
		const context = makeContext();
		magicRouter(fake.pi);
		const prompt = "typoを修正して\n```\nlocal://paste-1.md\n```";
		const result = await emitInput(fake, context, prompt);
		expect(result).toBeUndefined();
		expect(fake.debugLines.at(-1)).toContain("attachments=0");
	});
});
