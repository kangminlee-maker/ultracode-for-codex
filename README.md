# Ultracode for Codex

Dynamic workflows redesigned for Codex, with parallel subagents, visible
progress, and a local CLI runtime for durable, resumable execution.

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

- Get multi-angle reviews instead of a single linear pass.
- Run implementation and verification work phase by phase.
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

Use the default skill for normal work:

```text
$ultracode-for-codex Review this change for correctness and security risks.
```

Good tasks for the default skill:

- code review;
- implementation planning;
- multi-step verification;
- architecture or design critique;
- release readiness checks;
- work that benefits from parallel perspectives.

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

Run a built-in task workflow:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --name task \
  --args '{"prompt":"review correctness risks and propose fixes"}'
```

Run a code review:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --name code-review \
  --args '{"prompt":"review the current change"}'
```

The built-in `code-review` workflow collects bounded repository evidence,
chooses review lenses, runs finder agents in parallel, verifies each candidate,
and returns JSON with `findings`, `provenance`, `synthesis`, and `stats`.
Finder-class agents run at the `high` effort tier while verification and
synthesis stay at `xhigh`. Use `{"level":"high"}` to skip the final sweep, or
omit it for the default `xhigh` review.

CLI runs use OS background execution by default. The command prints a launch
record with a `jobId`, then you can inspect or control the job:

```bash
npm exec -- ultracode-for-codex status <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex logs <jobId> --cwd /path/to/project --tail 40
npm exec -- ultracode-for-codex result <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex cancel <jobId> --cwd /path/to/project
```

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
