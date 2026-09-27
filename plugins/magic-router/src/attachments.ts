import { readFile, stat } from "node:fs/promises";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { maskNonProse, resolveLocalUrlToPath } from "./omp-compat";

const LOCAL_PASTE_REFERENCE_RE = /\blocal:\/\/paste-\d+\.md\b/g;
const WRAPPED_ATTACHMENT_OPEN = "<attachment>\n";
const WRAPPED_ATTACHMENT_CLOSE = "\n</attachment>";
const MAX_REFERENCES = 4;
const MAX_WRAPPED_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

export interface RoutingSignalText {
	text: string;
	loadedReferences: string[];
	wrappedAttachments: number;
}

/**
 * Positions masked by fenced / inline code only (no XML masking).
 * Derived via the native helper on `<`-neutralized text so the exact
 * `<attachment>` wrapper itself never counts as masked, while fenced and
 * inline code regions still do. Index-stable with the original text.
 */
function codeMaskedPositions(text: string): boolean[] {
	const probe = text.replace(/</g, "￾");
	let maskedProbe: string;
	try {
		maskedProbe = maskNonProse(probe);
	} catch {
		return new Array<boolean>(text.length).fill(false);
	}
	const masked: boolean[] = new Array<boolean>(text.length).fill(false);
	for (let i = 0; i < text.length; i++) {
		const orig = probe[i];
		const out = maskedProbe[i];
		if (out === " " && orig !== " " && orig !== "\n" && orig !== "\t" && orig !== "\r") {
			masked[i] = true;
		}
	}
	return masked;
}

function isRangeInCode(codeMasked: boolean[], from: number, to: number): boolean {
	for (let i = from; i < to && i < codeMasked.length; i++) {
		if (codeMasked[i] === true) return true;
	}
	return false;
}

/**
 * Session-local paste references that are real transports: occurrences in
 * native prose, not inside fenced code / inline code / XML samples.
 */
export function localPasteReferences(text: string): string[] {
	let masked: string;
	try {
		masked = maskNonProse(text);
	} catch {
		return [...new Set(text.match(LOCAL_PASTE_REFERENCE_RE) ?? [])].slice(0, MAX_REFERENCES);
	}
	const found: string[] = [];
	for (const match of text.matchAll(LOCAL_PASTE_REFERENCE_RE)) {
		const start = match.index ?? 0;
		const ref = match[0];
		// Prose occurrence survives native masking byte-identically.
		if (masked.slice(start, start + ref.length) === ref && !found.includes(ref)) {
			found.push(ref);
			if (found.length >= MAX_REFERENCES) break;
		}
	}
	return found;
}

/**
 * Extract only the exact wrapper OMP uses for the "Attach as a wrapped block"
 * large-paste action. Generic XML/HTML remains opaque to the classifier.
 * Wrappers inside fenced / inline code samples are not transports.
 */
export function wrappedAttachmentBodies(text: string): string[] {
	const bodies: string[] = [];
	const codeMasked = codeMaskedPositions(text);
	let cursor = 0;

	while (bodies.length < MAX_WRAPPED_ATTACHMENTS) {
		const open = text.indexOf(WRAPPED_ATTACHMENT_OPEN, cursor);
		if (open === -1) break;
		if (isRangeInCode(codeMasked, open, open + WRAPPED_ATTACHMENT_OPEN.length)) {
			cursor = open + 1;
			continue;
		}
		const bodyStart = open + WRAPPED_ATTACHMENT_OPEN.length;
		const close = text.indexOf(WRAPPED_ATTACHMENT_CLOSE, bodyStart);
		if (close === -1) break;
		if (isRangeInCode(codeMasked, close, close + WRAPPED_ATTACHMENT_CLOSE.length)) {
			cursor = close + 1;
			continue;
		}

		const body = text.slice(bodyStart, close);
		if (Buffer.byteLength(body, "utf8") <= MAX_ATTACHMENT_BYTES) bodies.push(body);
		cursor = close + WRAPPED_ATTACHMENT_CLOSE.length;
	}

	return bodies;
}

const READONLY_FRAMING_RE =
	/要約|まとめ|説明|要旨|概要|翻訳|サマリ|summariz|explain|describe|translat|とは|何が問題|内容を(?:説明|要約)/i;
