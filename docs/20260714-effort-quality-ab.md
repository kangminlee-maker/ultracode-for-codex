# Comparative effort quality A/B — medium vs high vs xhigh (2026-07-14)

One-line result: across **two live arms on real Codex `gpt-5.6-sol`** — a shallow
single-module arm (N=15/cell) and a depth cross-file arm (N=6/cell) — review
**quality is tier-independent**: medium, high, and xhigh all saturate at ~96–100%
bug detection, **0 false positives, and blind-judge quality 3/3**. The only thing
that scales with effort is **latency (and tokens), with no quality payoff**: xhigh
is **1.7× slower on shallow and 2.4× slower on depth** than medium for equal or
better results, and under a fixed 8-min deadline xhigh/high **time out on hard
tasks that medium completes**.

This settles the one open gate in `IMPLEMENTATION_MAP.html` ("run a representative
medium/high quality-cost A/B before changing the packaged default effort from
xhigh"). **Scope: this measures the READ-ONLY REVIEW/ANALYSIS path only (`task`,
`code-review`) — NOT code-writing/generation, where higher effort may still pay.**
Within review/analysis: `xhigh` buys no measurable quality over `medium` and costs
1.7–2.4× latency + deadline-miss risk, so lowering the REVIEW-path effort to
`medium` (or `high`) is supported. The packaged **global** default
(`settings.json codex.reasoningEffort`) also governs unmeasured code-generating
`batch`/custom workflow agents, so it should **not** be flipped on this
review-only evidence; the change is a separate, behavior-changing owner decision
and is **not** applied here.

Artifacts + reproduction: `docs/quality-ab-2026-07-13/` (runner, fixtures,
ground-truth signatures, graders, blind-judge rubric/inputs/verdicts, onto-mining).

## Method

- **Backend:** live Codex app-server, `gpt-5.6-sol`, one run at a time (no
  intra-batch parallelism, so latencies are uncontaminated). Built-in `task`
  (read-only analysis) — the built-in whose phase/synthesis agents inherit the
  run-level `--reasoning-effort`, so the effort knob is what varies across cells
  (the planner is pinned at `medium` in all cells; that is real product behavior).
- **Cells:** `--reasoning-effort medium | high | xhigh`, round-robin interleaved so
  any account/throttle drift over the batch hits all three evenly. `--retry-limit 0`
  (each run is one honest attempt). Resumable JSONL, per-cell + global
  consecutive-failure circuit breakers, backoff.
- **Primary signal (deterministic):** each run's final text is graded against
  per-bug ground-truth signatures (function/location + specific-symptom regex) →
  recall. Falsifiable, reproducible, no judge.
- **Secondary signal (blind LLM judge):** each output is anonymized (opaque id,
  **cell sealed** so neither the judge nor the prompt author sees the tier),
  sharded, and judged by independent Claude subagents against a rubric carrying
  the module source + the ground-truth bugs. The judge reports per-bug detection
  (crediting a bug only when the reviewer treats it as a real defect, not when it
  is demoted to a contract-dependent aside), false-positive count, and fix quality
  0–3. The decision rests on the deterministic signal; the judge cross-checks it.
- **Two arms of increasing difficulty** (see below). Every planted bug was
  runtime-verified to actually misbehave before the live runs (negative control).

## Arm 1 — shallow (single-module local bugs)

`fixtures/cart-fixture/src/cart.js`: 8 definite single-function bugs (sign, index
base, boundary comparison, `reduce` missing initial value, boolean sort
comparator, splice-during-forEach, async-`forEach` race, operator precedence).
N=15/cell, 480 s cap. **45/45 completed, no failures.**

| cell | det. recall | judge detection | judge FP/run | judge quality | latency median | tokens median |
|---|---|---|---|---|---|---|
| medium | 97.5% | **100%** | 0.00 | 3.00 | **146 s** | 50,365 |
| high | 99.2% | 100% | 0.00 | 3.00 | 183 s | 52,607 |
| xhigh | 98.3% | 100% | 0.00 | 3.00 | **253 s** | 56,366 |

