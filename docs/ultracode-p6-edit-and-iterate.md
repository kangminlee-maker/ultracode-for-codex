# Ultracode P6 — Edit-and-Iterate DX (PG-ITER, Scope B = a+b)

Status: design (2026-07-15). Branch `parity/pg-iter-edit-and-iterate`, base main `6d54ba9`.
Extends `docs/ultracode-p3b-resume-cache.md` (resume/cache contract) and
`docs/ultracode-p3a-journal-design.md` (call-key chain).

## Goal

Close the PG-ITER parity gap so a workflow author can *edit-and-iterate* the way the
native Workflow tool does:

- **(a)** After any run, the CLI tells the author **where the persisted script lives** and
  how to iterate on it. Native returns `scriptPath` in the tool result; our runtime already
  carries it on the launch result, the `workflow.started` event, and `WorkflowTaskSnapshot`
  — the CLI just never printed it.
- **(b)** Support `{scriptPath|script|script-file, resumeFromRunId}` together so an author can
  **resume a prior run with an EDITED script**: the longest unchanged prefix of `agent()`
  calls returns cached results, the first edited/new call and everything after run live.
  **Precise parity scope (per 2-kind design review):** this holds *exactly* for **chained**
  (unkeyed) `agent()` calls — native's semantics. Our `logicalKey` (`opts.key`) extension is
  position-independent by design, so a keyed call whose key+prompt+opts are unchanged may reuse
  its source result out-of-prefix (a documented superset native doesn't have because native has
  no logical keys). See Known limits.

Non-goal (dropped, see `[[parity-gap-map-2026-07]]`): **(c)** renaming `run_<uuid>` → `wf_…`
(breaking: existing `run_` validation + persisted-run round-trip; cosmetic-only gain).

## Why this is small and low-to-moderate risk

The load-bearing machinery **already exists**; PG-ITER is mostly relaxing two input gates
plus one render addition. Re-derived against real code @ `6d54ba9`:

- **Resume cache is script-agnostic.** `createResumeCache` (`workflow-runtime.ts:2114`) builds
  the cache **solely from the source journal's `agentCallKey` entries** — no dependency on
  script text. `computeWorkflowAgentCallKey` (`workflow-journal.ts:361`) keys each call by
  `sha256(previousCallKey \0 prompt \0 stableJson(opts))` (chained) or by `logicalKey`
  (keyed). So an edited script whose first N calls reproduce the same `(prompt, opts)`
  sequence hits the cache for those N; the first divergent call gets a new key → miss → live,
  and the chain diverges for everything after → all live.
- **Cache lookup already implements native prefix semantics.** `takeResumeCacheHit`
  (`:3842`): contiguous `prefixOpen` run in started-order, then an exact-key fallback
  (`byCallKey`, one-shot) — a **documented superset** of native (out-of-prefix reuse, p3b).
- **The edited script's gating equals its own source class — resume adds no new exposure.**
  The trust model (verified `:583`) is
  `WORKFLOW_PERMISSION_REQUIRED_SOURCES = {script_path, project, user, plugin}`; `inline` and
  `built_in` are **ungated by design** (your own local / shipped code), while `script_path`
  and the shared sources are gated. `resolveTrustedScriptPathMetadata` (`:2255`) only trusts a
  `script_path` whose sidecar `metadata.scriptHash === scriptHash`, so an **edited** `--script-path`
  file (hash differs) is untrusted → the permission gate (`workflowPermissionRequired`, `:1743`,
  `:2201-2252`) applies exactly like fresh unreviewed content (the PG-NEST lesson). Crucially,
  whatever source class the edited script belongs to, its gating is **identical to running it
  fresh without resume** — resume only reuses the source run's agent **results** (local data you
  already own, cwd-partitioned), it never executes new code under another run's grant. So
  `--script-file evil.js` runs ungated with or without `--resume-from-run-id` (it is inline
  either way); PG-ITER widens nothing.

What actually blocks edit-and-iterate today is **two explicit rejections**:

