# Local Dynamic Workflow Design

This design records the implemented direction for Ultracode for Codex local
dynamic workflows. It captures Codex behavior, current repository state,
remaining optional backlog, dependency order, and verification gates without
copying third-party source or implementation artifacts.

## Goal

Local workflows should run from a prompt or named workflow input, create
task-specific lenses at run time, execute independent work through phase-wise
parallelism by default, and use runtime-owned schemas, evidence, progress,
persistence, and resume/cache behavior for reproducibility.

The implemented concrete target is the built-in `code-review` workflow, which
uses a review-specific dynamic workflow:

```text
Collect Review Evidence
  -> Scope
  -> no-barrier lens work:
       per-lens Find
       per-candidate Verify inside each lens result
  -> Sweep when the selected level calls for it
  -> Synthesize
```

The important correction is the item boundary: finders are lens-scoped, but
verifiers are candidate-scoped. The workflow must explicitly convert finder
outputs into runtime-indexed candidate envelopes before verifier agents run.

## Implementation Status

Status as of 2026-06-23:

- Steps 1-4 are implemented in `src/runtime/workflow-runtime.ts`, `src/cli.ts`,
  the packaged skill files, and installed-package E2E tests.
- `workspaceContext({ includeDiff: true })` now emits bounded review evidence,
  source snapshot metadata, context hashes, and allowed evidence refs.
- Dynamic verifier agents use explicit logical keys via `agent(..., { key })`,
  and same-session resume can reuse logical-keyed results after dynamic reorder.
- Built-in `task` remains the generic phase planner.
- Built-in `code-review` now uses the specialized Evidence -> Scope -> Find ->
  Verify -> optional Sweep -> Synthesize harness.
- Installed E2E covers the shipped `code-review` path in JSONL and plain
  progress modes, including dynamic finder/verifier overlap, optional sweep,
  synthesis, invalid evidence fail-closed behavior, and package skill contents.
- Progress projection keeps cumulative phase summaries and expands dynamic
  verifier agents under the planned dynamic verifier placeholder.

## Current Implementation Snapshot

| Area | Current implementation | Gap to close |
| --- | --- | --- |
| Workflow launch | `src/runtime/workflow-runtime.ts` accepts inline scripts, named workflows, runtime `scriptPath`, and `args`. No launch document is required. | Preserve prompt-first launch as an explicit invariant and avoid requiring design documents or review reports in built-ins. |
| Workflow VM | Scripts use pure-literal `meta`, run in a hardened VM, disable host globals, reject nondeterministic APIs, persist scripts, and expose `agent`, `parallel`, `pipeline`, `hash`, `workspaceContext`, `announcePlan`, `announcePhasePlan`, `phase`, and `log`. | Keep documentation and tests aligned around item-preserving pipeline semantics, phase grouping, runtime-owned hashes, and dynamic phase plans. |
| Structured output | `agent(..., { schema })` requires a `StructuredOutput` tool call and runtime-validates JSON Schema with unknown-field rejection when `additionalProperties: false` is present. Built-in `code-review` uses schemas for scope, finder candidates, verifier verdicts, and synthesis decisions. Installed E2E covers these schemas through the shipped package path. | Optional backlog only: add wider package fixtures if future schema variants are introduced. |
| Review evidence | `workspaceContext({ includeDiff: true })` returns git status, selected current files, bounded staged/unstaged/committed diffs, source snapshot id, context hash, allowed evidence refs, and unavailable evidence notes. Codex subagents can read files and list directories, but shell/git tools are disabled. | Optional backlog: add installed E2E around truncation and deleted files beyond the current source-level runtime tests. |
| Parallel execution | `parallel()` and `pipeline()` both use `MAX_PARALLELISM = 16`. `pipeline()` processes each original item through all stages and does not flatten arrays returned by a stage. | Keep this item-preserving contract explicit. Built-in review must not assume `pipeline()` is `flatMap`; it must create candidate envelopes before candidate verification. |
| Built-in workflows | `task` remains the generic phase planner. `code-review` uses a specialized Evidence -> Scope -> Find -> Verify -> optional Sweep -> Synthesize harness with dynamic lenses and candidate-scoped verifiers. | Optional backlog: dogfood the review workflow against a larger real repository after publish. |
| Progress | Runtime emits plan, phase plan, phase start, agent start/completion/failure, completion, and failure events. Agent completion includes elapsed and known-count fields. CLI projects those events to JSONL or plain progress. Built-in `code-review` assigns explicit phases to dynamic finder, verifier, sweep, and synthesis agents, and the final summary expands dynamic verifier labels. | Optional backlog: tune additional visual profiles after more real runs. |
| Persistence | Journal, result files, resume/cache, permission records, background files, and preserved worktrees are runtime-owned. Agent cache keys support prefix-ordered hits and logical-keyed hits for dynamic verifier reuse after reorder. | Optional backlog: add package-level cross-process resume/cache E2E after a durable public resume contract is designed. |
| Native skill | `skills/ultracode-for-codex/SKILL.md` keeps the main Codex context as orchestrator and defaults to phase-wise parallel work. The CLI skill documents the explicit local runtime path. | Keep future docs behavior-first and avoid exposing internal CLI vocabulary as the default native command contract. |