- **Quality: flat.** Both signals agree — every cell finds every bug with correct
  minimal fixes and zero false positives. (The deterministic <100% is entirely a
  too-strict signature on the *easiest* bug, B1-sign; the judge confirms B1 was
  detected in the 6 runs the regex missed, so true recall is 100%.)
- **Latency: already tier-dependent.** xhigh is **1.7×** medium for identical
  output. Even the shortest medium run (2 agents, 65 s) diagnosed all 8 correctly.

## Arm 2 — depth (cross-file bugs grounded in real review history)

To test whether *reasoning-depth-gated* tasks separate the tiers where shallow
local bugs did not, the depth fixture was designed from **real onto review
findings mined on this machine**: 5,010 `finding-ledger.yaml` across ~20 projects
→ **15,752 findings**; the 1,345 with code evidence are dominated by **cross-file
contract/authority disconnections** (a concept/field/guard/authority changed in
one place while a consumer, sibling path, verifier, or projection still holds the
old/wrong/narrow version) — not local logic bugs (`onto-mining/TAXONOMY.md`).

`fixtures/order-fixture/src/` (6 files): 8 cross-file bugs, one per mined family —
field-name drift (producer `byObservation` vs consumer `observations`),
authority/identity split (precondition by name, mutation by id), guard scoped to a
sibling path (bulk update skips the ownership check the single path enforces),
capability treated as an arbitrary key (receipt existence checked, ownership not),
cache currentness keyed on the wrong sentinel (never invalidated on update),
validator not mirrored to the import surface, duplicated divergent render paths
(text receipt drops the discount line), vacuous verifier (asserts a hand-set
literal, never the computed value). Each file reads plausibly in isolation; the
defect is in the relationship. N=6/cell, 1800 s cap. **18/18 completed.**

| cell | det. recall | judge detection | judge FP/run | judge quality | latency median | tokens median |
|---|---|---|---|---|---|---|
| medium | 100% | 95.8% | 0.00 | 3.00 | **373 s** | 92,275 |
| high | 100% | 95.8% | 0.00 | 3.00 | 614 s | 109,359 |
| xhigh | 97.9% | 97.9% | 0.00 | 3.00 | **906 s** | 128,409 |

- **Quality: flat again.** All cells cluster at ~96–100% detection with 0 false
  positives and quality 3/3. No cell is reliably better — xhigh is marginally
  higher on the (stricter) judge detection and marginally lower on the
  deterministic signal; the two cancel and both differences are within n=6 noise
  (one review out of 48 bug-decisions). medium finds all 8 cross-file bugs *and*
  contributes ~11 additional genuinely-valid findings (immutable-field patching,
  post-patch revalidation, defensive copies, float rounding) — verified real, not
  false positives.
- **Latency: steep tier penalty.** xhigh is **2.4×** medium (906 s vs 373 s) and
  uses 1.4× the tokens, for equal-or-worse quality.
- **Deadline behavior (the operational finding).** At the shallow arm's 480 s cap,
  a calibration showed medium **2/2 completed** (8/8) while high and xhigh were
  **0/4 — every run timed out**. Given room (1500 s), high completed in 610 s and
  xhigh in 1116 s, both 8/8. So on hard tasks under a fixed deadline, higher effort
  does not merely cost more — it can fail to deliver at all where medium succeeds.

## Why quality doesn't separate but latency does

The bugs — even the hard cross-file ones — are found by *reading the code
carefully and tracing a concept across files*, which `gpt-5.6-sol` does well at
every tier. Higher reasoning effort buys more deliberation per agent, but on these
tasks there is no residual quality to recover (medium already saturates), so the
extra deliberation converts directly into wall-clock and tokens with no payoff.
Effort would only help on tasks where medium leaves quality on the table; none of
the representative or hard-cross-file review tasks tested here are such tasks.

## Relationship to W3 (`docs/20260707-task-effort-ab.md`)

W3 concluded `task` latency/tokens were tier-independent and kept `xhigh`. That
held **only for W3's trivial fixture** (one tiny string-utils module, one planted
edge case): the plan was so small that per-agent reasoning depth barely mattered.
On the real-work fixtures here (8 bugs; multi-file), higher effort is *clearly*
slower and costs more tokens. W3's "no cost difference" was a fixture artifact;
this study supersedes it for representative review workloads and adds the quality
axis W3 left open.