1. CLI `cli.ts:1378` — `--resume-from-run-id cannot be combined with --script/--script-file/--script-path/--name/positional`.
2. Runtime `workflow-runtime.ts:1949-1951` — `prepareResumePlan` throws if
   `workflowLaunchHasSourceSelector(input)` while resuming; it forces
   `launchInput = {...sourceTask.retryInput}` (the ORIGINAL script).

## Design

### (a) Surface the persisted script path — informational, always-on

Native always returns the path; gating it behind a flag would be un-native and pointless, and
it changes no execution behavior. Two render sites in `cli.ts`:

- `streamCommandWorkflow` `workflow.started` (`:1546-1547`, plain mode): append
  `script=<event.scriptPath>` to the started line. (`workflow.started` already carries
  `scriptPath`, runtime `:1830`.)
- `renderWorkflowCompletionGuidance` (`:1628`): after completion, print an **iterate hint**
  using `snapshot.scriptPath` (already on the snapshot, `:251`) and `snapshot.runId`:
  - plain (stderr): `[iterate] edit <scriptPath> then re-run: --script-path <scriptPath> [--resume-from-run-id <runId>]`
  - jsonl: add a `workflow.iterate.ready` record carrying `scriptPath`, `runId`.

Only additive output. Affected output-snapshot tests are updated to the new parity output
(intended change, not a regression).

### (b) Edited-script resume — the new input combination IS the opt-in

House style is default-off + reversible. Here the **novel input combination**
(`sourceSelector + resumeFromRunId`) is itself the gate: today it errors, so **every existing
invocation is byte-identical** (proven by diff + suite). Enabling it only affects callers who
pass both — matching native (always-on there) while staying reversible. No separate flag.

Two edits:

1. **CLI (`cli.ts:1362-1381`, `workflowLaunchInputFromOptions`).** Stop rejecting a source
   selector co-supplied with `--resume-from-run-id`. Still reject the *empty* case (neither a
   selector nor resume). Pass both through to the launch input.
2. **Runtime (`prepareResumePlan`, `:1941-1965`).** When `workflowLaunchHasSourceSelector(input)`:
   build `launchInput` from the **co-supplied (edited) selector** (not `sourceTask.retryInput`),
   keep `sourceTask` set (so `createResumeCache(sourceTask)` still loads the source's cache),
   inherit `args` from the source when the caller didn't supply them, and attach the normalized
   `resumeFromRunId`. Remove the throw for this case. The no-selector path is unchanged
   (re-run the original persisted source).

Everything downstream is already correct for this:
- `launch` parses/executes `resolved.script` = the edited script; `createResumeCache` reads the
  **source** journal → edited run executes with the source's cache. New `runId`, new journal,
  new persisted script (via the existing fresh-persist branch for `--script`/`--script-file`).
- **Safety:** `workflowPermissionRequired` runs on the edited script (new hash → not
  pre-approved → gated); `workflowRequestedIsolationModes(resolved.script)` reviews the edited
  script's isolation; source-integrity (`durableCompletedResumeSource` hash/metadata checks,
  `:2023-2026`) still validates the **source** anchor only.

### Selector coverage & persistence (b)

- `--script <edited>` / `--script-file <edited>`: raw text → `resolved.scriptPath` undefined →
  existing **fresh-persist-under-new-runId** branch (`:1763-1767`) writes correct metadata →
  clean, chainable. These resolve to the `inline` source, which is **ungated by design**
  (`WORKFLOW_PERMISSION_REQUIRED_SOURCES`, `:583`) — same as a fresh inline run, no new exposure.
  **Primary tested flow.**
- `--script-path <path>` **unchanged**: trusted reuse, 100% cache hit (a pure "continue").
- `--script-path <path>` **edited in place**: hash≠sidecar → untrusted → **permission-gated**
  (`script_path` is a permission-required source), runs with the source cache; the resulting
  run's sidecar metadata is stale, so *that* run is a weaker onward resume anchor. **This is the
  flow the security-control test exercises** (asserts `permission_required`).

## Concept economy

No new concepts. Reuses `resumeFromRunId`, `workflowLaunchHasSourceSelector`, the call-key
chain, `createResumeCache`/`takeResumeCacheHit`, the permission gate, and `scriptPath` (already
on event/snapshot/launch). One new user-facing string family: the `[iterate]` hint /
`workflow.iterate.ready` jsonl event — a projection of existing `scriptPath`+`runId`, not new
authority.

