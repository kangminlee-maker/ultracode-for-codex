# W3: task effort-tier A/B — xhigh vs high (2026-07-07)

One-line result: lowering the built-in `task` from the default `xhigh` to `high`
gives **no measured benefit** — completion, latency, agent count, token cost, and
finding quality are all statistically indistinguishable across 15 live runs each
on real Codex. **Recommendation: keep `xhigh`; make no change.** `task` cost is
driven by the planner's chosen agent count (plan shape), not by per-agent effort,
so tiering effort down does not reduce it.

This settles the "optionally shorten the task synthesis tail via a lighter tier"
item left open after the 0.4.2 reliability study
(`docs/20260706-runtime-reliability-study-0.4.2.md`). The design that motivated it
(W3) was reviewed by a 3-lens subagent panel and gated on this measurement; the
measurement says do not change the default.

## Method

- Backend: real Codex (`codex-cli` GPT-5.5 family), one run at a time, quiet
  machine (verified: no concurrent LLM turns during the batch).
- Both cells: built-in `task`, same fixture (`task-fixture`: a small string-utils
  module with a `wordCount('')` edge-case bug) and the same prompt, `--retry-limit 0`.
- Baseline cell (`xhigh`): the task cell from the 0.4.2 study, N=15, at the shipped
  default effort, recorded as process-exit wall.
- Variant cell (`high`): N=15 at `--reasoning-effort high` (no product code change —
  the effort knob applies the lower tier to the planner and all phase agents).
- Latency for the variant is the `workflow.completed` `durationMs` (workflow time),
  captured by an event-driven harness. This was necessary because, on the account
  used, the CLI process hung ~2 min on **exit** after completing the workflow in
  seconds (an environment/auth-layer shutdown quirk — likely a `.superset` codex
  wrapper notify hook — not the workflow; work and result JSON were correct). The
  baseline ran when process exit was clean, so its wall ≈ workflow duration, making
  the two comparable.
- Confound controls: same N, fixture, prompt, and 480 s hard cap; deadline outcomes
  separated from quality; agent counts captured to expose any planner-shape shift.

## Result

| Tier | N | completed | deadline-aborted | dur median | dur p90 | dur max | agents median | tokens median | bug found |
|---|---|---|---|---|---|---|---|---|---|
| `xhigh` (baseline) | 15 | 13 | 2 | 155 s | 203 s | 223 s | 9 | 40,174 | (calibration-confirmed) |
| `high` (W3) | 15 | 15 | 0 | 153 s | 188 s | 399 s | 9 | 40,200 | **15/15** |

- **Token cost — identical.** Median 40,200 vs 40,174 (delta +26 tokens, ~0.06%).
  Lowering the tier does not reduce cost.
- **Latency, agent count — identical.** 153 s/9 vs 155 s/9. `high` even has its own
  slow tail (one 399 s run), so it is not the faster option.
- **Quality — preserved.** `high` surfaced the planted `wordCount` bug in all 15
  runs; `xhigh` found it at calibration.
- **Completion.** The 2 `xhigh` "aborts" are artifacts of the imposed 480 s cap
  (they were slow, not broken); under the shipped default `timeout 0` they complete.
  So real-world completion is equivalent (`high` also has a >200 s tail).

## Why there is no benefit

`task` fans out ~9 planner-chosen agents per run in both cells. Total wall time and
token cost are dominated by that agent count, not by each agent's reasoning depth.
Dropping `xhigh → high` changes per-agent depth but not the plan, so the aggregate
cost/latency barely moves. The lever for `task` cost, if ever wanted, is **plan
size** (cap agents/phases), not effort tier.

## Decision

- **No code change.** Keep the `xhigh` default for `task`. The default-off
  discipline held: measure before changing, and the measurement says do not change.
- The general-runtime identity work that shipped alongside this (W1 change-evidence
  rename, W2 general example workflows) is independent and already on `main`.

## Limitations

- Single small fixture and one task prompt; a larger or harder task could show a
  bigger per-agent-reasoning effect, so "no benefit" holds for this workload class,
  not universally.
- N=15 per cell; the completion-rate gap is within deadline-artifact + sampling noise.
- Token totals may not fully expose hidden reasoning tokens, but the observable cost
  is identical.
- Separate observation (not a `task` result): on the test account the CLI did not
  exit promptly after workflow completion (~2 min shutdown hang; work and result
  correct). Worth a follow-up if it reproduces without the `.superset` wrapper.

## Reproduction

Harness and raw data are co-located: `docs/reliability-2026-07-06/w3-ab.mjs`
(event-driven task@high runner) and `docs/reliability-2026-07-06/w3-high-runs.jsonl`
(the 15 variant runs). The `xhigh` baseline is the `task` cell of
`docs/reliability-2026-07-06/reliability-runs.jsonl`. Re-run:
`node w3-ab.mjs` (from that dir, with fixtures built via `make-fixtures.mjs`).
