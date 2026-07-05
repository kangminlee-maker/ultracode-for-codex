# Ultracode Resume Cache Contract

This is the current local resume/cache contract. It builds on
`docs/ultracode-p3a-journal-design.md` and the durable local workflow state
under `${ULTRACODE_FOR_CODEX_HOME:-~/.ultracode-for-codex}`.

Updated 2026-07-05 (P4-B): failed, cancelled, and interrupted runs became
valid resume sources, discovery became journal-first for non-completed
sources, and exact-key reuse widened to every durably completed agent result.

## Scope

Resume/cache is local and command-owned. Same-process runtime calls may pass
`resumeFromRunId` directly, and CLI users may pass `--resume-from-run-id` to
resume a run from preserved script, result, and journal state. Resume must
run from the source run's working directory: workflow state is partitioned
by the exact cwd.

## Rules

- `resumeFromRunId` accepts workflow `runId` values known by the current
  `WorkflowTaskRegistry`, or run ids with durable journal state under the
  same workflow state directory.
- Valid source classes by journal terminal entry:
  - completed (`workflow.run.completed`);
  - failed (`workflow.run.failed`, including cancelled runs with reason
    `workflow_aborted` — the explicit resume invocation is the confirmation);
  - interrupted (no terminal entry, e.g. a killed process). The CLI projects
    this class through the existing `exited_unknown` job status.
- Running source runs fail with `workflow_resume_running`. In-registry
  sources are checked by task status; cross-process sources are checked
  through a runtime-owned `run.pid` liveness file written at launch and
  removed at the terminal state. A stale pid reused by an unrelated live
  process can false-positive this guard; deleting the `run.pid` file under
  the run's transcript directory clears it.
- In-process retry (`retry`, CLI `--retry-limit`) resumes the failed run, so
  durably completed agent results are reused across retry attempts; a source
  whose journal cannot serve as a resume source falls back to a fresh re-run.
  Because each retry attempt chains the previous attempt's cache, the newest
  attempt's `runId` is also the best later resume anchor.
- CLI `--resume-from-run-id` reuses the original persisted runtime script and
  rejects any additional workflow source selector. Without `--args`, it also
  reuses the original args. Without `--model`, it adopts the source run's
  recorded model so cached agent results stay reusable; an explicitly
  different model proceeds with a full re-run and a warning log.
- Durable discovery is result-record-first for completed runs and
  journal-first otherwise: the `workflow.run.started` entry carries the
  script path, script hash, source identity, args, and runtime cwd needed to
  rebuild the retry input (`toolName` is not journaled and is re-supplied by
  the resume launch input). A valid result record beside a non-completed
  journal (the terminal append was interrupted) falls through to
  journal-first discovery. Fail-loud cases: a result record that exists but
  cannot be read, parsed, or bound to its run; a record that contradicts the
  journal or the persisted script; and a terminal-completed journal reaching
  journal-first discovery (record missing, or bytes present after the
  terminal entry) — completed sources must bind through their result record.
- The persisted script must still exist, its hash must equal the source
  journal's `scriptHash`, and script metadata must match the journal's
  source identity. Inherited resume args come from the source journal's
  `workflow.run.started` entry; a result record that also stores args must
  match them.
- For non-completed sources, an unterminated final journal line was never
  durably committed (the writer emits entry+newline as one buffer) and is
  dropped whether or not its bytes parse as complete JSON. Completed-source
  acceptance still requires a clean, newline-terminated, terminal-completed
  journal. A broken hash chain rejects the source.
- Cache reuse:
  - the contiguous started-order prefix is reused in order, as before;
  - exact `agentCallKey` matches may additionally reuse **any** durably
    completed agent result in the source journal, so one early stall cannot
    discard the results of agents that completed after it;
  - only `workflow.agent.completed` results are reused; failed and stalled
    agents always re-run;
  - cache hits emit `workflow.agent.completed` with `cached: true` and zero
    usage for the current run.
- Resumed runs write their own journal entries and disclose, as progress log
  lines: the source terminal state and reason, the reusable completed-agent
  count, a model mismatch against the current backend (agent results whose
  call keys embed a different model re-run; per-agent model overrides keep
  their cached results), and workspace drift since the source run (git HEAD
  + status + tracked-content diff fingerprint recorded at launch in
  `workflow.run.started`; untracked-file content changes are visible only as
  presence changes). Drift is a disclosure, not a gate: cached results still
  apply, because prompt/key discipline — not the fingerprint — is the
  semantic cache identity.

`agentCallKey` is derived from previous key, prompt, and stable semantic opts:

```text
sha256(previousAgentCallKey + "\0" + prompt + "\0" + stableJson(opts))
```

Logical-keyed agents derive instead from
`sha256("logical\0" + key + "\0" + prompt + "\0" + stableJson(opts))`, which
is order-independent. Semantic opts include schema, model, effort, isolation,
and agent type. Display values such as label and phase stay outside the cache
identity. A duplicate logical key within one run fails at agent reservation
time (`workflow_input_invalid`), because it would poison the journal as a
resume source. This also means re-calling a failed agent with the same
logical key is unsupported: use a distinct key per attempt.

## Caveats

- An exact key match is semantically sufficient only when prompts and logical
  keys actually encode the agent's semantic inputs. Bind logical keys to the
  evidence snapshot they depend on (the built-in `code-review` folds the
  source snapshot hash into every key) and embed distinguishing content in
  prompts; the workspace-drift disclosure exists because the runtime cannot
  decide staleness for underspecified prompts.
- Cached reuse replays result values, not side effects. Worktree-isolated
  agents do not get their file effects replayed; preserved worktrees remain
  per `docs/ultracode-p3c-worktree-isolation.md`.
- Cross-version resume of built-in workflows stops when the built-in script
  text changes, because the script hash is part of the source binding.
- Runs without a run-level model record no model identity: their cache keys
  carry the backend placeholder, so a change to the Codex default model
  between the source run and a resume is invisible to the cache and to the
  mismatch disclosure. Pin `--model` (or per-agent `model`) when default-model
  drift matters.

## Verification

- `test/workflow-runtime.test.mjs` covers exact cache hits, retry/cancel
  interactions, cross-registry completed-run resume, failed-run resume with
  out-of-prefix reuse, interrupted-run resume from torn and unterminated
  journal tails, kill-window fall-through, duplicate-key reservation
  rejection, model-mismatch and workspace-drift disclosures, and broken hash
  chain rejection.
- `test/workflow-journal.test.mjs` validates the journal reader used to derive
  cache entries.
- `scripts/e2e-installed-ultracode-for-codex.mjs` covers packaged
  `code-review` resume with cached agent completions.

Realization:

- `mock`: direct runtime tests use a fake subagent backend.
- `boundary_stub`: packaged CLI E2E uses a fake Codex app-server for CLI
  execution paths.
