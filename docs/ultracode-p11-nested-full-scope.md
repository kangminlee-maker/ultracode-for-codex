# Ultracode P11 — Nested `workflow()` full-scope sources (PG-NEST v2-A)

Status: design (2026-07-16). Branch `parity/pg-nest-fullscope` off `main@c523a99`.
Builds on P5 (nested v1, built-in/inline only). This is backlog item 1 of the two PG-NEST
follow-ons; concurrent nesting (item 2) is a separate PR (P12).

## 1. Goal

v1 `workflow(nameOrRef)` nests **built-in names + `{ script }`** only; `resolveNestedChild`
(`workflow-runtime.ts`) hard-rejects `project`/`user`/`plugin` names and `{ scriptPath }`. Close
the native contract C5a (`name` → saved/built-in; `{ scriptPath }` → file) by expanding the
resolvable child sources, **behind the existing `--nested-workflows` gate**, without letting a
child run **unreviewed** content under the parent's grant.

## 2. The authority problem & the design

The top-level launch permission gate (`workflowPermissionRequired`) is **interactive**: for a
`script_path`/`project`/`user`/`plugin` source it either finds a matching `allow` **record** or
returns a `permission_required` result the CLI prompts on (under `--permission ask`) / auto-allows
+ records (under `--permission allow`). A nested child resolved **mid-run** cannot replay that
prompt — the run is already streaming, often in the background.

**Design: nested children from a permission-required source are gated by the permission RECORD
only — fail-loud if not already approved.** At child resolution:

- source ∈ {`built_in`, `inline`} → **no permission** (unchanged from v1; built-in registry and the
  inline text are part of the already-approved parent script).
- source ∈ {`project`, `user`, `plugin`, `script_path`} → compute the child's `workflowPermissionKey`
  (source, path, name, scriptHash) and read `workflowPermissionRecord(key)`:
  - `allow` **and** the record matches the child's current isolation review → **run the child**.
  - `deny` → throw `workflowPermissionDeniedError` (catchable per C5f).
  - **unapproved / stale review** → throw `workflowInputError`: the child needs prior approval;
    there is no mid-run prompt. Because the permission-record store is memoized per runtime
    (`this.permissionRecords`, never invalidated, `:2409-2411`), a grant written by a separate
    "run-it-directly" process is not seen by an already-running parent — so the message must tell the
    user to approve the child directly once **and re-launch the parent** (MINOR-5). Authority-safe: the
    memoized store can only produce false-negatives (fail-closed), never false-positives, because keys
    embed the content hash.

This is the safe non-interactive posture: **a parent can only nest a permission-required child the
user has already independently vetted** (exact key = source+path+name+scriptHash). Editing the child
changes its `scriptHash` → key miss → unapproved → fail-loud (no silent stale-content execution).

### Isolation needs no new code (deliberate)

