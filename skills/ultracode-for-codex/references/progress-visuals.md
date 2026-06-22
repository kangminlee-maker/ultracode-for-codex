# Progress Visuals

Use these golden examples for Codex-native Ultracode progress updates. The goal
is fast visual parsing in chat while staying portable across terminals and
renderers. Prefer ASCII symbols and short labels.

## Default Live Snapshot

Use this for ordinary phase progress. It is inspired by test-runner summaries:
completed work is listed first, active work is visually distinct, and totals are
grouped at the bottom.

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

Use `+` for completed items, `>` for running items, `!` for blocked or failed
items, and `-` for queued items. Keep each row to one line when possible.

## Dense Meter Snapshot

Use this when the work is count-heavy and the user needs ratios.

```text
Progress Snapshot  main c3734d8

Native routing       ####################----  5 / 6 checks
CLI package E2E      ########################  passed
Skill install check  ################--------  4 / 6 files
Docs contract        ############------------  2 / 4 sections

Elapsed 1m 42s   Next: npm exec run shim check
```

Use fixed-width bars only when the denominator is meaningful. Do not invent a
percentage for semantic work that cannot be counted.

## Long Async Timeline

Use this for long-running parallel work where event order matters.

```text
#1 [plan] classify task shape
#1 DONE 0.8s

#2 [phase:inspect] spawn 2 review agents
#2 running 2 agents

#3 [agent:native-routing] verify skill split
#3 DONE 34.1s

#4 [agent:cli-package] verify installed E2E
#4 DONE 48.7s

#5 [synthesis] merge findings
#5 running
```

Use this sparingly in chat. It is best when the user asks for detailed live
process visibility.

## Completion Impact Summary

Use this in final or phase-completion reporting when files changed.

```text
Change Impact

  skills/ultracode-for-codex/SKILL.md           | 200 +++++++++++---------
  skills/ultracode-for-codex-cli/SKILL.md       | 136 +++++++++++++
  scripts/e2e-installed-ultracode-for-codex.mjs |  78 +++++++-
  README.md                                     |  62 ++++--

  8 files changed, 295 insertions(+), 201 deletions(-)
```

Prefer real `git diff --stat` output when available.

## Plan-Style Result Summary

Use this with the impact summary to explain what changed conceptually.

```text
Execution Result

  + add     ultracode-for-codex-cli skill command
  ~ update  ultracode-for-codex native orchestration contract
  ~ update  installed E2E to cover npm exec run
  = keep    CLI runtime command surface

Result: 1 added, 2 updated, 1 kept
Risk: Codex skill reload cannot be forced inside the current session
```

Use `+ add`, `~ update`, `= keep`, and `! risk` consistently.

## Folded Detail Summary

Use this when the top-level result is enough and details should remain compact.

```text
E2E Validation Summary

[passed] Native skill routing
[passed] CLI package runtime
[passed] npm exec run shim
[passed] CODEX_HOME skill copy

Details
  native-routing-review     5 findings, 0 failures
  cli-package-review        7 findings, 0 failures
  npm test:all              35 tests passed
```

This is best for final handoff or after multiple agents have returned.
