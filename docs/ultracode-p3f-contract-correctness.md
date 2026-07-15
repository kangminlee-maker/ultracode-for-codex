# Ultracode P3F: Workflow Contract-Correctness (pipeline signature + item cap)

Status: IMPLEMENTED. Date: 2026-07-15. Branch `parity/workflow-gaps-next` @ base `19ad88a` (v0.4.5).
Scope owner-selected as the "contract-correctness bundle" (PG-PIPE + PG-GUARD + PG-META).
PG-PIPE + PG-GUARD shipped in `src/runtime/workflow-runtime.ts`; PG-META resolved as
documentation-only (see below). `npm test` 116/116. The "Open decisions" below are now
resolved (recorded inline).

## Goal

Close the small, high-confidence parity divergences between the native Claude Code
Workflow contract and this runtime's control-flow hooks, without expanding concept
surface or breaking released scripts. Re-derived gap map: `docs/` sibling analysis
(2026-07-15, 4-cluster audit + self re-verify).

## Scope decision (refined during design — one item dropped)

| Item | Verdict | Rationale |
| --- | --- | --- |
| **PG-PIPE** pipeline() stage signature + null semantics | **BUILD** | Genuine behavioral divergence; real consumer (any pipeline script); built-ins unaffected. |
| **PG-GUARD** 4096-item cap on parallel()/pipeline() | **BUILD** | Native-specified explicit error; reuses existing error vocab; concept-neutral. |
| **PG-META** description-required / whenToUse / phase.model | **DROP (document as acceptable divergence)** | See below. |

### Why PG-META is dropped (premise correction)

The owner picked the bundle believing PG-META was a cheap parity win. Design
analysis overturns that:

- **`description` required** — would be a *breaking validation tightening* on a
  released (v0.4.5) tool. Evidence: **53 of 60 test metas omit `description`**
  (`grep` over `test/`), as do the native-style `{ name: "x" }` scripts users
  write. `description` is already *consumed when present* (surfaced as `summary`
  in progress/permission/launch: `workflow-runtime.ts:1816,1889,2198,2218`), so
  requiring it adds no runtime authority — only churn and breakage. Per the
  hard-block rule (block only deterministically-decidable *structural/security*
  violations; route quality concerns to non-blocking disclosure), a missing
  description is a DX/quality concern, not a structural violation → must not
  hard-reject. Native requires it only because its gallery needs a card subtitle;
  this CLI launches by explicit `--name` and has no such gallery. **Acceptable
  divergence: keep `description` optional.**
- **`whenToUse`** — native shows it in the workflow *list/gallery*. This CLI has
  **no workflow-list command that renders meta** (`grep`: no `--list`/catalog
  consumer). Adding the field would create an **inert field** (a concept with no
  downstream reader) — explicitly disallowed by the concept-economy guidance.
  **Drop** unless a listing consumer is added (out of scope).
- **phase `model`** — native uses it as a progress-display annotation for a phase
  that runs a model override. This runtime routes agent model per `agent()` call
  (`workflow-runtime.ts:2901`), not per phase, and the progress renderer shows no
  per-phase model. The field would be **inert** here. **Drop** unless per-phase
  routing/render is wired (a separate, larger feature).

Net: PG-META becomes a documentation note (acceptable divergences), not code.

## Current state (cited)

`parallel()` and `pipeline()` — `src/runtime/workflow-runtime.ts:3333-3373`:

```
parallel(ctx, items):   Array.isArray guard → mapWithConcurrency(items, 16, thunk→catch→null)
pipeline(ctx, items, stages):
   Array.isArray + stages-are-functions guards
   mapWithConcurrency(items, 16, async (item) => {
     let current = item;
     for (const stage of stages) {
       if (current === null || current === undefined) return null;   // (B) short-circuits on RETURNED nullish
       try { current = await stage(current); }                       // (A) single arg: no originalItem/index
       catch { emit log; return null; }                              //     throw → null (correct)
     }
     return current;
   })
```

