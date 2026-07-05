# Runtime failure-contract DX handoff (2026-07-05)

One-line state: three workflow-runtime contract gaps confirmed on the installed v0.4.1 during real
background runs; all three are runtime-generic (they were *surfaced* through the built-in `code-review`,
but none is review-specific — they bind every workflow that runs on this runtime, built-in or
user-authored).

Pinned state: repo `~/Documents/ultracode-for-codex` @ `ad7d0cf` (main); installed package
`ultracode-for-codex@0.4.1` (global npm, `/opt/homebrew/lib/node_modules/ultracode-for-codex`);
observations from background jobs run 2026-07-05 22:35–22:40 KST with cwd `~/Documents/agent-dotfiles`
(clean working tree). Line anchors below are against `ad7d0cf`; re-grep by name before editing.

## CONFIRMED (each re-establishable from the evidence ref alone)

### F1 — Structurally unsatisfiable preconditions are detected only after spending an agent

- A workflow whose deterministic allowed-ref universe is empty cannot produce any valid scope, yet the
  runtime runs planning/scope agents first and hard-fails only when the agent's output hits ref
  validation. Observed: on a clean tree, evidence collection yields zero `file:` refs, the Scope-phase
  agent (xhigh) still runs ~1–2 min, then `validateFile` rejects its first output.
- Runtime-generic: any workflow gated on `workspaceContext`-derived allowed refs (evidence refs, file
  refs — and by the same shape, any future allowed-set) has this ordering; user scripts consuming
  `workspaceContext(...)` inherit it too.
- Evidence: `src/runtime/workflow-runtime.ts:1192-1196` (allowedFileRefs derived solely from `file:`
  entries in the evidence context) and `:857` (`validateFile` fail site). Jobs:
  `job_b40ac20a-a8fe-45a1-869c-1244f4095c66` (22:35:00→22:37:07, agents 1/1 "Scope", then
  `workflow_failed`), `job_a2c44fe1-cffd-4521-a753-5ceec561964c` (22:38:03→22:39:18, same class).
  Repro: `ultracode-for-codex run --accept-llm-guide=v1 --cwd <any-clean-repo> --name code-review
  --args '{"prompt":"review x"}'`.

### F2 — Contract-rejection diagnostics state WHAT was rejected, not WHY or what would pass

- `fail(label + " references unsupported file " + file)` (and the sibling "includes unsupported
  evidence ref") tell the caller which value was rejected but not the rejection's cause (not present in
  the allowed set derived from current evidence) nor the remediation (what populates that set — e.g. a
  pending change for diff-derived refs). Both observed failures required reading `dist/` source to
  diagnose; an LLM operator without source access would guess.
- Runtime-generic: this is the shared rejection-message shape for allowed-set validations; every
  workflow's structured outputs are validated through it.
- Evidence: `src/runtime/workflow-runtime.ts:857` (file refs) and the evidence-ref twin directly above
  it (`"includes unsupported evidence ref"`); observed messages in both job progress logs:
  `code-review invalid: scope.files[0] references unsupported file README.md`.

### F3 — Terminal failure leaves a 0-byte `result.json`: the result channel is not total

- The background launcher creates the result file at start (`open(resultPath, 'w', 0o600)`), and only
  the success path writes the final JSON; on `workflow.terminal_failure` the failure is written to
  progress JSONL only. Consumers of `result`/`resultPath` get an empty file that fails JSON parsing
  instead of a structured failure record.
- Runtime-generic: `result.json` is the machine-consumed output channel for every run; an output
  channel that is only valid on success breaks the runtime's own "stdout reserved for final JSON
  result" contract on the failure half. Observed: both failed jobs left `result.json` at 0 bytes
  (`-rw------- ... 0 Jul 5 22:35 .../result.json`), and `json.load` raises `Expecting value`.
- Evidence: `src/cli.ts:292-299` (result file pre-created empty), `src/cli.ts:~1420-1428` (terminal
  failure emits progress record only); job dirs
  `~/.ultracode-for-codex/background/job_b40ac20a-*/result.json` and `job_a2c44fe1-*/result.json`.

