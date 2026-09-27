export const ThinkingLevel = {
	Inherit: "inherit",
	Off: "off",
	Minimal: "minimal",
	Low: "low",
	Medium: "medium",
	High: "high",
	XHigh: "xhigh",
	Max: "max",
} as const;

export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];
export type ConfiguredThinkingLevel = ThinkingLevel | typeof AUTO_THINKING;

export const AUTO_THINKING = "auto" as const;

const THINKING_LEVELS: string[] = Object.values(ThinkingLevel);
const ROLE_PREFIXES = ["@", "pi/"] as const;
const ROLES = new Set(["default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor"]);

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (!value) return undefined;
	if (THINKING_LEVELS.includes(value as ThinkingLevel)) return value as ThinkingLevel;
	if (value.length < 2) return undefined;
	const matches = THINKING_LEVELS.filter((level) => level.startsWith(value));
	return matches.length === 1 ? (matches[0] as ThinkingLevel) : undefined;
}

function splitThinkingSuffix(
	value: string,
	minColonIndex: number,
	allowMaxAndAuto: boolean,
): { base: string; level?: ConfiguredThinkingLevel } {
	const colon = value.lastIndexOf(":");
	if (colon <= minColonIndex) return { base: value };
	const suffix = value.slice(colon + 1);
	const level = parseThinkingLevel(suffix);
	if (level && (level !== ThinkingLevel.Max || allowMaxAndAuto)) return { base: value.slice(0, colon), level };
	if (allowMaxAndAuto && suffix === AUTO_THINKING) return { base: value.slice(0, colon), level: AUTO_THINKING };
	return { base: value };
}

function rolePrefixLength(value: string): number | undefined {
	if (value === "*" || value.startsWith("*:")) return 0;
	return ROLE_PREFIXES.find((prefix) => value.startsWith(prefix))?.length;
}

function expandRoleAlias(value: string, settings?: { getModelRole?: (role: string) => string | undefined }): string {
	const normalized = value.trim();
	if (normalized === "default") return settings?.getModelRole?.("default") ?? value;
	const prefixLength = rolePrefixLength(normalized);
	if (prefixLength === undefined) return value;
	const role = normalized === "*" ? "default" : (normalized.slice(prefixLength).split(":", 1)[0] ?? "");
	if (!ROLES.has(role) && settings?.getModelRole?.(role) === undefined) return value;
	return settings?.getModelRole?.(role) ?? value;
}

export function concreteThinkingLevel(level: ConfiguredThinkingLevel | undefined): ThinkingLevel | undefined {
	return level === AUTO_THINKING ? undefined : level;
}

interface ExplicitThinkingSelectorOptions {
	isLiteralModelId?: (provider: string, id: string) => boolean;
}

function isLiteralModelSelector(value: string, options?: ExplicitThinkingSelectorOptions): boolean {
	const selector = value.slice(0, value.lastIndexOf(":"));
	const slash = selector.indexOf("/");
	return slash > 0 && options?.isLiteralModelId?.(selector.slice(0, slash), selector.slice(slash + 1)) === true;
}

/** Extract only the explicit thinking selector, preserving OMP role expansion semantics. */
export function extractExplicitThinkingSelector(
	value: string | undefined,
	settings?: { getModelRole?: (role: string) => string | undefined },
	options?: ExplicitThinkingSelectorOptions,
): ConfiguredThinkingLevel | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized || normalized === "default") return undefined;

	const visited = new Set<string>();
	let current = normalized;
	while (!visited.has(current)) {
		visited.add(current);
		const rolePrefix = rolePrefixLength(current);
		const strict = splitThinkingSuffix(current, rolePrefix ?? "pi/".length, false).level;
		if (strict) return strict;
		const extended = splitThinkingSuffix(current, rolePrefix ?? "pi/".length, true).level;
		if (extended && (rolePrefix !== undefined || !isLiteralModelSelector(current, options))) return extended;
		const expanded = expandRoleAlias(current, settings).trim();
		if (!expanded || expanded === current) break;
		if (expanded === "default") return undefined;
		current = expanded;
	}
	return undefined;
}
