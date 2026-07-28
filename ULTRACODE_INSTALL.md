# Ultracode install and usage guide

This file is for LLM agents installing or operating `ultracode-for-codex`.
Read it before running CLI workflows, installing the Codex skill commands, or
generating integration code.

## What This Package Does

`ultracode-for-codex` provides two Codex skill command surfaces and a local
command-owned workflow runtime backed by an already-authenticated Codex CLI
session.

Skill commands:

- `$ultracode-for-codex`: default hybrid orchestration. The main Codex
  context plans phases, delegates fan-out phases to this CLI runtime when it
  is installed (falling back to Codex-native subagents), synthesizes results,
  and shows progress directly in the chat with test-runner-style live snapshots
  and diffstat-plus-plan completion summaries.
- `$ultracode-for-codex-cli`: explicit CLI runtime operation for background
  jobs, attached runs, package validation, release checks, and reproducible
  local runtime artifacts.

The packaged `settings.json` defaults CLI workflow runs to OS background
execution with result and progress files under
`${ULTRACODE_FOR_CODEX_HOME:-~/.ultracode-for-codex}/background/{jobId}`.

Production surface:

- `ultracode-for-codex run`
- `ultracode-for-codex status`
- `ultracode-for-codex wait`
- `ultracode-for-codex logs`
- `ultracode-for-codex result`
- `ultracode-for-codex cancel`
- `ultracode-for-codex jobs`
- `ultracode-for-codex list`
- `ultracode-for-codex archive`
- `ultracode-for-codex export`
- `ultracode-for-codex skills`
- `ultracode-for-codex setup`

Progress, cancellation, permission review, retry, and final result projection
are handled inside the CLI process. Progress is JSONL on stderr by
default so Codex can parse and summarize workflow state.

## Install

Use the npm package for consumer installs.

```bash
npm install --save-dev ultracode-for-codex
npm exec -- ultracode-for-codex --help
npm exec -- ultracode-for-codex --llm-guide
```

For source-checkout validation, install the generated tarball instead:

```bash
npm install --save-dev ./ultracode-for-codex-<version>.tgz
```

Optional Codex skill commands:

```bash
npm exec -- ultracode-for-codex skills --install
```

This copies both packaged skill folders into
`${CODEX_HOME:-$HOME/.codex}/skills`. Installed skill commands do not update
themselves: re-run it after package updates. `ultracode-for-codex skills`
(without `--install`) reports `current`, `stale`, or `missing` per skill, and
`npm install` prints a reminder when previously installed skill commands no
longer match the package. A skill folder that does not declare the expected
skill name is reported `unmanaged` and never overwritten.

`$ultracode-for-codex` keeps orchestration in the main Codex context.
`$ultracode-for-codex-cli` uses the npm CLI runtime. The npm package remains the
runtime artifact for CLI execution.

## Run The CLI Runtime

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --script-file .codex/workflows/review.js \
  --args '{"prompt":"review the current change"}'
