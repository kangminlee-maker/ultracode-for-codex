---
name: ultracode-for-codex
description: Run Ultracode for Codex in Codex-native mode, with the main Codex context planning phases, spawning parallel subagents, synthesizing results, and showing progress directly in the chat.
---

# Ultracode for Codex

## Core Rule

This skill is the primary Codex-native Ultracode command. Treat the current
Codex main context as the orchestrator. Plan adaptive phases, spawn focused
subagents directly from Codex, synthesize phase outputs, and keep the user
informed in the chat.

Use the CLI runtime only when the user explicitly asks for `$ultracode-for-codex-cli`,
CLI execution, background jobs, packaging, publish preparation, installed
runtime validation, or reproducible local runtime artifacts.

## Required Capability Surface

Use Codex subagent tools for delegated work. If subagent tools are not visible,
search for the multi-agent tools first. If no subagent surface is available,
state that native parallel orchestration is unavailable in this session and
continue with the best single-context workflow.

Do not make the CLI process the default orchestrator for this skill. The npm
runtime remains available through `$ultracode-for-codex-cli`, but this command's
value is high-visibility orchestration in the main context.

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

4. Spawn independent phase agents in parallel by default. Use a single agent
   only when parallel work is risky, wasteful, or blocked by a strictly
   sequential dependency.
5. Keep subagent prompts concrete and bounded. Give each agent a distinct angle,
   expected output shape, and file or responsibility boundary when relevant.
6. While agents run, do non-overlapping main-context work such as deterministic
   file inspection, test execution, or integration planning.
7. As agents complete, report progress with a visual snapshot rather than a
   dense sentence. Use the Default Live Snapshot golden shape from
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

8. Synthesize each phase before deciding the next phase. Preserve disagreement,
   uncertainty, material risks, and exact evidence.
9. After the final synthesis, include the Completion Impact Summary and
   Plan-Style Result Summary golden shapes from `references/progress-visuals.md`,
   followed by a short phase/agent summary.
10. Recommend that the current session LLM critically re-check the final result
    before the user relies on it, especially for code, security, release, or
    architecture decisions.

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

For code review, common parallel angles are runtime correctness,
security/capability boundaries, API/CLI contracts, persistence/retry/cancel
behavior, user-visible progress, package contents, and test coverage.

For implementation, split by disjoint write ownership where possible. Tell
subagents they are not alone in the codebase and must not revert unrelated or
parallel edits.

## Output Contract

Keep progress visible but concise. Prefer stable visual summaries over prose-only
status sentences. Use `references/progress-visuals.md` for the golden examples.
The final answer should include:

- the completed result or findings;
- evidence and verification performed;
- a phase/agent summary;
- residual risk or unverified items;
- a critical re-check recommendation for the current session LLM when the result
  will drive action.