A nested child runs on the parent's `ctx`, and every agent's isolation is already checked at
dispatch against `ctx.isolationReview` (`workflow-runtime.ts:3026`,
`workflowIsolationReviewAllowsMode`). So a child's agent that requests `worktree` is **already**
constrained to the parent run's approved isolation review. Consequence, by construction: a nested
child **cannot use an isolation mode beyond what the parent run was approved for** — no silent
authority widening (which a naive "union the child's modes into the review" would cause, since the
user approved the parent, not the child's extra modes). A child needing `worktree` therefore
requires the **parent** to have been approved for `worktree`. Documented limit, not a gap.

## 3. Scope

> Revised after adversarial design-verify (findings folded below).

- **In:** `resolveNestedChild` resolves a **string name** via `resolveNamedWorkflow` (project → user →
  plugin → built-in), record-gated for the permission-required sources; `{ script }` inline (unchanged);
  clear catchable errors for unknown name / denied / unapproved (C5f). Still **sequential** (v1
  `nestedInFlight` guard preserved — concurrency is P12). Still **one-level** (C5e). Behind
  `--nested-workflows` (default off).
- **`{ scriptPath }` — DEFERRED (design-verify MAJOR-2).** `readRuntimeWorkflowScript`
  (`workflow-runtime.ts:2547+`) confines a `scriptPath` ref to the runtime's **own** scripts dir
  (`pathInsideOrEqual(workflowScriptsDir, …)` → "must point to a runtime-owned workflow script") — so
  the "arbitrary file exec" framing was **overstated**; a `{ scriptPath }` can only reference
  already-persisted runtime scripts. But every such script carries a `.meta` recorded under its
  **original** source, so a nested `{ scriptPath }` either (a) with the trusted-metadata source upgrade
  resolves to `inline`/`built_in` and **skips the record gate**, or (b) without it needs a
  `script_path`-keyed allow record that in practice never exists → dead-on-arrival. Neither is a clean,
  useful, safe semantics, and the capability is niche (the same scripts are reachable by **name**). So
  v2-A keeps rejecting `{ scriptPath }` (as v1) with a clear message; it is a documented follow-on.
- **Out (documented):** mid-run interactive approval (structurally impossible for background runs);
  isolation-review widening (unsafe — see §2); concurrent nested children (P12).

## 4. Contracts & decisions

- **D1 — Record-only gate, fail-loud.** No new flag; reuses `--nested-workflows` + the existing
  permission **record** store. `assertNestedChildPermitted` mirrors the top-level allow-check
  structure **exactly** (`:2240-2249`): explicit `record?.decision === 'allow'` **and**
  `workflowPermissionRecordMatchesCurrentReview(record, childRequestedReview)` → pass; explicit
  `record?.decision === 'deny'` → `workflowPermissionDeniedError`; else → `workflowInputError`
  (unapproved). The matcher is `…MatchesCurrentReview` (the same one the top-level `allow` path and
  `recordWorkflowSourceAllow` use — **not** `…MatchesMetadata`, which is the scriptPath-sidecar path);
  it does not check `decision`, so the explicit decision branches are load-bearing. Never a mid-run
  prompt, never silent execution of unreviewed content.
- **D2 — Resolution reuse, name only.** String name → `resolveNamedWorkflow(name)` (already
  project→user→plugin→built-in, throws `namedWorkflowNotFoundError`). `{ script }` → inline (unchanged).
  `{ scriptPath }` → still rejected (§3). `scriptHash` is computed from the **exact** text that is then
  parsed and executed (no re-read between hash and exec) so there is no TOCTOU; the child's own
  isolation review = `workflowRequestedIsolationModes(childScript)` feeds the matcher.
- **D3 — Default-off; name-precedence change is intentional parity.** `--nested-workflows` disabled →
  the throwing stub, byte-identical. Enabled → `{ script }` inline nesting is unchanged, but **nested
  name resolution now follows the top-level project→user→plugin→built-in precedence** (v1 was
  built-in-only). So `workflow('code-review')` that hit the built-in in v1 resolves to a same-named
  **project** `code-review` if one exists — a gated source that runs it (if approved) or fails loud (if
  not), matching top-level semantics. Intended parity, but a behavior change for shadowed names —
  tested (shadow-precedence) and documented, not "unchanged."
- **D4 — Isolation, no code.** `ctx.isolationReview` = the parent run's approved review
  (`:2718`, never reassigned during nesting); the per-agent dispatch check (`:3026`) already constrains
  a child's agents to it. A child cannot exceed the parent's approved review (no silent widening — which
  a naive union would cause). A child requesting a mode beyond the parent's review fails at that agent's
  dispatch. Over-restriction (a child independently approved for worktree, blocked under a non-worktree
  parent) is a documented limit; its message refers to the parent's review (MINOR-6, cosmetic).
- **D5 — In-flight guard ordering (design-verify BLOCKER-1).** Because resolution is now **async**
  (`resolveNamedWorkflow` FS I/O + async record read), `ctx.nestedInFlight = true` must be set
  **synchronously before the first await**, and one `try { resolve+gate+execute } finally {
  ctx.nestedInFlight = false; ctx.toVmValue = parentProjector }` must cover **resolution too** — else
  (a) two concurrent `workflow()` calls both pass the guard and clobber the shared projector (the v1
  BLOCKER), and (b) a caught unapproved/denied throw during resolution would wedge `nestedInFlight`
  stuck true. `parentProjector` is captured before the await.
- **D5 — Resume.** Unchanged from v1: a child emits only `agent.*` on the parent's single hash chain;
  the permission record lives in the same store the top-level gate uses, so a resumed run re-checks
  the same records. `--nested-workflows` is not inherited on resume (v1 limit, unchanged).

## 5. Files to touch

- `src/runtime/workflow-runtime.ts` — `resolveNestedChild` becomes async, resolves the full source
  set + applies the record gate (a new `assertNestedChildPermitted(resolved, parsed, scriptHash)`
  reusing `workflowPermissionKey` / `workflowPermissionRecord` /
  `workflowPermissionRecordMatchesCurrentReview` / `workflowPermissionDeniedError`); `runNestedWorkflow`
  awaits it. Return the resolved source metadata alongside the parsed script so the gate can key on it.
- Tests: full-scope resolution (built-in still works; project/user/plugin/scriptPath resolve),
  permission gate (approved → runs; unapproved → fail-loud; denied → throws), isolation constraint
  (child worktree agent fails under a non-worktree-approved parent), still-sequential, still-one-level.
- `CHANGELOG.md` `[Unreleased]`; `docs/ultracode-p5-nested-workflow.md` backlog note → done pointer.

## 6. Done-when / verification

- Design-verify (adversarial subagent) on this doc before coding; re-verify each finding vs code.
- Unit: the resolution + gate + isolation matrix above; **byte-identical with `--nested-workflows`
  off**; v1 built-in/inline tests stay green.
- Falsifiability: drop the record gate → an unapproved project/scriptPath child runs → the gate test
  fails; restore.
- CLI end-to-end smoke: a parent that nests an approved project workflow runs; nesting an unapproved
  one fails loud.
- `npm run test:all`; dogfood + `chatgpt-codex-connector` bot MERGE GATE.

## 7. Known limits (v2-A)

Sequential nesting only (P12 = concurrent); one-level (C5e); no mid-run interactive approval (must
pre-approve the child); a nested child cannot exceed the parent's approved isolation review;
`--nested-workflows` not inherited on resume.
