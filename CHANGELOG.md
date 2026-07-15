# Changelog

All notable changes to `ultracode-for-codex` are recorded here. This file tracks
current-state release history; deeper design notes live under `docs/`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- `workflow.agentConcurrency` (`--agent-concurrency`): bound the number of agent
  dispatches running concurrently within a single workflow run. `unbounded` (the
  default) applies no pool and preserves current behavior; `auto` derives a size
  from available CPUs (`min(16, cores - 2)`); a positive integer pins it. Exposed
  to workflow scripts as `budget.agentConcurrency` (`budget.maxParallelism` still
  reports the `parallel()`/`pipeline()` item bound). The permit is held for the
  real dispatch's full lifetime, so an aborted or stalled agent cannot let a retry
  over-subscribe the pool.
- `--budget <N|Nk|Nm>`: an optional per-run output-token ceiling (with an optional
  `+`, and `k`/`m` = ×1e3/×1e6). Once a run's successful-agent output tokens reach
  it, `agent()` refuses to launch a further dispatch (a non-retryable
  `workflow_input_invalid`; inside `parallel()`/`pipeline()` the refused item resolves
  to `null`). Workflow scripts read `budget.total`, `budget.spent()`, and
  `budget.remaining()` to self-pace (e.g. `while (budget.remaining() > N)`); these are
  non-enumerable, so a run with no budget is byte-identical to before. Per-run and
  best-effort by design: it counts successful-agent output tokens only
  (stall/validation-failed spend is not counted), it is soft under concurrency (agents
  admitted before a sibling exhausts the ceiling still dispatch), and it is **not
  inherited on resume** — a `--resume-from-run-id` invocation that omits `--budget`
  runs uncapped, so re-pass the flag. An output-token guardrail, not a hard cost cap.
- Backend failures are now classified `terminal`, `transient`, or `rate_limited`
  at the boundary from the codex turn error, instead of being flattened into an
  opaque message. A `terminal` failure (auth, bad request, context-window, sandbox,
  and similar) fails with the non-retryable `workflow_agent_terminal` reason and is
  no longer retried; transient and rate-limited failures keep the retryable
  `workflow_agent_failed` reason. A failure whose variant is not recognized defaults
  to retryable and emits a distinguishable log, so a renamed provider variant cannot
  degrade into silent infinite retry. A `turn/completed` with a non-`completed`
  status (for example `interrupted`) is now treated as a failure rather than an
  empty successful turn.
- `workflow.worktreeRetention` (`--worktree-retention`): a completed
  `isolation: "worktree"` agent's worktree is now reclaimed when it holds no real
  changes, matching native `isolation` semantics. Cleanliness is decided by
  `git worktree remove` itself (no `--force`), so a clean or ignored-only tree is
  removed while one holding real changes is refused and preserved — build output
  no longer strands a multi-gigabyte worktree. Changed, stalled, and aborted
  worktrees are still always preserved for review. Set the setting (or the flag)
  to `preserve-all` to keep every worktree, as previous versions did.
- Workflow failure reasons now drive retry: `recovery.retryable` is derived from
  the reason instead of being hard-coded `true`, so a deterministic failure
  (invalid input or meta, a nondeterministic script) is no longer retried to the
  configured `--retry-limit`. Backend failures carry a canonical
  `workflow_agent_failed` reason and stay retryable.

### Changed

- Lowered the packaged default reasoning effort (`settings.json`
  `codex.reasoningEffort`) from `xhigh` to `medium`. A live two-arm effort A/B on
  `gpt-5.6-sol` (2026-07-14) found review/analysis quality is tier-independent —
  medium, high, and xhigh all reach ~96–100% bug detection with 0 false positives
  and equal fix quality on both single-module and hard cross-file review tasks —
  while `xhigh` costs 1.7–2.4× the latency and can miss a fixed deadline that
  `medium` meets. Scope caveat: the measurement covers the read-only
  review/analysis path only; code-writing/generation was not measured, so revisit
  this default if/when that workload becomes primary. The value is fully
  overridable with `--reasoning-effort`, and the `code-review` built-in's own
  `level` (which sets its own effort) is unchanged. See
  `docs/20260714-effort-quality-ab.md`.

## [0.4.5] - 2026-07-12

### Added

