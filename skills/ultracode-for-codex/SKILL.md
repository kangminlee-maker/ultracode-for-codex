---
name: ultracode-for-codex
description: Operate, package, validate, or update the Ultracode for Codex npm runtime. Use when installing or running local workflows, checking runtime boundaries, packaging release tarballs, updating docs, or maintaining the companion Codex skill.
---

# Ultracode for Codex

## Core Rule

Treat the npm package as the runtime artifact. This skill is only a companion
guide for Codex agents. Runtime authority remains in the `ultracode-for-codex`
binary, tests, package exports, journal layer, and workflow runtime code.

Workflow execution runs through the local CLI command. Progress,
cancellation, permission review, retry, and result projection stay in that
command process. `settings.json` defaults runs to OS background execution; use
that path for long Codex-launched work so Codex can keep doing other tasks and
inspect the background job later. Attached runs stream stderr JSONL for
Codex-readable status, while stdout remains the final workflow result JSON.

The default Ultracode work shape is phase-wise parallel execution: built-in
`task` and `code-review` first call a planner agent, then execute each planned
phase with parallel focused subagents by default, followed by phase and final
synthesis. A single-agent path is reserved for cases where the planner judges
parallel execution risky or wasteful.
Planner guidance includes classify-and-act, fan-out-and-synthesize,
adversarial verification, generate-and-filter, tournament, and loop-until-done
patterns so workflow shape can follow the task instead of a fixed template.

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
- Built-in `task` and `code-review` inject deterministic workspace context into
  planner-selected phase-wise parallel subagents.
- Keep workflow execution local and command-owned; settings default to OS
  background execution so long runs can keep waiting while Codex does other
  work.
- Keep `journalPath`, `journal.jsonl`, and journal contents out of CLI output.
- Treat `.ultracode-for-codex` workflow state as sensitive local data.
- Keep `resumeFromRunId` runtime-internal unless cross-process resume
  gets an explicit durable design.
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
