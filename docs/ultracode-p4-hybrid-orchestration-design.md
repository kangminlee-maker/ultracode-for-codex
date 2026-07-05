# Ultracode P4: Tiered Agents And Recoverable Hybrid Orchestration (Design)

Status: implemented (steps 1-5) at package version 0.4.0; unit and installed
E2E gates green; live-Codex items pending (see Open Items).
Date: 2026-07-05.

User-locked decisions:

1. Orchestration architecture: hybrid delegation. The native skill keeps
   planning and synthesis in the main Codex context and delegates fan-out
   phases to the local CLI runtime.
2. Built-in `code-review` default tiering: finder-class agents drop to `high`;
   scope, verifier, and synthesis stay `xhigh`.
3. Resume scope: both failed runs (terminal `workflow.run.failed`) and
   interrupted runs (no terminal entry, e.g. process kill) become valid resume
   sources.

## Goal

Add two capabilities to the `ultracode-for-codex` skill surface:

1. Per-agent `model`/`effort` selection so workflows can funnel-tier: wide
   cheap sweeps, expensive verdicts.
2. Recoverable orchestration for the native skill path: schema-enforced agent
   outputs, durable journal, and resume — including recovery of completed
   agent results from stalled, failed, or killed runs.

## Verified Current State

Re-derived from source on 2026-07-05, then re-checked by three independent
review lenses. Line numbers refer to that snapshot.

| Claim | Evidence |
| --- | --- |
| Backend already supports per-request effort | `src/codex/subagent-backend.ts:180` (`request.reasoningEffort ?? this.reasoningEffort`), thread config `:196,:313-346`, turn `effort` `:204` |
| Backend already supports per-turn model override | `turn/start` `model` param `:203`; `modelOverrideFor` `:680-684` — configuredModel wins when set, so a per-agent request model cannot override it today. Thread config carries no `model` key (`:335-340`), so the per-turn param is the only per-agent model channel |
| Runtime blocks per-agent model | `src/runtime/workflow-runtime.ts:2531-2533` rejects `options.model` |
| Runtime hardcodes effort | semanticOpts `effort: 'xhigh'` `:2548`; `agentRequest` `reasoningEffort: 'xhigh'` `:5534`; `AgentOptions` has no `effort` field `:490-497` |
| Deliberate deferral | `docs/local-dynamic-workflow-design.md:187` ("Keep broad `model`, `effort`, and `agentType` options out of the next implementation") |
| Cache identity already includes model/effort | `workflowAgentSemanticOpts` `:5995-6009`; `computeWorkflowAgentCallKey` `src/runtime/workflow-journal.ts:352-364` |
| Resume accepts completed runs only | `readCompletedResumeJournal` requires terminal `workflow.run.completed` and rejects `truncatedTail` `:1824-1836`; durable discovery depends on `<runId>.result.json`, written only on success `:2371-2382`, `:1741-1749`; the CLI preflight gate `assertBackgroundResumeSource` (`src/cli.ts:153-164`) enforces the same |
| Journal start entry carries almost everything resume needs | `workflow.run.started` has `workflowName`, `workflowSource`, `workflowSourcePath`, `scriptPath`, `scriptHash`, `args`, `runtime.cwd` (`src/runtime/workflow-journal.ts:42-53`). `toolName` is not journaled; it is re-supplied by the resume launch input (`workflow-runtime.ts:1728`) |
| Cache hits are prefix + exact-key, today, for all sources | `createResumeCache` breaks at first started-without-completed and builds `byCallKey` from that prefix only `:1784-1807`; `takeResumeCacheHit` does sequential prefix, then unconditional `byCallKey` exact lookup `:3206-3224` — out-of-prefix exact-key reuse is already shipped semantics for completed-run resume |
| Journal reader recovers only genuinely truncated tails | trailing line that fails JSON.parse with a truncation error is dropped and flagged `truncatedTail` (`workflow-journal.ts:370-390`); a final line that is complete JSON but missing its newline throws (`:378-381`). The writer emits entry+newline as one buffer (`:707`), so the newline is the commit marker |
| Duplicate agent call keys poison resume latently | duplicates are not checked at write time; `validateWorkflowJournal` throws `duplicate agentCallKey` at read time and rejects the whole journal (`workflow-journal.ts:454-456`) |
| Workflow state is partitioned by exact cwd | `defaultWorkflowStateDir` hashes `resolve(cwd)` into `~/.ultracode-for-codex/workspaces/<label>-<digest16>` (`src/runtime/state-root.ts:13-18`); resume from any other directory computes a different partition |
| The CLI never surfaces `runId` for background jobs | launch record has `jobId,pid,paths` only (`src/cli.ts:286-296`); `BackgroundJobStatus` has no `runId` field (`:332-359`); `runId` is minted inside the detached child (`workflow-runtime.ts:1616`) and appears only in progress JSONL events |
| `--llm-guide` contains no authoring API | `--llm-guide` renders `ULTRACODE_INSTALL.md` verbatim (`src/ultracode-install-guide.ts`); that file has zero occurrences of `agent(`, `pipeline(`, `parallel(`, `schema`, or `export const meta` |
| `--permission allow` records a standing grant | auto-approval persists an allow record keyed by `(source,path,name,scriptHash)` (`workflow-runtime.ts:1956,1992-2043`) |
| Built-in script size headroom | generated `code-review` script is ~29.9 KB vs `MAX_SCRIPT_BYTES` 64 KiB — adding effort options is safe |
| Native skill path has none of this | `skills/ultracode-for-codex/SKILL.md` uses Codex-native subagents; output shape is a prompt convention; no journal/resume; CLI used only on explicit request |
| Default settings | packaged `settings.json`: background execution, permission `ask`, `codex.reasoningEffort: "xhigh"` |