## Verification plan

Static: `npm test` (build→verify:runtime-boundary→node --test), `typecheck`.

Runtime (new tests — **ADD**, not update; there is currently no test asserting the
selector+resume rejection, so nothing to "update" — MINOR-1):
- (a) `workflow.started` render includes `script=<path>`; the iterate hint fires on **both**
  completion (`renderWorkflowCompletionGuidance`) **and failure** (`renderFailedSnapshot`) —
  failed runs are a prime iterate case (MINOR-3); jsonl emits `workflow.iterate.ready` with the
  right scriptPath+runId.
- (b) edited-resume matrix on a real run, with **precise** assertions (MAJOR-1 — assert the real
  behavior, do not write a vacuous "don't over-assert" test):
  - **append** an agent at the end → all prior chained calls cached, new one live;
  - **change** an early **chained** agent's prompt → prefix closes there, that call **and all
    downstream chained calls run LIVE** (assert live, not cached — this is the core parity claim
    and its negative control);
  - **edit-drop guard (MAJOR-3):** `--script <edited>` + resume must **not** be a 100% cache hit
    — assert the edited call actually ran live (the source script was not silently resolved);
  - **keyed superset:** a `logicalKey` call after an edit with unchanged key+inputs **may**
    exact-key-hit — assert this documented behavior explicitly;
  - **unchanged** script + resume → 100% cache hit;
  - **args inheritance** on edited resume (no `--args` → source args inherited);
  - **security control (MAJOR-2 — must target the flow that actually gates):** use
    **`--script-path` edited-in-place** (hash ≠ sidecar) and assert `status === 'permission_required'`
    for the new hash. Do NOT assert a gate fires on `--script`/`--script-file` — `inline` is
    ungated by design (`:583`), so that assertion would be vacuous.
- **Falsifiability (negative controls):** temporarily revert (i) the `prepareResumePlan` change
  → edited-resume "downstream runs live" test fails (it 100%-cache-hits); (ii) the render
  additions → (a) tests fail. Restore.
- Keep asserting the **empty-input** rejection (`cli.ts:1380-1382`) still holds; add a positive
  test that `--script + --resume-from-run-id` now succeeds (previously threw at `:1377-1378`).

Dogfood: built-in `code-review` on the diff; re-verify each finding against real code.

## Known limits (documented divergences)

Cross-family design review (Codex CLI, 2026-07-15) surfaced three; each re-verified against
real code and resolved as a documented limit, not a blocker:

- **logicalKey exact-key reuse after an upstream edit** (Codex risk #2, re-verified). For
  **chained** (unkeyed) calls, editing an early call diverges the hash chain
  (`computeWorkflowAgentCallKey`, chained branch), so that call **and everything after it run
  live** — native's exact semantics. The exact-key fallback (`takeResumeCacheHit:3856`) can only
  re-hit a call whose key is position-independent, i.e. a `logicalKey`/`opts.key` call: if its
  key+prompt+opts are unchanged it reuses the source result even though upstream context changed.
  This is **by design of logical keys** (position-independent reuse is their purpose,
  `workflow-journal.ts:369`). Authors who need a keyed call to re-run after an upstream edit
  should change its key/inputs or drop the key. Tests assert this superset rather than
  over-asserting native prefix-only.
- **Resume replays results, not side effects** (Codex risk #3, re-verified). A cached prefix
  agent returns its journaled result but its filesystem writes (e.g. into an ephemeral worktree)
  are **not** re-created. An edited downstream consumer that assumes those files exist runs
  against missing state. This is inherent to resume (native-consistent: worktrees are ephemeral
  and native resume caches results too), not introduced here. Author edited suffixes to depend on
  cached **return values**, not prior side effects.
- **Editing a run's persisted anchor in place breaks its resume (live-verified 2026-07-15).**
  The persisted `scriptPath` is the run's resume anchor: `durableCompletedResumeSource`
  (`:2023-2026`) requires the source's persisted script hash to still equal the journal's
  `scriptHash`. If you edit that exact file (e.g. `--script-path <thatFile>` in place, or edit
  it then `--script-file <thatFile>`), the source can no longer be resumed
  (`workflow_input_invalid: cannot be used as a resume source`). **Correct iterate flow: edit a
  COPY** (or use inline `--script`) and `--script-file <copy> --resume-from-run-id <runId>` — the
  copy re-runs as fresh inline while the source anchor stays intact (this is what the
  live-verified smoke and the tests do). The `[iterate]` hint instructs exactly this. (This is a
  consequence of our source-anchor-is-hash-validated design vs native's journal-only anchor; not
  closed in this MVP to avoid touching shared resume-source validation.)
- **cwd (MINOR-4 correction):** resume runs in the **invocation** cwd (`this.options.cwd ??
  process.cwd()`, `:1791`), NOT an auto-restored source cwd; a workspace mismatch only emits a
  soft fingerprint warning (`:1876`). p3b's "run from the source cwd" is a **user obligation** —
  the author must invoke edited-resume from the same cwd as the source, or cached results may
  reference stale file state.
- **jsonl consumers (MINOR-2):** (a) adds `script=` to the started line and a new
  `workflow.iterate.ready` jsonl event for every run — additive, but a new event type strict
  parsers must tolerate. Intended parity output.
- **iterate-hint path values are unquoted** (cosmetic): the `[iterate]` command interpolates
  `scriptPath`/`cwd` unquoted (consistent with the pre-existing unquoted `scriptPath`). The line
  is a template with a `<copy>` placeholder — never a verbatim paste — so a cwd/path containing
  spaces must be quoted by the author when they fill it in. Not closed to avoid re-quoting the
  pre-existing rendering.
- `run_<uuid>` runId format unchanged (part c dropped).

## Design-review record (2-kind, pre-implementation, 2026-07-15)

Two independent adversarial lenses on the design + real code, findings re-verified by me:
- **Codex CLI (cross-family):** 3 risks — inline-ungated (existing model, no new exposure),
  keyed exact-key reuse (== MAJOR-1), side-effects-not-replayed (native-consistent, documented).
- **Claude adversarial subagent:** confirmed no security-escalation hole and no hard blocker
  beyond the two gates (retry byte-identical, MCP surface unwired, `normalizeLaunchInput`
  co-presence safe). Three MAJORs folded in above: MAJOR-1 (parity claim precise + tests assert
  real behavior), MAJOR-2 (security test targets `--script-path`, not inline), MAJOR-3 (build
  edited launchInput from the co-supplied selector only — the CLI already enforces a single
  selector at `cli.ts:1373`; add a runtime single-selector assertion as defense-in-depth + an
  "edit must run live" negative test). MINORs 1-4 folded into the plan/limits.

Post-implementation dogfood (built-in `code-review`, level high, on the working-tree diff;
8 finders → 5 reported, all re-verified against real code):
- P1 iterate hint omitted the source-cwd precondition → FIXED (hint now pins `--cwd <cwd>`).
- P1 an empty selector value (`--name=`) silently collapsed into a no-selector resume (a
  pre-existing truthiness gap, same "silent selector drop" class as MAJOR-3) → FIXED (loud
  empty-selector guard in `workflowLaunchInputFromOptions`; live-verified).
- P2 `--help` overpromised "downstream runs live" (keyed contradiction) → FIXED (help + hint
  qualified to chained calls).
- P2 this doc's selector-coverage bullet mis-stated inline as permission-gated → FIXED above.
- P2 pre-existing background retry/terminal race (`renderFailedSnapshot` emits
  `workflow.terminal_failure` before `workflow.retrying`) — NOT introduced here (the failure
  render predates this change); left OUT OF SCOPE for a focused follow-up.

Live verification: (a) started line + iterate hint (with `--cwd`) surfaced; (b) edited-resume
smoke — unchanged chained prefix `cached=true`, edited + appended calls live, result reflected
the edit (proving no silent edit-drop); empty-selector guard rejects `--name=`/`--script-path=`.
Full suite 130/130 (build→runtime-boundary→node --test); the 3 new PG-ITER tests are
falsifiability-proven (temp-revert of `prepareResumePlan` → all 3 fail).
