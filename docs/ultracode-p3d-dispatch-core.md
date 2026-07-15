# p3d — Dispatch core: shared concurrency pool, spend ceiling, backend failure taxonomy

Design, 2026-07-15. Branch `parity/g4-failure-classification-retry-backoff` @ `98a0fb8`.
Series: [p3a journal](ultracode-p3a-journal-design.md) · [p3b resume cache](ultracode-p3b-resume-cache.md) · [p3c worktree isolation](ultracode-p3c-worktree-isolation.md) · **p3d dispatch core**.

Covers roadmap groups **G1** (global agent concurrency) and **G3** (token spend ceiling + backend failure taxonomy).

Tier: **T2** — authority-changing. Full skeleton: design → design verify (two reviewer kinds, act on the union) → implement default-off → implementation verify.

## 0. Scope decision after design review round 1 (2026-07-15)

Design review (authority lens + code/execution lens) returned **two blockers**. One of them redraws the scope of this stream.

- **This stream ships A (concurrency pool) + C (failure taxonomy).** Both stay inside the `runAgentInner`/`runAgentAttempt` choke point and touch neither the journal schema nor the resume-cache authority — the property that made G1/G3 safe to do together.
- **B (spend ceiling) is split out to a separate design, `p3e`.** Blocker 1 (below) proved a live `spent()` is *incompatible* with the resume-cache determinism contract unless the **journal + resume-cache entry shape** (owned by p3a/p3b) also change to carry historical usage. That is exactly the authority expansion this stream was scoped to avoid. B is not hard, but its boundary is bigger than "the dispatch core," so it earns its own design + review, not a rushed graft here. Owner-approved 2026-07-15.

Blocker 2 (permit release decoupled from real backend completion) is an **A** defect and is fixed *in* this design — see §4A.

The rest of this document keeps the full three-part analysis because A, B, and C were derived together and B's §4B is the input to p3e. Sections scoped out of implementation are marked **[→ p3e]**.

**Landed 2026-07-15.** A shipped in `ced1971` (default-off pool). C shipped as classification only: backend maps the codex turn error → `SubagentFailureKind` (`src/codex/turn-failure.ts`, allowlist pinned to the fixture), throws a `SubagentFailure`; the runtime's `codedAgentFailure` maps the kind → stable code (`terminal` → new non-retryable `workflow_agent_terminal`; else the existing retryable `workflow_agent_failed`) and emits an observability log for an unrecognized variant; `turn/completed` status handling is now exhaustive. **Backoff and a backend-attempt retry loop are deliberately NOT in C** — the P0 (stop retrying terminal) needs no new loop (the existing CLI retry gate keys on the code), and adding backoff opens the retry-ownership/multiplication question the code/execution lens flagged; it is its own follow-up. Not adding backoff is not a regression: non-terminal failures keep today's immediate-retry behavior exactly. Other backend exits (RPC timeout, close, wait timeout) remain uncoded → `workflow_agent_failed` (retryable), which is the correct classification for those transient/operational failures; deterministic launch-time `prepare()`/model-validation classification is a tracked follow-up.

---

## 1. Measured background

Every claim below was re-derived this session from source or from the installed `codex-cli 0.144.1` binary. Claims inherited from the prior handoff that did **not** survive re-derivation are listed in §7.

