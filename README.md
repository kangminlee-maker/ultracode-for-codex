# Ultracode for Codex

Ultracode for Codex ships two Codex skill commands plus a local npm CLI runtime.
`$ultracode-for-codex` is the default high-visibility mode: the Codex main
context plans adaptive phases, spawns focused parallel subagents, synthesizes
their results, and reports progress directly in the chat.
`$ultracode-for-codex-cli` is the explicit runtime path for package validation,
background jobs, attached CLI runs, release checks, and reproducible local
workflow artifacts.

## Quick Start

Install from npm:

```bash
npm install --save-dev ultracode-for-codex
npm exec -- ultracode-for-codex --llm-guide
```

Or install the CLI globally:

```bash
npm install -g ultracode-for-codex
ultracode-for-codex --version
ultracode-for-codex --llm-guide
```

Install the Codex skill commands from a project install:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R ./node_modules/ultracode-for-codex/skills/ultracode-for-codex \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
cp -R ./node_modules/ultracode-for-codex/skills/ultracode-for-codex-cli \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Or install the skill commands from a global npm install:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
GLOBAL_NODE_MODULES="$(npm root -g)"
cp -R "$GLOBAL_NODE_MODULES/ultracode-for-codex/skills/ultracode-for-codex" \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
cp -R "$GLOBAL_NODE_MODULES/ultracode-for-codex/skills/ultracode-for-codex-cli" \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Build and verify a local installable tarball from a source checkout:

```bash
npm install
npm run pack:ultracode-for-codex
```

Install the tarball from a target project:

```bash
npm install --save-dev /path/to/ultracode-for-codex-<version>.tgz
```

Run through the CLI runtime when that path is explicitly wanted:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/target-repo \
  --script-file .codex/workflows/review.js \
  --args '{"prompt":"review the current change"}'
```

By default this prints a background launch record to stdout. The record contains
`jobId`, `pid`, `resultPath`, `progressPath`, `metadataPath`, and `pidPath`.
Use the job id to inspect or control the background run:

```bash
npm exec -- ultracode-for-codex status <jobId> --cwd /path/to/target-repo
npm exec -- ultracode-for-codex wait <jobId> --cwd /path/to/target-repo
npm exec -- ultracode-for-codex logs <jobId> --cwd /path/to/target-repo --tail 40
npm exec -- ultracode-for-codex result <jobId> --cwd /path/to/target-repo
npm exec -- ultracode-for-codex cancel <jobId> --cwd /path/to/target-repo
npm exec -- ultracode-for-codex jobs --cwd /path/to/target-repo
npm exec -- ultracode-for-codex archive <jobId> --cwd /path/to/target-repo
```

Run attached to the current terminal:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --execution attached \
  --cwd /path/to/target-repo \
  --script-file .codex/workflows/review.js \
  --args '{"prompt":"review the current change"}'
```

Named workflows are resolved from `.codex/workflows`, user workflow folders,
plugin workflow folders, and built-ins:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/target-repo \
  --name task \
  --args '{"prompt":"review correctness risks and propose fixes"}'
