# Ultracode Resume Cache Contract

This is the current local resume/cache contract. It builds on
`docs/ultracode-p3a-journal-design.md` and the durable local workflow state
under `${ULTRACODE_FOR_CODEX_HOME:-~/.ultracode-for-codex}`.

## Scope

Resume/cache is local and command-owned. Same-process runtime calls may pass
`resumeFromRunId` directly, and CLI users may pass `--resume-from-run-id` to
resume a completed run from preserved script, result, and journal state.

## Rules

- `resumeFromRunId` accepts workflow `runId` values known by the current
  `WorkflowTaskRegistry` or completed run ids with durable result and journal
  state under the same workflow state directory.
- CLI `--resume-from-run-id` reuses the original persisted runtime script and
  rejects any additional workflow source selector. Without `--args`, it also
  reuses the original args.
- Durable result records store the minimal runtime-owned retry input needed for
  resume. Journal paths and contents remain local state and are not printed in
  ordinary CLI output.
- Durable resume requires a matching terminal `workflow.run.completed` journal
  entry for the selected run id.
- Durable resume binds the result record's script path and persisted script
  metadata back to the journal's `workflow.run.started` script path and source
  identity.
- Inherited resume args come from the source journal's `workflow.run.started`
  entry. If the durable result record also stores args, they must match the
  journal args.
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

- `test/workflow-runtime.test.mjs` covers exact cache hits, retry/cancel
  interactions, and cross-registry completed-run resume.
- `test/workflow-journal.test.mjs` validates the journal reader used to derive
  cache entries.
- `scripts/e2e-installed-ultracode-for-codex.mjs` covers packaged
  `code-review` resume with cached agent completions.

Realization:

- `mock`: direct runtime tests use a fake subagent backend.
- `boundary_stub`: packaged CLI E2E uses a fake Codex app-server for CLI
  execution paths.
