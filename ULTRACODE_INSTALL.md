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
- Forbidden inside scripts: `Date`, `Math.random`, dynamic `import`, `eval`,
  and the `Function` constructor. Scripts are capped at 64 KiB. Violations
  fail before any agent runs.

API surface:

- `agent(prompt, options)` runs one Codex subagent and returns its raw text,
  or the validated structured value when `options.schema` is set. Options:
  - `schema`: JSON Schema for the required structured return value. The
    runtime forces a StructuredOutput submission and validates it; use
    `additionalProperties: false` to reject unknown fields. Pass a schema for
    every result the script or a later phase consumes as data.
  - `effort`: `none|minimal|low|medium|high|xhigh` (default `xhigh`).
    Funnel-tier: wide sweeps and finder-style scans at `high` or below,
    verdicts and synthesis at `xhigh`. Model support varies: the current
    default Codex model rejects `minimal`, and an unsupported effort fails
    that agent loudly.
  - `model`: per-agent model override. Precedence: per-agent `model` beats
    run-level `--model`, which beats the Codex thread default. Unknown models
    fail that agent loudly; there is no silent fallback.
  - `key`: logical identity for resume/cache. Required discipline for dynamic
    parallel agents: bind the key to the evidence snapshot it depends on
    (for example fold a `workspaceContext` snapshot hash into the key), and
    never reuse a key within one run — a duplicate key fails at reservation.
  - `label` and `phase`: display grouping only; not part of cache identity.
  - `isolation: "worktree"`: run the agent in an isolated git worktree.
- `parallel(items)` runs thunks concurrently. A failed item becomes `null`
  in the result array; the script must check for `null` and fail closed when
  the result is required.
- `pipeline(items, ...stages)` moves each item through stages independently.
  It is item-preserving: stage return arrays are not flattened.
- `phase(title)` groups later agents in progress output; overlapping calls
  should pass an explicit `phase` option instead.
- `workspaceContext(options)` returns deterministic workspace evidence
  (`includeDiff: true` adds bounded diff evidence and allowed evidence refs).
- `log(message)`, `announcePlan`, `announcePhasePlan`, `hash(value)`, `args`,
  and `budget` are available; `setTimeout`/`clearTimeout` work inside the
  run.

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
dynamic fan-out without a logical `key`.

Settings defaults:

```json
{
  "workflow": {
    "executionMode": "background",
    "progress": "jsonl",
    "permission": "ask",
    "retryLimit": 0,
    "timeoutMs": 0,
    "background": {
      "runDir": "{stateRoot}/background/{jobId}",
      "resultFile": "result.json",
      "progressFile": "progress.jsonl",
      "metadataFile": "metadata.json",
      "pidFile": "pid"
    }
  }
}
```

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
- The package default workflow timeout is `0`, meaning the workflow waits until
  it completes, is cancelled, or the Codex app-server exits.
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
- Use `--execution background` for OS background runs and `--execution attached`
  only when the caller should stay connected until completion.

## Runtime Contract

- Use Codex app-server over stdio as the production backend.
- Keep CLI workflow execution local and command-owned; settings default to OS
  background execution so long runs can keep waiting while Codex does other
  work.
- Route progress, cancellation, permission review, retry, and result projection
  through the CLI command.
- Keep stdout reserved for the final JSON result; stream progress records to
  stderr as JSONL unless a human chooses `--progress plain`.
- Strip direct provider credentials from child CLI environments.
- Run Codex subagents against the requested workflow cwd and provide bounded
  read-only workspace tools for text file reads and directory listings.
- Built-in `task` adds deterministic workspace context to planner-selected
  phase-wise parallel subagents. Built-in `code-review` uses deterministic
  review evidence, allowed evidence refs, dynamic lenses, candidate verification,
  and bounded final synthesis.
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
  Isolated worktrees are intentionally preserved for review, including clean
  worktrees.
- Treat workflow state under `${ULTRACODE_FOR_CODEX_HOME:-~/.ultracode-for-codex}`
  as sensitive local data. Project-local `.ultracode-for-codex/` directories are
  legacy state and should stay ignored.

## First Checks After Install

```bash
npm exec -- ultracode-for-codex --help
npm exec -- ultracode-for-codex --version
npm exec -- ultracode-for-codex --llm-guide
```

If this guide is missing, treat the package as invalid. If `run` is used without
`--accept-llm-guide=v1`, the CLI prints this guide and exits before executing a
workflow.

## Documentation Map

- `README.md`: human quickstart and common examples.
- `skills/ultracode-for-codex/SKILL.md`: default hybrid orchestrator
  command.
- `skills/ultracode-for-codex/references/progress-visuals.md`: golden visual
  progress and completion summary examples for native orchestration.
- `skills/ultracode-for-codex-cli/SKILL.md`: explicit CLI runtime command.
- `docs/ultracode-p3a-journal-design.md`: implemented journal contract.
- `docs/ultracode-p3b-resume-cache.md`: local resume/cache contract.
- `docs/ultracode-p3c-worktree-isolation.md`: worktree isolation contract.
