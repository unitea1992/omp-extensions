import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PLUGINS_DIR = resolve(ROOT, "plugins");

function listSrcFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listSrcFiles(full));
		else if (/\.m?[jt]sx?$/.test(entry)) out.push(full);
	}
	return out;
}

/**
 * Marketplace-installed plugins run from the OMP plugin cache without their
 * own node_modules, and OMP SDK deep subpaths move between releases
 * (e.g. `pi-coding-agent/modes/markdown-prose` and `pi-coding-agent/thinking`
 * vanished in 18.2.x, breaking 0.1.5/0.2.1 at startup). Runtime value imports
 * from the host SDK must therefore never appear in plugin `src/` — only
 * `import type` (erased before module resolution) is allowed. Stable runtime
 * constants belong in a vendored `omp-compat` module pinned by omp-parity
 * tests instead.
 */
function findRuntimeHostImports(source: string): string[] {
	const hits: string[] = [];
	const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
	for (const match of code.matchAll(/(?:^|;|\n)\s*(import|export)\s+([^;]*?)\bfrom\s*["']([^"']+)["']/g)) {
		const kind = match[1] ?? "";
		const clause = (match[2] ?? "").trim();
		const specifier = match[3] ?? "";
		if (!specifier.includes("@oh-my-pi/")) continue;
		if (/^type\b/.test(clause)) continue;
		const named = clause.match(/\{([^}]*)\}/);
		if (named) {
			const bindings = (named[1] ?? "")
				.split(",")
				.map((binding) => binding.trim())
				.filter(Boolean);
			if (bindings.length > 0 && bindings.every((binding) => /^type\b/.test(binding))) continue;
			hits.push(`${kind} { ${(named[1] ?? "").trim()} } from "${specifier}"`);
			continue;
		}
		hits.push(`${kind} ${clause} from "${specifier}"`);
	}
	for (const match of code.matchAll(/(?:import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)) {
		const specifier = match[1] ?? "";
		if (specifier.includes("@oh-my-pi/")) hits.push(`dynamic import of "${specifier}"`);
	}
	return hits;
}

describe("extension runtime imports", () => {
	test("plugin src/ has no runtime value imports from the OMP host SDK", () => {
		const violations: string[] = [];
		for (const plugin of readdirSync(PLUGINS_DIR).sort()) {
			const srcDir = join(PLUGINS_DIR, plugin, "src");
			let files: string[] = [];
			try {
				files = listSrcFiles(srcDir);
			} catch {
				continue;
			}
			for (const file of files) {
				const hits = findRuntimeHostImports(readFileSync(file, "utf8"));
				for (const hit of hits) {
					violations.push(`${file.replace(`${ROOT}/`, "")}: ${hit}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
