import { expect, test } from "bun:test";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { type NousOAuthCredentials, loginNousPortal, refreshNousPortalCredentials } from "../src/auth.ts";

function invokeJwt(exp: number): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ scope: "inference:invoke", exp })).toString("base64url");
	return `${header}.${payload}.sig`;
}

test("Device OAuth を /login 用 callback へ提示して credentials を返す", async () => {
	const now = 1_800_000_000_000;
	const access = invokeJwt(Math.floor(now / 1000) + 3600);
	const authUrls: string[] = [];
	const calls: string[] = [];
	const fetchFn = async (input: string | URL): Promise<Response> => {
		calls.push(String(input));
		if (String(input).endsWith("/api/oauth/device/code")) {
			return Response.json({
				device_code: "device-code",
				user_code: "ABCD-EFGH",
				verification_uri: "https://portal.example.test/device",
				verification_uri_complete: "https://portal.example.test/device?code=ABCD-EFGH",
				expires_in: 600,
				interval: 1,
			});
		}
		return Response.json({
			access_token: access,
			refresh_token: "refresh-token",
			expires_in: 3600,
			scope: "inference:invoke",
			token_type: "Bearer",
		});
	};
	const callbacks = {
		fetch: fetchFn,
		onAuth: ({ url }: { url: string }) => authUrls.push(url),
	} as unknown as OAuthLoginCallbacks;

	const credentials = await loginNousPortal(callbacks, {
		fetchFn,
		now: () => now,
		portalBaseUrl: "https://portal.example.test",
		sleepFn: async () => {},
	});

	expect(calls).toEqual([
		"https://portal.example.test/api/oauth/device/code",
		"https://portal.example.test/api/oauth/token",
	]);
	expect(authUrls).toEqual(["https://portal.example.test/device?code=ABCD-EFGH"]);
	expect(credentials.access).toBe(access);
	expect(credentials.refresh).toBe("refresh-token");
	expect(credentials.expires).toBe((Math.floor(now / 1000) + 3600) * 1000 - 120_000);
});

test("refresh token を body と x-nous-refresh-token に載せ、rotation を反映する", async () => {
	const now = 1_800_000_000_000;
	const access = invokeJwt(Math.floor(now / 1000) + 3600);
	const refreshHeaders: Array<string | null> = [];
	const refreshBodies: string[] = [];
	const current: NousOAuthCredentials = {
		access: "old-access",
		refresh: "refresh-token",
		expires: now - 1,
		portalBaseUrl: "https://portal.example.test",
		clientId: "hermes-cli",
		scope: "inference:invoke",
	};
	const credentials = await refreshNousPortalCredentials(current, {
		now: () => now,
		fetchFn: async (_input, init) => {
			refreshHeaders.push(new Headers(init?.headers).get("x-nous-refresh-token"));
			refreshBodies.push(String(init?.body ?? ""));
			return Response.json({
				access_token: access,
				refresh_token: "rotated-refresh-token",
				expires_in: 3600,
				scope: "inference:invoke",
			});
		},
	});

	expect(refreshHeaders).toEqual(["refresh-token"]);
	expect(refreshBodies).toEqual(["grant_type=refresh_token&client_id=hermes-cli&refresh_token=refresh-token"]);
	expect(credentials.access).toBe(access);
	expect(credentials.refresh).toBe("rotated-refresh-token");
});

test("Device OAuth の不正 interval は 5 秒へフォールバックする", async () => {
	const now = 1_800_000_000_000;
	const access = invokeJwt(Math.floor(now / 1000) + 3600);
	let tokenPolls = 0;
	const sleeps: number[] = [];
	const fetchFn = async (input: string | URL): Promise<Response> => {
		if (String(input).endsWith("/api/oauth/device/code")) {
			return Response.json({
				device_code: "device-code",
				user_code: "ABCD-EFGH",
				verification_uri: "https://portal.example.test/device",
				verification_uri_complete: "https://portal.example.test/device?code=ABCD-EFGH",
				expires_in: 600,
				interval: "invalid",
			});
		}
		tokenPolls += 1;
		if (tokenPolls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
		return Response.json({ access_token: access, refresh_token: "refresh-token", scope: "inference:invoke" });
	};
	const callbacks = { fetch: fetchFn, onAuth: () => {} } as unknown as OAuthLoginCallbacks;
	await loginNousPortal(callbacks, {
		fetchFn,
		now: () => now,
		portalBaseUrl: "https://portal.example.test",
		sleepFn: async (ms) => {
			sleeps.push(ms);
		},
	});
	expect(sleeps).toEqual([5_000]);
});

test("明示された OAuth scope に inference:invoke がなければ拒否する", async () => {
	const now = 1_800_000_000_000;
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ scope: "inference:mint_agent_key", exp: Math.floor(now / 1000) + 3600 }),
	).toString("base64url");
	const wrongAccess = `${header}.${payload}.sig`;
	const fetchFn = async (input: string | URL): Promise<Response> => {
		if (String(input).endsWith("/api/oauth/device/code")) {
			return Response.json({
				device_code: "device-code",
				user_code: "ABCD-EFGH",
				verification_uri: "https://portal.example.test/device",
				verification_uri_complete: "https://portal.example.test/device?code=ABCD-EFGH",
				expires_in: 600,
				interval: 1,
			});
		}
		return Response.json({
			access_token: wrongAccess,
			refresh_token: "refresh-token",
			scope: "inference:mint_agent_key",
		});
	};
	const callbacks = { fetch: fetchFn, onAuth: () => {} } as unknown as OAuthLoginCallbacks;
	expect(
		loginNousPortal(callbacks, {
			fetchFn,
			now: () => now,
			portalBaseUrl: "https://portal.example.test",
			sleepFn: async () => {},
		}),
	).rejects.toThrow("inference:invoke");
});
