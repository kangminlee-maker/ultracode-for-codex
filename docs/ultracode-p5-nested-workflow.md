# Ultracode P5: Nested `workflow()` sub-workflows (Design)

Status: IMPLEMENTED — v1 scope = **built-in + inline children only**, default-off
(owner-approved 2026-07-15 after 2-lens design-verify). `npm test` 125/125; CLI E2E
verified (nested on → child runs; off → throws stub). All DESIGN-VERIFY OUTCOME fixes
folded: per-execution projector (capture-at-creation + restore), args-by-frame-presence,
`▸ name › phase` composed grouping, built-in/inline scope (deletes the security/isolation
findings), inert `budget.nestedWorkflows` field dropped. Date: 2026-07-15.
Branch `parity/workflow-nested` @ base `938f461` (v0.4.5). Parity item PG-NEST from
`memory:parity-gap-map-2026-07`. Full-scope expansion (project/user/plugin/{scriptPath}
behind the permission gate) is BACKLOG. Built-in workflows do not use worktree isolation,
so the isolation-review gap does not bite v1; an inline child requesting worktree fails
closed (documented v1 limit).

## Goal

Implement the native Workflow `workflow(nameOrRef, args?)` hook: run another workflow
inline as a **child** that shares the parent run's concurrency pool, agent counter,
abort signal, and token budget, returns the child's result, and remains resumable.
Currently a throwing stub (`workflow-runtime.ts:2818-2820`).

Native contract (parity target):
- C5a `name` → saved/built-in resolution; `{scriptPath}` → file.
- C5b child SHARES concurrency cap / agent counter / abort signal / token budget.
- C5c child agents grouped under `▸ name`.
- C5d child tokens count toward `budget.spent()`.
- C5e one-level nesting only — `workflow()` inside a child throws.
- C5f throws on unknown name / unreadable scriptPath / child syntax error (catchable).

## Key enabling facts (verified against code + a focused journal/resume audit)

1. **The agent call key is script-agnostic.** `computeWorkflowAgentCallKey` hashes only
   `(previousAgentCallKey, prompt, semanticOpts)` — or `(logicalKey, prompt, semanticOpts)`
   — with **no** workflowName/scriptHash/runId (`workflow-journal.ts:361-373`). So a child's
   agents chain into the parent's single hash chain with no collision and no divergence from
   crossing scripts.
2. **The journal writer lives on the task, not the run context:** `ctx.task.journal.append`
   (`workflow-runtime.ts:2936,3021,…`). A child sharing the same `ctx` shares the one writer.
3. **Run-scoped mutable state lives on `ctx`** (`:2660-2681`): `agentCount`, `outputTokens`,
   `previousAgentCallKey`, `usedLogicalKeys`, `agentPool`, `controller` (abort), `budgetTotal`.
   All are read/mutated in `runAgentInner` (`:2889,2916-2932,3036,2905-2911`). A child that
   shares the same `ctx` object shares every one of them — matching C5b/C5d exactly, for free.
4. **The journal is strictly single-run.** `entries[0]` must be `workflow.run.started`
   (`workflow-journal.ts:430`), and every later entry must match that start's `taskId`/`runId`
   (`:450-452`). There is exactly one hash chain across all agents (`:435,463-479`), with global
   uniqueness on `agentId`/`agentIndex`/`agentCallKey`. **Therefore a child must NEVER emit its
   own `run.*` entry; it appears only as `agent.*` entries on the parent's chain.**
5. **`resolveNamedWorkflow(name)`** (`:2389`, project→user→plugin→built-in) and the scriptPath
   read path already turn a name/path into a script; `parseInlineWorkflowScript` turns a script
   into `{meta, body, metaLiteral}` and throws on syntax/meta errors — reusable for C5a/C5f.
6. **Re-entrancy is safe.** By the time a script calls `await workflow(...)`, the parent's
   `runInContext` has already returned (its `__workflow_main` promise is pending in the event
   loop). `host.workflow` runs the child in its OWN fresh VM context and returns a promise the
   parent awaits — no nested `runInContext`.

## Design

### Core: a child shares the parent `ctx`; `host.workflow` bypasses launch/runTask

`host.workflow(nameOrRef, childArgs)` (bound to the parent `ctx` and the registry `this`):

1. **Feature gate (default-off).** If nested workflows are disabled, throw the existing
   "not supported" error — byte-identical to today. When enabled, proceed. (Gate details below.)
