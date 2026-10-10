import { describe, expect, test } from "bun:test";
import { constants, accessSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

interface Catalog {
	name: string;
	owner: { name: string };
	metadata?: { description?: string; version?: string; pluginRoot?: string };
	plugins: Array<{ name: string; version: string; source: string }>;
}

interface PluginPackage {
	name: string;
	version: string;
	omp?: { extensions?: string[] };
	pi?: { extensions?: string[] };
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseVersion(output: string): [number, number, number] | undefined {
	const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/u);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function versionAtLeast(actual: [number, number, number], minimum: [number, number, number]): boolean {
	for (let index = 0; index < minimum.length; index++) {
		const actualPart = actual[index] ?? -1;
		const minimumPart = minimum[index] ?? -1;
		if (actualPart !== minimumPart) return actualPart > minimumPart;
	}
	return true;
}

function readOmpVersion(omp: string | null): [number, number, number] | undefined {
	if (!omp) return undefined;
	const result = Bun.spawnSync([omp, "--version"], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) return undefined;
	return parseVersion(`${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`);
}

/**
 * `bun run` prepends `node_modules/.bin` to PATH, so the workspace-pinned
 * The workspace-pinned OMP shim can shadow a newer global install. Collect every `omp`
 * on PATH (plus the default Bun install location), dedupe by realpath, and
 * let callers pick the newest one instead of trusting `Bun.which` order.
 */
function listOmpCandidates(): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const push = (path: string) => {
		let real: string;
		try {
			real = realpathSync(path);
		} catch {
			return;
		}
		if (seen.has(real)) return;
		try {
			accessSync(path, constants.X_OK);
		} catch {
			return;
		}
		seen.add(real);
		candidates.push(path);
	};
	const direct = Bun.which("omp");
	if (direct) push(direct);
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir) push(resolve(dir, "omp"));
	}
	if (process.env.HOME) push(resolve(process.env.HOME, ".bun/bin/omp"));
	return candidates;
}

function findNewestOmp(): { path: string; version: [number, number, number] } | null {
	let best: { path: string; version: [number, number, number] } | null = null;
	for (const candidate of listOmpCandidates()) {
		const version = readOmpVersion(candidate);
		if (!version) continue;
		if (!best || versionAtLeast(version, best.version)) best = { path: candidate, version };
	}
	return best;
}

