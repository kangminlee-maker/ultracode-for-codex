# Ultracode P12 — Concurrent nested `workflow()` (PG-NEST v2-B)

Status: design (2026-07-16). Branches off `main` after P11 (v2-A) merges. This is backlog item 2 of
the two PG-NEST follow-ons: remove the sequential-only limit so concurrent nested children are safe.

## 1. Goal

v1/v2-A run nested children **sequentially**: `runNestedWorkflow` rejects a second child while one is
in flight (`ctx.nestedInFlight`). The reason (P5 doc §Known-limits) is the **VM value projector**:
`ctx.toVmValue` is a **single shared slot** on the run context, and `trackWorkflowPromise` captures it
at each promise's creation (`workflow-runtime.ts:3823`). Two concurrent children each install their own
realm projector via `setVmValueProjector` → `ctx.toVmValue = projector` (`:2936`), clobbering each
other; a promise created in child A's realm after child B installs would capture B's projector and
**marshal A's structured result into the wrong realm** (silent corruption). The sequential guard avoids
this by construction. v2-B removes the guard by making the projector **per-execution** instead of a
shared `ctx` slot, so `parallel([() => workflow('a'), () => workflow('b')])` runs both safely.

## 2. Design — per-execution projector scope

> Revised after adversarial design-verify (BLOCKER-1/2, MAJOR-3, MINOR-4/5 folded).

`ctx.toVmValue` has **two** read sites (design-verify BLOCKER-1): `trackWorkflowPromise` (`:3823`,
projects a promise's settled value) **and** `runNestedWorkflow` (`:3688`,`:3699`, projects the child's
**return value** into the parent realm — which is why the `host.workflow` wrapper passes
`projectResult=false`, `:2908`). Naively deleting `ctx.toVmValue` would drop the child-return projection
and hand the parent a **child-realm** object (silent regression, invisible to primitive/JSON tests). So
the fix must **re-home the child-return projection onto `trackWorkflowPromise`**, making it the genuine
sole consumer:

- New `interface WorkflowProjectorScope { toVmValue?: (value: unknown) => unknown }` — **one per
  `createVmGlobals` call**, distinct from `WorkflowChildFrame` (NIT-6: the top-level run has a scope but
  no frame; the projector doesn't exist at globals-build time — it's installed later by
  `installWorkflowVmGlobals`→`setVmValueProjector`, `:5994` — so host methods must close over a mutable
  holder written after they're built).
- `setVmValueProjector: (projector) => { scope.toVmValue = projector }` (was `ctx.toVmValue = …`).
- `createVmGlobals` threads its `scope` to **every** `trackWorkflowPromise` call it makes — the complete
  set (MINOR-5): `host.trackPromise` (`:2863`), `host.parallel` (`:2872`), `host.pipeline` (`:2875`),
  `host.workspaceContext` (`:2879`), `host.workflow` (`:2908`), and `host.agent`→`runAgent` (`:2869/2870`).
  Missing any → `capturedProjector` undefined → unprojected host-realm results.
- `runAgent(ctx, prompt, options, scope)` → `trackWorkflowPromise(ctx, operation, true, scope)`.
- `trackWorkflowPromise(ctx, value, projectResult, scope)` → `capturedProjector = projectResult ?
  scope?.toVmValue : undefined`; its recursive `tracking.trackPromise` re-passes the same `scope`.
- **BLOCKER-1 fix — child-return projection moves to the wrapper.** `host.workflow` →
  `trackWorkflowPromise(ctx, runNestedWorkflow(…), **true**, scope)` (was `false`); `runNestedWorkflow`
  returns the **raw** `childResult` (delete its internal `parentProjector`/projection). The wrapper
  captures the **parent** scope's projector at creation, so the raw child-realm result is projected into
  the parent realm exactly as before — but now via the single consumer. (The old `:2906` "don't
  re-project" warning only held because the shared slot was the *child's* projector at wrap time; with
  per-execution scope the wrapper's captured projector is the *parent's*.)
- `runNestedWorkflow`: each child's `createVmGlobals(ctx, frame)` gets its **own** scope. **Delete** the
  `ctx.toVmValue` save/restore, the internal child-return projection, the `ctx.nestedInFlight`
  guard/field, and `ctx.toVmValue`. Child promises capture the child scope; parent promises the parent
  scope — no shared slot, so concurrent children never interfere.

The top-level run (`runTask` → `createVmGlobals(ctx)`, no frame) gets one scope whose projector never
changes after install → **byte-identical** to today's single-slot behavior for every non-nested and
sequential-nested run.

## 3. Contracts & decisions

- **D1 — Per-execution isolation.** Each `createVmGlobals` call owns one `WorkflowProjectorScope`.
  Promises capture the scope of the execution that created them (closure over the host methods), so a
  concurrent sibling's projector install cannot be captured by this execution's promises. Removes the
  clobber that forced sequential nesting.
- **D2 — One-level still holds, independently of concurrency.** C5e is enforced by the child's
  `host.workflow` being the throwing stub (bound by frame presence, `:2901`), **not** by a shared
  counter — so concurrent children still cannot nest further. Unchanged.
- **D3 — Shared run state stays shared.** `agentCount`, `outputTokens`, `previousAgentCallKey`,
  `usedLogicalKeys`, `agentPool`, `controller`, `budgetTotal`, and the single journal writer remain on
  `ctx` — concurrent children share them exactly as sequential children do (C5b/C5d). Only the
  **projector** moves off `ctx`; nothing else. The agent call-key chain is still a single serialized
  chain (agents journal in dispatch order), unaffected by which child created them.
- **D4 — Default-off / byte-identical.** With `--nested-workflows` off, the throwing stub is the only
  path (unchanged). With it on, a non-nested or sequential-nested run behaves identically (one scope,
  projector installed once). Proven by the suite.
- **D5 — the two sequential-rejection tests flip.** Removing `ctx.nestedInFlight` turns BOTH
  sequential-guard tests red (MAJOR-3): N9 (`test/workflow-runtime.test.mjs`, "rejects the second
  child") and the v2-A concurrent test (asserts `{ nulls: 1, ok: 1 }`). Both become "concurrent children
  both run" (`{ nulls: 0, ok: 2 }` / both results present).
- **D6 — child-return projection re-homed (BLOCKER-1, refined during impl).** The naive fix (flip the
  `host.workflow` wrapper to `projectResult=true`) is **wrong**: `handledWorkflowPromise` projects
  **rejection reasons** too, so a child's error would be **double-projected** (child realm → parent
  realm) and stripped to a bare `[object Object]` (caught by the N6 error-propagation test). Instead
  `runNestedWorkflow` takes the **parent scope** and projects only the **success** result via it
  (`parentScope.toVmValue(childResult)`); the wrapper stays `projectResult=false` so the error
  propagates **raw**. The parent scope (not a shared `ctx` slot) still prevents a concurrent sibling
  from misrouting the return. Falsifiable: N6 goes `[object Object]` if the wrapper is flipped to
  `true`.
- **D7 — realm mismatch is value-benign in this sandbox; falsification is behavioral.** Each execution
  gets a fresh `createWorkflowVmContext()` realm, but the sandbox exposes **no intrinsics** (`Object` is
  undefined → `instanceof`/`Object.getPrototypeOf` unavailable) and projection **preserves properties**,
  so a wrong-realm structured result is **not observable** from inside a script (an `instanceof`-style
  control cannot run, let alone falsify). The per-execution scope is therefore the correct **structural**
  fix for a latent hazard, and the falsifiable signals are: (a) **behavioral** — with the guard restored,
  one concurrent sibling is rejected (only 1 of 2 runs); (b) **N6** — the return-projection re-homing
  (D6) preserves raw error propagation. The concurrent test asserts both children run and return
  **value-correct** structured results.

## 4. Files to touch

- `src/runtime/workflow-runtime.ts` — `WorkflowProjectorScope` type; `createVmGlobals` owns a scope +
  threads it; `runAgent` + `trackWorkflowPromise` gain a `scope` param; `runNestedWorkflow` drops the
  guard + save/restore; remove `ctx.toVmValue` + `ctx.nestedInFlight`.
- Tests: replace N9 with a concurrent-children-both-run + per-realm-correctness test; keep the
  sequential N-series (they still pass — sequential is a subset of concurrent-capable). Add a
  structured-result-per-child realm test under `parallel([workflow, workflow])`.
- `CHANGELOG.md`; `docs/ultracode-p5-nested-workflow.md` sequential-limit note → done pointer.

## 5. Done-when / verification

- Design-verify (adversarial subagent) on this doc; re-verify each finding vs code.
- Unit: concurrent children both run + return value-correct structured results; N6 error propagation
  preserved (return-projection re-homing, D6); sequential N-series stay green; byte-identical with
  `--nested-workflows` off.
- Falsifiability: (a) restore the `nestedInFlight` guard → the concurrent tests fail (one sibling
  rejected); (b) flip the `host.workflow` wrapper to `projectResult=true` → N6 fails with `[object
  Object]`. Restore both.
- CLI end-to-end smoke: a parent that runs two nested children in `parallel` returns both results.
- `npm run test:all`; dogfood + `chatgpt-codex-connector` bot MERGE GATE.

## 6. Known limits (v2-B)

Still one-level (C5e). Still `--nested-workflows` gated, not inherited on resume. Concurrency of nested
children is bounded by the same `agentConcurrency` pool their agents already share (no separate
child-level parallelism cap). **Resume of concurrent-nested runs is best-effort for UNKEYED agents**
(MINOR-4): because `resolveNestedChild`/`assertNestedChildPermitted` are async, the merged agent
encounter order across concurrent children is nondeterministic, so an unkeyed agent's positional resume
identity can shift — use logical `key()` for agents inside concurrently-nested children that must resume
deterministically. (The hash chain itself stays intact — the call-key critical section in
`runAgentInner` is synchronous and this is the same concurrency top-level `parallel()` already had.)