2. **Resolve + validate `childArgs`** as a JSON value, exactly like top-level `args`
   (`journalJsonValueOrInputError`).
3. **Resolve the child script (C5a / C5f) — v1 built-in/inline only** (`resolveNestedChild`):
   - `typeof nameOrRef === 'string'` → `this.findBuiltinWorkflow(nameOrRef)` (synchronous, no
     I/O; unknown → throws). project/user/plugin name resolution is deferred (permission gate).
   - `{ script: '<text>' }` → parse the inline child directly (its text is part of the
     already-approved parent script — a permission-free `inline` source).
   - `{ scriptPath }` → **rejected in v1** (arbitrary file exec; deferred behind the gate).
   - `parseInlineWorkflowScript(script)` → `childParsed` (syntax/meta error → throws). All these
     rejections propagate to the parent's `await workflow(...)`, catchable per C5f. Resolution is
     synchronous, so nested resolution adds no I/O interleaving to the merged agent order.
4. **Execute the child on the shared `ctx`:**
   `const childGlobals = this.createVmGlobals(ctx, { args: childArgs, nested: true, group: '▸ ' + childParsed.meta.name, metaSource: childParsed });`
   `const result = await executeInlineWorkflow(childParsed, childGlobals, ctx.controller.signal);`
   Because `host.workflow` calls `executeInlineWorkflow` directly (NOT `launch`/`runTask`), **no
   child `run.started` is written**; the child's `agent()` calls flow through the same
   `runAgentInner` → the same `ctx` counters/chain and the same `ctx.task.journal` (invariant #4).
5. **Return `result`** (whatever the child's top-level `return` produced).

### `createVmGlobals(ctx, frame?)` — a small parameterization

Today `createVmGlobals(ctx)` binds every hook to `ctx` and reads `ctx.input.args`. Add an
optional `frame` so a child can differ from the top-level WITHOUT mutating the shared `ctx`
(so concurrent `workflow()` calls never corrupt each other's display state):

- `argsLiteral = vmDataLiteral(frame?.args ?? ctx.input.args, 'args')`.
- `host.workflow`: top-level (no frame) → the real nested executor; child (`frame.nested`) →
  a hook that throws `workflowInputError('workflow() cannot be nested more than one level.')`
  (C5e). The one-level rule is enforced by *which* hook the frame binds, not a shared counter,
  so it is concurrency-safe.
- **Per-child display frame (not on `ctx`):** `frame` carries a closure-local `currentPhase`
  (initially undefined) and `group`. The child's `host.phase(title)` updates
  `frame.currentPhase` (+ emits `workflow.phase.started`) instead of `ctx.currentPhase`; the
  child's `host.agent(prompt, opts)` resolves the event phase as
  `opts.phase ?? frame.currentPhase ?? frame.group`. `metaSource` (childParsed) is used for
  phase-detail lookup. The **top-level path is unchanged** (no frame → reads/writes
  `ctx.currentPhase` exactly as today → byte-identical when nested is off).

This is the one place the display state is deliberately *not* shared: counters/budget/chain/
journal/abort/logical-keys share `ctx` (correctness); phase/group live in the per-execution
frame (display, concurrency-safe).

### Grouping (C5c)

Child agents carry `frame.group = '▸ <childName>'` as their default phase when the child sets
no phase of its own, so they render under a `▸ name` group. The group is a display value only;
it is **never** an input to `computeWorkflowAgentCallKey` (invariant #1), so it cannot affect
resume identity.

## Invariants the implementation must hold (from the audit)

1. Never append a second `run.started` (or any `run.*`) for a child — child work is `agent.*` only.
2. One shared `taskId`/`runId`, one shared `previousAgentCallKey`/`agentCount` → `agentId`/
   `agentIndex`/`agentCallKey` stay globally unique and chained.
3. Preserve deterministic merged encounter order (already required by `parallel()`); the child
   must be driven through the parent `ctx`, never a separate chain.
4. `usedLogicalKeys` stays one shared run-global namespace (a separate child Set would emit a
   duplicate `agentCallKey` and poison the journal). Shared `ctx` gives this automatically; a
   parent+child reusing a logical key throws by design (correct).
5. The `▸ name` group must not enter `computeWorkflowAgentCallKey`.

## Default posture / reversibility

Default-**off**, mirroring `agentConcurrency`. A setting `workflow.nestedWorkflows` =
`disabled` (default: `host.workflow` throws the current message → byte-identical by diff) |
`enabled`, plus a `--nested-workflows` flag and a `budget.nestedWorkflows` script-visible field.
Rationale: the capability only activates on an explicit `workflow()` call, but it interleaves a
second script into the shared journal/resume stream — the highest-leverage correctness surface —
so we land it dormant, validate (incl. resume across nesting), then flip in a later change, as
G1/A did. When off, the diff's only reachable behavior is the unchanged throw.

## v1 scope

IN: C5a (**built-in name + inline `{ script }`**), C5b/C5d (shared pool/counter/abort/budget via
shared `ctx`), C5e (one-level throw), C5f (resolution/parse errors, catchable), return value,
C5c `▸ name › phase` composed grouping, resume across nesting (free via the shared script-agnostic
chain).

OUT / accepted v1 limits (documented, not regressions):
- **Source scope**: only `built-in` names and inline `{ script }` (the permission-free sources).
  `project`/`user`/`plugin` names and `{ scriptPath }` (arbitrary file exec) are deferred behind the
  reused permission gate — the FULL-scope expansion backlog item.
- **Sequential nesting only**: a `workflow()` started while another child is in flight is rejected
  (`ctx.nestedInFlight`). The shared VM projector (`ctx.toVmValue`) is a single slot, so two
  concurrent siblings would clobber each other's realm; sequential nesting keeps
  capture-at-creation + save/restore correct. Concurrent nested children need the projector moved
  off `ctx` (per-execution) — deferred with the full-scope work.
- **A nested child does not announce a progress plan**: `announcePlan`/`announcePhasePlan` mutate
  parent-only `ctx` plan state that a child sharing `ctx` would corrupt, so they are inert no-ops for
  a child. The child's agents still group under `▸ name`.
- **Resume needs the flag re-passed**: like `--budget`, `--nested-workflows` is not inherited on
  resume; a resumed nested run without it disables nesting and the `workflow()` call throws. Re-pass
  the flag when resuming a nested run.
- **No new resume authority**: the child's own `scriptHash` is not recorded (invariant #4); a
  changed child is detected implicitly by call-key divergence (native prefix semantics).

## DOGFOOD OUTCOME (2026-07-15, built-in `code-review` on the diff, findings re-verified)
20 candidates / 20 verified. Two P1s both resolved by the **sequential-nesting guard** (they were
the concurrent-sibling projector-clobber and concurrent-unkeyed-resume-instability — the guard
removes concurrent siblings, and v1's synchronous resolution removes the resolve-I/O ordering
concern). P2s folded: child `opts.phase` now composes under the group (not replace); child
`announcePlan`/`announcePhasePlan` made inert no-ops; docs aligned to built-in/inline; resume-needs-flag
documented. Added tests: N9 (concurrent nested rejects) + a built-in-name resolution test.

## Verification plan (falsifiable)

Unit (`test/workflow-runtime.test.mjs`), each must fail if the mechanism is wrong:
- **N1 return + resolution:** parent `return await workflow('child')` returns the child's value;
  child resolved from a registered built-in/`userWorkflowDirs`. Negative: unknown name rejects
  with a resolution error; bad `{scriptPath}` rejects; a child with a syntax error rejects — all
  catchable in the parent (`try/catch` returns a sentinel).
- **N2 shared counter/budget (C5b/C5d):** a parent with 1 own agent + a child with 2 agents ends
  with `budget.spent()` = sum of all three and `agentCount` = 3; a `--budget` ceiling that the
  combined spend exceeds trips inside the child (proves the ceiling is shared, not per-child).
- **N3 one-level nesting (C5e):** a child that calls `workflow(...)` rejects with the nesting
  error; contrast: the parent calling `workflow()` succeeds.
- **N4 resume across nesting:** run parent+child to completion, then resume with the identical
  scripts → 100% cache hit (no backend calls); then resume with the CHILD's second agent prompt
  changed → cache replays the prefix up to that call and re-runs from it (negative control:
  assert the backend is called exactly for the diverged tail). This is the load-bearing test.
- **N5 no second run.started:** assert the journal has exactly one `workflow.run.started` and one
  terminal entry, with all child agents present as `agent.*` on the single chain
  (`validateWorkflowJournal` passes).
- **N6 logical-key namespace:** parent and child both using `key:"x"` → the second throws
  (shared namespace); a child using a key the parent didn't → fine.
- **N7 default-off:** with the feature disabled, `workflow(...)` throws the current
  "not supported" message; enumeration/behavior of a non-nesting workflow is byte-identical
  (contrast test).
- **N8 abort propagation (C5b):** aborting the parent mid-child cancels the child's in-flight agent.

Gate: `npm test` full green + typecheck. Then two-kind adversarial design-verify (this doc)
BEFORE coding; then implement default-off; then dogfood `code-review` on the diff; re-verify;
present for squash-merge.

## DESIGN-VERIFY OUTCOME (2026-07-15, two adversarial lenses + self re-verify)

Two lenses (execution-correctness + parity/scope) CONVERGED on one BLOCKER and surfaced
several MAJORs. All re-verified against code. Corrections to fold before coding:

- **[BLOCKER] `ctx.toVmValue` is shared-ctx state the design misclassified.** It is the
  per-VM-context value projector (`:2842-2844`, set per context at `:5689`, read live at settle
  `:3555`). A child clobbers it and never restores → parent structured-agent results after/
  concurrent-with the child marshal through the child's (defunct) realm — silent wrong-realm
  corruption (primitives unaffected, hiding it). FIX: make the projector **per-execution** (a
  local in each `createVmGlobals` call captured by that execution's `trackWorkflowPromise`), NOT
  `ctx.toVmValue`; and **project the child's return value into the PARENT realm** before returning.
  Add `toVmValue`/projector to the "framed, not shared" set.
- **[MAJOR/security] child bypasses the permission gate.** `host.workflow`→`executeInlineWorkflow`
  skips `requireWorkflowPermission` (`:2178-2195`); `project`/`user`/`plugin`/`script_path` are
  permission-required (`:563`). An approved parent could run unreviewed content, incl.
  `{scriptPath:'/any/file'}`. → **v1 scopes nesting to `built-in` (+ inline) children only** (the
  non-permission sources), deleting this hole; permission-gated sources deferred behind the reused
  gate. Also fixes the isolation-review gap below.
- **[MAJOR] isolation review covers only the parent script** (`:1716`,`:2664`,`:2913`), so a child
  using `isolation:'worktree'` fails closed unless the parent coincidentally uses it. Built-in/
  inline scope + unioning the (known) child's `workflowRequestedIsolationModes` into the review at
  resolve time resolves it without a new grant.
- **[MAJOR] argless child inherits parent args** — pick source by frame PRESENCE, not
  arg-nullishness: `frame ? vmDataLiteral(frame.args) : vmDataLiteral(ctx.input.args)`.
- **[MAJOR] `▸ name` grouping lost when the child calls `phase()`** (built-ins do, heavily) →
  COMPOSE: effective phase = `frame.currentPhase ? \`${group} › ${currentPhase}\` : group`. The
  child needs a SEPARATE phase impl (frame + metaSource), and its agent hook must ALWAYS inject an
  explicit `opts.phase` (else `runAgentInner`'s `?? ctx.currentPhase` fallback mis-tags `:2934`).
- **[MAJOR] concurrent-nested resume is best-effort** (child resolve I/O interleaving makes merged
  order less deterministic than flat `parallel()`); "free resume" holds for sequential + keyed
  concurrent only. Document as best-effort (recommend logical keys), add a concurrent N4 test, and
  N4's negative control must expect the WHOLE diverged tail (changed child agent + every later
  parent agent, since chain divergence changes their keys).
- **[MINOR] drop the inert `budget.nestedWorkflows` field** (no consumer; a script nests by
  CALLING `workflow()`, and disabled throws catchably). Keep setting + `--nested-workflows` flag.
- Default-off is acceptable ONLY with a **committed flip milestone** (else the flagship ships
  permanently-inert surface).

CONFIRMED SOUND: synchronous counter/chain claim (no race), no second `run.started`, abort/
finalizer sharing, MAX_AGENT_CALLS, logical-key poisoning defense.

Meta (both lenses): the "flagship" framing is over-weighted — P4 hybrid already fans out via
separate runs, not in-script nesting. **Smallest viable = built-in/inline-only nesting**, which
deletes the security/isolation findings and matches the realistic use (nesting `code-review`/`task`).

## Open decisions (for owner — pre-implementation)
1. **Scope**: built-in/inline-only v1 (RECOMMENDED — deletes security/isolation findings) vs full
   all-sources (reuse the permission gate; larger surface) vs reconsider/defer PG-NEST.
2. Default-off gate + committed flip milestone (recommended) — setting + `--nested-workflows` flag,
   drop the inert budget field.
3. Confirm the `toVmValue` per-execution-projector fix (mandatory regardless of scope).