## Optional Backlog

These items are useful quality extensions, but they are not required for the
current local dynamic workflow release:

- Cross-process `code-review` resume/cache E2E. Current tests cover logical
  keys and same-session dynamic reorder reuse. A durable cross-process contract
  should be designed before exposing or testing resume as a package-level
  public behavior.
- Broader installed review-evidence fixtures. Source-level tests cover
  deterministic review evidence and invalid refs. Package-level fixtures can be
  expanded later for large truncation cases, deleted files, and removed hunks.
- Real Codex app-server dogfood run. This is valuable as a manual quality
  signal, but it depends on the live Codex environment and should not replace
  deterministic fake app-server E2E gates.
- Multi-perspective semantic review. Parallel LLM review can improve judgment
  quality before publish, while deterministic schema, evidence, package, and
  runtime-boundary tests remain the release gate.

## Design Principles

1. Prompt-first launch.
   The workflow input is `script`, `name` or `scriptPath`, plus `args`. A design
   document, review report, or generated file can be evidence or output, but it
   is not a prerequisite for execution.

2. LLM owns semantics; runtime owns authority.
   The LLM may choose scope, lenses, materiality, and synthesis rationale. The
   runtime owns ids, paths, source snapshots, evidence refs, serialization, JSON
   Schema validation, allowed-set validation, journal writes, result projection,
   progress, retry, cancellation, cache keys, and permission decisions.

3. Pipeline first, barrier only when needed.
   `pipeline()` is the default for multi-stage work because each original item
   can move to the next stage as soon as its own previous stage completes.
   `parallel()` is a barrier and should be used when a stage needs the full
   prior-stage set, such as global dedupe, early exit, or final synthesis.

4. Item domains must be explicit.
   A lens, a finder result, and a candidate are different item domains. The
   script must name where it converts from one domain to another. The runtime
   must not silently flatten stage outputs.

5. Lenses are generated per task.
   Built-ins may provide reusable lens seeds, but the active lens set should be
   selected from the user request, runtime-owned change evidence, repository
   context, and previous phase output.

6. Schema-first is not evidence-grounded by itself.
   Review candidates, verifier verdicts, and synthesis decisions should flow
   through `agent(..., { schema })`, then runtime validation. File paths, line
   ranges, candidate indexes, and evidence refs still need script/runtime
   allowed-set checks before they become final output.

7. Progress is cumulative.
   Planning snapshots may be partial. Each phase plan is emitted immediately
   before that phase group becomes relevant. Completion summaries should report
   how many finder and verifier agents ran per phase and which lens or candidate
   each represented.

## Detailed Design For 1-4

### 1. Prompt-First Workflow Input

Current code already has the right launch shape. The implementation work is to
make this invariant visible and testable:

- built-in `task` and `code-review` accept `args.prompt` as the primary user
  instruction;
- `code-review` collects deterministic repository evidence through a
  runtime-owned review context before asking the LLM to choose scope or lenses;
- final results are returned as workflow result JSON and projected by CLI;
- optional documents remain ordinary files created by a later implementation
  task, not workflow launch authority.

Implementation points:

