/**
 * unanchored-fit-margin.ts
 *
 * Field test for the "B1" fix: shrink max_tokens when pi's prompt estimate is
 * UNANCHORED (no real engine usage in history to calibrate against).
 *
 * Estimation note: the payload's `tools` array is counted in `est` (core counts
 * the system message's toolsAdded the same way). OpenAI-format payloads carry
 * tools at the top level, so without this the margin is short by ~tools/4.
 *
 * Why: pi sizes every request as max_tokens = contextWindow - est - 4096
 * (packages/ai/src/api/simple-options.ts, clampMaxTokensToContext). The 4096 is
 * a pure drift buffer, valid only while the estimate is usage-anchored (last
 * real engine totalTokens + chars/4 delta for new messages). After compaction
 * the summary is a newer prefix and voids the anchor, so the estimate is a pure
 * chars/4 guess over the whole rewritten history. chars/4 undercounts
 * code-dense transcripts well past 4096 (repo incident bb8082466: 42106 est vs
 * 55389 actual, ~32%; 2026-09-27 vh114: 34569 est vs >=38666 real, ~12%), so
 * input + max_tokens exceeds the engine window and vLLM rejects with 400
 * "maximum context length is C ... requested Y output tokens ... at least P
 * input tokens". The built-in refit loop then needs ~9 binary-search retries
 * because vLLM's P is a tautology (prompt + requested output).
 *
 * This extension: while unanchored, clamp max_tokens with a proportional
 * margin instead of the flat 4096:
 *     margin = max(4096, est * 0.4)
 * Anchored requests are untouched (the flat margin is correct there — the
 * 2026-09-24 commit rejected a blanket proportional margin because it
 * truncated replies when the estimate was accurate).
 *
 * Unanchored tracking (proxy for the core's lastUsageIndex === null):
 *   - session start            -> unanchored (true initially)
 *   - session_compact          -> unanchored
 *   - assistant message_end with real usage and stopReason not
 *     error/aborted            -> anchored (next real engine usage re-anchors)
 * Known proxy gaps (all harmless; the refit loop remains the backstop):
 *   - a run of aborted/error turns keeps the core anchored, this does not
 *   - a resumed session gets one extra conservative turn before anchoring
 *
 * Verification:
 *   - own audit (one line per clamp):  ~/.pi/agent/logs/unanchored-fit-margin.log
 *   - success signal: ~/.pi/agent/fit-retry-audit.jsonl — expect NO new
 *     "fit400" lines for vh114 (or any local provider) after this loads.
 *
 * Tuning:  PI_UNANCHORED_MARGIN=0     disable
 *          PI_UNANCHORED_RATIO=0.6    stronger margin (default 0.4)
 * Revert:  delete this file (or /reload after deleting)
 *
 * Note: this is the field-test vehicle for a 3-line core patch
 * (clampMaxTokensToContext: margin = lastUsageIndex === null
 *  ? max(4096, est*0.4) : 4096). The extension survives pi updates; the core
 * patch is the canonical home if the data confirms it. See AINotes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VERSION = "1.0.0";
const FLOOR = 4096; // core CONTEXT_SAFETY_TOKENS
const MIN_OUT = 8192; // core MIN_USABLE_MAX_TOKENS
const IMG_CHARS = 4800; // core ESTIMATED_IMAGE_CHARS (1600 tokens worth)

function enabled(): boolean {
	return process.env.PI_UNANCHORED_MARGIN !== "0";
}

function ratio(): number {
	const raw = Number(process.env.PI_UNANCHORED_RATIO ?? "0.4");
	return Number.isFinite(raw) && raw > 0 ? raw : 0.4;
}

function audit(line: string): void {
	try {
		const p = path.join(os.homedir(), ".pi", "agent", "logs", "unanchored-fit-margin.log");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// Observational only: never break the request path.
	}
}

/** Rough char count of an OpenAI-format message (same idea as core, coarser input). */
function messageChars(m: any): number {
	if (!m || typeof m !== "object") return 0;
	let chars = 0;
	const c = m.content;
	if (typeof c === "string") chars += c.length;
	else if (Array.isArray(c)) {
		for (const part of c) {
			if (part?.type === "text") chars += part.text?.length ?? 0;
			else if (part?.type === "image_url") chars += IMG_CHARS;
			else if (part) chars += JSON.stringify(part).length;
		}
	} else if (c != null) chars += JSON.stringify(c).length;
	if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
	if (typeof m.reasoning_content === "string") chars += m.reasoning_content.length;
	return chars;
}

export default function (pi: ExtensionAPI) {
	let unanchored = true; // session start: conservative until first real usage
	let contextWindow = 0;

	pi.on("model_select", (e) => {
		contextWindow = (e as any).model?.contextWindow ?? 0;
	});
	pi.on("session_compact", () => {
		unanchored = true;
	});
	pi.on("message_end", (e) => {
		const m = (e as any).message;
		if (
			m?.role === "assistant" &&
			m.stopReason &&
			m.stopReason !== "error" &&
			m.stopReason !== "aborted" &&
			((m.usage?.totalTokens ?? 0) > 0)
		) {
			unanchored = false;
		}
	});

	pi.on("before_provider_request", (e) => {
		if (!enabled() || !unanchored || contextWindow <= 0) return;
		const p = (e as any).payload;
		if (!p || typeof p !== "object") return;
		const field: "max_tokens" | "max_completion_tokens" | undefined =
			typeof p.max_tokens === "number"
				? "max_tokens"
				: typeof p.max_completion_tokens === "number"
					? "max_completion_tokens"
					: undefined;
		if (!field) return;
		const raw = p[field];
		const toolsChars = Array.isArray(p.tools) ? JSON.stringify(p.tools).length : 0;
		const est = Math.ceil(
			(((p.messages ?? []) as any[]).reduce((sum: number, m: any) => sum + messageChars(m), 0) +
				toolsChars) /
			4,
		);
		const margin = Math.max(FLOOR, Math.ceil(est * ratio()));
		const capped = Math.max(MIN_OUT, contextWindow - est - margin);
		if (capped < raw) {
			p[field] = capped;
			audit(`v${VERSION} clamped est=${est} margin=${margin} ${raw}->${capped} ctx=${contextWindow}`);
		}
	});
}
