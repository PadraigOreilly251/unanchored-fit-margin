/**
 * Mock harness test for unanchored-fit-margin.ts — no pi process needed.
 * Loads the extension via jiti, simulates the event stream, asserts clamp math.
 */
import path from "node:path";
import os from "node:os";
import { createJiti } from "/home/erpod/pi-mono/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import(path.join(os.homedir(), ".pi", "agent", "extensions", "unanchored-fit-margin.ts"));
const ext = mod.default;

let failures = 0;
function assert(cond, label) {
	if (cond) console.log(`  ok   ${label}`);
	else { console.error(`  FAIL ${label}`); failures++; }
}

async function runCase(name, env, script) {
	const oldEnv = { ...process.env };
	Object.assign(process.env, env);
	try {
		const handlers = {};
		const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn); } };
		ext(pi);
		const fire = async (name, payload) => { for (const h of handlers[name] ?? []) await h(payload); };
		const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0 } };
		await script(fire, handlers);
	} finally {
		process.env = { ...oldEnv };
	}
}

const ctx = 131072;
// ~40k chars of messages => est = 10000 tokens (10000 chars = 2500? no: 40000/4 = 10000)
const bigText = "x".repeat(40000);
const bigMsgs = [
	{ role: "system", content: bigText.slice(0, 20000) },
	{ role: "user", content: bigText.slice(0, 10000) },
	{ role: "assistant", content: bigText.slice(0, 10000) },
];
const expectedEst = 10000;
const expectedMargin = Math.max(4096, Math.ceil(10000 * 0.4)); // 4096
const expectedCap = Math.max(8192, ctx - 10000 - 4096); // 116976

await runCase("session start + compaction: unanchored clamps", {}, async (fire) => {
	await fire("model_select", { type: "model_select", model: { contextWindow: ctx }, previousModel: undefined, source: "set" });
	await fire("session_compact", { type: "session_compact" });
	const payload = { model: "qwen3.8-27b", messages: bigMsgs, max_tokens: 116976 }; // core's own arithmetic: ctx-est-4096
	await fire("before_provider_request", { type: "before_provider_request", payload });
	// est=10000 -> margin=max(4096,4000)=4096 -> cap=116976 == raw -> no change (floor dominates below ~12.5k est)
	assert(payload.max_tokens === 116976, `est=10k: margin floor dominates, cap ${expectedCap} equals raw 116976 -> unchanged`);

	// 100k chars => est 25000 -> margin max(4096, 10000)=10000
	const msgs2 = [{ role: "system", content: "y".repeat(100000) }];
	const raw2 = ctx - 25000 - 4096; // 101976 (core arithmetic)
	const payload2 = { model: "qwen3.8-27b", messages: msgs2, max_tokens: raw2 };
	await fire("before_provider_request", { type: "before_provider_request", payload: payload2 });
	const expCap2 = Math.max(8192, ctx - 25000 - 10000); // 96072
	assert(payload2.max_tokens === expCap2, `est=25k: clamped ${raw2} -> ${payload2.max_tokens} (expected ${expCap2})`);
});

await runCase("anchored after successful assistant response: no clamp", {}, async (fire) => {
	await fire("model_select", { type: "model_select", model: { contextWindow: ctx }, previousModel: undefined, source: "set" });
	const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0 } };
	await fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop", usage } });
	const msgs = [{ role: "system", content: "y".repeat(100000) }];
	const raw = ctx - 25000 - 4096;
	const payload = { model: "qwen3.8-27b", messages: msgs, max_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload });
	assert(payload.max_tokens === raw, `anchored: ${raw} untouched`);
});

await runCase("error/aborted message_end does NOT anchor; compaction re-anchors to unanchored", {}, async (fire) => {
	await fire("model_select", { type: "model_select", model: { contextWindow: ctx }, previousModel: undefined, source: "set" });
	const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0 } };
	await fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "error", usage } });
	const msgs = [{ role: "system", content: "y".repeat(100000) }];
	const raw = ctx - 25000 - 4096;
	const payload = { model: "qwen3.8-27b", messages: msgs, max_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload });
	assert(payload.max_tokens < raw, `error stopReason: still unanchored, clamped to ${payload.max_tokens}`);

	await fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "aborted", usage } });
	const payload2 = { model: "qwen3.8-27b", messages: msgs, max_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload: payload2 });
	assert(payload2.max_tokens < raw, `aborted stopReason: still unanchored, clamped`);

	// success anchors, then compaction voids again
	await fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop", usage } });
	const payload3 = { model: "qwen3.8-27b", messages: msgs, max_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload: payload3 });
	assert(payload3.max_tokens === raw, `anchored after stop: untouched`);
	await fire("session_compact", { type: "session_compact" });
	const payload4 = { model: "qwen3.8-27b", messages: msgs, max_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload: payload4 });
	assert(payload4.max_tokens < raw, `session_compact re-voids anchor: clamped to ${payload4.max_tokens}`);
});