## Decision

- **Scope of the finding — REVIEW/ANALYSIS ONLY.** Both arms measured the
  read-only review/analysis path (the built-in `task`, and by extension
  `code-review`). This study says **nothing** about code-writing, generation, or
  transformation tasks; higher effort may well earn its cost there. Do not
  generalize "quality saturates at medium" beyond review/analysis.
- **Finding (review/analysis):** the packaged default effort `xhigh` produces no
  measurable review-quality advantage over `medium` (or `high`) on representative
  single-module or hard cross-file review tasks, and costs 1.7–2.4× latency,
  ~1.4× tokens, and deadline-miss risk on hard tasks.
- **Why NOT to lower the global default on this evidence.** The packaged default
  effort lives in `settings.json` (`codex.reasoningEffort`) and governs *every*
  Ultracode workflow agent — `task` (review, measured) but also `batch` and
  custom workflows, which can generate or transform code and were **not**
  measured. Lowering the global default would apply a review-only result to
  unmeasured code-writing agents. (Actual file edits are owned by the main Codex
  context and use the parent CLI's own effort, so they are unaffected either way.)
- **Recommended paths (owner decision, not applied here):**
  - **Preferred:** lower effort only where the evidence is — the review/analysis
    path — e.g. give `task`/`code-review` a review-scoped effort default of
    `medium`/`high` while leaving the global default (and code-generating
    batch/custom agents) at `xhigh`. Needs a small code change (a per-review
    effort default) rather than editing the global setting.
  - **Alternative:** measure a code-writing/generation arm before touching the
    global default; only then decide whether the global `xhigh` is justified.
  - **Not recommended:** flip the global `settings.json` default to `medium` on
    this evidence alone — it over-applies a review-only result.
- Behavior-changing regardless of path; the value stays fully overridable with
  `--reasoning-effort`, so old behavior is recoverable per the repo's change-safety
  discipline.
- The `max` single-agent path and the `ultra` exclusion are unaffected.

### Applied (owner decision, 2026-07-14)

The owner elected to lower the **global** default now — `settings.json`
`codex.reasoningEffort` `xhigh → medium` — on the review-scoped evidence, explicitly
deferring the code-writing question: revisit the default if/when code-generation
becomes a primary workload. Only the packaged default was changed; the runtime's
library-level fallback and the `code-review` built-in's own `level` effort are
unchanged, and `--reasoning-effort` still overrides. Verified end-to-end: `setup`
reports `effort=medium`, full unit suite green (77/77). (`CHANGELOG.md` [Unreleased].)

## Limitations

- Two fixtures (one JS domain each) and one review prompt; "quality saturates at
  medium" holds for this workload class (single-repository correctness review),
  not universally. A task requiring genuinely deeper multi-step deduction than
  cross-file tracing could still separate the tiers.
- Depth arm N=6/cell (latency gradient is large and robust; the quality-parity
  claim rests more on the flat judge/FP/quality than on tight recall CIs).
- Blind judge is a single Claude-subagent pass per output (not a multi-vote panel);
  it cross-checks the deterministic signal rather than standing alone. Judge and
  deterministic detection agree 98.3% (shallow) / 97.2% (depth); disagreements are
  the confirm-vs-hedge nuance, distributed across cells (not tier-correlated).
- Latencies are process/workflow durations on one account, one run at a time;
  absolute seconds will vary, but the *ratios* between cells are the robust part.

## Reproduction

`docs/quality-ab-2026-07-13/`: `make-fixture.mjs` / `make-depth-fixture.mjs`
(fixtures + runtime negative-control), `run-ab.mjs` (3-cell runner; env
`AB_FIXTURE`/`AB_PROMPT_FILE`/`AB_CAP_MS`/`AB_N`), `ground-truth*.mjs` +
`grade.mjs` (deterministic recall), `onto-mining/` (harvest + taxonomy),
`build-judge-inputs.mjs`→`make-shards.mjs`→blind judge subagents→
`judge-aggregate.mjs`. Raw runs: `runs.jsonl` (shallow), `depth-runs.jsonl`
(depth), plus calibration/diagnostic JSONL.
