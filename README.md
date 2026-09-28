# unanchored-fit-margin

A hardening extension for the [pi](https://github.com/earendil-works/pi) coding
agent. It keeps local vLLM servers from rejecting requests with
**"maximum context length ... does not fit" 400s** in the window right after a
compaction — and, as a side effect, removes the ~1-second burst of instant 400s
that the built-in fit-retry loop otherwise walks through.

## The problem

pi sizes every request as:

```
max_tokens = contextWindow − estimatedPromptTokens − 4096
```

(`packages/ai/src/api/simple-options.ts`, `clampMaxTokensToContext`). The 4096
is a pure estimator-drift buffer, and the estimate is *usage-anchored*: the real
engine token count from the last successful response, plus a chars÷4 guess for
the messages added since.

Compaction rewrites the history and inserts its summary at the front — a newer
prefix — which voids the anchor. Until the next assistant turn succeeds, the
estimate is a **pure chars÷4 guess over the entire rewritten history**. For
code/JSON-dense transcripts chars÷4 undercounts real tokenizers well past the
4096 buffer (measured: ≥ 4,097 tokens on a vLLM incident; 31.6% on a
code-dense halogen case), so `input + max_tokens` exceeds the engine window and
the server rejects with 400.

It gets worse: vLLM's error body does **not** report the real prompt length.
When the request doesn't fit, its renderer reports exactly
`contextWindow − requestedOutput + 1` (vLLM ≥ 0.30, `renderers/params.py`:
"contains at least P input tokens" with P truncated at `max_input_tokens + 1`).
P is therefore tautological — it *is* the request's own `max_tokens` — and any
client refit that trusts it re-sends a request that fails by construction. pi's
built-in fit-retry (refit at `C − P`, then cut `33 · 2^attempt` per rejection)
still converges, but by walking 7–9 instant 400s (~1 s) before the
exponential cuts eclipse the real drift.

## The fix

While the estimate is **unanchored**, replace the flat 4096 margin with a
proportional one and clamp the outgoing request:

```
margin     = max(4096, est · 0.4)
max_tokens = max(8192, contextWindow − est − margin)
```

Anchored requests pass through **untouched** — that gate is what keeps the
proportional margin from crushing `max_tokens` when the estimate is accurate
(pi's core deliberately rejected a blanket proportional margin for exactly that
reason; applied unconditionally it truncated replies in sessions above ~70%
window).

Unanchored state is tracked with the extension's event hooks (a proxy for the
core estimator's `lastUsageIndex === null`):

| event | state |
|---|---|
| session start / `session_start` | unanchored (conservative until first real usage) |
| `session_tree` (re-branch/rewind) | unanchored (the anchored usage may live on another branch) |
| `session_compact` | unanchored |
| `message_end`: assistant with real usage, stopReason not `error`/`aborted` | anchored |

The clamp itself runs in `before_provider_request` on the final
OpenAI-format payload (both `max_tokens` and `max_completion_tokens`
variants). The context window is read **live from `ctx.model`** on each
request (the `model_select` event is a fallback for processes where
`ctx.model` is undefined — the two diverge when the model is selected
before the extension loads, which would otherwise leave the window at 0
and the clamp silently no-oping). The re-estimate counts message text,
tool calls, and the payload's `tools` array, with images counted at the
core's 4,800-char constant rather than at face value (a 1 MP base64 image
is ~1.3 M chars). Audit lines carry the model label for forensics.

**Why 0.4:** the two measured undercounts (≥ 4,097 ≈ 12% of the estimate on
the vLLM incident; 13,283 = 31.6% on the halogen case) both sit under it, with
headroom for denser transcripts.

Known proxy gaps (harmless — the core fit-retry remains the backstop for
everything this extension misses): a run of aborted/error turns keeps the core
anchored and this one does too; a resumed session gets one extra conservative
turn before anchoring.

## Install

```
cp unanchored-fit-margin.ts ~/.pi/agent/extensions/
```

Restart pi or `/reload`. No core patch — the extension survives pi updates.

## Verify

- **Clamp audit** (one line per clamp, with the est/margin math):
  `~/.pi/agent/logs/unanchored-fit-margin.log`
- **Success signal** (pi core's fit-retry audit): no new `fit400` lines in
  `~/.pi/agent/fit-retry-audit.jsonl` for your local providers.

Live check (2026-09-27, vLLM 131k-window Qwen-class model): an unanchored
request that carried a 4096-margined `max_tokens` of 101,972 was clamped to
96,072 (`est=25000, margin=10000`); the session's following window had zero
400s and zero fit400 audit lines (prior bursts of the same class averaged ~9
instant 400s each).

## Tests

`unanchored-fit-margin.test.mjs` — 14 assertions (anchor lifecycle, both
payload field names, image/base64 handling, tools counting, env disable,
no-model safety, custom ratio, floor behavior). Plain Node, no dependencies
beyond `jiti` for the TS import:

```
node unanchored-fit-margin.test.mjs
```

## Tuning / revert

| env | effect |
|---|---|
| `PI_UNANCHORED_MARGIN=0` | disable the extension entirely |
| `PI_UNANCHORED_RATIO=0.6` | stronger margin (default 0.4) |

Revert: delete the file (or `/reload` after deleting).

## Upstreaming note

The canonical home for this margin is a 3-line core change in
`clampMaxTokensToContext` (`margin = lastUsageIndex === null ?
max(4096, est·0.4) : 4096` — the estimator already returns
`lastUsageIndex`). The core patch would also cover SDK users that extensions
don't reach. This extension is the update-proof field-test vehicle; upstream
the core change if the field data keeps confirming, then retire this.
