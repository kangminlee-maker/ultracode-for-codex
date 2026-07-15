# p3e — Spend ceiling: host-backed `budget`, `total`/`spent()`/`remaining()`, resume-deterministic accounting

Design, 2026-07-15. Branch `parity/g4-failure-classification-retry-backoff` @ `b75b538`.
Series: [p3a journal](ultracode-p3a-journal-design.md) · [p3b resume cache](ultracode-p3b-resume-cache.md) · [p3c worktree isolation](ultracode-p3c-worktree-isolation.md) · [p3d dispatch core](ultracode-p3d-dispatch-core.md) · **p3e spend ceiling**.

Covers roadmap group **G3a** (token spend ceiling), split out of p3d §0/§4B because it expands the journal + resume-cache authority that p3d was scoped to leave untouched.

Tier: **T2** — authority-changing (journal + resume-cache entry shapes). Full skeleton: design → design-verify (two reviewer kinds, act on the union) → implement default-off → implementation-verify.

**STATUS: design-verify round 1 done (§8); owner chose Path 1 (minimal per-run ceiling) 2026-07-15. The implementable design is §9 — it supersedes the A/B/§4B analysis above, which is retained as the derivation that led here.** A (concurrency pool) + C (failure taxonomy) already shipped on this branch (`ced1971`, `9b35138`, `b75b538`); this document is B only.

---

## 0. The correction that shapes this design

p3d's blocker 1 framed the resume problem as *re-billing*: a live `spent()` that reads 0 for replayed agents lets a `while(remaining()>N)` loop overshoot the ceiling. Re-derived from code this session, the sharper and load-bearing statement is:

> **`spent()` feeds control flow, so it must replay identically or resume becomes non-deterministic and cascades the hash-chain cache.**

Worked example. Original run, `total = 100k`, loop body spends 50k output tokens/agent:
- iter 1: `spent()=0` → launch → agent A (50k). iter 2: `spent()=50k` → launch → agent B (50k). iter 3: `spent()=100k` → `remaining()=0` → stop. **2 agents.**

Resume with a naive per-run `spent()` (cached hit contributes 0, as today at `workflow-runtime.ts:2941,2957`):
- iter 1: `spent()=0` → cache HIT A, spend stays 0. iter 2: `spent()=0` (!) → cache HIT B, still 0. iter 3: `spent()=0` → launch a **third**, uncached agent … the loop keeps going until it spends 100k of *fresh* tokens.

The resume runs a different iteration count than the original. Because `agentCallKey` is a hash chain (`sha256(prev + prompt + opts)`, p3b:87-90), the first divergent iteration invalidates **every** downstream cache entry — the exact cascade p3b's determinism contract exists to prevent. So this is not merely a cost-accounting nicety; **per-lineage `spent()` (cached agents contribute their historical spend) is required for resume correctness.** A "per-run, native-parity" `spent()` is a trap: it silently breaks resume for the loop-until-budget pattern that is the budget feature's whole reason to exist.

Consequence for scope: B *must* touch the resume-cache entry shape (carry historical usage) and the cached-hit journal write. That is precisely the p3a/p3b authority expansion p3d deferred — correctly earning B its own design + review.

---

## 1. Measured background

Every claim re-derived this session from source at `b75b538`.

| # | Claim | Evidence |
|---|---|---|
| M1 | `budget` is injected as a **frozen data literal**, so `spent()`/`remaining()` cannot be literal data — `budget` must become host-backed like `agent`/`log`/`hash`. | `workflow-runtime.ts:2810-2818` (`budgetLiteral`), `:5681` (`define(globalThis,"budget",{value:freeze(<literal>)})`) |
| M2 | Host methods are wired as `host.X = hardenCallable(fn)` on a null-proto frozen object, exposed via `__host.X(...)` in the VM bootstrap. This is the exact seam `spent`/`remaining` slot into. | `:2783-2807`, bootstrap `:5683-5694` |
| M3 | `MAX_AGENT_CALLS` is checked **pre-dispatch** at the top of `runAgentInner`, throws `workflowInputError`, **before** `ctx.agentCount += 1` (`:2889`) and before any journal write. This is the ceiling precedent. | `:2867-2869` |
| M4 | Per-run output tokens accrue **only on the success path** (`ctx.outputTokens += usage.outputTokens`). A cached hit journals `usage:{0,0,0}` and accrues nothing. | success `:2990,3007-3009`; cached `:2941,2957` |
| M5 | `ctx.outputTokens/inputTokens/tokens` is the **run-cost** authority; it is what `workflow.run.completed.usage` reports. Cached agents contributing 0 to it is the correct billing view. | `:3426-3429` |
| M6 | The resume-cache entry carries **only** `{agentCallKey, result}`; `createResumeCache` drops `entry.usage` when it copies from the source journal. | `:505-508`, `:2082-2083` |
| M7 | The journal reader **already exposes and validates `usage`** on `workflow.agent.completed` (`usage: WorkflowJournalUsage`, required, non-negative-finite per key). Historical usage is already durable and readable — **reading it needs no journal-schema change.** | `workflow-journal.ts:73, 282-295, 567, 605-608` |
| M8 | The CLI strict-parse precedent exists: `parseAgentConcurrency` rejects `parseInt` prefixes deliberately (`"parseInt would accept a prefix and hide the mistake"`), threads flag → runtime option → `budget` field. | `cli.ts:112, 2029-2037, 143, 263, 2107`; settings `settings.ts:20, 90-92` |
| M9 | Native contract (parity target): `budget.total` null when unset; `budget.spent()` = output tokens; `budget.remaining()` = `max(0, total - spent())` or `Infinity`; once `spent() >= total`, further `agent()` calls **throw**. | Workflow tool contract |