`mapWithConcurrency` already supplies `index` to its callback (`:5982,:5991`), so
the index is available and merely discarded by the current `async (item) =>`.

Neither hook caps item count. `MAX_AGENT_CALLS = 1000` (`:551`) is the only backstop,
and only for items that dispatch agents; pure-compute items are unbounded (`:5984`).

## Native contract (authoritative parity target)

- `pipeline(items, stage1, ...)`: no barrier; **every stage callback receives
  `(prevResult, originalItem, index)`**; a stage that **throws** drops that item to
  `null` and skips its remaining stages. (Silent on a stage that *returns* nullish
  → the returned value, incl. `null`, flows to the next stage.)
- `parallel(thunks)`: barrier; a throwing thunk → `null`; the call never rejects *because of
  a thunk failure*. (Input-shape errors — a non-array argument, and now >4096 items — are
  call-level validation errors that DO reject the call, distinct from per-thunk failures.)
- A single `parallel()`/`pipeline()` call accepts **at most 4096 items**; more is an
  **explicit error, not silent truncation**.

## Design

### PG-PIPE — pipeline() signature + null semantics (`pipeline()` only)

1. **Signature (additive, zero-risk):** pass `(current, item, index)` to each stage,
   where `current` = prevResult, `item` = the original pipeline item, `index` = its
   position. Capture `index` from `mapWithConcurrency`'s existing 2nd callback arg.
   Existing stages that read one arg are unaffected.
2. **Null semantics (behavior-changing, isolated):** remove the
   `if (current === null || current === undefined) return null;` short-circuit. Native
   drops an item **only on throw**; a stage that *returns* `null`/`undefined` passes
   that value to the next stage (which may handle or throw on it — a throw then yields
   `null` via the existing catch). This conflation is the actual bug: today a legit
   `null` return is indistinguishable from a failure.

Post-change worker:
```
async (item, index) => {
  let current = item;
  for (const stage of stages) {
    try { current = await stage(current, item, index); }
    catch (err) { emit('pipeline stage failed…'); return null; }
  }
  return current;
}
```

### PG-GUARD — 4096-item cap (both hooks)

- New module-level `const MAX_PARALLEL_ITEMS = 4096;` beside `MAX_PARALLELISM` (`:552`),
  single-sourced and used by both hooks.
- In `parallel()` and `pipeline()`, after the `Array.isArray` guard and before dispatch:
  `if (items.length > MAX_PARALLEL_ITEMS) throw workflowInputError('<hook>() accepts at most 4096 items; got <n>.');`
- Reuses `workflowInputError` → existing `workflow_input_invalid` code. Inside
  `parallel()`/`pipeline()` this throw converts to a per-item `null` only if the *outer*
  call is itself nested in another parallel/pipeline. For a direct top-level call the
  `async` method returns a rejected promise → the run fails with `workflow_input_invalid`
  (native "explicit error"). For a call nested inside an outer stage/thunk the rejection
  is caught and converted to a per-item `null` — which is exactly how the outer
  parallel/pipeline treats any thrown error, so it matches native parity there too.

## Concept economy

- No new field, enum, failure-kind, or public vocabulary. PG-GUARD reuses
  `workflowInputError`/`workflow_input_invalid`; one internal constant
  (`MAX_PARALLEL_ITEMS`) single-sources the bound and is surfaced to scripts through
  the already-exposed `budget.maxParallelism` **only if we choose** — default: keep it
  internal (the item cap is a guardrail, not an authoring dial). PG-PIPE edits an
  existing function body. Net concept surface: **+1 internal constant, 0 public.**

## Reversibility / default posture

- PG-PIPE signature + PG-GUARD are non-breaking for existing scripts (additive args;
  cap only fires >4096, already pathological — agent-bearing items would hit the 1000
  cap first). Default-on = parity.
