# Changelog

Notable changes to `unanchored-fit-margin`, newest first. Dates are UTC.
Incident references are deliberately date + model + shape only — no session
ids or payloads in a public repo.

## [1.0.0] — 2026-09-27

Initial release.

- Proportional fit margin (`max(4096, est·0.4)`) applied **only while the pi
  prompt estimate is unanchored** (session start, and after each
  `session_compact` until the first assistant message with real,
  non-error/non-aborted usage re-anchors). Anchored requests untouched —
  required, because pi's core rejected a blanket proportional margin on
  2026-09-24 for truncating replies when the estimate was accurate.
- Clamp via the `before_provider_request` hook on the final OpenAI-format
  payload; both `max_tokens` and `max_completion_tokens` variants; images
  counted at the core's 4,800-char constant; payload `tools` array counted.
- Audit: one line per clamp in `~/.pi/agent/logs/unanchored-fit-margin.log`;
  success signal = no new `fit400` lines in pi core's
  `~/.pi/agent/fit-retry-audit.jsonl`.
- Field data motivating the release (both public-repo-clean, date+shape only):
  - 2026-09-24, halogen 119k window, code-dense transcript: est 42,106 vs
    actual 55,389 (31.6% undercount); 400 at sent `max_tokens` 63,798.
  - 2026-09-27, vLLM 131k window, Qwen-class model: post-compaction request
    rejected with tautological "contains at least P input tokens"
    (P = C − Y + 1, confirmed on all 11 observed failures that day); built-in
    fit-retry converged in 9 instant 400s.
  - Live verification with this extension (2026-09-27, same vLLM host):
    unanchored request clamped 101,972 → 96,072; zero 400s and zero fit400
    audit lines afterward (prior bursts: 51 fit400 lines that day).
- 14/14 assertions in `unanchored-fit-margin.test.mjs`.