- Keep `WorkflowLaunchInput` unchanged.
- Add a runtime test proving named `code-review` accepts `args.prompt` and does
  not require an external design or review document under the current planner.
- Put the full Scope/Find/Verify/Synthesize acceptance test in the specialized
  built-in step, after that script exists.
- Keep active user docs focused on prompt or named workflow execution.

### 2. Deterministic Workflow Runtime Contract

Current runtime support is strong, but the specialized review workflow needs
three contract refinements:

- review evidence context;
- dynamic candidate identity and cache keys;
- fail-closed candidate accounting.

Existing support to preserve:

- pure-literal `meta`;
- script persistence and metadata;
- hardened VM and disabled host globals;
- `Date`, `Math.random`, dynamic import, eval, function constructor, and
  TypeScript syntax rejection;
- JSON-serializable `args` and `budget`;
- agent cap, parallelism cap, and stall retry policy;
- hash-chained journal and same-session resume/cache.

Required refinements:

- Extend `workspaceContext` for review, or add a dedicated helper, so the
  runtime can include bounded diff evidence. The preferred shape is an extension
  such as `workspaceContext({ query, includeDiff: true, diffBaseRef })` unless a
  separate helper is clearly simpler.
- Document that `pipeline()` is item-preserving and does not flatten arrays.
  Add tests that fail if it becomes a stage barrier or an implicit flatMap.
- Document that phase titles are progress groups. A phase can group agents even
  when a no-barrier lens pipeline overlaps `Find` and `Verify`.
- Every overlapping finder or verifier `agent()` call must pass an explicit
  `phase`; it must not rely on the global `phase()` value.
- Add logical agent identity for built-in dynamic agents, or equivalent runtime
  behavior, before claiming resume/cache stability for overlapping verifier
  work. The preferred option is an explicit logical key derived from
  runtime-canonical values: `sourceSnapshotId`, `contextHash`, an
  allowed-evidence-index digest, a canonical scope digest, a script-normalized
  `lensKey`, `candidateDigest`, and `candidateIndex` only as a tie breaker.
  LLM-provided lens ids are semantic suggestions until the script normalizes,
  dedupes, and validates them; the global start order should not be the source
  of truth for these dynamic agents.
- Keep `workflow()` nested calls deferred unless a concrete built-in needs them.
- Keep broad `model`, `effort`, and `agentType` options out of the next
  implementation. If the review harness adds a logical key option, keep it
  narrow, validated, and covered by cache-key tests.
- Revisit `MAX_SCRIPT_BYTES = 64 * 1024` only if the specialized built-in script
  exceeds it. If raised, add a size-cap test and keep the new cap explicit.

### 3. Dynamic Lens Generation

Use a two-layer lens model:

- baseline lens seeds live inside the built-in `code-review` script;
- the Scope step selects or adapts the active set based on user instruction,
  runtime-owned change evidence, language/framework hints, and repository
  context.

Recommended seed lenses:

| Lens | Purpose |
| --- | --- |
| Diff correctness | Inspect touched hunks and enclosing functions for runtime bugs. |
| Removed behavior | Check deleted or replaced guards, validation, errors, and tests. |
| Cross-file contract | Trace callers/callees for changed preconditions or return shapes. |
| Language/platform pitfalls | Look for language-specific footguns and environment-sensitive behavior. |
| Wrapper/delegation correctness | Check adapters, proxies, caches, decorators, and delegation paths. |
| Security/capability boundary | Check authority, permissions, credential handling, and local state exposure. |
| Persistence/retry/cancel | Check journals, resume/cache, retries, cancellation, and terminal states. |
| CLI/user contract | Check commands, settings, progress, package contents, and documented behavior. |
| Tests/package coverage | Check whether tests and packaged artifacts cover the changed behavior. |
| Maintainability/conventions | Check duplication, altitude, and repository instruction alignment. |

The Scope agent may return fewer lenses for tiny changes and may add a specific
lens when the prompt names a risk. The runtime should not hard-code semantic
materiality; it should validate schema shape, allowed refs, caps, and identity
before executing the chosen plan.

### 4. Ultracode Skill And Session Trigger Model

Codex has two explicit commands:

- `$ultracode-for-codex`: main-context orchestration with high visibility;
- `$ultracode-for-codex-cli`: explicit local CLI runtime.