External premise (user-measured, not re-verifiable from this repo): Codex-native
subagents inherit the session `turn_context`, which forces `xhigh` effort.
Re-measure once before finalizing P4-D skill wording.

## Design Overview

| Part | Concept | Surface |
| --- | --- | --- |
| P4-A | Per-agent `effort`/`model` agent options | workflow runtime + Codex backend |
| P4-B | Failed/interrupted-run resume | workflow runtime + journal reader + CLI |
| P4-C | `code-review` funnel tiering | built-in workflow script |
| P4-D | Hybrid native-skill orchestration + authoring surface | skills, `ULTRACODE_INSTALL.md`, CLI validate mode |

P4-A and P4-B are independent runtime features. P4-C depends on P4-A. P4-D
depends on P4-A and P4-B for its value.

## P4-A: Per-Agent Effort And Model

### API

```js
await agent(prompt, {
  effort: "high",          // optional; ReasoningEffort enum
  model: "gpt-5.5-mini",   // optional; non-empty string
  // existing: label, key, phase, schema, isolation
})
```

Validation (runtime enum validation, fail-loud):

- `effort` must be one of the `ReasoningEffort` values
  (`none|minimal|low|medium|high|xhigh`); anything else is
  `workflow_input_invalid`. Implementation note: `REASONING_EFFORTS` in
  `src/settings.ts` is module-private today; export it (or an exported guard)
  rather than duplicating the list.
- `model` must be a non-empty string. Model existence cannot be validated
  locally; an unknown model fails the Codex turn and surfaces as a normal
  agent failure. No silent fallback to the default model.

### Plumbing

- `AgentOptions` gains `effort`; the `model` rejection at
  `workflow-runtime.ts:2531` is removed.
- `runAgentInner` computes `effectiveEffort = options.effort ?? 'xhigh'` and
  `effectiveModel = options.model ?? ctx.model`, records both in
  `semanticOpts`, and passes them through `runAgentWithStallRetries` into
  `agentRequest`, replacing the hardcoded `'xhigh'` at `:5534`.
- Backend `modelOverrideFor` precedence flips to: explicit per-agent request
  model wins; otherwise run-level configured model; otherwise thread default:

```ts
private modelOverrideFor(requestModel: string): string | undefined {
  if (requestModel && requestModel !== this.model && requestModel !== 'codex-subagent') {
    return requestModel;
  }
  return this.configuredModel;
}
```

  When no per-agent model is set, the runtime keeps passing `ctx.model`
  (= `backend.model`), so the first branch never fires and behavior is
  byte-identical to today (traced for both the `--model`-set and unset cases).

### Silent-override risk

Per-agent `model` flows only through the `turn/start` `model` param; the
thread config has no model key. A live app-server that silently ignores that
param (rather than erroring) would produce results from the config model
while the runtime keys them under the requested model — a cache
misattribution. The Step 5 live smoke must therefore assert the override
took effect (observe the effective model in the turn result/usage), not just
that the call succeeded. Fake app-server tests prove plumbing; only the live
probe proves acceptance. See Redesign Triggers.

### Cache identity compatibility

`semanticOpts` already serializes `model` and `effort` into `agentCallKey`.
Compatibility rule: **absent options must serialize exactly as today** —
`effort: 'xhigh'` literal and `model: ctx.model`. Existing completed-run
journals then keep producing cache hits. Explicit per-agent values produce
different call keys, which is correct: a different effort or model is a
different semantic call and must not reuse the old result.

The unspecified-effort default stays the `'xhigh'` literal rather than
`settings.codex.reasoningEffort`, for two reasons: today's workflow agents
already ignore the setting (hardcoded), and binding call keys to a mutable
setting would silently invalidate resume caches when the setting changes.

### Out of scope

`agentType` options, budget-driven dynamic tiering, and per-phase effort
defaults stay out. Only the two narrow options ship. This deliberately
overrides the deferral recorded at `docs/local-dynamic-workflow-design.md:187`;
that doc gets a dated correction in Step 5 so active docs do not contradict
shipped behavior.

## P4-B: Failed And Interrupted Run Resume

### Resume source classes

| Class | Journal terminal | Accepted today | Accepted after P4-B |
| --- | --- | --- | --- |
| completed | `workflow.run.completed` | yes | yes (unchanged semantics) |
| failed | `workflow.run.failed` (includes cancelled runs, reason `workflow_aborted`) | no | yes |
| interrupted | none (killed process; tolerated truncated tail) | no | yes |
| running | n/a | no (`workflow_resume_running`) | no (unchanged) |

