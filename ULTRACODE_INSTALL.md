# Ultracode install and usage guide

This file is for LLM agents installing or operating `ultracode-for-codex`.
Read it before running workflows or generating integration code.

## What This Package Does

`ultracode-for-codex` provides a local command-owned workflow runtime backed by an
already-authenticated Codex CLI session. The packaged `settings.json` defaults
workflow runs to OS background execution with result and progress files under
`.ultracode-for-codex/background/{jobId}`.

Production surface:

- `ultracode-for-codex run`

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
npm install --save-dev ./ultracode-for-codex-0.2.6.tgz
```

Optional Codex companion skill:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R ./node_modules/ultracode-for-codex/skills/ultracode-for-codex \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
```

The skill is only an operating guide. The npm package remains the runtime
artifact.

## Run

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --script-file .codex/workflows/review.js \
  --args '{"prompt":"review the current change"}'
```

The default run prints a background launch record to stdout. Prefer that
background path for long Codex-launched work so Codex can continue other tasks
and inspect `progressPath` or `resultPath` later. Use `--execution attached`
only when the caller must block until completion.

Use built-in `task` for general work and `code-review` for review-specific work.
Both start with an LLM planner, execute phase by phase, run multiple focused
Codex subagents in parallel within each phase by default, and synthesize phase
and final results. The planner chooses a single-agent path only when parallel
execution would add risk or waste.
Planner guidance includes classify-and-act, fan-out-and-synthesize,
adversarial verification, generate-and-filter, tournament, and loop-until-done
patterns so different work types can use different phase shapes.

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
      "runDir": ".ultracode-for-codex/background/{jobId}",
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
- Progress events are printed to stderr as JSONL by default.
- The final workflow result is printed as JSON to stdout.
- The package default workflow timeout is `0`, meaning the workflow waits until
  it completes, is cancelled, or the Codex app-server exits.
- JSONL records include `kind`, `version`, `event`, `status`, and `summary`;
  agent records also include stable agent identity and label fields.
- Built-in `task` and `code-review` emit `workflow.plan.ready` as a planning
  snapshot, not a promise that every later phase is already known.
- `workflow.phase.planned` is emitted immediately before each phase starts and
  carries that phase's current planned agent role labels. Each
  `workflow.phase.started` record repeats the same role labels when the phase
  begins.
- Each `workflow.agent.completed` record includes phase progress, total known
  agent progress, and elapsed time.
- Press `Ctrl-C` once to cancel the running workflow.
- Use `--retry-limit <n>` to retry failed runs in the same process.
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
- Keep workflow execution local and command-owned; settings default to OS
  background execution so long runs can keep waiting while Codex does other
  work.
- Route progress, cancellation, permission review, retry, and result projection
  through the CLI command.
- Keep stdout reserved for the final JSON result; stream progress records to
  stderr as JSONL unless a human chooses `--progress plain`.
- Strip direct provider credentials from child CLI environments.
- Run Codex subagents against the requested workflow cwd and provide bounded
  read-only workspace tools for text file reads and directory listings.
- Built-in `task` and `code-review` add deterministic workspace context to
  planner-selected phase-wise parallel subagents, then synthesize each phase and
  the final result.
- Install consumers from a packaged artifact.
- Keep `journalPath`, `journal.jsonl`, and journal contents out of CLI output.
  Local runtime state may still contain runtime-owned
  `transcriptDir`, `scriptPath`, and result files.
- `resumeFromRunId` remains a runtime-internal same-session capability; the
  CLI uses retry or explicit reruns for user-facing recovery.
- Use `isolation: "worktree"` only in git repositories with at least one commit.
  Isolated worktrees are intentionally preserved for review, including clean
  worktrees.
- Treat `.ultracode-for-codex` workflow state as sensitive local data.

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
- `docs/ultracode-p3a-journal-design.md`: implemented journal contract.
- `docs/ultracode-p3b-resume-cache.md`: runtime-internal resume/cache contract.
- `docs/ultracode-p3c-worktree-isolation.md`: worktree isolation contract.