Keep that split. The native skill should mirror the same behavior principles:

- run from the current request without requiring a separate launch document;
- create lenses for the current request;
- use parallel subagents by default;
- verify concrete findings before reporting them;
- show partial plans honestly and update later phase plans after earlier results.

Do not make CLI-specific implementation vocabulary the default user-facing
contract of `$ultracode-for-codex`. Public docs should describe what users see
and can rely on. Internal design docs can describe the exact local runtime
pipeline.

The local CLI remains the reproducible runtime path with background execution,
JSONL progress, cancellation, retry, journal, and packaged E2E coverage.

## Detailed Design For 5: Local Code-Review Workflow

### Inputs

`code-review` accepts object args:

```json
{
  "prompt": "review the current change for material bugs",
  "level": "xhigh",
  "diffBaseRef": "HEAD~1"
}
```

`prompt` is required by behavior but has a safe default. `level` is optional.
`diffBaseRef` is optional and is interpreted by the runtime, not by shell access
inside subagents.

Supported levels for the built-in script:

| Level | Max active finders | Max candidates per lens | Sweep | Report cap |
| --- | ---: | ---: | --- | ---: |
| `high` | 8 | 6 | no | 10 |
| `xhigh` | 10 | 8 | yes | 15 |

The counts are caps, not exact requirements. Scope selects `0..N` active lenses
under the level cap. Tests should assert cap behavior rather than exact finder
counts.

The package default Codex reasoning effort is already `xhigh`, so the workflow
level should default to `xhigh`. A future `max` alias can map to `xhigh` unless
the backend exposes a distinct effort.

### Review Evidence Context

Before Scope runs, the script asks the runtime for a review evidence context.
The runtime, not the LLM, owns the evidence snapshot.

Preferred call shape:

```js
const context = await workspaceContext({
  query: prompt,
  includeDiff: true,
  diffBaseRef: workflowInput.diffBaseRef
});
```

The runtime-owned context should include:

- root path and source snapshot id;
- git status and changed file metadata;
- staged and unstaged diff hunks when available;
- committed diff hunks when `diffBaseRef` or a prompt-derived range is accepted;
- deleted-file or removed-hunk content when git can provide it;
- numbered current-file blocks for changed, explicit, priority, and instruction
  files;
- repository instruction files surfaced by the same path rules;
- an allowed evidence-ref index for files, hunks, and line ranges;
- truncation metadata when size caps omit files or hunks.

Runtime constraints:

- diff collection is bounded by max bytes, max files, and max hunk count;
- paths are normalized and must stay inside the workspace root;
- unsupported ranges are reported in the context as unavailable, not silently
  replaced with broad repository scans;
- all evidence refs carry enough data for later allowed-set validation;
- subagent prompts receive the context as data, not authority to execute shell
  commands.

Scope may summarize or select from this evidence. Scope must not return command
strings whose output becomes review authority.

### Scope Step

Run one structured Scope agent before fan-out.

Scope schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["files", "summary", "lensDecisions", "lenses"],
  "properties": {
    "files": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" },
    "instructions": { "type": "string" },
    "lensDecisions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["seedId", "action", "reasonCategory", "decisionRefs", "reason"],
        "properties": {
          "seedId": { "type": "string" },
          "action": { "type": "string", "enum": ["select", "skip"] },
          "selectedLensId": { "type": "string" },
          "reasonCategory": { "type": "string", "enum": ["matched_change", "prompt_risk", "no_evidence", "cap_limit", "redundant", "out_of_scope", "tiny_change"] },
          "decisionRefs": { "type": "array", "minItems": 1, "items": { "type": "string" } },
          "reason": { "type": "string" }
        }
      }
    },
    "lenses": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "title", "focus", "kind"],
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "focus": { "type": "string" },
          "kind": { "type": "string", "enum": ["correctness", "security", "contract", "persistence", "coverage", "maintainability"] }
        }
      }
    }
  }
}
```

Rules:

- determine review scope from the prompt and runtime-owned evidence context;
- include committed and uncommitted changes only when the context contains that
  evidence or clearly records why it is unavailable;
- read repository instruction files surfaced by the review evidence context;
- return no findings early when there are no reviewable changes;
- choose the active lenses from baseline seeds plus prompt-specific risks;
- return a `lensDecisions` row for every baseline seed and every prompt-specific
  risk that was considered, including skipped lenses and the skip reason;
- bind every `lensDecisions` row to at least one script-supplied
  `decisionRefs` entry. A decision ref is one of: an allowed evidence ref,
  a canonical prompt-risk id, or an unavailable-evidence id emitted by the
  runtime evidence context. Scope must not invent these ids;
- keep LLM-provided lens ids short and stable within the run;
- script-normalize selected lens ids into runtime `lensKey` values and reject
  duplicates after normalization;
- validate that every selected lens has a matching `lensDecisions` row with
  `action: "select"`;
- keep active lens count within the selected level cap;
- the script validates returned files against the context allowed file set.

### Find And Verify Pipeline

Do not use `pipeline(activeLenses, findStage, verifyStage)`. That shape is
incorrect because the runtime pipeline is item-preserving and finder output is a
multi-candidate container.

Use this script-level contract instead:

```text
pipeline(activeLenses, reviewLensStage)

