import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import nousPortalProvider, { loginNousPortal, refreshNousPortalCredentials } from "../src/index.ts";

function unsetNousApiKey(): void {
	Reflect.deleteProperty(process.env, "NOUS_API_KEY");
}

test("OMP native provider API に OAuth provider を登録する", () => {
	const previous = process.env.NOUS_API_KEY;
	unsetNousApiKey();
	let id: string | undefined;
	let config: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
	const pi = {
		registerProvider(providerId: string, providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1]) {
			id = providerId;
			config = providerConfig;
		},
	} as unknown as ExtensionAPI;

	try {
		nousPortalProvider(pi);
	} finally {
		if (previous === undefined) unsetNousApiKey();
		else process.env.NOUS_API_KEY = previous;
	}

	expect(id).toBe("nous-portal");
	expect(config?.oauth?.name).toBe("Nous Portal");
	expect(config?.oauth?.login).toBe(loginNousPortal);
	expect(config?.oauth?.refreshToken).toBe(refreshNousPortalCredentials);
	expect(config?.oauth?.getApiKey?.({ access: "invoke-jwt", refresh: "refresh", expires: Date.now() + 60_000 })).toBe(
		"invoke-jwt",
	);
	expect(config?.fetchDynamicModels).toBeFunction();
	expect(config?.apiKey).toBeUndefined();
});

test("NOUS_API_KEY がある場合だけ direct key fallback を登録する", () => {
	const previous = process.env.NOUS_API_KEY;
	process.env.NOUS_API_KEY = "sk-nous-test";
	let config: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
	const pi = {
		registerProvider(_providerId: string, providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1]) {
			config = providerConfig;
		},
	} as unknown as ExtensionAPI;

	try {
		nousPortalProvider(pi);
	} finally {
		if (previous === undefined) unsetNousApiKey();
		else process.env.NOUS_API_KEY = previous;
	}

	expect(config?.apiKey).toBe("NOUS_API_KEY");
});
