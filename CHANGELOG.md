# Changelog

All notable changes to `ultracode-for-codex` are recorded here. This file tracks
current-state release history; deeper design notes live under `docs/`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Fixed

- A run no longer aborts with `workflow_journal_write_failed` ("before agent start") when an agent's
  prompt exceeds the journal's 512 KiB per-string cap. This bit large-input `task`/`code-review` runs
  at the aggregating synthesis agent, whose prompt (all prior evidence + findings) crossed the cap —
  deterministically, so retries and the `--name task` path recurred. The journal now stores an
  **audit-bounded** copy of an oversized prompt (head preview + total byte length + sha256 of the full
  prompt) and marks the entry `promptBounded`; validation skips the prompt-vs-key re-derivation for such
  entries. Correctness is unchanged: the agent still receives the **full** prompt, and resume recomputes
  the call key from the live prompt (never from the stored copy), so the call-key value and cache
  identity are byte-identical. Load-bearing strings (results, keys) remain exact and capped.

## [0.6.0] - 2026-07-16

### Added

- **Concurrent nested `workflow()` children** (PG-NEST v2-B): nested children may now run in parallel
  (e.g. `parallel([() => workflow("a"), () => workflow("b")])`), lifting the sequential-only limit. The
  VM value projector — previously a single shared `ctx` slot captured per-promise, which forced
  sequential nesting to avoid concurrent children clobbering each other's realm — is now
  **per-execution**: each execution (the top-level run and every nested child) owns its own projector
  scope, so concurrent children marshal into their own realms without interference. A child's return
  value is projected into the parent realm on success while errors propagate raw (no double-projection).
  Still one-level, still behind the default-off `--nested-workflows` gate (byte-identical when off);
  resume of concurrent-nested runs is best-effort for unkeyed agents (use `key()` for deterministic
  resume). See `docs/ultracode-p12-concurrent-nesting.md`.

- Nested `workflow()` **full-scope name sources** (PG-NEST v2-A): a nested `workflow(name)` now
  resolves a **project / user / plugin** workflow (same project→user→plugin→built-in precedence as a
  top-level launch), not just a built-in. A nested child from a permission-required source is gated by
  the existing permission **record**: it runs only if you have already approved that exact workflow
  (source + path + name + content hash), else it **fails loud** (catchably) — a nested call cannot
  prompt for approval mid-run, so it never silently runs unreviewed content. A child cannot exceed the
  parent run's approved isolation review (no authority widening). `{ scriptPath }` nesting remains
  deferred (a scriptPath ref is confined to runtime-owned scripts whose records live under their
  original source, so it has no clean gate). Still one-level, still sequential (concurrent nesting is a
  separate follow-on), still behind the default-off `--nested-workflows` gate — with it off, behavior
  is byte-identical. Note: a built-in name now shadowed by a same-named saved workflow resolves to the
  saved (gated) source, matching top-level semantics. See `docs/ultracode-p11-nested-full-scope.md`.

- `workflow.agentTypes` (`--agent-types <disabled|enabled>`): opt-in **per-agent types**
  (PG-AGENTTYPE). When enabled, `agent(prompt, { agentType: "reviewer" })` resolves a named type
  from your native Codex registry (`~/.codex/agents/*.toml`, keyed by filename stem) and applies
  that type's **model**, **model_reasoning_effort**, and **developer_instructions (persona)** to that
  one agent call — the persona is injected as the subagent's developer instructions with the workflow
  return-value contract appended last (native-faithful: system prompt + StructuredOutput composed).
  Explicit `opts.model`/`opts.effort` on the call still win over the type; the type's model/effort are
  validated through the same normalizers as the per-call opts, so a banned `ultra` effort or the
  reserved model placeholder in a registry file is rejected at use-time and never reaches dispatch.
  Registry parsing is **lenient** (unknown keys, `[tables]`, arrays, and non-string scalars are
  ignored; a file that cannot be parsed is skipped with a stderr note) so an unrelated or
  evolving-schema file never bricks a run; a script that names a missing/invalid type fails loud.
  Disabled (the default) leaves `agentType` inert — a script that uses it fails loud — and every other
  path is **byte-identical** to today (the type name is absent from the call key and journal, and the
  registry is not read). Because the type name **is** part of the agent call key (unlike the run-level
  web/file/mcp gates), a typed run **auto-restores** `--agent-types` on resume (scanned from the source
  journal) rather than requiring you to re-pass it; editing a type's `model`/`model_reasoning_effort`
  between runs busts that agent's cache like a script edit. `sandbox_mode` and per-type web/MCP are not
  applied in v1 (writes stay gated by `isolation:'worktree'` + `--agent-file-write`, so a read-only
  type cannot gain write and a write type cannot bypass the gate). See `docs/ultracode-p10-agent-type.md`.