reviewLensStage(lens):
  1. run one finder agent for the lens
  2. validate and cap finderOutput.candidates
  3. deterministically wrap each candidate as:
     { candidateIndex, candidateId, candidateDigest, lensKey, lensTitle, candidate }
  4. run one verifier agent per candidate envelope
  5. fail closed if any candidate lacks a verifier result
  6. return verified candidate envelopes for that lens

after pipeline:
  flatten lens results in active lens order and candidateIndex order
```

This preserves the no-barrier property at the lens level: a lens that finishes
finding can verify its candidates while another lens is still finding. It also
makes verifier work candidate-scoped.

Finder schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["candidates"],
  "properties": {
    "candidates": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["file", "summary", "failureScenario", "evidenceRefs"],
        "properties": {
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "summary": { "type": "string" },
          "failureScenario": { "type": "string" },
          "evidenceRefs": { "type": "array", "minItems": 1, "items": { "type": "string" } },
          "kind": { "type": "string" }
        }
      }
    }
  }
}
```

Verifier schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "evidence", "evidenceRefs"],
  "properties": {
    "verdict": { "type": "string", "enum": ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    "evidence": { "type": "string" },
    "evidenceRefs": { "type": "array", "minItems": 1, "items": { "type": "string" } },
    "severity": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] }
  }
}
```

Execution rules:

- a finder emits every candidate with a concrete failure scenario;
- the script assigns `candidateIndex`, `candidateDigest`, and `candidateId`; the
  LLM does not;
- `candidateDigest` is derived from normalized candidate content, validated
  non-empty evidence refs, `lensKey`, `sourceSnapshotId`, `contextHash`, the
  allowed-evidence-index digest, and truncation metadata, so a changed evidence
  authority cannot accidentally reuse a prior verifier cache entry merely because
  its candidate text and index stayed the same;
- each candidate envelope gets an independent verifier agent;
- finder outputs are not globally deduped before verification;
- candidate files and evidence refs are validated against the runtime evidence
  context before verification;
- verifier refs are validated against the same allowed evidence-ref index;
- finder candidates, verifier verdicts, and final findings must each carry at
  least one allowed evidence ref; empty arrays are invalid, not weak evidence;
- `REFUTED` candidates are filtered after verification;
- `PLAUSIBLE` remains in recall-oriented review unless final synthesis drops it
  under the report cap;
- all finder and verifier `agent()` calls pass explicit `phase` and stable
  labels; dynamic verifier agents also pass a logical key once the runtime
  supports that option;
- fail closed when `candidateCount !== verifierAttemptCount`, a verifier result
  is `null`, a schema result is invalid, or an evidence ref is outside the
  allowed set.

Progress rules:

- `Find` phase plan lists active finder lenses;
- `Verify` phase plan may start with a placeholder such as
  `Verify candidates emitted by finder lenses`;
- verifier rows are appended as candidate envelopes are created;
- completed agent counts grow from actual started/completed events;
- final summaries report finder lens count, candidate verifier count, failed or
  invalid candidate count, and any truncation or incomplete-review status.

### Sweep Step

For `xhigh`, run one additional structured finder after initial verification.
It receives:

- review evidence context summary;
- scope block;
- kept candidates;
- refuted count;
- invalid or truncated evidence counts;
- gap focus list.

It must search only for new defects and return up to 8 candidates. The script
wraps those candidates as new candidate envelopes and sends them through the
same verifier contract.

### Synthesis Step

Use a synthesis agent with a bounded decision schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "decisions"],
  "properties": {
    "summary": { "type": "string" },
    "decisions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["index", "action", "reasonCategory", "reason"],
        "properties": {
          "index": { "type": "integer" },
          "action": { "type": "string", "enum": ["report", "merge", "drop"] },
          "merge": { "type": "array", "minItems": 1, "items": { "type": "integer" } },
          "severity": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] },
          "reasonCategory": { "type": "string", "enum": ["material", "duplicate", "not_material", "report_cap", "unsupported_evidence", "superseded"] },
          "reason": { "type": "string" }
        }
      }
    }
  }
}
```