await runCase("max_completion_tokens variant + tool calls + images counted", {}, async (fire) => {
	await fire("model_select", { type: "model_select", model: { contextWindow: ctx }, previousModel: undefined, source: "set" });
	await fire("session_compact", { type: "session_compact" });
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "z".repeat(80000) }, { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(100000) } }] },
		{ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "x".repeat(10000) }) } }] },
	];
	const raw = 110000;
	const payload = { model: "qwen3.8-27b", messages: msgs, max_completion_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload });
	// chars = 80000 + 4800 + toolcall json (~10150) => est ~ (80000+4800+~10150)/4 ~= 23738; base64 NOT counted (4800 instead)
	const est = Math.ceil((80000 + 4800 + JSON.stringify([{ id: "1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "x".repeat(10000) }) } }]).length) / 4);
	const expCap = Math.max(8192, ctx - est - Math.max(4096, Math.ceil(est * 0.4)));
	assert(payload.max_completion_tokens === expCap, `max_completion_tokens clamped to ${payload.max_completion_tokens} (expected ${expCap}, est=${est})`);
	assert(payload.max_completion_tokens > 8192, `base64 not counted at face value: cap stays sane`);
});

await runCase("disabled via PI_UNANCHORED_MARGIN=0", { PI_UNANCHORED_MARGIN: "0" }, async (fire) => {
	await fire("model_select", { type: "model_select", model: { contextWindow: ctx }, previousModel: undefined, source: "set" });
	const msgs = [{ role: "system", content: "y".repeat(100000) }];
	const raw = 101976;
	const payload = { model: "qwen3.8-27b", messages: msgs, max_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload });
	assert(payload.max_tokens === raw, `disabled: untouched`);
});

await runCase("no model_select yet: no crash, no change", {}, async (fire) => {
	const msgs = [{ role: "system", content: "y".repeat(100000) }];
	const raw = 101976;
	const payload = { model: "qwen3.8-27b", messages: msgs, max_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload });
	assert(payload.max_tokens === raw, `no contextWindow known: untouched`);
});

await runCase("custom ratio PI_UNANCHORED_RATIO=0.6", { PI_UNANCHORED_RATIO: "0.6" }, async (fire) => {
	await fire("model_select", { type: "model_select", model: { contextWindow: ctx }, previousModel: undefined, source: "set" });
	const msgs = [{ role: "system", content: "y".repeat(100000) }]; // est 25000
	const raw = ctx - 25000 - 4096;
	const payload = { model: "qwen3.8-27b", messages: msgs, max_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload });
	const expCap = Math.max(8192, ctx - 25000 - Math.ceil(25000 * 0.6)); // margin 15000
	assert(payload.max_tokens === expCap, `ratio 0.6: clamped to ${payload.max_tokens} (expected ${expCap})`);
});

await runCase("tools array counted in est", {}, async (fire) => {
	await fire("model_select", { type: "model_select", model: { contextWindow: ctx }, previousModel: undefined, source: "set" });
	const msgs = [{ role: "system", content: "y".repeat(100000) }]; // 25000
	const tools = Array.from({ length: 4 }, (_, i) => ({
		type: "function",
		function: { name: `tool${i}`, description: "d".repeat(4900), parameters: { type: "object", properties: {} } },
	}));
	const toolsChars = JSON.stringify(tools).length;
	const est = Math.ceil((100000 + toolsChars) / 4);
	const expCap = Math.max(8192, ctx - est - Math.max(4096, Math.ceil(est * 0.4)));
	const raw = 101976;
	const payload = { model: "qwen3.8-27b", messages: msgs, tools, max_tokens: raw };
	await fire("before_provider_request", { type: "before_provider_request", payload });
	assert(payload.max_tokens === expCap, `tools counted: clamped to ${payload.max_tokens} (expected ${expCap}, est=${est}, toolsChars=${toolsChars})`);
	assert(payload.max_tokens < 89072, `tools really shrink the cap (without tools it would be 89072)`);
});

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
