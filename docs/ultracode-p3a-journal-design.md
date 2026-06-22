# Ultracode Journal Contract

This is the current journal contract for the local command-owned workflow runtime.
It is implemented in `src/runtime/workflow-journal.ts` and
`src/runtime/workflow-runtime.ts`.

## Goal

Every launched workflow writes a durable
`<transcriptDir>/journal.jsonl` ledger. The journal is the canonical runtime
artifact for future replay/cache behavior; CLI progress is only a
projection.

P3-A is done when:

- `workflow.run.started` is durably written before `taskId` and `runId` are
  acknowledged to the caller;
- agent started/completed/failed entries use deterministic start-order call
  keys;
- exactly one terminal run entry is durable before terminal workflow events and
  result projection;
- journal write failures fail closed with `workflow_journal_write_failed`;
- journal readers validate schema, ordering, sequence, hash chain, task/run
  identity, agent pairing, terminal uniqueness, and trailing partial-line
  recovery.

## Authority Model

| Concept | Authority | Rule |
| --- | --- | --- |
| `journal.jsonl` | runtime canonical artifact | Future replay/cache reads this ledger. |
| `WorkflowEvent` | runtime projection | CLI progress consumes this stream. |
| `taskId`, `runId`, `seq`, `recordedAt` | runtime | Never accepted from workflow script or model output. |
| `journalPath` | runtime internal state | Never printed in CLI output. |
| `scriptPath`, `workflowSource`, `scriptHash` | runtime resolver | Captured in `workflow.run.started`. |
| agent return value | runtime executor | Raw text or validated structured output. |

The CLI defaults to OS background execution from `settings.json`, writing result
and progress files under the configured background run directory. Attached
execution prints progress to stderr as JSONL and final result JSON to stdout.
Journal contents and `journalPath` remain internal runtime state.

## Ordering

Launch ordering:

1. Normalize and validate workflow input.
2. Resolve source, permission, script hash, and transcript directory.
3. Create the transcript directory.
4. Append and durably flush `workflow.run.started`.
5. Register the task, emit `workflow.started`, and start execution.

Agent ordering:

1. Reserve `agentIndex`, `agentId`, `previousAgentCallKey`, and `agentCallKey`
   before the first await.
2. Append and flush `workflow.agent.started`.
3. Emit `workflow.agent.started`.
4. Execute Codex subagent with stall retry and structured-output validation.
5. Append and flush exactly one agent final entry.
6. Emit the matching final event.

Terminal ordering:

1. Create or reuse one terminal finalizer.
2. Normalize result or failure payload.
3. Append and flush terminal run entry.
4. Emit `workflow.completed` or `workflow.failed`.
5. Write/project the terminal result when successful.

## Verification

- `test/workflow-journal.test.mjs` verifies stable JSON, writer durability, and
  reader validation.
- `test/workflow-runtime.test.mjs` verifies direct runtime launch, failure,
  retry, cancel, resume/cache, and worktree paths.
- `scripts/e2e-installed-ultracode-for-codex.mjs` verifies the packaged CLI
  against a fake Codex app-server boundary.
