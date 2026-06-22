# Ultracode Resume Cache Contract

This is the current same-session resume/cache contract. It builds on
`docs/ultracode-p3a-journal-design.md`.

## Scope

Resume/cache is runtime-internal and same-session. User-facing recovery uses
same-run retry or explicit CLI reruns.

## Rules

- `resumeFromRunId` accepts only workflow `runId` values already known by the
  current `WorkflowTaskRegistry`.
- Running source runs fail with `workflow_resume_running`.
- Completed agent prefixes are reused only when the current `agentCallKey`
  matches the source journal prefix.
- The first changed or new agent call and every suffix call reruns.
- Cache hits emit `workflow.agent.completed` with `cached: true` and zero usage
  for the current run.
- Resumed runs write their own journal entries.

`agentCallKey` is derived from previous key, prompt, and stable semantic opts:

```text
sha256(previousAgentCallKey + "\0" + prompt + "\0" + stableJson(opts))
```

Semantic opts include schema, model, effort, isolation, and agent type. Display
values such as label and phase stay outside the cache identity.

## Verification

- `test/workflow-runtime.test.mjs` covers exact cache hits and retry/cancel
  interactions.
- `test/workflow-journal.test.mjs` validates the journal reader used to derive
  cache entries.

Realization:

- `mock`: direct runtime tests use a fake subagent backend.
- `boundary_stub`: packaged CLI E2E uses a fake Codex app-server for CLI
  execution paths.