- `workflow.agentMcp` (`--agent-mcp <server1,server2,...>`): opt-in support for workflow
  subagents to call the user's own **Codex MCP servers**, scoped to a **named allowlist**.
  Empty (the default) provisions no MCP servers into the isolated Codex home and declines
  every MCP tool-call approval, so existing behavior is byte-identical. When one or more
  server names are given, exactly those `[mcp_servers.NAME]` sections are copied **verbatim**
  from your `~/.codex/config.toml` into the isolated home, and their tool-call approvals are
  auto-accepted (a headless run has no human to prompt; the allowlist is the decision). The
  match is **segment-exact** — `--agent-mcp onto` never provisions `ontology-docs`. An
  allowlisted name with no `[mcp_servers.NAME]` table header fails loud at start (never a
  silent no-op). This is the **largest authority expansion** in the capability stream: a named
  stdio server runs as a local **unsandboxed** subprocess (its full capability), and a named
  streamable-http server reaches its external endpoint (an egress/exfiltration surface like
  `--agent-web-search`) — so name only trusted, read-mostly servers for untrusted-input runs.
  **Run-level** (applies to every agent) and, like `--budget`/`--nested-workflows`, **not
  inherited on resume** — re-pass it. A disabled (`enabled = false`) server stays disabled even
  when allowlisted; a broken/slow allowlisted server degrades to "its tools are absent," never a
  hung run; a re-executed agent that calls a side-effecting server repeats the external effect.
  See `docs/ultracode-p9-agent-mcp.md`.

- `workflow.agentFileWrite` (`--agent-file-write`): opt-in file writes for **worktree-isolated**
  subagents. `disabled` (the default) offers only the read-only workspace tools, so existing
  behavior is byte-identical. When `enabled`, an agent running under `isolation: "worktree"`
  additionally gets `write_file` (create/overwrite) and `str_replace` (edit the single unique
  occurrence) tools, **confined to that worktree** by a symlink-safe path guard; a read-only
  (non-isolated) agent never gets them. This makes worktree isolation's writes — previously a
  write-permitted sandbox with no write tool — actually functional. Writes are run-level
  (re-pass on resume) and execute in the runtime process, so the path guard is the containment.
  Known limits: writes to gitignored paths may be reclaimed under `remove-clean` retention (use
  tracked paths or `--worktree-retention preserve-all`); writes are per-agent-private (a sibling
  agent does not see them) and are surfaced for human review, not fed to downstream agents; a
  resumed run replays cached results without re-writing. See
  `docs/ultracode-p8-agent-file-write.md`.

- `workflow.agentWebSearch` (`--agent-web-search`): opt-in support for workflow
  subagents to use the native Codex `web_search` tool. `disabled` (the default) keeps
  `web_search="disabled"` at every Codex config site, so existing behavior is
  byte-identical. When `enabled`, every agent in the run may search the web. This is
  **run-level** (applies to all agents in the run), and, like `--budget` and
  `--nested-workflows`, is **not inherited on resume** — re-pass it. Caveats: a
  re-executed (non-cached) web-search agent is not bit-reproducible across runs (its
  output depends on live web state; the resume cache still replays run-time snapshots by
  key, so identical-script resume is a 100% cache hit); `--budget` counts output tokens
  only and does **not** bound web-search cost, which lands on input tokens; and enabling
  it opens the worker's first outbound content channel (an egress/prompt-injection
  surface), which is why it is default-off and explicit. See
  `docs/ultracode-p7-agent-web-search.md`.

