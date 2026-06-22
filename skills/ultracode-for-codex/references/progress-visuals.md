# Progress Visuals

Use these golden examples for Codex-native Ultracode progress updates. The goal
is fast visual parsing in chat while staying portable across terminals and
renderers. Prefer ASCII symbols and short labels.

## Research Pattern Map

These patterns are adapted from established CLI/TUI conventions:

- multi-task progress: Rich-style multiple task rows with progress metadata;
- test progress: pytest-style progress/count/timing summaries;
- async build logs: Docker BuildKit-style numbered steps and plain progress;
- folded details: GitHub Actions-style grouped log sections;
- change plans: Terraform-style add/update/keep/destroy action symbols;
- rollout watches: Kubernetes rollout-style "N out of M" convergence messages;
- audit tables: npm audit-style severity/package/path/remediation columns.

Map those patterns to Ultracode situations instead of using one universal
status format.

## Situation Choice Matrix

Choose one row per task situation. Each row has at most three user-facing
shapes: primary, support, and finish. Do not present profile names to the user.
If a task mixes situations, choose the dominant row for live progress and borrow
at most one support shape from another row.

| Situation | Primary | Support | Finish |
| --- | --- | --- | --- |
| Ordinary or mixed work | Default Live Snapshot | Verification Gate Matrix | Plan-Style Result Summary |
| Design or planning | Decision Tournament | Context Coverage Matrix | User Decision Gate |
| Implementation | Implementation Work Ledger | Verification Gate Matrix | Completion Impact Summary |
| Review or audit | Agent Lens Matrix | Context Coverage Matrix | Evidence To Finding Trace |
| Release or install | Artifact Inventory | Rollout Or Convergence Watch | Risk Or Audit Table |
| Retry, cancellation, or long-running work | Recovery Ledger | Resource Budget Snapshot | Rollout Or Convergence Watch |

Phase Plan Preview is baseline behavior before a phase starts, not an extra
choice. Long Async Timeline is only a temporary diagnostic appendix when the
user explicitly asks to debug detailed event order.

## Cumulative Ledger Rule

Within one user request, progress snapshots are cumulative. Do not let completed
work scroll out of the next snapshot just because new work starts. Keep completed
rows, update their status, and append newly discovered work below them. This
makes the current answer self-contained even if the user only sees the latest
snapshot.

```text
Phase Commit Prep

  + README install flow          done      local + global skill install
  + Registry/install check       done      <version> published and installed
  + Verification                 done      npm run test:all

  > Commit                       running   staging release changes
  - Push                         queued    origin/main

Checks 3 passed | 0 failed | 2 running/queued
Next: commit release changes
```

Use `+` for completed work, `>` for running work, `-` for queued work, and `!`
for blocked or failed work. Keep earlier completed rows visible in every later
snapshot for the same request.

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

Keep each row to one line when possible.

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

## Building Block Examples

Use these shapes as building blocks selected by the Situation Choice Matrix
above. Do not present this full list as user-facing choices.

### Phase Plan Preview

Use this immediately before spawning agents for a phase.

```text
Phase Inspect - planned fan-out

  - Runtime contracts     check execution authority and failure semantics
  - UX/progress           inspect visible status and completion summaries
  - Tests/package         verify E2E, tarball, and installed skill contents

Parallelism: 3 agents
Synthesis: merge material findings and decide next phase
```

### Agent Lens Matrix

Use this when several agents are reviewing the same artifact from different
angles.

```text
Review Lenses

  + Runtime correctness       no material issue       workflow-runtime.ts
  + Capability boundary       no material issue       subagent-backend.ts
  ! User visibility           needs fix               progress visuals
  > Package contract          running                 tarball contents

Findings 1 open | 2 clear | 1 running
Next: fix user visibility contract
```

### Implementation Work Ledger

Use this when work is split into edit scopes.

```text
Implementation Ledger

  + Skill routing docs         updated   skills/ultracode-for-codex
  + CLI skill command          added     skills/ultracode-for-codex-cli
  > E2E package checks         editing   scripts/e2e-installed-...
  - README install flow        queued    local/global install examples

Files touched 6 | Tests queued 2 | Risk low
```

### Verification Gate Matrix

Use this after tests, package checks, reviews, or publish dry-runs.