**M7 is the pleasant surprise.** The *success-path* journal already stores real usage, so a single resume hop from a fresh source already has the historical numbers available — the only durable gap is the *cached-hit* write (M4), which zeroes usage and therefore loses history at the **second** resume hop.

---

## 2. Done-when

| ID | Criterion | Judge |
|---|---|---|
| DW-B1 | `total` unset ⇒ budget inert, byte-identical to `b75b538`: no ceiling, `remaining()` = `Infinity`, existing tests green with no change. | Diff review + full suite green; a test that sets no budget observes `Infinity`. |
| DW-B2 | With `total` set and `spent() >= total`, the next `agent()` throws **pre-dispatch** (before `agentCount++`/journal), as a stable non-retryable `workflow_input_invalid`. **Negative control**: a budget larger than the run never throws. | Test through `runAgentInner`; assert throw point precedes journal append; assert non-retryable via `isRetryableFailureReason`. |
| DW-B3 | On a resumed run, `spent()` at logical agent K equals the original run's `spent()` at K, so a `while(remaining()>N)` loop replays the **same iteration count** and preserves the cache prefix (no hash-chain cascade). **This is the blocker-1 criterion.** | Test: run a budget loop to completion, resume, assert identical agent count and that the started-order prefix is fully cache-hit (cardinality > 0 asserted). **Negative control**: reverting the cached-usage accrual makes the resume diverge. |
| DW-B4 | A cached hit accrues its historical output tokens into `spent()` **without** inflating run-cost: `workflow.run.completed.usage.outputTokens` still excludes replayed tokens. | Test asserting `spent()` > 0 after an all-cache-hit resume while `run.completed.usage.outputTokens == 0`. |
| DW-B5 | `budget` becomes host-backed with no observable change when off: `remaining()` is never journaled as `Infinity` (only `total: number\|null` is durable), and enumerating `budget` does not break an existing script. | Diff review; JSON round-trip test of the journaled `total`; a script reading `budget.maxParallelism` still works. |
| DW-B6 | `--budget` parses strictly: `500000`, `500k`, `+500k` accepted; `500kb`, `5e2k`, `0`, `-1`, `12x` rejected with a clear error. | Unit test over the parser, mirroring `parseAgentConcurrency`'s table. |

---

## 3. Concept map

| Concept | Path | Reuse / extend / split | Note |
|---|---|---|---|
| `budget.total` | `budget` literal (exists, adds field) | **extend** | `number \| null`; the run's ceiling. Journaled in `workflow.run.started` so resume reuses it (mirrors args/model reuse, p3b:42-45). |
| `budget.spent()` / `budget.remaining()` | `budget` host methods (new) | **add, host-backed** | Follows M2's `host.X = hardenCallable` seam. Not literal data (M1). |
| lineage output spend | `ctx.replayedOutputTokens` (new counter) | **add** | Historical output tokens from cache hits. `spent()` = `ctx.outputTokens + ctx.replayedOutputTokens`. Keeps run-cost (`ctx.outputTokens`) pure — a genuine authority split (run-cost ≠ budget-spend). |
| `WorkflowResumeAgentCacheEntry.usage` | `:505-508` (extend) | **extend** | Carry the source journal's `entry.usage` (available per M7) so a cache hit can accrue historical spend. |
| cached-hit journal `usage` | `:2941` | **redefine or split** — see D-B3 | Today zeroed (M4). Must persist history for multi-hop resume. Decision D-B3 picks *redefine the field* vs *add a field*. |
| spend-ceiling error | `workflowInputError` → `workflow_input_invalid` | **reuse** | Same as `MAX_AGENT_CALLS` (M3): stable, non-retryable — correct for an exhausted ceiling. No new `workflow_budget_exhausted` code (p3d D-2). Fix the *message*, not the code. |