### Fixed

- `--agent-file-write` git-metadata denylist now splits paths on **both** `/` and `\`, so a
  Windows-style relative path such as `.git\config` is refused (previously the `/`-only split let
  it past the `.git` denylist on Windows). Windows-only, defense-in-depth — the primary
  worktree-confinement path guard already held. Reported by the automated PR reviewer on the
  file-write change; folded into the MCP work.

## [0.5.0] - 2026-07-15

### Added

- Edit-and-iterate DX (PG-ITER). **(a)** Every run now surfaces where its script was
  persisted: the `[workflow] started` line prints `script=<path>`, and on both completion
  and terminal failure a plain-mode `[iterate]` hint prints the script path, a
  copy-edit-resume command, and `--cwd <cwd>` (jsonl consumers already have `scriptPath` on
  the `workflow.started` event). **(b)** `--resume-from-run-id`
  may now be **co-supplied with one source selector** (`--script`/`--script-file`/
  `--script-path`/`--name`) to resume a prior run with an **edited** script: the resume cache
  is keyed by the source journal's `agent()` call-key chain (independent of script text), so
  unchanged **chained** calls before your edit reuse cached results and the first edit plus its
  downstream chained calls run live — native's prefix semantics. An unchanged keyed (`opts.key`)
  call may reuse its cached result out of prefix (position-independent by design). The new input
  combination is the opt-in: without it every invocation is byte-identical (the source integrity,
  permission gate, and isolation review all apply to the edited script exactly as to a fresh run,
  so an edited `script_path`/project/user/plugin source is re-reviewed and inline stays ungated).
  Editing a run's own persisted anchor in place breaks its resume, so iterate on a **copy**. An
  empty selector value (e.g. `--name=`) now fails loud instead of silently resuming the original
  script. See `docs/ultracode-p6-edit-and-iterate.md`.
- `workflow.nestedWorkflows` (`--nested-workflows`): opt-in support for a workflow
  script calling `workflow(nameOrRef, args?)` to run another workflow inline as a
  child. `disabled` (the default) keeps the previous throwing stub, so existing
  behavior is byte-identical. When `enabled`, a workflow may nest a **built-in**
  workflow by name or an **inline** child via `{ script }`; the child shares the
  parent run's concurrency pool, agent counter, token budget, abort signal, and
  journal, its agents render under a `▸ name` group, and it returns its result to
  the caller. `workflow()` inside a child throws (one level only). Nesting is
  resumable: the child's agents journal onto the parent's single call-key chain, so
  an unchanged resume is a full cache hit and a changed child re-runs only from the
  diverged call. v1 limits: nested children run **sequentially** (a second `workflow()`
  started while another child is in flight is rejected), a nested child does not announce
  a progress plan, and — like `--budget` — the flag is **not inherited on resume**, so
  re-pass `--nested-workflows` when resuming a nested run. Project/user/plugin and
  `{ scriptPath }` children are deferred behind the permission gate. See
  `docs/ultracode-p5-nested-workflow.md`.
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
- `parallel()` and `pipeline()` now reject a call with more than 4096 items with an
  explicit `workflow_input_invalid` error instead of silently accepting an unbounded
  batch, matching the native per-call item cap.

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
- `pipeline()` stages now receive `(prevResult, originalItem, index)`, matching the
  native signature; previously a stage saw only `prevResult`. This part is additive:
  existing single-argument stages ignore the new arguments and behave identically.
  Separately — and this is a behavior change — a stage that *returns* `null`/`undefined`
  now passes that value onward to the next stage instead of short-circuiting the item;
  only a stage that *throws* drops the item to `null` and skips its remaining stages
  (unchanged). This affects any multi-stage pipeline whose earlier stage can return a
  nullish value, regardless of how many arguments its stages read. Every built-in
  workflow is unaffected (`code-review` runs a single-stage pipeline). See
  `docs/ultracode-p3f-contract-correctness.md`.

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