```

The CLI built-in `task` and `code-review` workflows use an LLM planner first,
then run work phase by phase. Within each phase, multiple focused Codex
subagents run in parallel by default, followed by phase and final synthesis. The
planner may choose a single-agent path only when parallel execution would add
risk or waste. Planner guidance includes dynamic workflow patterns such as
classify-and-act, fan-out-and-synthesize, adversarial verification,
generate-and-filter, tournament, and loop-until-done, so different work types
can use different phase shapes.

## Settings

Package defaults live in `settings.json`:

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

Use `--execution attached`, `--progress`, `--permission`, `--retry-limit`, and
`--timeout-ms` to override settings for one run.
The package default workflow timeout is `0`, meaning the workflow waits until it
completes, is cancelled, or the Codex app-server exits. Set `--timeout-ms` to a
positive value to opt into a deadline for one run.
Use the default background execution for long Codex-launched work so Codex can
continue other tasks and inspect the job later with `status`, `logs`, or
`result`. Use
`--execution attached` only when the caller must block until the final result.

## CLI Controls

- Use `--version` or `-v` to print the installed package version.
- Use `status`, `wait`, `logs`, `result`, and `cancel` with a background
  `jobId` or `metadata.json` path to inspect, wait for, read, or cancel OS
  background runs.
- Use `jobs` or `list` to enumerate local background runs.
- Use `archive` or `export` to write a sensitive local JSON bundle for one run
  without deleting runtime state.
- Use `wait --result`, `cancel --wait`, `logs --event <event>`, and `--plain`
  for shorter foreground checks.
- Progress is printed to stderr as JSONL by default.
- The final workflow result is printed as JSON to stdout.
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
- After a completed run, `workflow.summary.ready` reports each phase with its
  planned agent count and angle/focus list, then `workflow.review.recommended`
  asks the current session LLM to critically re-check the final result before
  acting on it.
- Press `Ctrl-C` once to cancel the active workflow.
- Use `--retry-limit <n>` to retry failed workflows inside the same process.
- `--timeout-ms 0` waits for completion, cancellation, or app-server exit.
  Positive values opt into a workflow deadline and per-agent silence budget;
  that budget is not divided by the retry budget.
- Use `--permission ask|allow|deny` for project/user/plugin/scriptPath workflow
  permission reviews.
- Use `--progress plain` for human-readable log lines.
- Use `--execution background` for OS background runs and `--execution attached`
  only when the caller should stay connected until completion.

## Codex Skill Commands

The npm package includes two Codex skill command folders:

- `skills/ultracode-for-codex`: default Codex-native orchestration. The main
  context plans adaptive phases, spawns parallel subagents, synthesizes each
  phase, reports completion progress, and recommends a final critical re-check.
  Live progress uses test-runner-style visual snapshots; completion reporting
  uses a diffstat-style impact summary plus a plan-style result summary.
- `skills/ultracode-for-codex-cli`: explicit CLI runtime operations, including
  background jobs, attached runs, packaging, release checks, runtime-boundary
  validation, and installed E2E tests.

## Runtime Boundaries

- The only production backend is Codex app-server over stdio.
- Direct provider credentials are stripped from the Codex child process
  environment.
- Codex subagents run against the requested workflow cwd and receive bounded
  read-only workspace tools for text file reads and directory listings.
- CLI built-in `task` and `code-review` inject deterministic workspace context into
  planner-selected phase-wise parallel subagents, then synthesize each phase and
  the final result.
- Workflow execution is local and command-owned; settings default to OS
  background execution so long runs can keep waiting while Codex does other
  work.
- `.ultracode-for-codex` workflow state is sensitive local data.
- `journalPath`, `journal.jsonl`, and journal contents stay out of CLI output.
  Local runtime state may still contain runtime-owned
  `transcriptDir`, `scriptPath`, and result files.
- `resumeFromRunId` remains runtime-internal and same-session; users retry the
  active run or rerun the workflow command.
- `agent(..., { isolation: "worktree" })` runs the agent in a detached git
  worktree and preserves the worktree for review, including clean worktrees.

## Development

```bash
npm install
npm test
npm run pack:ultracode-for-codex
npm run test:e2e:ultracode-for-codex
npm run test:all
```

## Publishing

The npm package name is `ultracode-for-codex`. Public publish metadata lives in
`package.json`, and `prepublishOnly` runs the full verification suite before
`npm publish`.

Check the package before publishing:

```bash
npm run publish:dry-run
```

Publish after `npm login`:

```bash
npm run publish:npm
```

For supported CI/CD environments, provenance is available as an explicit opt-in:

```bash
npm run publish:npm:provenance
```

Optional live smoke against the local Codex CLI:

```bash
ULTRACODE_LIVE_SMOKE=1 npm run smoke:live
```

Useful local run:

```bash
npm run build
node dist/cli.js run --accept-llm-guide=v1 --script-file ./workflow.js
```

## Docs

- `skills/ultracode-for-codex/SKILL.md`: default Codex-native orchestrator
  skill command.
- `skills/ultracode-for-codex/references/progress-visuals.md`: golden visual
  progress and completion summary examples for native orchestration.
- `skills/ultracode-for-codex-cli/SKILL.md`: explicit CLI runtime skill command.
- `ULTRACODE_INSTALL.md`: install and operating guide for LLM agents.
- `docs/ultracode-p3a-journal-design.md`: journal contract.
- `docs/ultracode-p3b-resume-cache.md`: runtime-internal resume/cache contract.
- `docs/ultracode-p3c-worktree-isolation.md`: worktree isolation contract.