Vocabulary rule (concept economy): "interrupted" is the runtime-level class
for a journal with no terminal entry. The CLI projects it through the
**existing** `exited_unknown` job status; no new CLI status token is added.
"failed" aligns with the existing `failed` status and journal terminal kind.

Cancelled runs are deliberately resumable: the explicit
`--resume-from-run-id` invocation is itself the confirmation. The resume
launch and `status` surface the source run's terminal reason (e.g.
`workflow_aborted`) so a deliberate cancel is visible before results are
reused.

### Durable discovery without a result record

Failed and interrupted runs have no `<runId>.result.json`. Discovery becomes
journal-first: locate `<stateRoot>/subagents/workflows/<runId>/journal.jsonl`,
validate it with the journal reader, and reconstruct the retry input from the
`workflow.run.started` entry (`workflowName`, `workflowSource`,
`workflowSourcePath`, `scriptPath`, `scriptHash`, `args`, `runtime.cwd`).
`toolName` is not journaled and is re-supplied by the resume launch input, as
today.

Binding rules are preserved, only re-anchored from the result record to the
journal: the persisted runtime script at `scriptPath` must still exist, its
hash must equal the started entry's `scriptHash`, and persisted script
metadata (`workflowName`, `scriptHash`) must match. Args inheritance keeps
the journal as authority, matching the existing p3b rule.

Fall-through rule (kill-window case): the success path writes
`<runId>.result.json` (`:2371-2382`) **before** appending the terminal
journal entry (`:2383` → `:3011`). A kill in that window leaves a result
record beside a non-completed journal. When the result-record path exists
but its completed-journal cross-check fails, discovery falls through to the
journal-first interrupted path instead of returning "unknown run".

### Journal reader tolerance for non-completed sources

Two tail states exist after a kill:

- trailing line that fails JSON.parse → already dropped and flagged
  `truncatedTail` (reader today);
- trailing line that is **complete JSON but missing its newline** → reader
  throws today (`workflow-journal.ts:378-381`), which would discard every
  durable completed result before it.

The writer emits entry+newline as a single buffer, so a missing newline
means the entry was never durably committed. For non-completed resume
sources, the reader treats this state exactly like a truncated tail: drop
the uncommitted line, set `truncatedTail`. Completed-source validation is
unchanged (a completed journal ends with a newline-terminated terminal entry
or it is invalid). Hash-chain, schema, ordering, pairing, and identity
validation still apply to everything before the dropped tail; a broken chain
rejects the source fail-loud.

### Cache construction for non-completed sources

Today `createResumeCache` iterates started entries in journal (reservation)
order and breaks at the first started-without-completed entry, and builds
`byCallKey` from that prefix only. For a parallel fan-out where `agent_1`
stalls and agents 2..10 complete, that yields zero reusable results even
though nine completed results are durable in the journal. This is the
concrete mechanism behind "a stall loses the intermediate outputs".

Change, scoped to failed/interrupted sources:

- keep the sequential `entries` prefix exactly as today;
- widen `byCallKey` to **every** `workflow.agent.completed` entry in the
  validated journal, not only the prefix.

Safety argument: an exact `agentCallKey` match reuses a result only when the
predecessor chain (for chained keys) or `logicalKey + prompt + semanticOpts`
(for logical keys) is identical. `usedCallKeys` still prevents double
consumption. Completed-run resume is unaffected because its prefix already
covers all agents. Only `workflow.agent.completed` results are reused;
failed and stalled agents always re-run.

Honest caveat (applies to today's shipped semantics too, not only the
widening): `takeResumeCacheHit` already performs out-of-prefix exact-key
lookups for completed-run resume (`:3219-3223`). An exact key match is
sufficient only when prompts and logical keys actually encode the agent's
semantic inputs. A prompt like "Process item" that does not embed the item,
or a logical key not bound to an evidence snapshot, can reuse a result whose
meaning has drifted. The built-in `code-review` already applies the right
discipline — it folds `sourceSnapshotHashKey` into every logical key
(`workflow-runtime.ts:932,:1008`). P4-D authoring guidance and the p3b
contract update state this discipline explicitly.

### Workspace drift disclosure

Resume replays cached results against a workspace that may have changed
since the source run. Drift is deterministically detectable but its
materiality is semantic, so per the capability-boundary rule it is a
non-blocking disclosure, not a hard gate:

- at launch, record a runtime-owned workspace fingerprint in
  `workflow.run.started` (git HEAD + porcelain status digest, excluding the
  runtime state dir via the existing exclusion helper; omitted outside git
  repos). This is an additive optional journal field; the reader accepts
  its absence so pre-P4 journals stay valid;
- on resume, a fingerprint mismatch emits a prominent warning event and a
  projection flag on the resume launch; cached results still apply.

Hard-blocking was rejected: it would break the legitimate
"edit the script, resume, reuse untouched agents" flow over an unchanged
workspace, and trivial drift (logs, untracked scratch) would force full
re-runs.