## PROPOSED (owner decisions; not verified as the best design)

- P1 (for F1): after deterministic evidence collection and before spawning any agent, hard-fail
  workflows whose required allowed-set is empty — e.g. `code-review invalid: no reviewable change
  evidence in the working tree (allowed file refs: 0)`. Generic placement: a precondition hook on
  allowed-set-consuming built-ins, plus (optional) a `workspaceContext` return field user scripts can
  check. Saves one xhigh agent + ~1–2 min per misfire and makes the failure classifiable at plan time.
- P2 (for F2): extend the shared rejection formatter to three parts — rejected value, cause
  ("not in <set-name> (N entries) derived from <source>"), remediation hint ("populated by <what>").
  Keep it in the one formatter so every allowed-set validation inherits it.
- P3 (for F3): make the result channel total — on any terminal state write a structured record
  (`{"status":"failed","failure":{"reason","phase","agentsCompleted","runId"}}`) to `result.json`, or
  document+emit a distinct `failure.json` and make `result` print it with a non-zero exit. Watch the
  interaction with `cli.ts:944` (`if (input.resultReady) return 'completed'`) — a non-empty failure
  record must not flip status logic to `completed`.

## Non-scope

- The `code-review` built-in's *policy* (diff-only reviewability) is not challenged here; whether it
  should accept committed-range or doc targets is a separate product decision. These three items stand
  regardless of that decision.
- v0.4.1 reliability re-measurement (separate ongoing effort; task-mode runs) is tracked outside this
  handoff.

## Next actions

1. Decide P1 placement (built-in precondition vs workspaceContext-level signal) — smallest surface
   first.
2. Implement P3 before P1/P2 if ordering matters operationally: it is the cheapest and unblocks all
   programmatic consumers of failed runs.
3. Add regression fixtures: (a) clean-tree `code-review` run fails pre-agent with the P1 message and
   0 spawned agents; (b) any forced terminal failure leaves a parseable `result.json` (negative
   control: successful run's `result.json` unchanged); (c) rejection message snapshot includes cause
   and remediation segments.

First command for the implementing session (model: WORKHORSE tier per the operator's binding table):
`cd ~/Documents/ultracode-for-codex && git log --oneline -3 && grep -n "references unsupported file" src/runtime/workflow-runtime.ts && grep -n "open(resultPath" src/cli.ts`

## Implementation status (2026-07-06)

All three items implemented on top of `ad7d0cf`; F1–F3 re-verified against source before coding.

- P3 (F3): `run` now writes an `ultracode.workflow.failure` record (`status`,
  `failure.{reason,error,workflowName,taskId,runId,phase?,agentsCompleted?}`) to stdout on any
  terminal failure or abort, so background `result.json` is total. `status` classifies a failure
  record as `failed` even when progress JSONL is missing (checked before the
  `resultReady → completed` fallback flagged in P3), and `result` / `wait --result` print it with
  exit 1. (`src/cli.ts`)
- P1 (F1): built-in `code-review` hard-fails after deterministic evidence collection and before
  spawning any agent when the allowed file-ref set is empty: `code-review invalid: no reviewable
  change evidence in the working tree: allowed file refs is empty (0 entries) …`. Placement
  decision: built-in precondition (smallest surface); no new `workspaceContext` return field —
  user scripts can already count `file:` entries in the returned context.
  (`src/runtime/workflow-runtime.ts`, embedded script)
- P2 (F2): shared `failUnsupportedRef` formatter emits rejected value + cause
  (`not in <set> (N entries) derived from <source>`) + remediation (`populated by <what>`) for
  decision-ref, evidence-ref, and file-ref rejections; the P1 message reuses the same set
  descriptors.
- Regression fixtures (a)/(b)/(c) added: `test/workflow-runtime.test.mjs` (clean-tree pre-agent
  failure with 0 backend requests; rejection-message cause/remediation segments) and
  `test/cli-result-contract.test.mjs` (attached/background failure records, success negative
  controls, progress-loss classification).