| # | Claim | Evidence |
|---|---|---|
| B1 | `MAX_PARALLELISM = 16` is enforced **only** inside `mapWithConcurrency`, called only by `parallel()` and `pipeline()` — each call opens its own independent pool. | `workflow-runtime.ts:538, 3255, 3275, 5875` |
| B2 | `runAgentInner` has **no** concurrency gate. Unbounded: bare `agent()` bursts, two concurrent `parallel()` batches, nested fan-out, and *multiple* agents per thunk. (A single `parallel()` of one-agent-per-thunk *is* bounded to 16 by `mapWithConcurrency` — corrected per review.) | `workflow-runtime.ts:2841-3110, 3253-3268, 5875-5891`; no semaphore/permit/acquire anywhere in `src/` |
| B3 | `budget` is injected into the VM as a **frozen data literal**, not a host-backed object. | `workflow-runtime.ts:2798-2803` (`vmDataLiteral`), `:5626` (`define(globalThis,"budget",{value:freeze(<literal>)})`) |
| B4 | `budget` exposes static caps only: `maxAgentCalls`, `maxParallelism`, `agentStallTimeoutMs`, `agentStallRetryLimit`. No `total` / `spent()` / `remaining()` / ceiling. | `workflow-runtime.ts:2798-2803` |
| B5 | Per-run usage is **already aggregated** — `ctx.inputTokens/outputTokens/tokens` — so `spent()` needs no new plumbing. | `workflow-runtime.ts:2992-2994`; ctx fields at `:331-335` |
| B6 | Usage is added **only on the success path**. A failed agent's spend is never counted. Cached resume hits journal `usage: 0`. | `workflow-runtime.ts:2926` (cached), `:2975-2994` (success) |
| B7 | `MAX_AGENT_CALLS = 1000` is already checked pre-dispatch at the top of `runAgentInner` and throws `workflowInputError`. This is the precedent a spend ceiling should follow. | `workflow-runtime.ts:537, 2852-2854` |
| B8 | The codex backend flattens the structured turn failure into a plain `Error` message via `JSON.stringify(turn.error)`, destroying it at the boundary. | `subagent-backend.ts:622, 632` |
| B9 | codex's `TurnError` is a struct of `{ codexErrorInfo, additionalDetails }` (3 elements incl. message). | `strings` on `codex-aarch64-apple-darwin` 0.144.1: `TurnError.ts` / `struct TurnError with 3 elements` |
| B10 | `CodexErrorInfo` on the wire is **camelCase** and **hybrid-shaped**: 11 bare-string variants + 5 externally-tagged object variants. The snake_case names visible via `strings` are internal Rust identifiers, **not** the wire vocabulary. | `codex app-server generate-json-schema --out <dir>` → `v2/TurnCompletedNotification.json`, `definitions.CodexErrorInfo`; description: *"This translation layer make sure that we expose codex error code in camel case."* |
| B11 | `httpStatusCode` exists **only** on 4 object variants (`httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected`, `responseTooManyFailedAttempts`), all already transient by name. It can never accompany `usageLimitExceeded`/`unauthorized`/`badRequest`, which are bare strings. ⇒ it carries **no classification signal**. | ibid. |
| B11a | `TurnError` requires `message`; `codexErrorInfo` is **nullable**, and `other` is an explicit variant. ⇒ "unclassified" is a supported wire state, not an anomaly. | ibid., `definitions.TurnError` |
| B12 | `CodexErrorInfo` carries **no** retry-after / reset field — confirmed by schema, not just by `strings`. Rate-limit reset timing exists only on the account channel (`RateLimitSnapshot`, `RateLimitWindow`, `account/rateLimitsUpdated`). | ibid.; `usageLimitExceeded` is a bare string with nowhere to carry one |
| B13 | `WORKFLOW_RETRYABLE_FAILURE_CODES` contains `workflow_agent_failed`, so **every** backend failure is currently retryable — including an `unauthorized` or `bad_request` that retrying can never fix. | `workflow-runtime.ts:573-579`, `:6629-6638` |
| B14 | `src/runtime/async-queue.ts` has **zero importers** and is a value-stream `AsyncIterable`, not a permit primitive. | grep across `src/`; file contents |

**B13 is the sharpest finding.** G4 fixed "everything is retryable" at the workflow level (`recovery.retryable` was unconditionally true). One layer down, the same defect survives: the backend's terminal failures are still classified retryable, because the evidence that would distinguish them (B10/B11) is thrown away at B8. C below is the completion of G4, not a new feature.

---

## 2. Done-when