- PG-PIPE **null-semantics is behavior-changing**. It is *not* gated behind a runtime
  flag: a per-run toggle for a core hook's semantics is disproportionate concept
  surface no operator would ever flip, and gating it would leave the non-parity bug as
  the default, defeating the chosen goal. Instead it is made **reversible by an
  isolated diff** and **proven safe**: all built-in workflows use single-stage
  pipelines (`code-review` `:1351`) or non-null-returning stages, and the existing
  `pipeline-contract` test returns non-null — so no built-in or current test changes
  behavior. A CHANGELOG "Changed" entry documents it. **Resolved: shipped as the straight
  fix, not gated** (a per-run semantics toggle was judged disproportionate; built-ins and
  the full suite are unaffected, proven by 116/116).

## Verification plan (falsifiable)

Unit (`test/workflow-runtime.test.mjs`), each must fail if the mechanism is wrong:
- **PG-PIPE-1 (signature):** a 2nd stage asserts it received `(prevResult, originalItem, index)` — encode `originalItem`+`index` into the result; fails today (both undefined).
- **PG-PIPE-2 (null passthrough, +contrast):** stage1 returns `null`; stage2 records that it *ran* and received `null`, returns a sentinel. Assert stage2 ran (fails under the old short-circuit) — negative control that pins the behavior change.
- **PG-PIPE-3 (throw still skips):** stage1 throws → item is `null` and stage2 never runs (unchanged native behavior; regression guard).
- **PG-PIPE-2b (undefined passthrough):** as PG-PIPE-2 but stage1 returns `undefined` — the old short-circuit caught `undefined` too, so this pins that `undefined` (not only `null`) now flows onward. (Added after review.)
- **PG-GUARD-1:** `parallel()`/`pipeline()` with 4097 items (passed via `args`) → rejects with `workflow_input_invalid`, the message pinned to the correct hook name; exactly 4096 completes for **both** hooks (the pipeline guard is an independent copy, so its off-by-one is pinned separately). (pipeline-under + hook-name asserts added after review.)
- **Regression:** existing `pipeline-contract` test (no-barrier + item boundaries) stays green.

Result: `npm test` **116/116** (build→test). PG-PIPE-1/2 proven falsifiable by reverting
the fix (both fail: `s2(s1(a,undefined,undefined)…)` and `{result:[null],ran:[]}`).

Suite: `npm test` full green + typecheck. Then dogfood the built-in `code-review` on
the diff (the second adversarial lens on real code), re-verify each finding, squash-merge.

## Resolved decisions
1. PG-PIPE null-semantics: shipped as the **straight fix** (not runtime-gated) — built-ins and the full suite unaffected (116/116); PG-PIPE-1/2 falsifiability-proven (reverting the fix fails both negative controls).
2. PG-META: **dropped to documentation-only** — `description` stays optional, `whenToUse`/phase-`model` omitted as inert (no consumer in this runtime). Confirmed against `normalizeWorkflowPhasePlan` (`:6463-6478`, drops a phase/agent `model` field) and a repo-wide `whenToUse` grep (zero consumers).

## Known limits (accepted; pre-existing, not introduced by this change)
These surfaced in the dogfood review, were re-verified against code, and are left as-is
because they are pre-existing properties of `parallel()`/`mapWithConcurrency`, match
native's call-time cap semantics, and require pathological input:
- **Cap is a call-time check, not a live-length invariant.** `mapWithConcurrency` iterates
  the live `items.length` (`:5988`), so a stage/thunk that mutates *its own input array*
  during the run could push the effective batch past 4096. Native's cap is likewise a
  call-time validation; defending runtime self-mutation is out of scope and would change
  `mapWithConcurrency` (shared with the agent pool). Backlog if ever needed: pass a snapshot.
- **Eagerly-rejected non-thunk promise items past the concurrency window.** `parallel()`
  awaits a promise-valued item only when a worker reaches it (`:3343`), so a *pre-created*
  rejected promise at index >16 can surface as an unhandled rejection before it is
  translated to `null`. Idiomatic usage passes thunks (invoked, and their rejection
  awaited, inside the worker), which are unaffected; this is a pre-existing property of the
  promise-item convenience path, mildly more reachable now that an oversized *nested*
  hook rejects eagerly. Backlog: attach a catch at enqueue time for promise-valued items.