### Run-level model identity on resume

`semanticOpts.model` bakes the run-level backend model into every call key,
but the model is not persisted in the retry input. A resume invoked without
the original `--model` would silently miss every cache entry and re-run the
whole workflow under a different model. Rule: when the resume launch does
not specify `--model`, adopt the source run's model (derived from the first
`workflow.agent.started` entry's `semanticOpts.model`; no journal schema
change needed). An explicitly different `--model` proceeds — the keys miss
and everything re-runs, which is correct — but emits a warning event naming
both models so the full re-run is visible and intentional.

### Duplicate logical keys fail at reservation time

A repeated logical `key` with identical prompt+opts currently writes two
identical `agentCallKey`s; the run completes normally but
`validateWorkflowJournal` rejects the whole journal at resume time
(`duplicate agentCallKey`, `workflow-journal.ts:454-456`) — a latent failure
that defeats resume for exactly the loop-shaped workflows that need it.
P4-B rejects a duplicate logical key at agent reservation time with
`workflow_input_invalid` (chained keys cannot collide because each
reservation advances the chain). This also protects completed-run resume
today.

### Resume must run from the original workspace root

Workflow state is partitioned by `sha256(resolve(cwd))`
(`state-root.ts:13-18`), so a resume invoked from any other directory —
including a subdirectory — reports "unknown run". The recovery protocol
therefore reads `cwd` from `status` (already projected) and passes it via
`--cwd`. A runId-addressable cross-workspace index is deferred until real
usage shows the documented rule is insufficient.

### CLI surface

