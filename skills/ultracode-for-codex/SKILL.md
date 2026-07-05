---
name: ultracode-for-codex
description: Run Ultracode for Codex in hybrid mode, with the main Codex context planning phases, delegating fan-out phases to the local CLI workflow runtime for schema-enforced, journaled, resumable parallel execution, and showing progress directly in the chat.
---

# Ultracode for Codex

## Core Rule

This skill is the primary Codex Ultracode command. Treat the current
Codex main context as the orchestrator: plan adaptive phases, synthesize
phase outputs, and keep the user informed in the chat. For execution,
delegate fan-out phases to the local CLI runtime (`ultracode-for-codex run`)
when the package is available. The runtime enforces structured agent
outputs, journals every agent result durably, runs agents in parallel with
per-agent `effort`/`model` tiers, and keeps failed or interrupted phases
resumable.

Codex-native subagents remain the fallback execution path when the CLI
runtime is unavailable in the session.

## Capability Detection

Before the first delegated phase, check the CLI runtime once:

```bash
npm exec --no -- ultracode-for-codex skills || ultracode-for-codex skills
```

The `--no` flag keeps `npm exec` from fetching the package when it is not
already installed; detection must never trigger a package install.

If neither resolves, say that the CLI runtime is unavailable, continue with
Codex-native subagents, and note that per-agent tiering, schema enforcement,
and crash recovery are unavailable in that mode.

The report also states whether the installed skill commands match the
package. If any skill reports `stale` or `missing`, run
`ultracode-for-codex skills --install` and tell the user the skill commands
were refreshed; the next Codex session loads the updated contract, while the
current session continues with the skill text it already loaded.

## Native Workflow

1. Identify the user goal, scope, constraints, likely completion condition, and
   whether the work is review, implementation, planning, verification, or mixed.
2. Design only the next useful phase when later phases depend on earlier
   results. A first plan may be partial.
3. Before each phase starts, show a compact phase plan in the chat:

```text
Phase Inspect - 3 agents
- Runtime contracts: verify the active execution path and failure semantics.
- UX/progress: check visibility, summaries, and user-facing wording.
- Tests/package: check coverage, package contents, and install behavior.
```

4. Execute fan-out phases through the CLI runtime (see Delegated Phase
   Execution). Use a direct Codex-native subagent only on the fallback path,
   or for a single quick delegated lookup where a background run adds no
   value.
5. While a phase runs, do non-overlapping main-context work such as
   deterministic file inspection, test execution, or integration planning.
6. As agents complete, report progress with a visual snapshot rather than a
   dense sentence; source the numbers from the run's progress records
   (`status`, `logs --tail`). Use the Default Live Snapshot golden shape from
   `references/progress-visuals.md` by default. Select task-specific additions
   from the Situation Choice Matrix in that reference. Within one user
   request, keep a cumulative ledger: do not remove completed rows from later
   snapshots; update their status and append newly discovered work below them.

```text
Phase E2E Validate

  + Native routing review        done      34s
  + CLI package review           done      48s

  > npm-exec-run-shim            running   1/2 checks
  > skill-copy-detection         running   3/6 files

Agents 2 completed | 2 running
Checks 5 passed | 0 failed | 2 running
Elapsed 1m 12s
```

7. Synthesize each phase before deciding the next phase. Preserve
   disagreement, uncertainty, material risks, and exact evidence.
8. After the final synthesis, include the Completion Impact Summary and
   Plan-Style Result Summary golden shapes from
   `references/progress-visuals.md`, followed by a short phase/agent summary.
9. Recommend that the current session LLM critically re-check the final result
   before the user relies on it, especially for code, security, release, or
   architecture decisions.

## Delegated Phase Execution

For each phase that fans out subagents:

1. Select a built-in when it fits — `--name code-review` for review phases,
   `--name task` for generic phase work; built-ins already enforce schemas,
   logical keys, and evidence discipline. Otherwise author a small per-phase
   workflow script.
2. Authoring contract: `ultracode-for-codex --llm-guide`, section "Author A
   Workflow Script", is the authoritative script contract. Non-negotiables:
   pure-literal `meta`; `schema` on every machine-consumed `agent()` call;
   logical `key`s bound to the evidence snapshot for dynamic parallel agents,
   never reused within a run; no `Date` or `Math.random`; funnel-tier with
   `effort` — sweeps and finder-style scans at `high`, verdicts and synthesis
   at `xhigh`.
3. Validate before launching; validation spends no agent tokens:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --validate \
  --script-file ./phase-review.js
```

   Fix hard failures. Treat schema/key warnings as prompts to fix the script,
   not noise.
4. Show the authored script path (and the script itself when short) in the
   chat, then launch the default background run with `--permission allow`.
   The user's approval of the launch command is the human gate;
   `--permission allow` records a standing grant bound to that exact script
   hash, so any script edit requires a fresh decision.
5. Record the recovery anchor in the chat as soon as the child starts:
   `status <jobId>` reports the `runId` and `cwd` a later resume needs. The
   launch record alone carries only the `jobId`.
6. Poll `status`/`logs --tail`, or hold with `wait --result`; read the phase
   result JSON with `result <jobId>`; synthesize in chat; plan the next
   phase.

Phase results are the workflow result JSON that the runtime validated against
the phase script's schemas. Markdown tables remain a chat rendering choice,
never the data channel between phases.

## Recovery

On a new session, or after a stall, act from the source run's working
directory:

| Situation | Action |
| --- | --- |
| Anchor lost | `jobs` (state is global across sessions), then `status <jobId>` for `runId`, `cwd`, and terminal reason |
| Job still running | `status <jobId>` or `wait --result` |
| Job completed while away | `result <jobId>`, continue synthesis |
| Job failed, cancelled, or killed | `run --accept-llm-guide=v1 --resume-from-run-id <runId> --cwd <cwd>` — completed agent results are reused; the resume discloses the source terminal reason, model mismatches, and workspace drift |
| No `runId` in `status` (job died before `workflow.started`) | relaunch the phase; there is no journal to resume |

## Planning Heuristics

Default to phase-wise parallel execution. Useful patterns include:

- classify-and-act: classify request type, risk, or repo area before choosing
  the phase shape;
- fan-out-and-synthesize: split independent lenses across parallel agents, then
  merge evidence;
- adversarial verification: assign at least one agent to challenge correctness,
  security, assumptions, or test adequacy;
- generate-and-filter: create candidate approaches or fixes, then select by
  evidence and constraints;
- tournament: compare competing alternatives when the best path is unclear;
- loop-until-done: iterate repair and verification only when there is a clear
  stop condition.

For code review, prefer the built-in `code-review` workflow: it collects
bounded review evidence, selects dynamic lenses, runs parallel finders at the
`high` sweep tier, verifies each candidate at `xhigh`, and synthesizes final
findings with provenance.

For implementation, split by disjoint write ownership where possible. Tell
subagents they are not alone in the codebase and must not revert unrelated or
parallel edits.

## Output Contract

Keep progress visible but concise. Prefer stable visual summaries over
prose-only status sentences. Use `references/progress-visuals.md` for the
golden examples. The final answer should include:

- the completed result or findings;
- evidence and verification performed;
- a phase/agent summary;
- residual risk or unverified items;
- a critical re-check recommendation for the current session LLM when the
  result will drive action.