- Live Codex `model/list` capability selection for setup and workflow runs,
  including fail-before-turn validation and catalog-supported `max` effort.
- A balanced `gpt-5.6-sol` path: task planning at `medium` with run-level
  medium/high inheritance, plus a code-review `high` profile using
  medium/high only.

### Changed

- Removed the hard-coded GPT-5.5 fallback. Explicit, inherited, and catalog
  default models now resolve in that order and the effective model is journaled.
- Capped native Codex multi-agent V2 at one total worker thread and kept
  `ultra` outside the workflow effort enum, preventing unjournaled descendant
  delegation.
- On POSIX hosts, Codex app-server cleanup now terminates the backend-owned
  process group, so shell-wrapped Codex binaries do not keep an attached CLI
  alive after result delivery. Windows continues to terminate the direct child
  process only.
- Clarified that native Codex Ultra owns ad-hoc proactive delegation, while
  Ultracode owns durable workflow guarantees; the built-in task is explicitly
  read-only analysis and the main Codex context owns edits.

## [0.4.4] - 2026-07-07

### Added

- `setup` command (alias `doctor`): a single readiness preflight that reports
  the package version, Codex CLI presence and version, Codex app-server
  reachability, Codex authentication (ChatGPT login, API key, or a no-auth
  provider), and installed-skill freshness. Prints JSON by default (`--plain`
  for human lines) and exits non-zero when anything blocks a delegated phase, so
  a missing Codex install or a logged-out session is caught before a workflow
  starts instead of mid-run. The default skill preflight now calls it.
- `references/codex-agent-prompting.md`: model-current guidance for writing the
  natural-language `agent()` prompt body (outcome-first framing, grounding, and
  verification for the GPT-5.5 Codex family), keeping `schema` as the owner of
  output shape and `effort` as the owner of reasoning depth.
- `references/example-workflows/`: three runnable, non-review example workflows on
  the generic host API — `research-fan-out` (fan-out-and-synthesize),
  `migrate-pipeline` (discover→transform→verify, using `includeDiff` so a
  non-review path exercises change evidence), and `judge-panel`
  (generate→judge→decide). A test runs the static validator over each so a broken
  example fails `npm test`.
- A failed agent's error now carries a `[codex thread <id>]` correlation id for
  tracing the failure to its Codex app-server thread in run logs.

### Changed

- Renamed the `workspaceContext` diff-evidence concept from "review evidence" to
  the general "change evidence" (`buildChangeEvidenceContext`,
  `ChangeEvidenceContext`, and the `### Change Evidence` context header). It is a
  general primitive any workflow can consume, not review-only; digest-,
  provenance-, and parse-contract-neutral (an in-flight run resumed across the
  upgrade re-runs agents — correct output, extra spend — same class as git drift).
- Reframed the README and default skill toward "general workflow runtime,
  code-review is one built-in"; the code-review vs task machinery asymmetry is
  documented as intentional, not neglect.
- Review guidance is now explicitly review-only: findings are presented ranked
  by severity, and fixes are never auto-applied off the back of a review.
- Documented the Codex model and config conventions the runtime follows: current
  GPT-5.5 model naming, reasoning-effort naming and the `medium` default, auth
  and default-model inheritance from `${CODEX_HOME:-~/.codex}`, and the isolated
  minimal subagent config.

## [0.4.3]

- Rename the `workspaceContext` concept from "review evidence" to "change
  evidence"; add general (non-review) example workflows and a general-first
  skill identity.

## [0.4.2]

- Live runtime reliability study; non-destructive workflow heartbeat for long or
  stuck runs; structured terminal-failure result record.

## [0.4.0]

- P4 hybrid orchestration: the main Codex context plans and synthesizes while
  delegating fan-out phases to the local CLI runtime.

## [0.3.4]

- Resume/cache and worktree-isolation contracts for the local workflow runtime.

## [0.3.2]

- Progress visual routing for native orchestration snapshots.

## [0.3.1]

- Split the packaged skill commands into `ultracode-for-codex` and
  `ultracode-for-codex-cli`.

## [0.3.0]

- Background execution controls: `status`, `wait`, `logs`, `result`, `cancel`,
  `jobs`, and `archive` for local background workflow jobs.

## [0.2.6]

- Dynamic phase planning for the workflow runtime.
