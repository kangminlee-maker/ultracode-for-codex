# Ultracode for Codex

Durable, schema-enforced, resumable multi-agent workflows for Codex.

Codex Ultra already provides native proactive delegation for ordinary ad-hoc
parallel work. Ultracode adds the workflow guarantees that native delegation
does not make canonical: deterministic scripts, per-agent schemas and tiers,
hash-chained journals, completed-step reuse, background job control, and
permission-reviewed worktree isolation.

The default experience is hybrid: you ask for `$ultracode-for-codex`, and the
main Codex chat becomes the orchestrator. It plans the next useful phase,
delegates heavy parallel work to the local CLI workflow runtime when the
package is installed, summarizes results, and shows compact progress
snapshots directly in the conversation. Delegated phases get schema-enforced
agent outputs, per-agent effort/model tiers, a durable journal, and resume
after failures — and they keep running even if the chat session stops.

The same CLI runtime is available directly for background jobs, reproducible
workflow runs, package checks, or attached terminal execution. Without the
CLI, the skill falls back to Codex-native subagents.

## Why Use It

- Make repeated or long-running multi-agent work auditable and recoverable.
- Plan and verify implementation work phase by phase while the main Codex
  context owns edits.
- See what agents are doing, what finished, and what still needs attention.
- Keep long CLI workflows running in the OS background when desired.
- Recover interrupted work: a crashed, killed, or cancelled run resumes with
  its completed agent results reused instead of re-run.
- Tier cost to the work: wide sweeps run at a cheaper reasoning effort while
  verdicts and synthesis stay at full effort, and single agents can pin their
  own effort or model.
- Validate an authored workflow script before it spends any agent tokens.
- Package the same workflow behavior for repeatable local use.

## Install

For one project:

```bash
npm install --save-dev ultracode-for-codex
```

For global use:

```bash
npm install -g ultracode-for-codex
```

If you installed it globally, check the CLI directly:

```bash
ultracode-for-codex --version
ultracode-for-codex --llm-guide
```

If you installed it as a project dependency, check it with `npm exec --`:

```bash
npm exec -- ultracode-for-codex --version
npm exec -- ultracode-for-codex --llm-guide
```

To upgrade an existing install to the latest release:

```bash
npm install --save-dev ultracode-for-codex@latest   # project install
npm install -g ultracode-for-codex@latest           # global install
```

After every upgrade, re-run `skills --install` (next section) so the installed
Codex skill commands match the new package version — they do not update
themselves, and `npm install` prints a staleness reminder when they drift.

## Install The Codex Skills

After installing the npm package, install (or update) the included skill
commands into your Codex skills folder.

From a project install:

```bash
npm exec -- ultracode-for-codex skills --install
```

From a global install:

```bash
ultracode-for-codex skills --install
```

The command copies both skill folders into
`${CODEX_HOME:-$HOME/.codex}/skills` and is safe to re-run after every
package update — installed skill commands do not update themselves.
`ultracode-for-codex skills` (without `--install`) reports whether the
installed copies match the package, and `npm install` prints a reminder when
previously installed skill commands are out of date.

Restart Codex or start a new Codex session if the skills do not appear
immediately.

## Use In Codex

Use native Codex Ultra for ordinary one-off work where model-directed
delegation is enough. Use the default Ultracode skill when the work benefits
from durable phase records, schema enforcement, background execution, or
resume/cache guarantees:

```text
$ultracode-for-codex Investigate why the checkout flow drops sessions and propose a fix.
```

Good tasks for the default skill — any work that benefits from parallel
perspectives, for example:

- implementation planning and multi-step investigation;
- architecture or design critique;
- migrations and repository-wide changes;
- research and synthesis across sources;
- code review (also available as the built-in `code-review` workflow);
- release readiness checks and verification.

The default skill shows a phase plan before work starts and keeps a cumulative
progress snapshot as agents finish.

Example:

```text
Phase Review

  + Runtime correctness       done      no material issue
  > Security boundary         running   checking local state handling
  - Package contract          queued    verify installed files

Agents 1 completed | 1 running | 1 queued
Next: synthesize material findings
```

## Use The CLI Runtime

Use `$ultracode-for-codex-cli` or the `ultracode-for-codex` binary when you
explicitly want a local command-owned workflow run.

Run the read-only built-in task analysis workflow with the Sol balanced tier:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --model gpt-5.6-sol \
  --reasoning-effort high \
  --name task \
  --args '{"prompt":"review correctness risks and propose fixes"}'
```

Run a code review:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --model gpt-5.6-sol \
  --reasoning-effort high \
  --name code-review \
  --args '{"prompt":"review the current change","level":"high"}'
```