```

The default run prints a background launch record to stdout. Prefer that
background path for long Codex-launched work so Codex can continue other tasks
and inspect the job later with `status`, `logs`, or `result`. Use
`--execution attached` only when the caller must block until completion.

Use the background `jobId` from the launch record to inspect or control the run:

```bash
npm exec -- ultracode-for-codex status <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex wait <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex logs <jobId> --cwd /path/to/project --tail 40
npm exec -- ultracode-for-codex result <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex cancel <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex jobs --cwd /path/to/project
npm exec -- ultracode-for-codex archive <jobId> --cwd /path/to/project
```

Use CLI built-in `task` for general work and `code-review` for review-specific
work. `task` starts with an LLM planner, executes phase by phase, runs multiple
focused Codex subagents in parallel within each phase by default, and chooses a
single-agent path only when parallel execution would add risk or waste. Planner
guidance includes classify-and-act, fan-out-and-synthesize, adversarial
verification, generate-and-filter, tournament, and loop-until-done patterns so
different work types can use different phase shapes.

`code-review` uses a specialized review harness. It collects bounded repository
evidence, selects active review lenses, runs one finder per lens in parallel,
verifies every emitted candidate with a candidate-scoped subagent, optionally
runs an `xhigh` sweep, then synthesizes final findings by verified candidate
index. The final JSON includes `findings`, `provenance`, `synthesis`, and
`stats`.

## Author A Workflow Script

Use this contract when writing a workflow script for `run --script`,
`run --script-file`, or a project workflow under `.codex/workflows/`.

Structure:

- The script must start with `export const meta = { ... };` as a pure object
  literal: `name` (required), `description`, and optional `phases` display
  hints. No variables, calls, spreads, or template strings inside `meta`.
- The body is plain async JavaScript (no TypeScript syntax). `return` produces
  the workflow result JSON.
- Forbidden inside scripts, rejected statically before any agent runs: `Date`,
  `Math.random` (and computed `Math[...]`), dynamic `import`, `eval`, the
  `Function` constructor, `WebAssembly`, `require`, `process`, `module`,
  `exports`, `global`, `globalThis`, `Object`, `Reflect`, `constructor`,
  `prototype`, `__proto__`, and TypeScript type annotations. **Declaring your own
  `async function` is also rejected** — the body is already async, so use
  top-level `await` and `.then()`. Scripts are capped at 64 KiB.
- `meta` is also injected as a script-local constant, so the body can read
  `meta.name` and `meta.phases` without redeclaring them.

API surface:

- `agent(prompt, options)` runs one Codex subagent and returns its raw text,
  or the validated structured value when `options.schema` is set. Options:
  - `schema`: JSON Schema for the required structured return value. The
    runtime forces a StructuredOutput submission and validates it; use
    `additionalProperties: false` to reject unknown fields. Pass a schema for
    every result the script or a later phase consumes as data.
  - `effort`: `none|minimal|low|medium|high|xhigh|max` (the run-level setting
    defaults to `xhigh`). An agent without an explicit effort inherits
    `--reasoning-effort`. `ultra` is intentionally unavailable because Codex
    maps it to proactive native delegation outside this runtime's journal and
    cost accounting. Model support is checked against `model/list` before the
    first turn; unsupported combinations fail before agent-token spend.
  - `model`: per-agent model override. Precedence: per-agent `model` beats
    run-level `--model`, which beats the Codex thread default. Unknown models
    fail that agent loudly; there is no silent fallback.
  - `key`: logical identity for resume/cache — a trimmed string of at most 160
    characters matching `^[A-Za-z0-9_.:/@+-]+$`. Required discipline for dynamic
    parallel agents: bind the key to the evidence snapshot it depends on
    (for example fold a `workspaceContext` snapshot hash into the key), and
    never reuse a key within one run — a duplicate key fails at reservation.
    Without a key, call identity chains positionally, so inserting an agent
    invalidates the cache for every agent after it; with a key, an unchanged call
    can be reused even after a reorder.
  - `agentType`: a type name from your Codex registry (`~/.codex/agents/*.toml`),
    which supplies developer instructions plus a default model and effort for that
    one agent. Requires `--agent-types enabled`; an unknown name fails before
    spend. An explicit `model`/`effort` on the call still wins.
  - `label` and `phase`: display grouping only; not part of cache identity.
  - `isolation: "worktree"`: run the agent in an isolated git worktree. It must be
    covered by the run's permission review or the call throws.
  - **In the resume call key:** the prompt, `schema`, `model`, `effort`,
    `isolation`, `agentType`, and `key`. Not in it: `label` and `phase`. Changing
    anything in the key means that agent re-runs on resume instead of replaying.
- `parallel(items)` runs thunks concurrently, at most 16 at a time, and returns
  results in input order. A failed item becomes `null` in the result array; the
  script must check for `null` and fail closed when the result is required.
- `pipeline(items, ...stages)` moves each item through stages independently. Each
  stage is called `(previousResult, originalItem, index)`. It is item-preserving:
  stage return arrays are not flattened. Only a stage that **throws** drops its
  item to `null`; a stage that returns `null` or `undefined` passes that value on
  as the next stage's input.
- `parallel` and `pipeline` accept at most 4096 items — exceeding it is an error,
  never a silent truncation. A run may make at most 1000 agent calls.
- `workflow(name, args)` runs another workflow as a nested child and returns its
  result. It requires `--nested-workflows enabled`, is one level deep only, and a
  child from a permission-gated source runs only if that exact workflow was
  already approved. Disabled by default: calling it then fails loudly.
- `phase(title)` groups later agents in progress output; overlapping calls
  should pass an explicit `phase` option instead. A `meta.phases[]` entry with the
  same `title` supplies that phase's display detail.
- `workspaceContext(options)` returns deterministic workspace evidence **as a
  single string** — parse it by its section headings, which are part of the
  contract (`## Workspace Context`, `Root:`, and with `includeDiff: true` also
  `evidenceGate:`, `evidenceGateReason:`, `### Change Evidence`,
  `### Allowed Evidence Refs`, `### Unavailable Evidence`, then `### Git Status`
  and `### Included Files`). Options `query`, `files`, `includeDiff`,
  `diffBaseRef`, `maxFiles`, `maxFileBytes`, `maxBytes`, and `maxDiffBytes` are
  clamped rather than rejected. The README's Workflow Script Contract section
  lists the full section order.
- `log(message)`, `announcePlan`, `announcePhasePlan`, `hash(value)`, `args`,
  and `budget` are available; `setTimeout`/`clearTimeout` work inside the
  run. `console.log`, `console.warn`, and `console.error` are aliases of `log`.
- `budget` exposes `total` (the `--budget` ceiling, or `null`), `spent()`,
  `remaining()`, `maxAgentCalls`, `maxParallelism`, and `agentConcurrency`.
  `spent()` counts only this run's fresh output tokens, so a resumed agent whose
  result was replayed from cache contributes nothing.
- Catchable with `try`/`catch`: input errors, script errors, structured-output
  failures, and coded agent failures. **Not catchable:** a journal write failure
  and a throwing `setTimeout` callback — both fail the run out of band. After
  cancellation `agent()` returns `null`, `log()` no-ops, and `phase()` and
  `workspaceContext()` throw.

This contract governs script *structure*. For the natural-language `prompt`
body of each `agent()` call — outcome-first framing, grounding and verification
rules, and per-task shape for the current Codex model family — follow
`skills/ultracode-for-codex/references/codex-agent-prompting.md`. It enforces
the division of labor: `schema` owns output shape, `effort` owns reasoning
depth, and the prompt owns intent and evidence discipline, so do not restate
JSON shape or ask an agent to "think harder" in the prompt.

Validate before launching:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --validate \
  --script-file ./phase-review.js
```

`--validate` resolves and parses the source without running agents. It
hard-fails structural problems (meta shape, size cap, forbidden APIs) and
prints non-blocking static warnings: agent() call sites without `schema` and
dynamic fan-out without a logical `key`. For a built-in that reviews change
evidence it also reports the evidence precondition — whether the gate would open,
the citable refs, and every dropped path with the rule that dropped it — using
the same builder the run uses, so the pre-check cannot disagree with the launch.
Read `evidence.gated` rather than the top-level `status`: `status: "valid"`
answers whether the request is well-formed, and a well-formed request can still
be gated.

Settings defaults — this is the complete shipped `settings.json`, and the
installed package's own copy is the only one the runtime reads. There is no
project-level or user-level settings file and no environment override of a
settings key, so a persistent change means editing that file; otherwise pass the
flag.

```json
{
  "workflow": {
    "executionMode": "background",
    "progress": "jsonl",
    "permission": "ask",
    "retryLimit": 0,
    "timeoutMs": 0,
    "heartbeatMs": 120000,
    "worktreeRetention": "remove-clean",
    "agentConcurrency": "unbounded",
    "nestedWorkflows": "disabled",
    "evidenceScope": "default",
    "refPolicy": "strict",
    "agentWebSearch": "disabled",
    "agentFileWrite": "disabled",
    "agentMcp": [],
    "agentTypes": "disabled",
    "background": {
      "runDir": "{stateRoot}/background/{jobId}",
      "resultFile": "result.json",
      "progressFile": "progress.jsonl",
      "metadataFile": "metadata.json",
      "pidFile": "pid"
    }
  },
  "codex": {
    "reasoningEffort": "medium",
    "verbosity": "medium"
  }
}
```

`--budget` has no settings key: it is off unless the flag is passed.

Useful controls:

- `--version` or `-v` prints the installed package version.
- `status`, `wait`, `logs`, `result`, and `cancel` accept a background `jobId`
  or `metadata.json` path.
- `jobs` and `list` enumerate local background runs.
- `archive` and `export` write a sensitive local JSON bundle for one run without
  deleting runtime state.
- `wait --result`, `cancel --wait`, `logs --event <event>`, and `--plain` are
  available for shorter foreground checks.
- Progress events are printed to stderr as JSONL by default.
- The final workflow result is printed as JSON to stdout.
- A terminal failure prints an `ultracode.workflow.failure` record (`status`,
  `failure.reason`, `failure.error`, `failure.workflowName`, `failure.taskId`,
  `failure.runId`, plus `failure.phase`/`failure.agentsCompleted` when known)
  to the same stdout channel, so background `result.json` parses on both
  outcomes. `status` classifies a failure record as `failed` even without
  progress events, and `result` prints it with exit code 1.
- A failed agent's error message carries a `[codex thread <id>]` correlation id
  so the failure can be traced to its Codex app-server thread in run logs. The
  thread is ephemeral and its isolated home is removed on close, so this is a
  diagnostic correlation id, not a `codex resume` handle.
- The package default workflow timeout is `0`, meaning the workflow waits until
  it completes, is cancelled, or the Codex app-server exits.
- Under an unbounded (`0`) timeout, a non-destructive `workflow.heartbeat`
  progress event is emitted every `workflow.heartbeatMs` (default 120000 ms)
  while a run is in flight, carrying elapsed time, current phase, and
  completed/known agent counts. It never aborts or retries the run — it only
  makes a long or stuck run visible. Override per run with `--heartbeat-ms <n>`;
  `0` disables it.
- JSONL records include `kind`, `version`, `event`, `status`, and `summary`;
  agent records also include stable agent identity and label fields.
- Built-in `task` and `code-review` emit `workflow.plan.ready` as a planning
  snapshot, not a promise that every later phase is already known. In
  `code-review`, later verifier agents are discovered after finder agents emit
  candidates.
- `workflow.phase.planned` is emitted immediately before each phase starts and
  carries that phase's current planned agent role labels. Each
  `workflow.phase.started` record repeats the same role labels when the phase
  begins.
- Each `workflow.agent.completed` record includes phase progress, total known
  agent progress, and elapsed time.
- After a completed run, `workflow.summary.ready` reports each phase with its
  planned agent count and angle/focus list, then `workflow.review.recommended`
  asks the current session LLM to critically re-check the final result before
  acting on it.
- Press `Ctrl-C` once to cancel the running workflow.
- Use `--retry-limit <n>` to retry failed runs in the same process; each
  retry resumes the failed run, so durably completed agent results are
  reused instead of re-running.
- Use `--resume-from-run-id <runId>` to resume a completed, failed, cancelled,
  or interrupted local workflow from preserved runtime state. Resume always
  uses the original persisted workflow source; without `--args`, it also
  reuses the original args, and without `--model`, it adopts the source run's
  model so cached agent results stay reusable. Run resume from the source
  run's working directory. `status <jobId>` reports the `runId` and `cwd` the
  resume needs; a job that died before `workflow.started` has no journal and
  must be relaunched instead.
- `--timeout-ms 0` waits for completion, cancellation, or app-server exit.
  Positive values opt into a workflow deadline and per-agent silence budget;
  that budget is not divided by the retry budget.
- Use `--permission ask|allow|deny` for project/user/plugin/scriptPath
  workflow permission reviews.
- Use `--progress plain` for human-readable log lines.
- `--evidence-scope all` forgives only the evidence extension allowlist, which
  makes `.java`/`.rb`/`.sql`/`.kt` projects reviewable by `code-review`; excluded
  directories, runtime state, and unsafe paths stay inadmissible at every scope.
- `--ref-policy lenient` drops the one candidate whose cited evidence ref cannot
  be resolved instead of failing the run, and discloses it in the result's
  `degraded` block with `stats.refDrops`. A run whose candidates all dropped
  still fails, so a degraded review never presents as a clean one. Lens decisions
  and structural violations stay fatal at either policy. A non-default policy is
  announced at launch; a resume or a `--script-path` launch across policies is
  refused, because the policy is baked into the generated script text.
- The README documents the complete execution and output contract: every flag,
  every `--args` schema, every record and progress event, the failure-reason
  vocabulary, and each built-in's result payload.
- Use `--execution background` for OS background runs and `--execution attached`
  only when the caller should stay connected until completion.

## Model And Config Conventions

- The live Codex `model/list` catalog owns available models and efforts. A
  run-level `--model`, inherited top-level Codex model, or catalog default is
  selected in that order; there is no hard-coded model fallback.
- `gpt-5.6-sol` supports the recommended balanced paths:
  `--reasoning-effort medium` for bounded analysis and `high` for
  correctness-sensitive work. `max` is available when the selected catalog
  model supports it. `ultra` remains native-Codex-only.
- Built-in `task` runs its planner at `medium`; other task agents inherit the
  run-level effort. Built-in `code-review` with `{"level":"high"}` uses
  `medium` scope plus `high` find/verify/synthesis. The default deep review
  keeps the high/xhigh funnel.
- Auth and the default model are inherited from your Codex install: the runtime
  copies `auth.json` and reads the top-level `model` from
  `${CODEX_HOME:-~/.codex}` (and its `config.toml`). Run `setup --model
  gpt-5.6-sol --reasoning-effort high` to confirm authentication and the exact
  model/effort capability before a delegated phase.
- Subagents otherwise run under an isolated, minimal `config.toml`
  (`web_search` disabled, read-only sandbox, analytics off) for reproducibility.
  Native multi-agent concurrency is capped at one total thread, so delegated
  agents cannot spawn unjournaled descendants even when model metadata enables
  Codex multi-agent V2.
  Project-level `.codex/config.toml` overrides beyond the default model are
  intentionally not applied to subagents — steer per run with `--model` /
  `--reasoning-effort`, or per agent with `model` / `effort`.

## Runtime Contract

- Use Codex app-server over stdio as the production backend.
- Keep CLI workflow execution local and command-owned; settings default to OS
  background execution so long runs can keep waiting while Codex does other
  work.
- Route progress, cancellation, permission review, retry, and result projection
  through the CLI command.
- Keep stdout reserved for the final JSON result; stream progress records to
  stderr as JSONL unless a human chooses `--progress plain`. The channel is
  total: terminal failures print an `ultracode.workflow.failure` record
  instead of leaving stdout (and background `result.json`) empty.
- Strip direct provider credentials from child CLI environments.
- Run Codex subagents against the requested workflow cwd and provide bounded
  read-only workspace tools for text file reads and directory listings.
- Built-in `task` adds deterministic workspace context to planner-selected,
  read-only phase-wise analysis subagents; the main orchestrator owns edits.
  Built-in `code-review` uses deterministic
  review evidence, allowed evidence refs, dynamic lenses, candidate verification,
  and bounded final synthesis. It reviews pending working-tree changes plus the
  `diffBaseRef..HEAD` range when one resolves; with neither it fails before
  spawning any agent with `no reviewable change evidence in the working tree`,
  naming which rule dropped which path, and ref rejections name the allowed set,
  its size, its source, and what populates it. Built-in args are validated at
  launch against a per-built-in contract, so an unknown key, a mistyped key, an
  unsupported `level`, or an unresolvable `diffBaseRef` is rejected before any
  spend with the rejected value, the cause, and the remediation. Cited refs are
  normalized before rejection (a trailing line number is stripped, and a
  mismatched ref kind resolves through the cited path), so only a path that is
  not in the evidence snapshot still fails closed.
- under `--ref-policy lenient` a ref that still resolves to no path in evidence drops
  that one candidate rather than the run, and the result reports `degraded` plus
  `stats.refDrops`; a run whose candidates all dropped still fails, and lens decisions
  and structural violations remain fatal at every policy.
- `run --validate` is the zero-token pre-check: it validates the request contract
  and, for `code-review`, reports the change-evidence precondition — whether the
  gate would open, the allowed evidence refs, and every dropped path with its
  rule. Use it before launching a run.
- Install consumers from a packaged artifact.
- Keep `journalPath`, `journal.jsonl`, and journal contents out of CLI output.
  Local runtime state may still contain runtime-owned
  `transcriptDir`, `scriptPath`, and result files.
- `--resume-from-run-id` reads the preserved runtime script and journal from
  the workflow state directory under
  `${ULTRACODE_FOR_CODEX_HOME:-~/.ultracode-for-codex}`. Completed sources
  bind through the result record; failed, cancelled, and interrupted sources
  are discovered journal-first from `workflow.run.started`. Completed agent
  results are reused only when their runtime-owned call keys still match, and
  the script path, script source identity, and inherited args must match the
  source journal. Resumed launches disclose the source terminal state, a
  model mismatch, and workspace drift since the source run as progress log
  lines; drift does not block cached reuse.
- Use `isolation: "worktree"` only in git repositories with at least one commit.
  A completed agent's worktree is reclaimed when it holds no real changes; one
  that holds changes, stalled, or was aborted is intentionally preserved for
  review and never auto-merged. Set `workflow.worktreeRetention` (or
  `--worktree-retention`) to `preserve-all` to keep every worktree.
- Treat workflow state under `${ULTRACODE_FOR_CODEX_HOME:-~/.ultracode-for-codex}`
  as sensitive local data. Project-local `.ultracode-for-codex/` directories are
  legacy state and should stay ignored.

## First Checks After Install

```bash
npm exec -- ultracode-for-codex --help
npm exec -- ultracode-for-codex --version
npm exec -- ultracode-for-codex --llm-guide
npm exec -- ultracode-for-codex setup
```

`setup` (alias `doctor`) verifies the whole chain in one call — package
version, Codex CLI presence and version, Codex app-server reachability, Codex
authentication (ChatGPT login, API key, or a no-auth provider), and whether the
installed skill commands match this package. It prints JSON by default (`--plain`
for human lines) and exits non-zero when anything blocks a delegated phase, so a
failing auth or a missing Codex install is caught before a workflow starts
instead of mid-run. When it reports not authenticated, run `!codex login`; when
it reports stale or missing skills, run `ultracode-for-codex skills --install`.

If this guide is missing, treat the package as invalid. If `run` is used without
`--accept-llm-guide=v1`, the CLI prints this guide and exits before executing a
workflow.

## Documentation Map

- `README.md`: human quickstart and common examples.
- `skills/ultracode-for-codex/SKILL.md`: default hybrid orchestrator
  command.
- `skills/ultracode-for-codex/references/progress-visuals.md`: golden visual
  progress and completion summary examples for native orchestration.
- `skills/ultracode-for-codex/references/codex-agent-prompting.md`: how to write
  the natural-language `agent()` prompt body for the current Codex model family.
- `skills/ultracode-for-codex-cli/SKILL.md`: explicit CLI runtime command.
- `docs/ultracode-p3a-journal-design.md`: implemented journal contract.
- `docs/ultracode-p3b-resume-cache.md`: local resume/cache contract.
- `docs/ultracode-p3c-worktree-isolation.md`: worktree isolation contract.
