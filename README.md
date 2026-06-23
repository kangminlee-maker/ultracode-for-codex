# Ultracode for Codex

Dynamic workflows redesigned for Codex, with parallel subagents, visible
progress, and an optional local CLI runtime.

The default experience is Codex-native: you ask for `$ultracode-for-codex`, and
the main Codex chat becomes the orchestrator. It plans the next useful phase,
runs independent subagents in parallel when that helps, summarizes their
findings, and shows compact progress snapshots directly in the conversation.

A local CLI runtime is included for users who want background jobs, reproducible
workflow runs, package checks, or attached terminal execution.

## Why Use It

- Get multi-angle reviews instead of a single linear pass.
- Run implementation and verification work phase by phase.
- See what agents are doing, what finished, and what still needs attention.
- Keep long CLI workflows running in the OS background when desired.
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

## Install The Codex Skills

After installing the npm package, copy the included skill commands into your
Codex skills folder.

From a project install:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R ./node_modules/ultracode-for-codex/skills/ultracode-for-codex \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
cp -R ./node_modules/ultracode-for-codex/skills/ultracode-for-codex-cli \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
```

From a global install:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
GLOBAL_NODE_MODULES="$(npm root -g)"
cp -R "$GLOBAL_NODE_MODULES/ultracode-for-codex/skills/ultracode-for-codex" \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
cp -R "$GLOBAL_NODE_MODULES/ultracode-for-codex/skills/ultracode-for-codex-cli" \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
```

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
Use `{"level":"high"}` to skip the final sweep, or omit it for the default
`xhigh` review.

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

## What Gets Installed

The package includes:

- `ultracode-for-codex`: the local CLI binary;
- `skills/ultracode-for-codex`: the recommended Codex-native skill;
- `skills/ultracode-for-codex-cli`: the explicit CLI/runtime skill;
- `settings.json`: default CLI runtime settings;
- `ULTRACODE_INSTALL.md`: detailed install and operating guide for agents.

## Local State

CLI background runs write local workflow state under `.ultracode-for-codex/` in
the target project. Treat that folder as local runtime data. It may contain
progress, metadata, transcripts, and results for the run.

Add it to `.gitignore` if your project does not already ignore it:

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
- `skills/ultracode-for-codex/SKILL.md`: Codex-native orchestration behavior.
- `skills/ultracode-for-codex/references/progress-visuals.md`: progress display
  examples.
- `skills/ultracode-for-codex-cli/SKILL.md`: CLI runtime behavior.