Runtime script assembly rules:

- index labels are assigned by the script from the verified candidate array;
- synthesis selects indexes and merge indexes only;
- script validates index bounds and decision coverage before constructing the
  final report;
- every verified non-refuted candidate must appear exactly once as the primary
  `index` of a `report`, `merge`, or `drop` decision, or as a merge target of
  one `merge` decision. Missing or duplicate coverage makes synthesis invalid
  and triggers script fallback;
- `action: "merge"` requires at least one merge index, and merge indexes are
  expanded by the script into candidate id and digest objects in final output;
- `drop` and `merge` decisions include a bounded `reasonCategory` plus open
  rationale text, so duplicate, materiality, report-cap, and unsupported-evidence
  decisions remain auditable;
- if synthesis is empty or invalid, the script emits `mode: "script_fallback"`,
  records a bounded `fallbackReason`, and generates deterministic report/drop
  decisions for every verified non-refuted candidate;
- severity defaults are assigned by the script when a verifier omits severity;
- final result shape is stable JSON:

```json
{
  "level": "xhigh",
  "provenance": {
    "sourceSnapshotId": "string",
    "contextHash": "sha256",
    "allowedEvidenceIndexDigest": "sha256",
    "diffBaseRef": "HEAD~1",
    "truncation": {
      "truncated": false,
      "truncationDigest": "sha256",
      "omittedFiles": 0,
      "omittedHunks": 0
    }
  },
  "summary": "string",
  "findings": [
    {
      "candidateId": "candidate_1",
      "candidateDigest": "sha256",
      "severity": "P1",
      "file": "src/example.ts",
      "line": 123,
      "summary": "string",
      "failureScenario": "string",
      "verdict": "CONFIRMED",
      "evidence": "string",
      "evidenceRefs": ["diff:src/example.ts:12-20"],
      "synthesisDecision": {
        "action": "report",
        "reasonCategory": "material",
        "reason": "string",
        "mergeCandidates": []
      }
    }
  ],
  "synthesis": {
    "mode": "agent",
    "fallbackReason": null,
    "decisions": [
      {
        "candidateId": "candidate_1",
        "candidateDigest": "sha256",
        "action": "report",
        "reasonCategory": "material",
        "reason": "string",
        "mergeCandidates": [
          {
            "candidateId": "candidate_2",
            "candidateDigest": "sha256"
          }
        ]
      }
    ]
  },
  "stats": {
    "finders": 10,
    "candidates": 18,
    "verifierAttempts": 18,
    "verified": 18,
    "refuted": 7,
    "invalid": 0,
    "reported": 3,
    "dropped": {
      "duplicate": 2,
      "notMaterial": 4,
      "reportCap": 2,
      "unsupportedEvidence": 0,
      "superseded": 0
    }
  }
}
```

## Development Order

### Step 1: Lock Current Runtime Semantics

Dependency: none.

Work:

- add targeted tests for no-barrier, item-preserving `pipeline()` ordering;
- add a test proving `pipeline()` does not flatten arrays returned by a stage;
- add a test proving `workflow.plan.ready` can be partial while later
  `workflow.phase.planned` events are discovered after earlier results;