| ID | Criterion | Judge |
|---|---|---|
| DW-A1 | With the pool on, concurrent in-flight backend dispatches never exceed the pool size — across a bare `agent()` burst, two concurrent `parallel()` batches, and `parallel()`-of-`agent()`. | Test asserting observed peak concurrency from a counting fake backend, with cardinality > 0 asserted (a pool that dispatches nothing passes vacuously). |
| DW-A2 | Pool off (landing default) ⇒ byte-identical behavior to `98a0fb8`. | Diff review + existing 84 tests green with no change. |
| DW-A3 | Waiting for a permit never counts toward `agentStallTimeoutMs` and never consumes a stall retry. | Test: pool size 1, N agents, stall timeout shorter than total serialized time; no stall failures. **Negative control**: acquiring inside the timer must make this test fail. |
| DW-A4 | Aborting the workflow settles queued permit waiters; no hang, no leaked permits. | Test: abort mid-queue, assert run terminates and pool returns to full. |
| DW-A6 | A permit is held for the true lifetime of the backend call: on abort/stall, the pool does not free the slot until the real dispatch settles. | Test with a backend that resolves **N ticks after** its abort signal; assert a fresh acquire cannot exceed the bound while the aborted dispatch is still in flight. **Negative control**: releasing on the race winner must fail this test. This is the test the existing fake backend cannot express. |
| DW-B1..B3 **[→ p3e]** | Spend ceiling `total`/`spent()`/`remaining()` semantics. | Split out — see §0. Blocker 1 makes these depend on a journal/resume-cache change. |
| DW-C1 | A codex turn failure's `codexErrorInfo` reaches the runtime as a backend-neutral kind, with **no string sniffing** anywhere. | Test with a fake app-server emitting a real-shaped `turn/completed` failure; grep for absence of message-matching. |
| DW-C2 | A terminal backend failure (`unauthorized`, `badRequest`) is **not** retried and does not read as retryable. | Test pinning the classification. |
| DW-C3 | A transient / rate-limited failure is retried with bounded, cancelable backoff. | Test with a fake backend failing then succeeding; assert attempt count and that SIGINT cuts the wait. |
| DW-C4 | The wire shape the mapping keys on is the **real** one. | **MET** — pinned to the binary's own generated protocol schema, not to a probe. See G-C0 in §7. |
| DW-C5 | Every variant in the **pinned fixture** is classified; a fixture variant with no mapping entry fails the build (compile-time exhaustive switch over the fixture's literal union). | This is **build-time fixture coverage**, not a runtime guarantee — the separately-upgraded installed binary can still send a value outside the fixture; DW-C6 covers that runtime gap. |
| DW-C6 | A live failure that lands in the unclassified bucket (`other`/null/unrecognized) emits a distinguishable log/metric. | Test asserting the signal fires on an unknown variant. This is the runtime observability D-3's exception depends on. |

---

## 3. Concept map

| Concept | Path | Reuse / extend / split | Note |
|---|---|---|---|
| agent permit pool | `src/runtime/agent-concurrency-pool.ts` (new, ~30 lines) | **add** | Named for the concept; not built on `async-queue.ts` (B14: wrong primitive). |
| `budget.maxParallelism` | exists, = 16 today | **keep unchanged, do NOT redefine** | Review HIGH finding: this field *is* `parallel()`/`pipeline()`'s bound (`MAX_PARALLELISM`, still 16 after this change). Silently repointing it at the new CPU-derived pool size would mislead any script sizing batches off it. |
| new pool's effective size | `budget.agentConcurrency` (new field) | **add, distinct name** | The pool's own number gets its own field. Honest count, not a rename of `maxParallelism`. Resolves D-1. |
| backend failure kind | `SubagentFailureKind` in `src/runtime/types.ts` (new) | **add, backend-neutral** | `'terminal' \| 'transient' \| 'rate_limited'`. Codex vocabulary stays inside `src/codex/`. |
| `workflow_agent_failed` | exists, retryable | **split** | Needs a terminal counterpart; see D-4. |
| `isRetryableFailureReason` | exists, single classifier | **reuse unchanged** | Stays the one place retryability is decided. |
| `budget.total/spent()/remaining()` **[→ p3e]** | `budget` (exists) | **extend, in p3e** | Split out (§0). |

**Net concept surface (A+C):** +3 real concepts (permit pool, its effective-size field, backend failure kind), 0 renames, 0 parallel vocabularies. The first draft claimed +2 by not naming the `maxParallelism` collision — corrected per review.

---

## 4. Design

### A — Shared agent concurrency pool (G1)

One `AgentConcurrencyPool` per run, held on `WorkflowRunContext`, acquired around **the backend dispatch only**.

**Placement: top of `runAgentAttempt` (`:3200`), before the stall timer starts; release in `finally`.** Three reasons, each load-bearing:

1. *Above* it, `runAgentWithStallRetries` does worktree create/finalize (`:3127-3141`) — slow git I/O. Acquiring in `runAgentInner` would serialize that I/O behind the concurrency limit. Permit wraps dispatch, not git.
2. *Inside* it, the stall timer starts at `:3210`. If the permit were acquired after the timer, queued agents would burn `agentStallTimeoutMs` waiting in line and fail as "stalled" — a self-inflicted DW-A3 violation. Acquire first, then start the timer.
3. Each stall retry re-acquires, because each attempt is a new dispatch.

**The handoff's "release before recursing or you self-deadlock" trap does not apply here** — verified, not assumed. Nothing that holds a permit awaits another `agent()`: the permit's critical section is exactly `backend.generate`, worktree I/O is outside it, and `host.workflow` throws on nesting (`:2791-2793`). Recorded so a future reader does not re-add a defensive release.

**BLOCKER 2 (found in review, fixed here): release on real completion, not on the abort race.** The first draft said "release in `finally`" at the top of `runAgentAttempt`. That is wrong, and wrong in this repo's signature failure mode. `runAgentAttempt` returns via `Promise.race([generated, aborted])` (`:3230`), where `aborted` resolves purely off the abort signal (`:3225-3229`). The real backend does **not** stop synchronously on abort: `generate`'s abort handler is `void interruptTurn()` — fire-and-forget, never awaited (`subagent-backend.ts:208-210`). So on a workflow abort or a stall timeout the function throws the instant `aborted` wins; an outer `finally` would then release the permit while `generated` — the real dispatch, on the shared app-server connection — is still in flight. Under stall-retry (`runAgentWithStallRetries`, `:3111-3177`) the next attempt immediately acquires a *fresh* permit while the orphaned previous dispatch keeps running on the same connection. **The pool bound becomes a lie by exactly the `mechanism ≠ state` mistake that caused two prior regressions.**
- **Fix:** the permit is released when `generated` itself settles, not when the race resolves. Concretely: acquire before the race; attach the release to `generated` (`generated.finally(release)`), not to the attempt's `try/finally`. The permit is held for the true lifetime of the backend call, so `abort → throw → next attempt` cannot over-subscribe the pool.
- **Falsifiability (this is the load-bearing part):** the existing fake backend cannot expose this — `FakeSubagentBackend` + `neverUntilAbort` reject on the *same tick* the abort fires (`test/workflow-runtime.test.mjs:2032-2040`), so `generated` and `aborted` settle together and any test written against it passes green whether the fix is present or not. DW-A1/A3/A4 therefore **require a new fake backend that deliberately stays in-flight past its own abort signal** (resolves `generated` a few ticks *after* abort). Without that backend the criterion passes vacuously — see DW-A6.

**MISSED in first draft (found in review): worktree-add burst is not gated by the pool.** `createAgentWorktree` runs at `:3127-3129`, *above* `runAgentAttempt` where the permit is acquired — deliberate, per reason 1. Consequence: a `parallel()` of 16 `agent({isolation:'worktree'})` calls can still fire up to 16 concurrent `git worktree add` against one repo even when the pool caps real dispatch at, say, 2. This design **accepts** that: `git worktree add` takes the repo's `index.lock`/`worktrees` lock and serializes safely (verified in G2's git 2.50.1 probe: concurrent add is safe), so the risk is bounded contention, not corruption, and gating it would forfeit reason 1's latency win. Recorded as accepted rather than left implicit; O-4 tracks a lighter git-I/O gate if contention ever shows up in practice.