- `--resume-from-run-id` accepts failed/interrupted run ids; the preflight
  gate `assertBackgroundResumeSource` (`cli.ts:153`) relaxes with the same
  rules; the help text at `cli.ts:1750` ("resumes a completed local
  workflow") is updated.
- `status <jobId>` (and `jobs` rows) gain `runId`, extracted from the
  child's `workflow.started` progress event — required by the P4-D recovery
  protocol, since the launch record cannot contain a `runId` that is minted
  later inside the detached child. A job that died before emitting
  `workflow.started` has no journal and is not resumable; the protocol says
  relaunch.
- Rejection messages distinguish "unknown run" from "journal invalid as
  resume source"; resumed launches surface the source run's terminal reason.
- A `resumable` flag, if added, is computed on read for single-job `status`
  only (journal validation per row is too expensive for bulk `jobs`) and is
  point-in-time; decide during Step 2 against real CLI output whether
  `runId` + `status` + reason already make it redundant.
- `docs/ultracode-p3b-resume-cache.md` is updated when this ships; the
  specific rules that flip are the completed-terminal requirement (p3b:30)
  and prefix-only reuse (p3b:34-35), plus the new caveats (workspace drift,
  key discipline, cancelled-run resumability).

### Safety rules (unchanged from round 1, restated)

- `running` sources keep failing with `workflow_resume_running`.
- Cached reuse replays result values, not side effects. Worktree-isolated
  agents do not get file effects replayed; preserved worktrees remain per
  the p3c contract. Documented in the p3b update.

## P4-C: Built-In Code-Review Funnel Tiering

Single effort profile for both levels, applied inside
`codeReviewBuiltinWorkflowScript()` via P4-A options (script has ~35 KB
headroom under `MAX_SCRIPT_BYTES`):

| Stage | Agents | Effort |
| --- | --- | --- |
| Scope | 1 | `xhigh` |
| Find | up to 8/10 finders | `high` |
| Verify | per-candidate verifiers | `xhigh` |
| Sweep (xhigh level only) | 1 sweep finder | `high` |
| Synthesize | 1 | `xhigh` |

- `level` keeps owning caps and sweep; the effort profile becomes another
  property of the existing `level` concept. No new args vocabulary.
- This is the only intended default-behavior change in P4. Risk: finder
  recall at `high`. Gate: one dogfood contrast run (same repo, same change
  set, finder `high` vs `xhigh`) before release; if material findings are
  lost, revert the finder tier to `xhigh` and keep P4-A options available
  for user-authored scripts.
- The built-in script text changes, so its `scriptHash` changes; prior
  built-in runs stop resuming against the new package version. This is the
  existing cross-version rule, not a new restriction.

## P4-D: Hybrid Native-Skill Orchestration

### Core rule change

`skills/ultracode-for-codex/SKILL.md` keeps the main Codex context as
planner and synthesizer. What changes: delegated fan-out phases run through
the local CLI runtime when it is available, instead of Codex-native
subagents. Codex-native subagents remain the fallback when the CLI package
is not installed or not authenticated, preserving today's behavior on
machines without the package.

Capability detection: `npm exec -- ultracode-for-codex --version` (or the
global binary). Detection failure routes to the native fallback with an
explicit note in chat, not an error.

### Authoring surface: capability, not convention

The value claim "schema enforcement replaces table convention" only bites if
authored scripts actually declare schemas. Script authoring is LLM output,
so P4-D moves the authoring contract onto the capability surface in three
ways, ordered by strength:

1. **Prefer built-ins.** When a phase fits `code-review` or `task`, the
   orchestrator launches the built-in instead of authoring a script; those
   scripts already enforce schemas, logical keys, and evidence discipline.
2. **Ship the authoring contract in `--llm-guide`.** Today
   `ULTRACODE_INSTALL.md` contains zero authoring API, so pointing authors
   at it is pointing at nothing. Step 4 adds the script contract there:
   pure-literal `meta`, the `agent(prompt, {schema, key, phase, label,
   effort, model, isolation})` surface, `pipeline`/`parallel` item-preserving
   semantics, forbidden nondeterministic APIs, and the key/prompt snapshot
   discipline. The guide ships in the package and is re-readable by the
   orchestrator at run time.
3. **Add a no-execution validate mode on `run`.** Reusing the existing
   no-run preflight pattern (`RESUME_PREFLIGHT_BACKEND`, `cli.ts:166-173`),
   it parses and persists the script, runs meta/size/determinism validation,
   and hard-fails structural invalidity before any agent spends tokens. It
   additionally emits **non-blocking warnings** — counts of `agent()` calls
   without `schema` and of dynamic fan-out calls without a logical `key` —
   as disclosures for the orchestrator, per the capability-boundary rule
   (semantic adequacy is not deterministically decidable, so it is not a
   hard gate).

The orchestrator's contract in SKILL.md: validate before launch; treat
warnings as prompts to fix the script, not noise.

### Phase execution contract

For each planned phase that fans out subagents:

1. Author a small per-phase workflow script (or select a built-in).
   Machine-consumed agent outputs use `agent(..., { schema })`; sweeps tier
   `high` and verdicts `xhigh` via P4-A options; dynamic parallel agents
   pass logical `key`s bound to the evidence snapshot (e.g. fold
   `workspaceContext` snapshot identity into the key, as the built-in does);
   never reuse a logical key within a run.
2. Validate (`run` validate mode), then launch background `run`.
3. Obtain the recovery anchor: poll `status <jobId>` once the child starts
   and surface `jobId`, `runId`, and `cwd` in chat. (The launch record
   cannot carry `runId`; it is minted in the detached child.)
4. Poll `status`/`logs --tail`, or hold with `wait --result`, while doing
   non-overlapping main-context work.
5. Read the phase result JSON, synthesize in chat, and plan the next phase.

The chat-visible progress contract (`references/progress-visuals.md`) is
unchanged; only the execution backend behind the snapshots changes.

### Output contract change

At phase boundaries, the markdown-table return convention is replaced by the
workflow result JSON that the runtime validated against the phase script's
schemas. Tables remain a chat rendering choice, never the data channel.

### Recovery protocol

On a new session (or after a stall), from the original workspace root
(`--cwd` from the anchor or from `status`):

| Situation | Action |
| --- | --- |
| Anchor lost | `jobs` to enumerate (state root is global; works across sessions), then `status <jobId>` for `runId`, `cwd`, terminal reason |
| Job still running | `status <jobId>` / `wait --result` |
| Job completed while away | `result <jobId>`, continue synthesis |
| Job failed, cancelled, or process killed | `run --resume-from-run-id <runId> --cwd <cwd>` (P4-B reuses completed agent results; terminal reason is surfaced) |
| Job died before `workflow.started` (no `runId` in `status`) | relaunch the phase; there is no journal to resume |

### Permission UX

Orchestrator-authored scripts are `script_path` sources and the packaged
default permission policy is `ask`, which would stall a background launch.
Design: the skill shows the authored script path (and the script itself when
short) in chat before launching, and launches with `--permission allow`.
`--permission allow` records a **persisted** allow keyed by
`(source, path, name, scriptHash)` — a standing grant, but bound to that
exact script hash, so any edit requires a fresh decision; the store lives
under the sensitive local state root. The human gate is the Codex session's
own shell-command approval for the launch command. `settings.json` defaults
are unchanged.

## Development Order

Each step lands independently green: `npm test` after every step;
`npm run test:e2e:ultracode-for-codex`, `pack`, and `publish:dry-run` at
step 5. Steps 1-3 preserve current behavior when new options are absent
(provable by diffing default-path journals/fixtures).

### Step 1: P4-A runtime options

Work: `AgentOptions`, validation (export `REASONING_EFFORTS` or a guard),
plumbing, `modelOverrideFor` precedence, semanticOpts recording.

Done when:

- fake-backend tests record `reasoningEffort` and model per request and
  prove explicit options reach `turn/start` fields;
- precedence test: per-agent model beats `--model`, which beats thread
  default;
- invalid effort/model values fail with `workflow_input_invalid`;
- a call-key fixture from a pre-P4 journal still cache-hits a
  default-options script (byte-identical semanticOpts).

### Step 2: P4-B failed/interrupted resume

Work: source-class eligibility (failed, interrupted, cancelled-with-reason),
journal-first durable discovery, result-record fall-through, reader
tolerance for complete-JSON-missing-newline tails on non-completed sources,
widened `byCallKey`, workspace fingerprint disclosure, run-level model
adoption + mismatch warning, duplicate-logical-key reservation-time
rejection, CLI acceptance (`--resume-from-run-id`, `assertBackgroundResumeSource`,
help text), `runId`/`cwd` projection into `status`/`jobs`, terminal-reason
surfacing.

Done when:

- resume from a failed-terminal journal reuses completed prefix and
  out-of-prefix completed results (parallel-stall scenario: 1 stall + N
  completions → N reusable);
- resume from a truncated-tail journal and from a
  complete-JSON-missing-newline tail both work; broken hash chain rejects;
- kill-window simulation (result.json present, journal non-terminal)
  resumes via fall-through;
- running-run rejection and completed-run semantics are unchanged (existing
  tests stay green without modification);
- args/script binding tests: journal-reconstructed retry input matches; a
  moved/edited persisted script rejects;
- resume without `--model` adopts the source model (cache hits); explicit
  different `--model` re-runs with a warning event;
- duplicate logical key fails at reservation with a clear error;
- fingerprint mismatch emits the drift warning while cache still applies;
  pre-P4 journals without the field stay valid;
- resume from a wrong cwd produces an actionable error; `status` output
  carries `runId` and `cwd` sufficient to execute the recovery protocol.

### Step 3: P4-C tiering

Work: effort profile in the built-in script; E2E fixture alignment.

Done when: installed E2E asserts finder agents request `high` and verifier
agents request `xhigh` through the fake app-server; dogfood contrast run
recorded with a go/no-go note on finder recall.

### Step 4: P4-D skill revision and authoring surface

Work: SKILL.md core rule, phase execution contract, recovery protocol,
authoring pitfalls; `ULTRACODE_INSTALL.md` gains the script authoring
contract (so `--llm-guide` actually contains it); `run` validate mode with
structural hard-fail + schema/key warnings; re-measure the native
`turn_context` premise once and adjust fallback wording if it changed.

Done when: packaged skill text matches shipped runtime behavior; validate
mode E2E-covered (invalid script fails without token spend; schema-less and
key-less warnings emitted); the recovery protocol is executable as written
from a cold session against real CLI output; no CLI-internal vocabulary
leaks into the default user-facing contract beyond the anchor fields
(`jobId`, `runId`, `cwd`).

### Step 5: Docs and release alignment

Work — the full enumerated update list:

- `README.md` (`:165` "Resume a completed local workflow" wording; "Use In
  Codex" section for hybrid behavior);
- `ULTRACODE_INSTALL.md` (resume contract lines; authoring section from
  Step 4);
- `skills/ultracode-for-codex/SKILL.md` (`:26-28` "Do not make the CLI
  process the default orchestrator" contradiction; frontmatter description);
- `skills/ultracode-for-codex-cli/SKILL.md` (`:59-62`, `:111`
  completed-only resume wording; `:15-16` orchestration-split nuance);
- `docs/ultracode-p3b-resume-cache.md` (rules `:30`, `:34-35`, new caveats);
- `docs/local-dynamic-workflow-design.md` (`:187` dated correction recording
  the P4-A override);
- `docs/provenance-audit.md` (version references, per the existing package
  validator convention);
- `IMPLEMENTATION_MAP.html` (first-viewport tiles: the "keep native and CLI
  authority distinct" risk reframes to "authored scripts must not silently
  weaken the schema/journal contract"; next-decision tile);
- CLI `--llm-guide`/help strings; package validator required text.

Plus release gates and live smoke N=1 through the real Codex app-server for
one tiered run (asserting the per-turn model override took effect — the
silent-no-op check) and one killed-then-resumed run.

Done when: all gates green; residual risk stated if live smoke is skipped.

## Review Gates

| Gate | Checks |
| --- | --- |
| Runtime contract | default-path byte-compat of semanticOpts/call keys; effort/model reach `turn/start`; precedence order |
| Resume safety | non-completed sources validated by the full journal reader; kill-window fall-through; tail tolerance; duplicate-key reservation rejection; model adoption; drift disclosure; exact-key-only reuse; running rejection; no side-effect replay claims |
| Review quality | tiering contrast run; recall regression is a release blocker for the P4-C default |
| Authoring surface | `--llm-guide` contains the script API; validate mode hard-fails structural invalidity without token spend and emits schema/key warnings |
| Recovery protocol | executable as written from a cold session against real CLI output (`jobs` → `status` → `runId`+`cwd` → resume) |
| Package/docs | every file in the Step 5 list updated; validator strings; provenance docs; version surfaces |

## Redesign Triggers

- Live probe shows the app-server rejects — or **silently ignores** — the
  per-turn `model` override → stop recording per-agent model in cache
  identity; either drop the `model` option or downgrade to per-thread
  configuration, then re-check latency cost.
- Live probe shows per-turn `effort` rejected → downgrade to thread-level
  effort per agent thread (already how threads start) and re-check latency.
- Finder `high` tier loses material findings in the contrast run → revert
  P4-C default; ship P4-A options only.
- Hybrid launch permission flow proves unusable inside Codex sessions →
  fall back to pre-registered project workflows under `.codex/workflows/`
  with standing permission records.
- Documented cwd-anchored resume proves insufficient in real recovery →
  add a runId-addressable workspace index.

## Open Items

Live verification results (2026-07-05, codex-cli 0.142.5, default model
`gpt-5.5`):

1. **Per-turn override enforcement — verified.** An invalid per-turn `model`
   fails the turn with a provider 400 (silent no-op refuted; the P4-A
   redesign trigger does not fire). Per-turn `effort` is enforced end-to-end:
   the live provider rejected `minimal` naming `reasoning.effort`, with
   supported values `none|low|medium|high|xhigh` — so `effort: "minimal"`
   fails that agent loudly on the current default model (documented in the
   authoring guide). On a ChatGPT-account Codex, alternate model ids outside
   the account's allowance are rejected loudly, which is the designed
   fail-loud behavior for per-agent `model`.
2. **Kill-then-resume — verified live.** A background run SIGKILLed
   mid-flight surfaced `exited_unknown` with the `runId`/`cwd` anchor in
   `status`; `--resume-from-run-id` reused both completed agent results
   (`cached: true`), disclosed `interrupted`, and completed the remaining
   agent.
3. **Finder-tier contrast — default holds.** Same repo, same change set
   (the P4 diff itself): finder `high` → 15 candidates, 8 reported, 27
   agents, 13.6 min; finder `xhigh` → 24 candidates, 8 reported (2
   not-material, 1 superseded), 36 agents, 23.0 min. Same material yield at
   41% less wall clock; per-tier unique findings were finder-variance, not a
   recall class. P4-C default stays `high`.
4. Native `turn_context` effort-inheritance premise: still user-measured —
   the native chat session's subagent tools cannot be driven from this
   terminal. The app-server layer beneath them is now proven to enforce
   per-turn effort/model (item 1), so the hybrid delegation path does not
   depend on this premise.
5. Workspace fingerprint outside git repos: unchanged open question
   (absence-means-no-check today).

Resolved during implementation: the `resumable` projection flag was not
added (`status` carries `runId`/`cwd`/`status`/`reason` instead); sweep
finder shipped at `high` per the user-locked tier decision, confirmed by
item 3.

## Review Round 3 Disposition (live dogfood code-review, 2026-07-05)

The two contrast runs double as the first live dogfood of the shipped
`code-review`. Their 8+8 reported findings were re-verified against the
diff; material ones fixed in the same session:

| Finding | Disposition |
| --- | --- |
| Relative `--cwd` breaks the recovery anchor (state is partitioned by exact path) | Fixed: the CLI pins `--cwd` to an absolute path at parse time |
| `status`/`wait` treat an in-process-retrying job as terminally failed (whole-stream terminal scan) | Fixed: a terminal event counts only while it is the newest status event |
| Background launches with `--progress plain` break machine state (runId/terminal derivation) | Fixed: the background child is always forced to `--progress jsonl`; `logs --plain` still renders human lines |
| Background run files created with default permissions despite sensitive-state docs | Fixed: run dir 0700, result/progress/metadata/pid 0600 |
| Explicit per-agent `model: "codex-subagent"` silently treated as no-override | Fixed: the reserved placeholder is rejected at agent option validation |
| Installed E2E blessed the old Codex-native skill metadata | Fixed: `openai.yaml` and the E2E assertion updated to the hybrid wording |
| Provenance audit carried a stale audit date next to 0.4.0 references | Fixed: dated update note added |
| Default-model drift is invisible to cache identity for no-model runs | Documented as a p3b caveat (pin `--model` when default drift matters) |
| Skill capability probe could trigger an npm install | Fixed: probe uses `npm exec --no` |
| `config.toml` default model recovered by regex, not a TOML parser | Deferred: pre-existing, bounded to a fallback default; noted here |

## Implementation Corrections (2026-07-05)

Recorded while implementing steps 1-5; each overrides the matching design
text above.

- **byCallKey widening is uniform, not scoped to non-completed sources.** A
  completed run can also contain failed agents mid-prefix when the script
  tolerated the failure, so the same exact-key safety argument applies to all
  source classes and one code path serves both. Completed-run prefix
  semantics are unchanged.
- **Run-level model is recorded as `runtime.model` in `workflow.run.started`**
  (additive optional journal field, with `runtime.workspaceFingerprint`),
  not derived from the first agent's `semanticOpts.model` as the design
  suggested — a first agent with a per-agent override would poison the
  derivation. Readers accept journals without the new fields.
- **Tolerant tail handling drops any unterminated final line**, parseable or
  not. The design's truncated-vs-complete distinction relied on parser error
  message shapes (`isTruncationParseError` under-matches Node's current
  messages); the commit-marker semantics (writer emits entry+newline as one
  buffer) make the distinction unnecessary for non-completed sources.
- **The `resumable` projection flag was not added** (Open Item 2 resolved):
  `status` now carries `runId`, `cwd`, terminal `status`, and `reason`, which
  the recovery protocol consumes directly.
- **One existing test contract flipped by design**: the kill-window case
  (result record beside a journal missing its terminal entry) previously
  asserted rejection and now asserts journal-first resume with cached reuse.
  Result records that contradict the journal or persisted script still fail
  loudly.
- **Preflight rename**: the CLI's no-run backend is now `PREFLIGHT_BACKEND`,
  shared by resume validation, resume model adoption, and `run --validate`.

## Review Round 2 Disposition (post-implementation diff review, 2026-07-05)

Eight finder angles over the implementation diff surfaced 24 candidates
(deduped); material findings and dispositions, all fixed and re-gated:

| Finding | Disposition |
| --- | --- |
| Cross-process resume of a still-RUNNING run launches a duplicate (the running guard only covered in-registry sources) | Fixed: runtime-owned `run.pid` liveness file, written at launch, removed at terminal; journal-first no-terminal sources reject with `workflow_resume_running` while the pid is alive |
| Corrupt/mismatched result records silently fell through to journal-first, bypassing record-journal binding | Fixed: an existing-but-unreadable/unparsable/unbound record fails loud; only a valid record beside a non-completed journal falls through |
| A completed journal with post-terminal bytes was rescued by journal-first, skipping the args cross-check | Fixed: journal-first rejects terminal-completed journals outright; completed sources must bind through their result record |
| `--validate` (and other value-less flags) swallowed a following positional token | Fixed: parser marks `plain/result/wait/validate` as value-less |
| Authoring scan paren-matching ignored string literals → false schema/key warnings | Fixed: generalized the meta-literal scanner (`findMatchingDelimiter`) that skips strings/comments; naive matcher deleted |
| Model-mismatch disclosure overclaimed ("will not be reused") and stayed silent for no-model sources | Fixed: accurate wording (per-agent model overrides keep cached results) and placeholder-aware comparison |
| Workspace fingerprint missed content edits to already-dirty tracked files | Fixed: fingerprint now includes the tracked-content `git diff HEAD`; untracked-content gap documented |
| `--retry-limit` re-ran every agent from scratch, discarding durable results | Fixed: `retry` resumes the failed run (with fresh-run fallback when the journal cannot serve as a source); also dissolves the "status reports the worst retry anchor" finding |
| Plain-mode `status` omitted the `runId`/`cwd` recovery anchor | Fixed: plain renderer includes both |
| Journal-first retryInput turned absent args into `null` and drops `toolName` | Fixed: null args normalize back to absent; `toolName` re-supply documented |
| Logical-key reuse after a failed attempt hard-fails the run | Kept as documented limitation (distinct key per attempt) — full support would change the journal duplicate-key contract; error message and p3b updated |
| `'codex-subagent'` placeholder compared as a raw string in three modules; journaled as a fake model name | Fixed: shared `SUBAGENT_MODEL_PLACEHOLDER` constant; `runtime.model` omitted from the journal when no run-level model is configured |
| Cleanup: duplicated preflight-registry boilerplate, duplicated resume-info derivation, double cache-entry materialization, inline type duplicating `WorkflowResumeSourceInfo` | Fixed: `withPreflightRegistry`, shared `workflowResumeSourceInfoFromJournal`, single materialization, `Omit<>` type |

## Review Round 1 Disposition

Three independent lenses reviewed the round-1 draft: code conformance
(~40 claims re-derived, 5 low/info corrections), failure-mode/recovery
attack (10 findings), concept-economy/capability-boundary (6 findings).
Material findings and their disposition:

| Finding | Disposition |
| --- | --- |
| `runId` never surfaced by launch record/status/jobs (2× HIGH) | Accepted → `runId`/`cwd` projection + protocol rewrite (P4-B CLI surface, P4-D) |
| Authoring contract absent from `--llm-guide`; authoring is convention (HIGH) | Accepted → authoring surface section: built-ins first, guide content, validate mode |
| Widened byCallKey + workspace drift → stale reuse (HIGH) | Accepted as disclosure-not-gate → fingerprint + warning + key discipline; noted the exposure predates P4 |
| Run-level model not restored on resume (MED) | Accepted → model adoption + mismatch warning |
| Complete-JSON-missing-newline tail throws (MED) | Accepted → reader tolerance for non-completed sources |
| Duplicate logical key poisons resume latently (MED) | Accepted → reservation-time rejection |
| State dir partitioned by exact cwd (MED) | Accepted → documented `--cwd` protocol; index deferred |
| Silent per-turn model no-op mis-keys cache (MED) | Accepted → live-smoke assertion + redesign trigger |
| Kill window between result write and terminal append (LOW) | Accepted → fall-through rule |
| Cancelled runs resumable (LOW-MED) | Accepted with policy: resumable; terminal reason surfaced; explicit resume is the confirmation |
| "interrupted" vs existing `exited_unknown` (MED) | Accepted → vocabulary mapping rule; no new CLI token |
| Doc-contradiction inventory (3 missing files + 4 in-file gaps) (MED) | Accepted → Step 5 enumerated list |
| `--permission allow` is a persisted grant (LOW) | Accepted → documented as scriptHash-bound standing grant |