- add a test proving named `code-review` launch accepts `args.prompt` and does
  not require an external design or review document under the current planner.

Done when:

- `npm test` passes;
- tests fail if `pipeline()` becomes a stage barrier;
- tests fail if `pipeline()` silently becomes a flatMap;
- tests do not assert future Scope/Find/Verify/Synthesize behavior before that
  built-in exists.

### Step 2: Add Review Evidence And Dynamic Identity Contracts

Dependency: Step 1.

Work:

- extend `workspaceContext` for bounded diff evidence, or add a narrowly scoped
  review evidence helper if extension becomes too broad;
- include changed-file metadata, staged/unstaged diff hunks, accepted committed
  diff range, deleted/prior content where available, source snapshot id,
  truncation metadata, and allowed evidence refs;
- add allowed-set validators for file paths, line ranges, hunk refs, and
  evidence refs;
- add a deterministic logical agent key contract for built-in dynamic verifier
  agents, or explicitly gate no-barrier verification behind a documented
  cache-hit limitation; the stable key must include source snapshot identity,
  canonical lens key, candidate digest, and candidate index tie breaker;
- update fake runtime and fake Codex fixtures so they can emit Scope, Finder,
  Verifier, Sweep, and Synthesis payloads rather than generic `{detail,count}`.

Done when:

- unit tests prove diff hunks and removed lines can appear in review evidence;
- invalid paths or evidence refs fail loudly before final output;
- dynamic verifier cache keys are stable across equivalent no-barrier runs and
  change when candidate content, source snapshot, context hash, truncation
  boundary, or allowed-evidence-index digest changes, or the runtime reports
  that this mode is not cache-stable;
- fixture outputs can drive every structured schema in the specialized workflow.

### Step 3: Add Specialized Code-Review Built-In

Dependency: Steps 1-2.

Work:

- add `codeReviewBuiltinWorkflowScript()` beside `phaseWiseBuiltinWorkflowScript()`;
- keep `task` on the generic planner;
- implement Scope, Find, Verify, optional Sweep, and Synthesize schemas;
- use baseline lens seeds plus Scope-selected active lenses;
- run a no-barrier lens pipeline where each lens stage performs finder work and
  candidate-scoped verifier fan-out;
- deterministically wrap candidates as runtime-indexed envelopes;
- validate candidate counts, verifier attempts, evidence refs, and final index
  bounds;
- fail closed on missing verifier results, invalid evidence refs, or empty
  evidence-ref arrays in candidates, verifier verdicts, or final findings;
- include source snapshot provenance in the final result and ensure every final
  evidence ref resolves against that snapshot;
- include bounded synthesis decision provenance in the final result so reported,
  merged, dropped, and superseded candidates remain auditable after the run;
- keep all final assembly deterministic inside the script.

Done when:

- built-in `code-review` returns stable JSON with `findings` and `stats`;
- all candidates with failure scenarios are verified or the workflow fails as an
  incomplete review;
- multiple candidates from one finder start multiple verifier agents;
- a candidate from an early finder can verify before a later finder finishes;
- `xhigh` runs Sweep and `high` skips Sweep;
- final synthesis cannot invent file paths, evidence refs, or indexes outside
  verified inputs;
- equivalent candidate indexes with different content or source snapshots do not
  reuse verifier cache entries;
- equivalent candidate indexes under different context hashes, truncation states,
  or allowed-evidence-index digests do not reuse verifier cache entries.

### Step 4: Progress, CLI Projection, And E2E Alignment

Dependency: Step 3.

Work:

- verify plain and JSONL progress show Evidence, Scope, Find, Verify, Sweep, and
  Synthesize clearly;
- ensure dynamic verifier counts are understandable when the initial plan cannot
  know every verifier;
- update completion summary so each phase reports finder count, verifier count,
  lens titles, candidate labels, invalid counts, and truncation warnings;
- add installed E2E coverage for `--name code-review` in JSONL and plain modes,
  using schema-aware fake payloads for Scope, Finder, Verifier, Sweep, and
  Synthesis;
- keep the current `task` E2E coverage so generic planner behavior remains
  protected.

Done when:

- runtime events such as `workflow.phase.planned`, `workflow.phase.started`,
  `workflow.agent.completed`, and `workflow.completed` remain stable for the
  specialized review path;