`acquire(signal)` must be abortable: queued waiters settle on `ctx.controller.signal` (DW-A4).

`parallel()`/`pipeline()` keep `mapWithConcurrency(16)` **unchanged**. It bounds *items* (arbitrary thunks, not just agents); the pool bounds *agent dispatches* globally. The pool is always the tighter bound for agents (pool ≤ 16), so keeping both costs nothing and keeps the diff minimal. This is the smallest change that buys B2's parity.

**Size:** `min(16, max(1, availableParallelism() - 2))` — native's formula verbatim, because parity is the goal. The handoff suggested an I/O-oriented default since codex agents are remote calls; rejected for now, recorded as an open question (§6 O-1) rather than a silent deviation.

**Landing (opt-in, per the G2.1→G2.4 pattern):** setting `workflow.maxParallelism`, values `'unbounded' | 'auto' | <positive int>`.
- Land with `'unbounded'` in `settings.json` ⇒ pool inert ⇒ DW-A2.
- Flip commit sets `'auto'` ⇒ native parity. `'auto'` exists because the native formula is computed and cannot live in a static settings file.

### B — Spend ceiling (G3a)

**`budget` becomes host-backed.** B3 means `spent()`/`remaining()` cannot be literal data. In the VM bootstrap, replace the frozen literal with a frozen object that spreads the existing literal and adds two `__host`-backed methods, alongside `agent`/`log`/`hash`. `total` stays in the literal (it is a constant for the run).