describe("marketplace catalog", () => {
	const catalog = readJson<Catalog>(resolve(ROOT, ".omp-plugin/marketplace.json"));

	test("catalog has required fields and installable plugins", () => {
		expect(NAME_RE.test(catalog.name)).toBe(true);
		expect(catalog.owner.name.length).toBeGreaterThan(0);
		expect(Array.isArray(catalog.plugins)).toBe(true);
		expect(catalog.plugins.length).toBeGreaterThan(0);
		for (const plugin of catalog.plugins) {
			expect(NAME_RE.test(plugin.name)).toBe(true);
			expect(plugin.name.length).toBeLessThanOrEqual(64);
			// Relative source path resolves into the repo — each plugin is its
			// own directory, not the repository root.
			expect(plugin.source.startsWith("./plugins/")).toBe(true);
			expect(plugin.source).not.toBe("./");
			const dir = resolve(ROOT, plugin.source);
			expect(existsSync(dir)).toBe(true);
		}
		// Every plugin must have a distinct marketplace name and source directory.
		expect(new Set(catalog.plugins.map((p) => p.name)).size).toBe(catalog.plugins.length);
		expect(new Set(catalog.plugins.map((p) => p.source)).size).toBe(catalog.plugins.length);
	});

	test("plugin packages match the catalog and expose an omp manifest", () => {
		for (const plugin of catalog.plugins) {
			const pkg = readJson<PluginPackage>(resolve(ROOT, plugin.source, "package.json"));
			expect(pkg.name.length).toBeGreaterThan(0);
			expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
			expect(plugin.version).toBe(pkg.version);
			// Legacy pi manifests are no longer accepted; omp is required.
			expect(pkg.omp).toBeDefined();
			const extensions = pkg.omp?.extensions;
			expect(extensions?.length).toBeGreaterThan(0);
			for (const entry of extensions ?? []) {
				expect(entry.startsWith("./")).toBe(true);
				expect(existsSync(resolve(ROOT, plugin.source, entry))).toBe(true);
			}
		}
	});

	test("plugins have README and LICENSE", () => {
		for (const plugin of catalog.plugins) {
			expect(existsSync(resolve(ROOT, plugin.source, "README.md"))).toBe(true);
			expect(existsSync(resolve(ROOT, plugin.source, "LICENSE"))).toBe(true);
		}
	});

	const newestOmp = findNewestOmp();
	const omp = newestOmp?.path ?? null;
	const ompVersion = newestOmp?.version;
	const supportsMarketplaceSmoke = ompVersion !== undefined && versionAtLeast(ompVersion, [18, 2, 6]);
	test.skipIf(!supportsMarketplaceSmoke)(
		"isolated Marketplace install loads all plugins in OMP >=18.2.6",
		async () => {
			if (!omp) return;
			expect(ompVersion).toBeDefined();
			if (!ompVersion) return;
			expect(versionAtLeast(ompVersion, [18, 2, 6])).toBe(true);

			const tempRoot = await mkdtemp(resolve(tmpdir(), "omp-marketplace-smoke-"));
			const tempDirs = [tempRoot];
			try {
				const marketplaceRoot = resolve(tempRoot, "marketplace");
				await mkdir(resolve(marketplaceRoot, ".omp-plugin"), { recursive: true });
				await cp(
					resolve(ROOT, ".omp-plugin", "marketplace.json"),
					resolve(marketplaceRoot, ".omp-plugin", "marketplace.json"),
				);
				for (const plugin of catalog.plugins) {
					const sourceRoot = resolve(ROOT, plugin.source);
					await cp(sourceRoot, resolve(marketplaceRoot, plugin.source), {
						recursive: true,
						filter: (source) => !source.split(sep).includes("node_modules"),
					});
				}

				const home = await mkdtemp(resolve(tmpdir(), "omp-marketplace-home-"));
				tempDirs.push(home);
				const agentDir = await mkdtemp(resolve(tmpdir(), "omp-marketplace-agent-"));
				tempDirs.push(agentDir);
				const configDir = await mkdtemp(resolve(tmpdir(), "omp-marketplace-config-"));
				tempDirs.push(configDir);
				const cacheDir = await mkdtemp(resolve(tmpdir(), "omp-marketplace-cache-"));
				tempDirs.push(cacheDir);
				const profile = `issue-74-smoke-${process.pid}`;
				const env = {
					...process.env,
					HOME: home,
					PI_CODING_AGENT_DIR: agentDir,
					XDG_CONFIG_HOME: configDir,
					XDG_CACHE_HOME: cacheDir,
				};
				const run = (args: string[]) => {
					const result = Bun.spawnSync([omp, "--profile", profile, ...args], {
						cwd: tempRoot,
						env,
						stdout: "pipe",
						stderr: "pipe",
					});
					const decode = (value: Uint8Array | undefined) => (value ? new TextDecoder().decode(value) : "");
					return { exitCode: result.exitCode, output: `${decode(result.stdout)}${decode(result.stderr)}` };
				};

				expect(run(["plugin", "marketplace", "add", marketplaceRoot]).exitCode).toBe(0);
				for (const plugin of catalog.plugins) {
					const installed = run(["plugin", "install", "--force", `${plugin.name}@omp-extensions`]);
					expect(installed.exitCode).toBe(0);
					expect(installed.output).toContain(`Installed ${plugin.name}`);
				}

				const profileRoot = resolve(home, ".omp", "profiles", profile);
				for (const plugin of catalog.plugins) {
					const pkg = readJson<PluginPackage>(resolve(ROOT, plugin.source, "package.json"));
					const cachePluginRoot = resolve(
						profileRoot,
						"plugins",
						"cache",
						"plugins",
						`omp-extensions___${plugin.name}___${plugin.version}`,
					);
					expect(existsSync(resolve(cachePluginRoot, "node_modules"))).toBe(false);
					expect(existsSync(resolve(profileRoot, "plugins", "node_modules", pkg.name))).toBe(true);
				}

				const listed = run(["plugin", "list", "--json"]);
				expect(listed.exitCode).toBe(0);
				for (const plugin of catalog.plugins) {
					expect(listed.output).toContain(plugin.name);
				}

				const startup = run(["--no-session", "--no-title", "--no-tools", "-p", "smoke"]);
				expect(startup.output).not.toMatch(/Failed to load extension|Cannot find package/u);
				expect(startup.output).toMatch(/No models available|No default model selected/u);
				expect(startup.exitCode).toBe(1);
			} finally {
				await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
			}
		},
		60_000,
	);
});