const CLOSURE_EXECUTION_RE =
	/作業して|対応して|実装して|修正して|改修して|進めて|完了して|取り込んで|実施して|実行して|解決して|反映して|取り組んで|implement|fix|address|execute|complete|resolve|finish/i;

/**
 * Outer directive with prose-only transports removed. Used to decide whether
 * an attachment is an instruction payload (bare / explicit handoff) or
 * source/reference material for a read-only request.
 */
export function outerDirectiveText(text: string): string {
	let outer = text;
	for (const body of wrappedAttachmentBodies(text)) {
		// Remove one occurrence per extracted body; byte-identical hand input
		// and real transports behave the same on the public hook.
		const wrapped = `${WRAPPED_ATTACHMENT_OPEN}${body}${WRAPPED_ATTACHMENT_CLOSE}`;
		outer = outer.replace(wrapped, " ");
	}
	for (const ref of localPasteReferences(text)) {
		outer = outer.split(ref).join(" ");
	}
	try {
		return maskNonProse(outer);
	} catch {
		return outer;
	}
}

/**
 * Summary / explain / read-only framing without closure intent: the
 * attachment is source material, so its embedded task verbs must not drive
 * delegation by themselves (P1-2).
 */
export function isSourceMaterialRequest(outerProse: string): boolean {
	return READONLY_FRAMING_RE.test(outerProse) && !CLOSURE_EXECUTION_RE.test(outerProse);
}

/**
 * Build richer classifier input for all three OMP large-paste transports.
 *
 * - Paste inline: OMP expands the text atom before the public `input` hook, so
 *   the raw `text` is already enough.
 * - Attach as a wrapped block: OMP expands to `<attachment>…</attachment>`.
 *   Generic XML is intentionally masked by the classifier, so the exact OMP
 *   wrapper body is copied into classifier-only supplemental text here.
 * - Attach as local file: `local://paste-N.md` is resolved through the public
 *   session-local protocol API and copied into classifier-only text.
 *
 * Supplemental content must never replace or be reinserted into the actual
 * user prompt. Transport-level manual keyword and command semantics therefore
 * remain based on the original `text` only.
 *
 * Directive authority (P1-2): a read-only outer request (要約して/説明して…)
 * treats attachments as source material, so supplements are withheld and the
 * outer directive alone routes. Bare transports and explicit instruction
 * handoffs keep the current supplement behavior.
 */
export async function buildRoutingSignalText(text: string, ctx: ExtensionContext): Promise<RoutingSignalText> {
	const supplements: string[] = [];
	let totalBytes = 0;
	let wrappedAttachments = 0;

	for (const body of wrappedAttachmentBodies(text)) {
		const bytes = Buffer.byteLength(body, "utf8");
		if (totalBytes + bytes > MAX_TOTAL_BYTES) break;
		supplements.push(body);
		totalBytes += bytes;
		wrappedAttachments++;
	}

	const loadedReferences: string[] = [];
	const references = localPasteReferences(text);
	const options = ctx.localProtocolOptions;
	if (options) {
		for (const reference of references) {
			try {
				const path = resolveLocalUrlToPath(reference, options);
				const metadata = await stat(path);
				if (!metadata.isFile() || metadata.size > MAX_ATTACHMENT_BYTES) continue;
				if (totalBytes + metadata.size > MAX_TOTAL_BYTES) break;

				const content = await readFile(path, "utf8");
				const bytes = Buffer.byteLength(content, "utf8");
				if (bytes > MAX_ATTACHMENT_BYTES || totalBytes + bytes > MAX_TOTAL_BYTES) break;

				supplements.push(content);
				totalBytes += bytes;
				loadedReferences.push(reference);
			} catch {
				// Attachment inspection is best-effort. The original prompt remains routable.
			}
		}
	}

	if (supplements.length > 0) {
		let sourceRequest = false;
		try {
			sourceRequest = isSourceMaterialRequest(outerDirectiveText(text));
		} catch {
			sourceRequest = false;
		}
		if (sourceRequest) {
			return { text, loadedReferences, wrappedAttachments };
		}
	}

	return {
		text: supplements.length > 0 ? `${text}\n\n${supplements.join("\n\n")}` : text,
		loadedReferences,
		wrappedAttachments,
	};
}