**`total`:** new CLI flag, parsed **strictly** (`+500k`, `500k`, `500000`; reject `500kb`, `5e2k`, prefixes). The roadmap already flags a `parseInt` prefix-acceptance bug elsewhere in the CLI — this parser must not repeat it. Unset ⇒ `null` ⇒ `remaining()` = `Infinity` ⇒ inert (DW-B1).

**`spent()`:** `ctx.outputTokens`. Native's `spent()` is output tokens; matching it verbatim. Two honest deviations from native, both recorded rather than papered over:
- Native's pool is shared with the main loop ("the pool is shared, not per-workflow"). Here there is no main loop; the scope is per-run. Documented, not faked.
- B6: failed agents' spend is invisible. Left as-is for now (§6 O-2).

**Ceiling:** pre-dispatch check in `runAgentInner`, immediately beside the `MAX_AGENT_CALLS` check (B7) — before `agentCount` increments and before any journal write (DW-B3). Reuses `workflowInputError`, exactly as the agent-call cap does: the resulting `workflow_input_invalid` is stable and non-retryable, which is the correct retry semantics for an exhausted ceiling.

**Known and accepted:** the ceiling is checked pre-dispatch but spend only becomes observable post-completion, so N concurrent in-flight agents can overshoot `total`. Native has the same property. Stated so review can rule on it rather than discover it.

### C — Backend failure taxonomy (G3b)

**Classify at the authority, cross the boundary neutral.** The codex backend is the only layer that knows codex vocabulary (B10/B11), so it maps `codexErrorInfo` → `SubagentFailureKind` and throws an error already carrying the kind. `workflow-runtime` consumes the kind and never learns a codex variant name. This is the same principle the existing comment at `:3241-3246` states — B8 is what currently makes that comment unhonorable.

**Wire shape — settled, authoritative (G-C0 CLOSED).** Generated from the installed binary itself:
`codex app-server generate-json-schema --out <dir>` → `v2/TurnCompletedNotification.json`, `definitions.CodexErrorInfo`.

Three facts from that schema overturn this design's own first draft, which had guessed the shape from `strings` output:

1. **Casing is camelCase, stated by the schema, not inferred.** `CodexErrorInfo.description`: *"This translation layer make sure that we expose codex error code in camel case."* The snake_case list visible in the binary is the internal Rust identifier set, **not** the wire vocabulary. A mapping keyed on snake_case would have matched nothing — exactly the dead-code failure G-C0 existed to prevent.
2. **The wire is a hybrid, not a uniform tagged enum.** Eleven variants are **bare strings**; five are **externally-tagged objects**. Any matcher must handle both shapes:
   - bare string: `"contextWindowExceeded" | "sessionBudgetExceeded" | "usageLimitExceeded" | "serverOverloaded" | "cyberPolicy" | "internalServerError" | "unauthorized" | "badRequest" | "threadRollbackFailed" | "sandboxError" | "other"`
   - tagged object: `{"httpConnectionFailed":{httpStatusCode}}`, `{"responseStreamConnectionFailed":{httpStatusCode}}`, `{"responseStreamDisconnected":{httpStatusCode}}`, `{"responseTooManyFailedAttempts":{httpStatusCode}}`, `{"activeTurnNotSteerable":{turnKind}}`
3. **`httpStatusCode` carries no classification signal.** It exists only on four object variants, all of which are already unambiguously transient *by name*. It can never appear on `usageLimitExceeded` (a bare string), so the first draft's `httpStatusCode === 429 ⇒ rate_limited` rule was unreachable dead logic. **Classification keys on the variant only**; `httpStatusCode` is diagnostic, not authority.

Also: `TurnError` requires `message` but `codexErrorInfo` is **nullable**. A failure with no `codexErrorInfo` is a *supported wire state*, not an anomaly, and must be mapped.

Mapping (pinned to the schema above):

| Kind | Variants |
|---|---|
| `rate_limited` | `usageLimitExceeded` |
| `transient` | `serverOverloaded`, `internalServerError`, `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected`, `responseTooManyFailedAttempts` |
| `terminal` | `unauthorized`, `badRequest`, `cyberPolicy`, `contextWindowExceeded`, `sessionBudgetExceeded`, `sandboxError`, `threadRollbackFailed`, `activeTurnNotSteerable` |
| `other`, `codexErrorInfo: null`, or a variant added after 0.144.1 | **see D-3 — sharpened below** |