**Net new concept surface:** +1 budget field (`total`), +2 host methods (`spent`/`remaining`), +1 ctx counter (`replayedOutputTokens`), +1 resume-cache field (`usage`). 0 new failure codes, 0 new vocabularies. The cached-hit journal change (D-B3) is either 0 or +1 field depending on the decision.

---

## 4. Design

### 4.1 `budget` becomes host-backed (M1, M2)

In the VM bootstrap (`:5681`), replace `value: freeze(${budgetLiteral})` with a frozen object that **spreads the existing literal** and adds two `__host`-backed methods:

```
budget = freeze({ ...<budgetLiteral>, spent: () => __host.spent(), remaining: () => __host.remaining() })
```

Host side (`:2807`, beside `host.setTimeout`):
```
host.spent = hardenCallable((): number => ctx.outputTokens + ctx.replayedOutputTokens);
host.remaining = hardenCallable((): number =>
  ctx.budgetTotal == null ? Infinity : Math.max(0, ctx.budgetTotal - (ctx.outputTokens + ctx.replayedOutputTokens)));
```

`total` stays in the literal (a per-run constant). `spent`/`remaining` are sync (they read ctx counters) — no promise plumbing, unlike `agent`. DW-B5: `remaining()` returning `Infinity` lives only in the VM; nothing journals it.

### 4.2 `total`: strict parse, threaded like `agentConcurrency` (M8)