The built-in `code-review` workflow collects bounded repository evidence,
chooses review lenses, runs finder agents in parallel, verifies each candidate,
and returns JSON with `findings`, `provenance`, `synthesis`, and `stats`.
Use `{"level":"high"}` for the Sol medium/high profile: scope runs at
`medium`, while finders, verification, and synthesis run at `high`, and the
final sweep is skipped. Omit it for the deeper default review, where finders
run at `high` and scope/verdict/synthesis run at `xhigh`.

The built-in `task` delegates read-only analysis. Its planner runs at `medium`;
other agents inherit `--reasoning-effort`. The main Codex context applies any
resulting changes. Custom scripts can opt into `isolation: "worktree"`. A completed agent's
worktree is reclaimed when it holds no real changes; one that holds changes is
preserved for explicit review rather than auto-merged. Set
`workflow.worktreeRetention` to `preserve-all` (or `--worktree-retention`) to
keep every worktree.

CLI runs use OS background execution by default. The command prints a launch
record with a `jobId`, then you can inspect or control the job:

```bash
npm exec -- ultracode-for-codex status <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex logs <jobId> --cwd /path/to/project --tail 40
npm exec -- ultracode-for-codex result <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex cancel <jobId> --cwd /path/to/project
```

Runs wait indefinitely by default (timeout `0`). So a long or stuck run stays
visible without a hard deadline, the runtime emits a non-destructive
`workflow.heartbeat` progress event every two minutes with the elapsed time,
current phase, and completed/known agent counts — it never aborts the run.
Tune it with `--heartbeat-ms <n>` (or `workflow.heartbeatMs` in settings); `0`
turns it off.

Use attached execution only when the terminal should stay connected until the
workflow finishes:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --execution attached \
  --cwd /path/to/project \
  --name task \
  --args '{"prompt":"check the release plan"}'
```

## Recover An Interrupted Run

Workflow state survives crashes, kills, and cancellations. From the source
run's working directory, find the run and resume it — completed agent
results are reused, and the resume discloses the source terminal state plus
any workspace drift since the original run:

```bash
npm exec -- ultracode-for-codex jobs --cwd /path/to/project
npm exec -- ultracode-for-codex status <jobId> --cwd /path/to/project
```

`status` reports the `runId` and `cwd` the resume needs:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --resume-from-run-id run_...
```

This accepts completed, failed, cancelled, and interrupted runs. A job that
died before its first `workflow.started` event has no journal and must be
relaunched instead. `--retry-limit <n>` uses the same machinery: each retry
resumes the failed attempt instead of re-running finished agents.

## Author And Validate Workflow Scripts

Project workflow scripts live in `.codex/workflows/`. The authoring contract
(structure, `agent()` options including per-agent `effort`/`model`/`schema`/
`key`, and failure semantics) ships in the package:

```bash
npm exec -- ultracode-for-codex --llm-guide
```

Validate a script without spending agent tokens — structural problems fail
loudly, and static warnings flag agent calls without schemas or logical keys:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --validate \
  --script-file .codex/workflows/review.js
```

## What Gets Installed

The package includes:

- `ultracode-for-codex`: the local CLI binary;
- `skills/ultracode-for-codex`: the recommended hybrid orchestration skill;
- `skills/ultracode-for-codex-cli`: the explicit CLI/runtime skill;
- `settings.json`: default CLI runtime settings;
- `ULTRACODE_INSTALL.md`: detailed install and operating guide for agents.

## Local State

CLI runs write workflow state under `${ULTRACODE_FOR_CODEX_HOME:-~/.ultracode-for-codex}`.
The runtime keeps background metadata, journals, transcripts, generated scripts,
and results outside the target project so review evidence stays focused on the
workspace itself.

Project workflow sources may still live in `.codex/workflows/`. If an older
workspace already has `.ultracode-for-codex/`, keep it ignored and treat it as
legacy sensitive local data:

```gitignore
.ultracode-for-codex/
```

## Troubleshooting

If Codex does not recognize `$ultracode-for-codex`, confirm that the skill
folder exists:

```bash
ls "${CODEX_HOME:-$HOME/.codex}/skills/ultracode-for-codex"
```

If `npm exec -- ultracode-for-codex` fails, confirm the package is installed:

```bash
npm ls ultracode-for-codex
```

If a CLI workflow is still running, list local jobs:

```bash
npm exec -- ultracode-for-codex jobs --cwd /path/to/project
```

## For Maintainers

Common source checkout commands:

```bash
npm install
npm test
npm run test:e2e:ultracode-for-codex
npm run test:all
npm run pack:ultracode-for-codex
```

Check the publish payload:

```bash
npm run publish:dry-run
```

## More Documentation

- `ULTRACODE_INSTALL.md`: detailed install and operating guide.
- `skills/ultracode-for-codex/SKILL.md`: hybrid orchestration behavior.
- `skills/ultracode-for-codex/references/progress-visuals.md`: progress display
  examples.
- `skills/ultracode-for-codex-cli/SKILL.md`: CLI runtime behavior.