The mapping is an **allowlist in both directions**: a variant is terminal only if named terminal, transient only if named transient. Nothing is inferred from message text. DW-C1's "no string sniffing" is therefore structurally enforceable, not just asserted.

**Backoff:** exponential + jitter, bounded, cancelable, at the attempt level. **Not** Retry-After-driven: B12 is confirmed by the schema — `usageLimitExceeded` is a bare string with nowhere to put a reset hint. This is where the deliberately-dropped G4.2 backoff finally belongs.

---

## 5. Decisions — resolved after review round 1

Both lenses (authority + code/execution) converged on these; recorded as settled with the reasoning that won.

- **D-1 — `budget.maxParallelism` collision → SPLIT the name.** Neither "report 16" (admitted-false once the pool exists) nor "report pool size" (misleads a script sizing `parallel()` batches off the same field) is right, because `maxParallelism` already *means* `parallel()`'s bound. Resolution: leave `budget.maxParallelism` unchanged (=16) and give the pool its own field `budget.agentConcurrency`. Reflected in §3.
- **D-2 [→ p3e] — spend ceiling as "input error".** Reuse `workflowInputError` (follows B7's `MAX_AGENT_CALLS` precedent, correct non-retryable semantics); fix the user-facing *message*, don't mint `workflow_budget_exhausted`. Deferred with B.
- **D-3 — `other`/null/future variant ⇒ transient (today's default unchanged), WITH observability.** Terminal is a strict allowlist; anything not provably terminal keeps today's retryable behavior, so C is a pure *narrowing* of retry scope — zero behavior change for unclassified failures. Review (authority lens) correctly flagged this departs from the codebase's own invariant at `workflow-runtime.ts:568-572` ("a newly introduced failure code defaults to non-retryable until listed"); accepted as a **deliberate, documented exception** because the cost is asymmetric (flipping to terminal kills good runs on the *common* transport-failure path to guard a rare rename). The exception is only safe if observable: the backend emits a distinguishable signal when a live failure lands in the unclassified bucket, so a codex rename that degrades a variant into "transient forever" surfaces in logs. Promoted to a hard requirement — **DW-C6**.
- **D-4 — terminal backend failure ⇒ throw a terminal-coded error (not return `null`).** This repo's existing contract is that a bare `agent()` always throws; `parallel()`/`pipeline()` already convert throws to `null`, so only a bare `agent()` would differ from native. Returning `null` only for the terminal case is a silent partial behavior change — a hand-written script without a null-check gets a confusing generic `TypeError` instead of an informative terminal-coded error. Throwing is both the smaller change and the clearer failure, and it leaves the `failTask` reachability the handoff worried about untouched.

---

## 6. Open questions (non-blocking)

- **O-1** — pool size formula: native CPU-based `min(16, cores-2)` vs an I/O-oriented bound, given codex agents are remote I/O-bound calls, not CPU work. Parity chosen for now.
- **O-2** — B6: should a failed agent's token spend count toward `spent()`? Today it is invisible; the ceiling therefore under-counts real cost.
- **O-3** — `src/runtime/async-queue.ts` is pre-existing dead code (B14). Out of scope for this change; flagged for separate removal.
- **O-4** — worktree-add burst is not gated by the pool (§4A). Accepted (git serializes add safely); a lighter git-I/O gate is possible if contention ever appears.
- **O-5** — pool releases on `generated` settle, which precedes app-server `turn/completed` confirmation, so an aborted dispatch's provider turn can briefly outlive its permit. Accepted as native-parity (any client-side pool has this); a full quiescence contract (hold until authoritative `turn/completed` + bounded interrupt grace) is deferred backend work.
- **O-6 (impl-review finding 1, confirmed: 136ms→473ms with pool on)** — the honest-bound fix (O-5/DW-A6: hold the permit until the abandoned dispatch settles) is in direct tension with the stall mechanism: when an attempt stalls, its permit is held until the orphaned dispatch unwinds, and the *retry's* `acquire()` blocks on it with no clock of its own, so stall-retry serializes behind the orphan rather than behind `agentStallTimeoutMs`. For the real backend this bites when a turn is stuck in the pre-`waitForTurn` RPC phase (before its abort listener exists), bounded by `rpcTimeoutMs`. **This is a genuine tradeoff between two reviewer-flagged concerns (design-review blocker 2 wants the honest bound; impl-review finding 1 wants stall responsiveness); they are contradictory when the orphan lingers.** Not fixed here: A is default-off, and resolving it (bound the retry's acquire by the stall clock, or release on abandon and accept teardown overlap) is a design decision, not a mechanical fix. Must be settled before the pool is enabled by default. Surfaced to owner with the flip decision.
- **O-7 (impl-review finding 2)** — `agentConcurrency: 'auto'` calls `availableParallelism()` fresh each process start, so `budget.agentConcurrency` can differ between a run's launch and its resume if host CPU count changes. Unlike the other (constant) budget fields it is environment-dependent. Low practical odds (same-host resume is the norm) but unguarded. Mitigation for determinism-critical runs: pin a fixed integer instead of `'auto'`. A durable pin (resolve once at launch, reuse on resume) would touch genesis/journal state — deferred with p3e's journal work.

## 7. Gates

- **G-C0 (blocked C) — CLOSED 2026-07-15, with authority rather than inference.** The wire shape of `codexErrorInfo` was unverified; a mapping keyed on the wrong casing would have been dead code that silently never matches. Settled by generating the protocol schema **from the installed binary itself**:
  ```
  codex app-server generate-json-schema --out <dir>
  # → v2/TurnCompletedNotification.json  ·  definitions.CodexErrorInfo / definitions.TurnError
  ```
  This is the authoritative wire contract, not a sample of one failing turn, so it also pins variants we would never hit in a probe. It overturned three of this design's own first-draft assumptions (casing, uniform-enum shape, `httpStatusCode` as a classification signal) — see §4C. **C is unblocked.**

  Standing rule this leaves behind: regenerate and diff this schema when the pinned codex version moves, since the mapping is an allowlist and a renamed variant degrades silently into the D-3 bucket.

## 8. Design-verify reviewer allocation (recorded, 2026-07-15)

| Slot | Intended | Actually ran | Effect on confidence |
|---|---|---|---|
| Authority / logic / concept lens | FRONTIER (Fable 5) | **Sonnet 5** — Fable 5 hit a monthly spend limit mid-review and returned nothing | Tier downgrade, kind preserved. Not retried: a live spend limit is not something to retry-storm. |
| Code / execution lens | Codex CLI (cross-family, read-only) | Codex CLI 0.144.1 | Intact. This is the independence-critical lens. |

Kind diversity survived (authority + code/execution, cross-family), so this is a **tier downgrade, not a family collapse** — verdicts remain eligible for CONFIRMED. The code/execution lens (Codex) ran a full, non-wandering review and independently regenerated the codex schema to the **same SHA-256** (`900bc6e4…`) that the fixture is pinned to — G-C0 is settled on reproducible bytes, not a single reading.

### Union of both lenses (act on the union — different-kind divergence is the expected signal)

**Convergent (both lenses, high confidence):** pool honesty under abort (Blocker 2); live `spent()` breaks resume determinism (Blocker 1); `$defs`→`definitions`; settings exact-object test breaks.

**Additional from the code/execution lens, folded into A/C scope:**
- **A — release-on-`generated`-settle is the right fix but has a bounded residual.** `generate()` rejects on the abort signal via `waitForTurn`'s local listener *before* the app-server confirms `turn/completed`, so a brief teardown window can hold more live provider turns than the pool size. This residual is **inherent to any client-side pool** (native releases on its own subagent-promise settle too and cannot prove the remote call stopped), so releasing on `generated` is native parity and is what A ships. The full "provider-turn quiescence" contract (hold until authoritative `turn/completed`) would require backend-abort surgery whose blast radius exceeds the pool — recorded as **O-5**, not done in A. Flagged to owner as the one judgment call.
- **C — scope is larger than the first draft and expands *within* the backend boundary (still no journal/resume touch):**
  - Adding `.kind` to a thrown error is **inert** unless a typed-error guard runs *before* `codedAgentFailure` (`:6629`), which today only preserves errors that already carry a stable `.code`. C must map kind→stable workflow code at the boundary and test through `runAgentAttempt → failTask`, not the backend in isolation.
  - Classifying only the two `turn.error` sites leaves prepare/start/RPC-timeout/close/wait-timeout/abort **unclassified**. C introduces one backend-neutral failure kind at *every* backend exit; `prepare()` (launch-time, before retry machinery) is handled separately.
  - `turn/completed` status handling is **non-exhaustive** (`:630` treats every non-`failed` as success); the schema has `completed|interrupted|failed|inProgress`, so a buffered `interrupted` can resolve as an empty success. C fixes this with an exhaustive switch — a pre-existing bug on C's exact boundary.
- **Fixture pinned in-repo** at `test/fixtures/codex-schema/TurnCompletedNotification.v0.144.1.json` (was only in scratch) — DW-C5 keys on it.
- **DW-A6 / DW-A1 need a new fake backend** whose provider turn stays live past its abort ACK; the existing fake rejects same-tick and structurally cannot expose the primary regression.

**Overturned by the code/execution lens (corrections applied):**
- **B2 overstated.** A single `parallel()` of one-agent-per-thunk *is* bounded to 16 (each thunk runs one agent under `mapWithConcurrency`). What is unbounded: bare `agent()` bursts, two concurrent `parallel()` batches, nested fan-out, and *multiple* agents per thunk. The gap is real; the example was imprecise. B2 reworded.
- **B13 narrowed.** "Every backend failure is retryable" holds for in-attempt uncoded failures, but `prepare()` failures run before the task/CLI-retry machinery exists — so prepare-time classification is a separate path (folded into C's scope above).

**Deferred to p3e (all B-related):** budget exhaustion swallowed by `parallel()`/`pipeline()` `null`-catch; `remaining() === Infinity` cannot cross the journal boundary (use comparison-only or `null`); failed/retried-turn spend invisible (O-2 becomes blocking for a spend authority); `budget` API extension is not byte-identical if scripts enumerate keys.

### Implementation review (round 2, after A+C landed — 2026-07-15)

Independent adversarial review (Sonnet) of the committed diff `98a0fb8..HEAD`, re-verified by me against real code. Outcome:
- **Finding 1 [HIGH, confirmed] — pool + stall-retry latency.** Real; measured. Recorded as O-6; not fixed (default-off; needs an owner decision). This is the impl-review's counterpoint to the design-review's blocker 2 — the two are in tension.
- **Finding 2 [MEDIUM] — `'auto'` not resume-safe.** Recorded as O-7.
- **Finding 3 [MEDIUM] — DW-A3/A4 lacked tests.** Fixed: added `permit waiting does not count toward the agent stall timeout (DW-A3)` and `cancelling a workflow settles queued permit waiters without hanging (DW-A4)`.
- **Finding 4 [MEDIUM→LOW after re-verification] — SubagentFailure classification lost under concurrent abort.** The reviewer traced `runAgentAttempt` but not `runAgentInner`: the abort catch (`workflow-runtime.ts:3036-3037, 3057`) journals `workflow_aborted` and returns `null`, so the failure reason is **not** flipped to `workflow_input_invalid` — the run's reason is `workflow_aborted` either way. Only the diagnostic log is skipped while aborting, which is acceptable. No code change; over-claim corrected.
- **Latent contract gap (area 2) — a synchronously-throwing backend would leak a permit forever.** Fixed defensively: `backend.generate()` is now wrapped so a sync throw releases the permit before rethrowing.
- Confirmed-correct by the reviewer: pool permit accounting (no leak/double-release), `workflow_agent_terminal` set membership, exhaustive `turn/completed` status, `classifyCodexErrorInfo` hybrid-shape handling.

## 9. Superseded claims

Corrections to the prior handoff, re-derived this session:

| Inherited claim | Verdict |
|---|---|
| "provider Retry-After lives at the agent attempt" | **False** (B12). No retry-after on `CodexErrorInfo`; reset timing is account-scoped only. Backoff must be exponential. |
| "`async-queue.ts` can back the pool" | **Weak** (B14). It is a value-stream queue, not a permit primitive. |
| "feed `spent()` from the journaled usage aggregation" | **True** (B5), with the unstated caveat B6 (failures uncounted). |
| "an outer worker holding a permit while awaiting inner agents self-deadlocks — release before recursing" | **Does not apply** given the §4A placement. Verified, not assumed. |
| (unstated) | `budget` is a frozen data literal (B3) — host-backing is a structural prerequisite the handoff missed. |