```text
Verification Gates

  + unit/integration           passed    35 tests
  + installed E2E              passed    fake Codex boundary
  + package validation         passed    35 files in tarball
  + publish dry-run            passed    would publish <version>

Gates 4 passed | 0 failed | 0 skipped
Residual: live Codex smoke remains opt-in
```

### Decision Tournament

Use this when comparing approaches before implementation.

```text
Decision Tournament

  A  CLI orchestration         rejected  low visibility
  B  Native main orchestration selected  highest chat visibility
  C  Hybrid auto-router        deferred  more moving parts

Winner: B
Reason: best fit for Codex-native progress and direct subagent control
```

### Blocked Or Risk Snapshot

Use this when a dependency, permission, failing gate, or missing capability
blocks progress.

```text
Blocked Snapshot

  + Package contents           verified
  ! Native subagent surface    blocked   multi-agent tools unavailable
  - Parallel review            paused    needs subagent surface

Blocker: native parallel orchestration unavailable in this session
Fallback: continue single-context review and record residual risk
```

### Retry Or Recovery Ledger

Use this for transient failures, retry loops, cancellation, or recovery.

```text
Recovery Ledger

  + attempt 1                  failed    workflow_agent_stalled
  + retry policy               applied   retry 1 / 2
  > attempt 2                  running   narrowed review prompt
  - synthesis                  queued    after terminal result

Retries 1 used | 1 remaining
Next: wait for attempt 2 terminal state
```

### Artifact Inventory

Use this when the output is files, package artifacts, generated docs, or local
state.

```text
Artifact Inventory

  + npm tarball                artifacts/ultracode-for-codex-<version>.tgz
  + native skill               skills/ultracode-for-codex/SKILL.md
  + CLI skill                  skills/ultracode-for-codex-cli/SKILL.md
  + progress examples          skills/ultracode-for-codex/references/progress-visuals.md

Artifacts 4 ready | Sensitive local state not included
```

### Rollout Or Convergence Watch

Use this when waiting for a target state: publish propagation, installed package
availability, test shards, deployment checks, or background jobs.

```text
Convergence Watch

  + npm registry                visible   <version> latest
  + global CLI                  updated   /opt/homebrew/bin/ultracode-for-codex
  > Codex skill reload          pending   next session boundary
  - downstream smoke            queued    user project install

Converged 2 / 4
Next: verify downstream smoke after reload
```

### Risk Or Audit Table

Use this for security, capability boundaries, provenance, dependency audit,
license review, or data exposure checks.

```text
Risk Audit

  severity  area                 status    evidence
  high      provider credentials  clear     env stripping test
  medium    local state paths     clear     .ultracode-for-codex ignored
  low       docs ambiguity        open      install wording

Open risk 1 low | Material risk 0
Next: clarify install wording
```

### Context Coverage Matrix

Use this when the quality of a result depends on which evidence was actually
read, searched, tested, or left unverified.

```text
Context Coverage

  + runtime source              read      src/runtime/workflow-runtime.ts
  + package scripts             read      scripts/package-...
  + installed E2E               executed  npm run test:e2e:...
  ! live Codex smoke            skipped   opt-in local environment

Coverage 3 verified | 1 residual
Residual: live smoke remains user-triggered
```

### User Decision Gate

Use this when the next step needs a product or risk choice rather than more
execution.

```text
Decision Gate

  A  Publish now                ready     all gates green
  B  Add live smoke first       safer     needs local Codex run
  C  Defer release              safest    no user impact yet

Recommended: A
Why: package and dry-run gates are green; live smoke is optional
```

### Resource Budget Snapshot

Use this for long work where elapsed time, agent count, retry budget, or token
budget matters.

```text
Resource Budget

  agents active                3 / 6
  retries used                 1 / 2
  elapsed                      7m 20s
  timeout                      none
  token budget                 not capped

Pressure: low
Next: wait for active agents before synthesis
```

### Evidence To Finding Trace

Use this when translating many observations into a smaller set of findings or
fixes.

```text
Evidence Trace

  evidence                         finding                 action
  package files include skill refs  packaging contract ok   keep
  npm exec run path untested        E2E gap                 add test
  progress rows disappear           visibility gap          add ledger rule

Findings 2 actionable | 1 keep
Next: implement E2E gap and ledger rule
```
