---
name: ultracode-for-codex-cli
description: Operate, package, validate, or update the Ultracode for Codex npm CLI runtime, including background jobs, attached runs, runtime boundaries, release tarballs, and Codex skill command files.
---

# Ultracode for Codex CLI

## Core Rule

Use this skill for the npm package and CLI runtime surface. Runtime authority for
this path lives in the `ultracode-for-codex` binary, tests, package exports,
journal layer, and workflow runtime code.

The default `$ultracode-for-codex` skill is Codex-native and keeps planning
and synthesis in the main context while delegating fan-out phase execution to
this CLI runtime. This `$ultracode-for-codex-cli` skill is for explicit CLI
runtime work: background execution, attached runs, package validation, release
preparation, installed E2E checks, runtime-boundary checks, and local workflow
artifacts.

Workflow execution through this path runs through the local CLI command.
Progress, cancellation, permission review, retry, and result projection stay in
that command process. `settings.json` defaults runs to OS background execution;
use that path for long Codex-launched CLI work so Codex can keep doing other
tasks and inspect the background job later. Attached runs stream stderr JSONL for
Codex-readable status, while stdout remains the final workflow result JSON.

## Install And Run

Use the npm package for consumer installs.

```bash
npm install --save-dev ultracode-for-codex
npm exec -- ultracode-for-codex --llm-guide
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --script-file .codex/workflows/review.js \
  --args '{"prompt":"review the current change"}'
```

For source-checkout validation before publish:

```bash
npm run pack:ultracode-for-codex
npm install --save-dev ./artifacts/ultracode-for-codex-<version>.tgz
```

CLI behavior:

- `--version` or `-v` prints the installed package version;
- default execution is `background`; stdout contains a launch record with
  `jobId`, `pid`, `resultPath`, `progressPath`, `metadataPath`, and `pidPath`;
- background jobs can be inspected with `status`, waited with `wait`, read with
  `logs` and `result`, and cancelled with `cancel`;
- background jobs can be enumerated with `jobs` or `list`, and exported without
  deletion with `archive` or `export`;
- `wait --result`, `cancel --wait`, `logs --event <event>`, and `--plain`
  provide focused foreground checks;
- `--resume-from-run-id <runId>` resumes a completed, failed, cancelled, or
  interrupted local workflow from preserved runtime state, rejects additional
  workflow source selectors, and reuses completed agent results only when the
  runtime-owned call keys still match; without `--model` it adopts the source
  run's model, and it must run from the source run's working directory;
- `run --validate` resolves and parses a workflow source without running
  agents: structural problems fail loudly, and static schema/key warnings are
  printed for the author;
- `status` and `jobs` report the workflow `runId` and `cwd` needed for resume
  once the child has emitted `workflow.started`;
- script `agent()` calls accept per-agent `effort` and `model` options; the
  built-in `code-review` runs finder-class agents at `high` and verdict-class
  agents at `xhigh`;
- attached execution is available with `--execution attached` when the caller
  should stay connected until completion;
- attached progress prints to stderr as JSONL by default;
- attached final workflow result prints as JSON to stdout;
- JSONL records include `kind`, `version`, `event`, `status`, and `summary`,
  with agent identity and label fields on agent records;
- built-in `task` and `code-review` emit `workflow.plan.ready` as a planning
  snapshot, not a promise that every later phase is already known;
- `workflow.phase.planned` is emitted immediately before each phase starts and
  carries that phase's current planned agent role labels;
- each `workflow.phase.started` record repeats the same role labels when the
  phase begins;
- each `workflow.agent.completed` record includes phase progress, total known
  agent progress, and elapsed time;
- built-in `task` uses the generic phase planner; built-in `code-review`
  collects bounded review evidence, selects dynamic lenses, runs parallel finder
  agents, verifies each emitted candidate, optionally runs an `xhigh` sweep, and
  synthesizes final findings by verified candidate index;
- after a completed run, `workflow.summary.ready` reports phase-level agent
  counts and angles, then `workflow.review.recommended` asks the current
  session LLM to critically re-check the final result before acting on it;
- `Ctrl-C` cancels the active attached workflow;
- `--retry-limit <n>` retries failed workflows inside the same process;
- `--timeout-ms 0` waits for completion, cancellation, or app-server exit;
  positive values opt into a workflow deadline and per-agent silence budget,
  and that budget is not divided by the retry budget.
- `--permission ask|allow|deny` handles project/user/plugin/scriptPath reviews.
- `--progress plain` switches to human-readable progress lines.
- background file locations are controlled by `workflow.background` in
  `settings.json`.

## Runtime Boundaries

- Use Codex app-server over stdio as the production backend.
- Keep direct provider credentials out of Codex child process environments.
- Codex subagents run against the requested workflow cwd and have bounded
  read-only workspace tools for text file reads and directory listings.
- Built-in `task` injects deterministic workspace context into planner-selected
  phase-wise parallel subagents. Built-in `code-review` uses deterministic
  review evidence, allowed evidence refs, dynamic lenses, candidate verification,
  and bounded final synthesis.
- Keep workflow execution local and command-owned; settings default to OS
  background execution so long runs can keep waiting while Codex does other
  work.
- Keep `journalPath`, `journal.jsonl`, and journal contents out of CLI output.
- Treat workflow state under `${ULTRACODE_FOR_CODEX_HOME:-~/.ultracode-for-codex}`
  as sensitive local data. Project-local `.ultracode-for-codex/` is legacy
  state and should stay ignored if present.
- `--resume-from-run-id` reads preserved script and journal state from the
  global workflow state root; completed sources bind through the result
  record, while failed, cancelled, and interrupted sources are discovered
  journal-first. Script path, script source identity, and inherited args must
  match the source journal. Resumed launches disclose the source terminal
  reason, model mismatches, and workspace drift as progress log lines.
- Use `isolation: "worktree"` only inside a git repo with at least one commit;
  isolated worktrees are intentionally preserved for review, including clean
  worktrees.

## Packaging And Verification

For source checkout changes, run the narrowest relevant check first, then a
release-level check before handoff:

```bash
npm test
npm run test:e2e:ultracode-for-codex
npm run test:all
```

Build an installable artifact with:

```bash
npm run pack:ultracode-for-codex
```

Check the npm publish payload with:

```bash
npm run publish:dry-run
```

Publish after npm login with:

```bash
npm run publish:npm
```

When architecture, runtime boundaries, package exports, or release scope
changes, update active docs such as `README.md`, `ULTRACODE_INSTALL.md`, and
`IMPLEMENTATION_MAP.html`.