- CLI JSONL projection records such as `workflow.summary.ready` and
  `workflow.review.recommended` remain stable as CLI projections rather than
  runtime event-union members;
- installed E2E checks cover the shipped `code-review` workflow path in both
  JSONL and plain progress modes;
- installed E2E asserts final stdout JSON shape, candidate-scoped verifier
  counts, invalid-ref failure behavior, and at least one case where a single
  finder emits multiple candidates that become separate verifier agents;
- progress summaries cannot omit dynamic verifier agents merely because they
  were not part of the first phase plan.

### Step 5: Native Skill And Package Docs Alignment

Dependency: Step 3, because shipped runtime behavior should define the concrete
review vocabulary.

Work:

- update `skills/ultracode-for-codex/SKILL.md` at the behavior level: dynamic
  lenses, parallel subagents, candidate verification, and visible progress;
- avoid exposing CLI-only terms as the default native skill contract;
- preserve `$ultracode-for-codex-cli` as the package/runtime path;
- update `README.md`, `ULTRACODE_INSTALL.md`, `IMPLEMENTATION_MAP.html`, package
  validator required text, and installed E2E string assertions after the runtime
  behavior ships;
- update packaged provenance docs, including version references in
  `docs/provenance-audit.md`, whenever package metadata changes;
- add a package validator that compares packaged provenance docs against
  `package.json` version and license metadata, and require
  `docs/provenance-audit.md` in the tarball entry list.

Done when:

- packaged skill guidance and runtime behavior use compatible concepts;
- public docs describe shipped behavior in user terms, not internal cleanup
  terminology;
- `npm run pack:ultracode-for-codex` includes the updated skills and docs;
- package validators fail on stale shipped docs that still describe the old
  generic planner path;
- package validators fail when shipped provenance docs mention stale package
  versions or omit the current package version/license.

### Step 6: Release-Level Verification

Dependency: Steps 1-5.

Work:

- run `npm test`;
- run `npm run test:e2e:ultracode-for-codex`;
- run `npm run pack:ultracode-for-codex`;
- run `npm run publish:dry-run`;
- run live smoke only when explicitly requested or when preparing a release.

Done when:

- source tests, packaged E2E, package contents, and publish dry run are green;
- residual live-smoke risk is stated if live smoke is skipped.

## Review Gates

Use these gates before implementation is considered complete:

| Gate | Checks |
| --- | --- |
| Runtime contract | item-preserving no-barrier pipeline, schema validation, allowed evidence refs, journal ordering, retry/cancel, resume/cache, worktree preservation |
| Review evidence | bounded diff context, deleted/prior content when available, source snapshot id, truncation metadata, path containment |
| Review quality | every candidate verified or fail-closed, refuted filtered, plausible preserved when recall-oriented, duplicates merged only at synthesis |
| Candidate identity | script-assigned indexes, runtime-owned ids/refs, stable logical keys for dynamic verifier agents |
| Visibility | phase plan before each relevant group, cumulative finder/verifier completion, final phase/agent summary |
| Package | `files` payload, skills, install guide, packaged provenance docs, package validator text, and package version surfaces |
| Provenance | current design text remains product-neutral and implementation-owned |

## Open Decisions

1. Default review level.
   Recommended default: `xhigh`, matching packaged Codex reasoning settings.

2. Review evidence helper shape.
   Recommended default: extend `workspaceContext` with `includeDiff` unless that
   makes the helper too broad. Use a dedicated review evidence helper only if it
   makes authority, validation, or tests clearer.

3. Dynamic verifier cache keys.
   Recommended default: add a narrow logical-key contract for built-in dynamic
   agents before claiming no-barrier resume/cache stability.

4. Script size cap.
   Recommended default: keep `64 KiB` until the specialized built-in script
   needs more. If it needs more, raise the cap deliberately and test it.

5. Dynamic verifier phase planning.
   Recommended default: use a planned placeholder for dynamic verifier agents
   and let actual counts grow from runtime events.

6. Public docs timing.
   Recommended default: keep this as an internal design document until the
   specialized review harness ships, then update user-facing docs to describe
   shipped behavior only.