New CLI `--budget <+Nk|Nk|N>` (name mirrors native's "+500k" directive; alias `--total` optional). Parser mirrors `parseAgentConcurrency` (`cli.ts:2029`): accept an optional leading `+`, an integer, an optional `k`/`m` suffix (×1_000 / ×1_000_000); **reject** anything `Number.parseInt` would truncate (`500kb`, `5e2k`, `12x`), zero, and negatives. Unset ⇒ `null` ⇒ inert (DW-B1). Thread flag → runtime option → `ctx.budgetTotal`, and into `budgetLiteral.total`. A settings.json default (`workflow.budget`) is **optional and deferred** — native's budget is a per-invocation directive, so the flag is the parity-faithful primary; a persistent default is a separate, lower-value follow-up.

### 4.3 `spent()` semantics + the blocker-1 fix (resume determinism)

Two counters, cleanly separated (concept split justified — different authority):
- `ctx.outputTokens` — **run cost**, fresh success only (unchanged, M5).
- `ctx.replayedOutputTokens` — **replayed history**, accrued on cache hits.
- `spent()` = their sum = **lineage output spend**.

Wiring:
1. `WorkflowResumeAgentCacheEntry` gains `usage` (M6→extend). `createResumeCache` copies `entry.usage` at `:2083` (available per M7).
2. The cached-hit path (`:2932-2963`) accrues `cached.usage.outputTokens` into `ctx.replayedOutputTokens`.
3. Because at logical point K the resume's `spent()` = the original's `spent()` (fresh-then vs replayed-now, same numbers), the loop/ceiling replays identically ⇒ DW-B3.

Rejected simplification (recorded so review can rule): accrue cached usage directly into `ctx.outputTokens` (one counter, no `replayedOutputTokens`). Rejected because it pollutes run-cost with replayed tokens (double-counts across a resume lineage when run costs are summed) — it conflates two authorities p3b keeps distinct ("zero usage for the current run", p3b:74-75).

### 4.4 Multi-hop durability — the cached-hit journal write (D-B3, needs a decision)

For a resume-of-a-resume, the historical numbers must survive the **first** resume's own journal. Today the cached hit writes `usage:{0,0,0}` (M4), so history is lost at hop 2. Two ways to fix, **surfaced for the design review to choose** (this is the one open decision that changes the journal contract):

- **D-B3-A (recommended): persist the historical `usage` on the cached-hit entry** (change `:2941` from zeros to `cached.usage`). Reuses the existing field; redefines `workflow.agent.completed.usage` from "spend *this run*" to "the agent's *actual* output-token cost, whenever spent" — arguably the more correct meaning, and 0 new concepts. **Gate G-B1 must clear first:** confirm no consumer sums `agent.completed.usage` to compute run cost (which would then double-count). Run-cost authority is `run.completed.usage` (ctx-driven, M5), so this is *likely* safe, but it is a p3b-contract change and must be verified, not assumed.
- **D-B3-B (conservative): keep `usage:0` on the cached entry, add a distinct `sourceUsage` field** carrying history. Preserves p3b's "zero usage for the current run" invariant literally; costs +1 journal field/concept and a schema-validator branch.

If G-B1 finds a re-sum consumer, fall back to D-B3-B. The progress *event* `tokens` (`:2957`) stays `0` either way (run-cost view for the CLI); only the durable journal `usage` carries history — journal = spend-truth, event = run-cost-view, and the decoupling is intentional and noted.

### 4.5 Ceiling check (M3, M9)

Pre-dispatch in `runAgentInner`, immediately beside the `MAX_AGENT_CALLS` check (`:2867`), so it runs before `agentCount++`, before the cache-hit check, and before any journal write:
```
if (ctx.budgetTotal != null && (ctx.outputTokens + ctx.replayedOutputTokens) >= ctx.budgetTotal) {
  throw workflowInputError(`Workflow token budget exhausted (spent ${spent} of ${ctx.budgetTotal}).`);
}
```
Reuse `workflowInputError` (D-2): `workflow_input_invalid` is stable + non-retryable, the correct semantics for an exhausted ceiling. Placing it *above* the cache-hit check is deliberate and safe under per-lineage `spent()`: at any cache-hit point the original run was under budget (or it would not have launched that agent), so the resume is under budget there too — no spurious throw on replay (part of DW-B3).

**Accepted soft-ceiling under concurrency (native-parity):** the check is pre-dispatch but spend is observable only post-completion, so N in-flight agents can overshoot `total`. Native has the same property (M9 throws per-call; concurrent calls race). Stated so review rules on it rather than discovering it. The loop-until-budget pattern guards with `while(remaining()>N)` and stops before over-launching.

**`parallel()`/`pipeline()` interaction (Gate G-B2):** a ceiling throw inside a thunk is converted to `null` by `parallel()`/`pipeline()`, exactly as native specifies ("a thunk that throws … resolves to null"). This is parity-correct, not a swallow-bug — *provided* `workflowInputError` from the ceiling is caught per-item and does **not** abort the whole run. G-B2 verifies which behavior the current `parallel()`/`pipeline()` error handling produces for a `workflowInputError` and pins a test either way.

---

## 5. Open decisions to settle in design-verify

- **D-B3 (§4.4)** — persist historical usage on cached entries by **reusing** `usage` (A, recommended) vs **adding** `sourceUsage` (B). Blocked on **G-B1**.
- **G-B1** — is `workflow.agent.completed.usage` ever summed to compute run cost anywhere (CLI summary, resume disclosure, `workflowResultUsage`)? If yes ⇒ D-B3-B.
- **G-B2** — does a `workflowInputError` thrown mid-thunk in `parallel()`/`pipeline()` become a per-item `null` (native-parity, desired) or a run-abort? Pin a test to whichever is real; adjust if it aborts.
- **G-B3** — must `total` be journaled in `workflow.run.started` and reused on resume (mirroring args/model, p3b:42-45), or is it re-supplied each invocation? Journaling it keeps a resumed budget loop's ceiling stable; re-supplying matches native's per-invocation model. Recommend journal + reuse-unless-overridden, but confirm against the p3b reuse rule.
- **O-B1 (from p3d O-2)** — failed / retried-turn spend is invisible to `spent()` (M4: only success accrues). For a spend *authority* this under-counts real cost. Deferred, not fixed here: matching native (success-only) is defensible, and counting failed spend would require accruing on the failure path too. Recorded as the first follow-up if the ceiling needs to be a true cost cap.
- **O-B2** — `budget` API is not byte-identical if a script does `Object.keys(budget)` (now includes `spent`/`remaining`). Practically nil, but a real enumeration-visible change; documented under DW-B5 rather than hidden.

---

## 6. Implementation-process plan (default-off, ordered; do NOT start until design-verify clears)

Each step lands behind the inert `total==null` default so the on/off diff is isolated (DW-B1 proven by diff first).

1. **Host-backed `budget` shell** (§4.1) — bootstrap object + `host.spent`/`host.remaining`, `ctx.budgetTotal` (null), `ctx.replayedOutputTokens` (0). Byte-identical when off. *Verify:* DW-B1, DW-B5; full suite green.
2. **`--budget` strict parse + thread** (§4.2) — mirror `parseAgentConcurrency`. *Verify:* DW-B6 parser table.
3. **Resume-cache carries `usage` + cached-hit accrual** (§4.3) — entry field, `createResumeCache` copy, accrue into `replayedOutputTokens`. *Verify:* DW-B3 (resume-determinism, negative control), DW-B4.
4. **Cached-hit journal persistence** (§4.4) — apply the D-B3 decision from design-verify. *Verify:* multi-hop resume test; G-B1 cleared.
5. **Ceiling check** (§4.5) — pre-dispatch throw beside `MAX_AGENT_CALLS`. *Verify:* DW-B2 (throw-point + non-retryable, negative control), G-B2 parallel/pipeline test.
6. **Docs + map** — update p3b (resume cache now carries usage; cached-hit usage semantics), CHANGELOG, IMPLEMENTATION_MAP (this closes the p3d-deferred spend gate). *Verify:* docs hygiene.

**Review gates before implementation (the method that worked for A+C, per the handoff):**
- **Design-verify: two different-kind adversarial reviewers on THIS document before any code** — one authority/logic/concept lens, one code/execution lens (cross-family, e.g. Codex CLI). Act on the union. Settle D-B3/G-B1/G-B2/G-B3 there.
- Implement default-off → dogfood the diff review (codex skill) → implementation-review round → act on the union.

**Non-negotiable carry-over lesson:** never trust a mechanism as proof of a state. Here the trap is assuming "cached hit ⇒ no spend" — true for *this run's cost*, false for *lineage spend*; conflating them is exactly what breaks resume determinism (§0).

---

## 7. Superseded / sharpened claims

| Prior claim | Verdict |
|---|---|
| p3d blocker 1: "live `spent()` re-bills on resume" | **Sharpened.** The load-bearing failure is resume *non-determinism* (spent() feeds control flow → hash-chain cascade), not just re-billing (§0). |
| "B needs the journal to change to carry historical usage" | **Half-true (M7).** The success-path journal *already* stores usage; only the cached-hit write zeroes it. The journal-schema change is at most +1 field (D-B3-B) or zero (D-B3-A). The resume-cache *entry* change is real. |
| "per-run native parity is the safe default" | **False for this repo.** Native's per-turn budget has no durable resume; ultracode's does, and per-run `spent()` breaks it (§0). Per-lineage is required, not optional. |

> **NOTE (2026-07-15, design-verify round 1):** the row above ("per-lineage is required, not optional") is itself **overturned** by the review below — per-lineage *scalar* accrual is an improvement over per-run for the clean sequential case but does **not** guarantee resume determinism across the cache modes the runtime actually supports. See §8.

---

## 8. Design-verify round 1 (2026-07-15) — two-kind adversarial review

Two different-kind reviewers on this document, each re-verified by me against real code at `b75b538`. **Kind diversity held** (authority/logic/concept lens = Claude subagent; code/execution lens = Codex CLI 0.144.1, cross-family) → verdicts are eligible for CONFIRMED, and the two lenses **converged** on the load-bearing defect — high confidence.

### Convergent core defect (both lenses, re-verified by me) — the design's §0 premise does not hold

**BLOCKER — a scalar `spent()` reconstructed from cache-hit accrual cannot equal the source run's `spent()` at the same logical point, across the resume/cache modes the runtime supports.** DW-B3 (as written) is therefore **false in general**, and §0's "per-lineage is required, not optional / guarantees determinism" is **overstated**: per-lineage scalar accrual fixes only the *clean, same-args, sequential, non-logical-keyed prefix* case (the §0 worked example — which does survive).

Re-verified failure modes (I confirmed each against real code, not just the reviews):
1. **Logical-key reorder (changed `--args`).** `test/workflow-runtime.test.mjs:900` proves it: the same script resumed with `args.order` flipped `['a','b']→['b','a']` is **fully cache-hit** because logical keys are order-independent (`workflow-journal.ts:369-370`). If agent a spent 80 and b spent 10, `spent()` before the 2nd agent is 80 in the source but 10 on resume → any `remaining()`-gated branch diverges. A scalar encounter-order sum cannot reconstruct source-point spend after reorder. (Mitigating: reorder requires the user to *change args* — arguably a different run, so determinism is not owed. But the design promised it unconditionally.)
2. **Out-of-prefix reuse of a failed-then-succeeded agent (same args).** Failed/stalled agents accrue 0 (`:3026` fail path, only `:3007` success accrues); on resume they re-run and may succeed, contributing real tokens that were 0 in the source (`byCallKey` retains later completions, `:2080-2100`, `:3647`). `spent()` is then strictly higher on resume from that point — same args, same order.
3. **Ceiling-above-cache spurious throw (§4.5).** Because the ceiling reads a live shared counter before `takeResumeCacheHit` (`:2932`) and before the pool `acquire()` (`:3233`, so cache-hit replay **bypasses the concurrency pool** entirely — unmentioned in the doc), a `parallel([F,B,C])` that legitimately overshot-but-completed in the source can, on faster pool-unbounded replay, have earlier siblings' accruals land before a later sibling's pre-dispatch check → the check throws where the source did not (→ per-item `null` under `parallel`, or run failure as a bare `agent()`). §4.5's "every cache-hit point was under budget in the original" holds only for sequential replay.

**Consequence:** the resume-determinism ambition that justified splitting B out of p3d (p3d §0 blocker 1) is **not deliverable by the scalar two-counter design**, and is only partially deliverable at all. This reopens whether the ambition is worth its cost — see the scope decision at the end.

### Additional HIGH findings (union; each re-verified)

- **H1 — `spent()` is not a spend authority even within a single fresh run.** Structured-output validation runs *before* usage accrual (`:2986` validate → `:2990` `workflowUsage` → `:3007` accrue), so an agent whose structured output fails validation discards its already-incurred provider spend; and stall-retry (`:3138`) accrues only the final successful attempt — prior stalled attempts that burned tokens are invisible. Under `parallel()`, each such failure becomes `null` while `spent()` stays flat, so the ceiling can be blown past arbitrarily. This is p3d O-2 promoted from "deferred nicety" to a correctness gap for anything called a *ceiling*.
- **H2 — G-B3 (`total` reuse on resume) is unimplementable as written.** `WorkflowLaunchInput` has no budget field (`:181`); resume inheritance reconstructs only existing retry-input fields (`:1913`); durable retry serialization keeps only script/args/tool (`:5169`); `run.started` has no `total` and rejects unknown keys (`workflow-journal.ts:248, 502, 548`). So "reuse-unless-overridden" needs a new launch-input field **and** a journal-schema addition (canonical location, validator, resume projection, compat) — not the free-standing note the doc implied. And the un-journaled horn silently drops the ceiling on a cross-process resume that omits `--budget` (a footgun on the recovery path).
- **H3 — the strict parser must bound to a finite safe integer.** The cited precedent (`parseAgentConcurrency`, `cli.ts:2033-2035`) is `/^[0-9]+$/` + `Number(v) >= 1` with **no upper bound**; a long digit string → `Infinity`, and `Infinity >= 1` passes. Mirrored verbatim for `--budget`, `--budget 9…9m` → `total = Infinity` → `spent() >= total` never true → **ceiling silently inert**. DW-B6 must require `Number.isSafeInteger` after multiplication.

### MEDIUM (union)

- **M1 — "byte-identical when off" (DW-B1/DW-B5) is impossible with an enumerable API extension.** Spreading the literal + adding `total`/`spent`/`remaining` makes three new keys visible to `for…in`/spread even when `total` is null (contradicts O-B2's own admission). Fix: define `spent`/`remaining` as **non-enumerable** methods (and treat DW-B1/B5 as "no *behavioral* change when off, enumeration excepted"), or relax the criterion explicitly.
- **M2 — over-broad necessity + naming.** §0's "required" should be scoped to "when `spent()` gates positional/hash-chain control flow"; logical-keyed loops add independent keys without cascading (`:369-370`). And "spend ceiling / journal = spend-truth" over-claims: it is an **output-token, success-path ceiling with native-parity semantics**, not a cost/dollar authority (H1). Rename/reword.

### Verified-clear (both lenses agree — these design decisions are settled)

- **G-B1 CLEARED → D-B3-A is correct and safe.** No consumer sums `workflow.agent.completed.usage` into run cost (resume disclosure counts completions `:1894`; CLI cost reads progress-event `tokens` `cli.ts:1574`; `run.completed.usage` is ctx-driven `:3421`; `workflowResultUsage` only estimates serialized size `:6726`; tests don't re-sum). D-B3-A (reuse the field) changes zero schema and passes `assertUsage`; **D-B3-B is the *larger* change** (adds a key → `rejectUnknownKeys` makes an old binary reject a new journal). The doc's "B is conservative" framing was backwards.
- **G-B2 SURVIVES → parity-correct.** A ceiling `workflowInputError` inside a thunk becomes a per-item `null` (`parallel` `:3308`, `pipeline` `:3325`, `mapWithConcurrency` `:5939`), not a run abort — matches native.

### Scope decision this review forces (coding-staged-workflow stop condition: the issue boundary expanded)

The core premise (§0) and three of six done-when criteria are implicated; the boundary expanded from "wire a ceiling" to "make `spent()` accurate and resume-deterministic," which the scalar design cannot fully do. Per the stop condition, this goes back to the owner as a **redesign/rework vs continue** choice — recorded here, decided with the owner. Options captured for that decision:
- **Path 1 (minimal per-run ceiling; recommended).** Drop the resume-determinism ambition entirely. Ship host-backed `budget` + `--budget` (with the H3 safe-integer bound) + pre-dispatch ceiling, `spent()` = per-run fresh output tokens (cached = 0, **today's behavior — no journal/resume-cache change**). Document that `spent()`/the ceiling are per-run and **not** resume-deterministic (native has no durable resume, so this is honest parity). Fix M1 (non-enumerable methods). Decide H1 as "ceiling is a lower bound on a fresh run" or accrue on failure paths. This **erases the BLOCKER, H2's journal wiring, and finding-2 class** and collapses p3e back near dispatch-core scope — the same "drop the ambition, erase the findings" move that retired `worktree clean`.
- **Path 2 (resume-deterministic ceiling; the original ambition).** Keep per-lineage accrual, but **rescope DW-B3** to "clean same-args sequential resume only," explicitly documenting the reorder / failed-then-succeeded holes; still must fix H1/H2/H3/M1. Larger surface, more risk, and *still* not fully deterministic on the edge cases.
- **Path 3 (defer B).** Park the spend ceiling; A+C already shipped the P0-relevant dispatch-core work.

---

## 9. Path 1 — final implementable design (owner-chosen 2026-07-15)

**Decision: drop the resume-determinism ambition.** `spent()` / the ceiling are **per-run** — they count this run's fresh successful-agent output tokens; cached agents contribute 0, exactly as the runtime does today (`:2941, 2957`). This is **honest native parity**: native's budget is per-turn and has no durable resume, so it never promised cross-resume determinism either. The tradeoff — a `while(remaining()>N)` loop that is resumed after interruption will re-run loop iterations whose agents were cached (re-billing) — is **documented, not fixed**. This is what makes the whole §8 blocker class disappear: with no per-lineage accrual there is no scalar-sum reconstruction to get wrong, no resume-cache field, no journal change, no `total`-reuse plumbing.

### 9.1 What changes (the entire surface)

- **`ctx.budgetTotal: number | null`** — the run's ceiling; `null` ⇒ inert. Threaded from a new `--budget` flag through the launch input.
- **`budget` becomes host-backed**, with `total`/`spent`/`remaining` added as **non-enumerable** properties (M1 fix), so `Object.keys(budget)` / `for…in` / spread are **byte-identical when off *and* on**. Direct access (`budget.total`, `budget.spent()`) works. The existing enumerable fields (`maxAgentCalls` … `agentConcurrency`) are untouched.
  - Host side (`:2807`): `host.spent = hardenCallable(() => ctx.outputTokens)`; `host.remaining = hardenCallable(() => ctx.budgetTotal == null ? Infinity : Math.max(0, ctx.budgetTotal - ctx.outputTokens))`. Sync, closing over `ctx` (host seam is confirmed sound, §8 M-note). `total` is a data property carrying `ctx.budgetTotal`.
- **`--budget <+Nk|Nk|N>`** — strict parse mirroring `parseAgentConcurrency` **plus the H3 bound**: match `/^\+?[0-9]+([km])?$/`, apply the `k`(×1e3)/`m`(×1e6) multiplier, then **reject unless `Number.isSafeInteger(result) && result >= 1`**. Unset ⇒ `null`. A settings.json default is out of scope (native's budget is per-invocation).
- **Ceiling check** — pre-dispatch in `runAgentInner`, immediately beside `MAX_AGENT_CALLS` (`:2867`), before `agentCount++` and before any journal write:
  ```
  if (ctx.budgetTotal != null && ctx.outputTokens >= ctx.budgetTotal) {
    throw workflowInputError(`Workflow output-token budget exhausted (spent ${ctx.outputTokens} of ${ctx.budgetTotal}).`);
  }
  ```
  Reuses `workflowInputError` → `workflow_input_invalid` (stable, non-retryable — correct for an exhausted ceiling; G-B2 confirms it becomes a per-item `null` inside `parallel()`/`pipeline()`, matching native).

**No change to:** the journal schema, the resume-cache entry, `createResumeCache`, the cached-hit path, `ctx.inputTokens/outputTokens/tokens` accrual, or `run.completed.usage`. Net concept surface: +1 ctx field, +1 budget data property, +2 host methods — all off by default.

### 9.2 Accepted limitations (documented, per owner decision)

- **L1 (per-run, not resume-deterministic).** A budget-gated loop resumed mid-flight re-bills cached iterations. Documented in the `--budget` help and in a CHANGELOG/README note; the guidance is to bound long work by the agent-call cap or `total` on a fresh run, not to rely on `spent()` surviving a resume.
- **L2 (output-token, success-path lower bound — from H1).** `spent()` counts successful agents' output tokens only. Spend from stalled/failed attempts or agents whose structured output fails validation is **not** counted (`:2986` validate precedes `:3007` accrue; stall loop `:3138` accrues only the final success). The ceiling is therefore a **lower bound** on true output spend, not a hard cost cap. Named accordingly ("output-token budget") so it is not mistaken for a dollar/cost authority. Accruing on failure paths is a deferred follow-up (O-B1), not in Path 1's minimal scope.
- **L3 (soft under concurrency).** Pre-dispatch check + post-completion spend ⇒ N in-flight agents can overshoot `total`. Native has the same property.

### 9.3 Done-when (Path 1)

| ID | Criterion | Judge |
|---|---|---|
| DW-B1 | `total` unset ⇒ inert **and** byte-identical incl. enumeration: `Object.keys(budget)` unchanged, existing tests green. | Diff + a test asserting `budget` key set is unchanged when off (non-enumerable methods). |
| DW-B2 | `spent() >= total` ⇒ next `agent()` throws pre-dispatch (before `agentCount++`/journal) as non-retryable `workflow_input_invalid`. **Negative control:** a budget larger than the run never throws; a run with no budget never throws. | Test through `runAgentInner`; assert throw precedes the started-journal append; assert `!isRetryableFailureReason`. |
| DW-B3 | On resume, `spent()` reflects **this run's** fresh spend (cached agents contribute 0), and the documented per-run caveat holds. | Test: resume an all-cache-hit prefix, assert `spent() == 0` after it (cardinality>0 on the cache-hit set). This *pins* the accepted L1 behavior rather than hiding it. |
| DW-B6 | `--budget` parse: `500000`/`500k`/`+500k` accept; `500kb`/`5e2k`/`0`/`-1`/`12x`/`9…9m`(overflow→non-safe-integer) reject. | Parser unit table incl. the safe-integer overflow case (H3). |

### 9.4 Implementation-process plan (default-off, ordered)

1. **Host-backed `budget` shell + non-enumerable methods** (`ctx.budgetTotal=null`, `host.spent/remaining`, bootstrap `:5681`). Byte-identical when off. *Verify:* DW-B1, existing suite green.
2. **`--budget` strict+safe parse and thread** (`cli.ts` beside `parseAgentConcurrency`, launch-input field, `ctx.budgetTotal`). *Verify:* DW-B6.
3. **Ceiling check** (pre-dispatch beside `MAX_AGENT_CALLS`). *Verify:* DW-B2 (throw point + non-retryable + negative controls), DW-B3 (resume caveat pinned), G-B2 parallel/pipeline null test.
4. **Docs** — `--budget` help incl. L1/L2 caveats, CHANGELOG, README/ULTRACODE_INSTALL, IMPLEMENTATION_MAP (closes the p3d-deferred spend gate as "per-run output-token ceiling"). No p3a/p3b edit (they are untouched).

**Verification proportionality:** Path 1 is default-off, touches neither journal nor resume authority, and its risks were already surfaced by the round-1 review. A second full two-kind adversarial round is disproportionate; the plan is a self-review + the dogfood diff review (codex skill) after implementation, then act on any union. Escalate only if implementation uncovers a new authority touch.

### 9.5 Implementation + dogfood review (2026-07-15)

Implemented default-off exactly as §9.1. `npm test` 110/110 (new: DW-B1/B2/B2-neg/B3/G-B2 + DW-B6 parser table + a registry-boundary rejection test), typecheck clean, real CLI N=1 (`--budget 500kb` rejected, `500k` accepted). **Impl trap:** the VM sandbox exposes no `Object`, so DW-B1's `Object.keys(budget)` first draft failed `workflow_failed`; the test now enumerates with `for-in` (the only path a script actually has), which still proves the non-enumerable methods stay hidden.

Dogfooded the built-in `code-review` (8 finders / 19 candidates / 19 verified / 0 refuted) on the working-tree diff, then re-verified each surviving concern against real code (not trusting the harness disposition):
- **[fixed, code] Registry boundary did not validate `budgetTotal`.** The sibling `resolveAgentConcurrency` validates at the constructor; `budgetTotal` was trusted (`options.budgetTotal ?? null`), so a programmatic caller could inject `-1`/`1.5`/`Infinity`/`NaN` and break the ceiling invariant. Added `resolveBudgetTotal` (null or positive safe integer, else `workflow_input_invalid`) + a rejection test. The CLI parser was already safe; this makes the registry the authority boundary, consistent with `agentConcurrency`.
- **[fixed, docs] Resume drops the ceiling silently.** Reported P2 (and the round-1 G-B3 footgun): a `--resume-from-run-id` that omits `--budget` runs uncapped, not merely counter-reset. Help + CHANGELOG now state the ceiling is **not inherited on resume** — re-pass `--budget`.
- **[fixed, docs] Metavar/parse mismatch (P3).** Help said `<+Nk|N>` but the parser also accepts `m`; metavar is now `<N|Nk|Nm>` and both docs note the `+`/`k`/`m` forms.
- **[no change, accepted] "Stale admission race" (finder P1) = L3 soft ceiling.** The ceiling is checked pre-dispatch, before the concurrency permit acquire, and not rechecked at dispatch — so a concurrent batch (with or without the pool) is not bounded within the batch. This is fundamental to a pre-dispatch check under concurrency (native has it), is the documented L3, and is the reason the ceiling meaningfully bounds *sequential* loops, not concurrent bursts. Disclosed in help/CHANGELOG ("soft under concurrency"). Not converted to a post-acquire recheck: that expands scope and both features are default-off.
- **[no change, accepted] Ceiling-above-cache ordering.** On resume, an exhausted budget refuses even a cache-hit agent; under Path 1's per-run `spent()` (cached = 0) this only happens once *fresh* spend exhausts the ceiling, and matches native's "any further `agent()` throws." Accepted design.
- Dropped by the harness and confirmed non-material by me: enumerable-property existence checks (methods are intentionally directly accessible), pre-existing generic CLI unknown-option acceptance (not introduced here), and test-coverage-only asks.
