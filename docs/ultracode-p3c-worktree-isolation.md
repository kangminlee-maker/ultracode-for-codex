# Ultracode Worktree Isolation Contract

This is the current contract for `agent(..., { isolation: "worktree" })`.

## Goal

Worktree isolation is an opt-in local isolation mode for subagents that need
workspace writes while keeping the source checkout reviewable.

P3-C is done when:

- the runtime creates a detached git worktree before the backend call;
- the backend turn runs with that worktree as its workspace;
- isolated worktrees are preserved after the agent finishes, including clean,
  changed, stalled, aborted, or status-unavailable worktrees;
- `semanticOpts.isolation` participates in the agent cache key.

## Authority Model

| Concept | Authority | Rule |
| --- | --- | --- |
| isolation request | workflow script | Only `isolation: "worktree"` is accepted. |
| worktree path | runtime | Runtime creates paths outside the source repo working tree. |
| backend cwd | runtime request packet | Subagent backend executes the turn in `worktreePath`. |
| changed/unchanged decision | runtime git status | `git status --porcelain --untracked-files=all --ignored=matching` decides the preservation reason. |
| preserved path projection | runtime event | Preserved worktrees are surfaced on agent final events. |

The accepted isolation values are `"none"` and `"worktree"`; any other value
fails as invalid workflow input.

## Worktree Location

Worktrees are created as siblings of the git root:

```text
<parent-of-git-root>/.ultracode-for-codex-worktrees/<repo-slug>-<repo-hash>/<runId>/<agentId>
```

The worktree is detached at `HEAD`; uncommitted source repo changes are not
copied into the isolated worktree.

## Lifecycle

1. Validate `agent()` options and include `isolation: "worktree"` in
   `semanticOpts`.
2. Append `workflow.agent.started`.
3. Create a detached git worktree for the agent.
4. Pass `worktreePath` to the subagent backend and append path-free worktree
   context to the backend prompt.
5. Inspect worktree status after the attempt settles.
6. Preserve the worktree with reason `clean`, `changed`, `stalled`, `aborted`,
   or `status_unavailable` and surface it on the agent final event.

## Verification

- `test/codex-isolation.test.mjs` verifies Codex backend request projection.
- `test/workflow-runtime.test.mjs` verifies clean and changed worktree
  preservation.
- `scripts/e2e-installed-ultracode-for-codex.mjs` verifies packaged CLI workflow
  execution through the fake Codex app-server boundary.
