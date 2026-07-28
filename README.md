# Ultracode for Codex

Durable, schema-enforced, resumable multi-agent workflows for Codex.

Codex Ultra already provides native proactive delegation for ordinary ad-hoc
parallel work. Ultracode adds the workflow guarantees that native delegation
does not make canonical: deterministic scripts, per-agent schemas and tiers,
hash-chained journals, completed-step reuse, background job control, and
permission-reviewed worktree isolation.

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

Looking for the exact interface? [Execution Contract](#execution-contract)
covers every command, flag, `--args` schema, and refusal; [Output
Contract](#output-contract) covers every record, event, and failure shape;
[Built-in Result Payloads](#built-in-result-payloads) covers what each built-in
returns.

## Why Use It

- Make repeated or long-running multi-agent work auditable and recoverable.
- Plan and verify implementation work phase by phase while the main Codex
  context owns edits.
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

Use native Codex Ultra for ordinary one-off work where model-directed
delegation is enough. Use the default Ultracode skill when the work benefits
from durable phase records, schema enforcement, background execution, or
resume/cache guarantees:

```text
$ultracode-for-codex Investigate why the checkout flow drops sessions and propose a fix.
```

Good tasks for the default skill — any work that benefits from parallel
perspectives, for example:

- implementation planning and multi-step investigation;
- architecture or design critique;
- migrations and repository-wide changes;
- research and synthesis across sources;
- code review (also available as the built-in `code-review` workflow);
- release readiness checks and verification.

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

Run the read-only built-in task analysis workflow with the Sol balanced tier:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --model gpt-5.6-sol \
  --reasoning-effort high \
  --name task \
  --args '{"prompt":"review correctness risks and propose fixes"}'
```

Run a code review:

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --cwd /path/to/project \
  --model gpt-5.6-sol \
  --reasoning-effort high \
  --name code-review \
  --args '{"prompt":"review the current change","level":"high"}'
```

The built-in `code-review` workflow collects bounded repository evidence,
chooses review lenses, runs finder agents in parallel, verifies each candidate,
and returns JSON with `level`, `provenance`, `summary`, `findings`, `degraded`,
`synthesis`, and `stats` — the full shape is in
[Built-in Result Payloads](#built-in-result-payloads).
Use `{"level":"high"}` for the Sol medium/high profile: scope runs at
`medium`, while finders, verification, and synthesis run at `high`, and the
final sweep is skipped. `{"level":"xhigh"}` — or omitting `level` — selects the
deeper review, where finders run at `high` and scope/verdict/synthesis run at
`xhigh`.

It reviews the working tree by default. Pass `{"diffBaseRef":"<base>"}` to review
the `<base>..HEAD` commit range instead, which works on a clean tree. The review
refuses to spend an agent when it cannot read the change it is asked to review;
`--validate` reports that verdict for free, before any tokens.

The built-in `task` delegates read-only analysis. Its planner runs at `medium`;
other agents inherit `--reasoning-effort`. The main Codex context applies any
resulting changes. Custom scripts can opt into `isolation: "worktree"`. A completed agent's
worktree is reclaimed when it holds no real changes; one that holds changes is
preserved for explicit review rather than auto-merged. Set
`workflow.worktreeRetention` to `preserve-all` (or `--worktree-retention`) to
keep every worktree.

CLI runs use OS background execution by default. The command prints a launch
record with a `jobId`, then you can inspect or control the job:

```bash
npm exec -- ultracode-for-codex status <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex logs <jobId> --cwd /path/to/project --tail 40
npm exec -- ultracode-for-codex result <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex cancel <jobId> --cwd /path/to/project
```

Runs wait indefinitely by default (timeout `0`). So a long or stuck run stays
visible without a hard deadline, the runtime emits a non-destructive
`workflow.heartbeat` progress event every two minutes with the elapsed time,
current phase, and completed/known agent counts — it never aborts the run.
Tune it with `--heartbeat-ms <n>` (or `workflow.heartbeatMs` in settings); `0`
turns it off.

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

## Execution Contract

Everything the CLI accepts. `run` is the only gated command: it refuses until
`--accept-llm-guide=v1` is passed, printing the install guide first.

### Commands

| command | purpose | positional |
| --- | --- | --- |
| `run` | Run a workflow, attached or in the OS background. | one workflow script file (same as `--script-file`) |
| `status` | Print a background job's status record. | `<jobId>` or a metadata path |
| `wait` | Block until a job reaches a terminal state. | `<jobId>` or a metadata path |
| `logs` | Print a job's progress JSONL. | `<jobId>` or a metadata path |
| `result` | Print a job's result JSON. | `<jobId>` or a metadata path |
| `cancel` | Signal a running job (default `SIGINT`). | `<jobId>` or a metadata path |
| `jobs` / `list` | List background jobs. | — |
| `archive` / `export` | Export one job's state to a single JSON file. | `<jobId>` or a metadata path |
| `skills` | Report whether installed Codex skills match this package; `--install` updates them. | none (rejected) |
| `setup` / `doctor` | Readiness check: package, Codex CLI, app-server, auth, model, effort, skills. | none (rejected) |
| `--version`, `--help`, `--llm-guide` | Print and exit 0. | — |

A positional containing `/`, `\` or ending in `.json` is read as a metadata path,
otherwise as a job id. `--help` and `--version` are recognized **only in command
position**: `run --help` is parsed as an option and hits the install-guide gate.

### Flags

Values are given as `--flag <grammar>`. Five flags are valueless: `--install`,
`--plain`, `--result`, `--wait`, `--validate`. An unknown flag is ignored
silently.

Workflow selection and identity (`run`):

| flag | value | default | notes |
| --- | --- | --- | --- |
| `--accept-llm-guide` | exactly `v1` | required | without it: guide on stdout, refusal on stderr, exit 1 |
| `--name` | built-in or saved workflow name | — | built-ins: `task`, `code-review`, `batch` |
| `--script` | inline JavaScript source | — | |
| `--script-file` | path | — | the positional argument is equivalent |
| `--script-path` | runtime-owned persisted script path | — | surfaced by `[iterate]` and by `status` |
| `--resume-from-run-id` | `run_<uuid>` | — | may be combined with exactly one selector to resume an edited script |
| `--args` | JSON object text | `{}` | per-built-in contract below; on resume, omitting it inherits the source run's args |
| `--args-file` | path to JSON | — | mutually exclusive with `--args` |
| `--validate` | valueless | off | zero-token pre-check; refuses `--resume-from-run-id` |
| `--cwd` | directory | `process.cwd()` | resolved to absolute at parse time |

Execution and reporting (`run`):

| flag | value | default |
| --- | --- | --- |
| `--execution` | `background` \| `attached` | `background` |
| `--progress` | `jsonl` \| `plain` | `jsonl` |
| `--permission` | `ask` \| `allow` \| `deny` | `ask` |
| `--timeout-ms` | integer, `0` = wait forever | `0` |
| `--heartbeat-ms` | integer, `0` = off | `120000` |
| `--retry-limit` | integer ≥ 0 | `0` |
| `--worktree-retention` | `preserve-all` \| `remove-clean` | `remove-clean` |
| `--agent-concurrency` | `unbounded` \| `auto` \| integer ≥ 1 | `unbounded` |
| `--budget` | `500000`, `500k`, `+500k`, `2m` | off — **no settings key** |
| `--model` | Codex model id | Codex default; a resume adopts the source run's model |
| `--reasoning-effort` | `none`\|`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max` | `medium` |
| `--verbosity` | `low` \| `medium` \| `high` | `medium` |
| `--command` | path to the Codex CLI binary | resolved |

Capability gates (`run`) — all default-off, all run-level, and all must be
re-passed on resume except `--agent-types`, which is restored from the journal
because the type name is part of each agent's call key:

| flag | value | default | what it grants |
| --- | --- | --- | --- |
| `--agent-web-search` | `disabled` \| `enabled` | `disabled` | live web search inside an agent's turn |
| `--agent-file-write` | `disabled` \| `enabled` | `disabled` | `write_file`/`str_replace` inside a worktree-isolated agent |
| `--agent-mcp` | comma-separated bare server names | `[]` | the named MCP servers from your Codex config |
| `--agent-types` | `disabled` \| `enabled` | `disabled` | `agent({agentType})` resolving `~/.codex/agents/*.toml` |
| `--nested-workflows` | `disabled` \| `enabled` | `disabled` | `workflow()` inside a workflow (one level) |
| `--evidence-scope` | `default` \| `all` | `default` | `all` forgives only the evidence extension allowlist |
| `--ref-policy` | `strict` \| `lenient` | `strict` | `lenient` drops one unusable candidate instead of failing the run |

Background commands:

| flag | value | applies to | default |
| --- | --- | --- | --- |
| `--job-id` | job id | all job commands | — |
| `--metadata-path` | path | all job commands | — |
| `--result-path`, `--progress-path`, `--pid-path` | path | all job commands | taken from metadata |
| `--tail` | integer ≥ 0, `0` = all | `logs` | all |
| `--event` | exact event name | `logs` | no filter |
| `--interval-ms` | integer ≥ 1 | `wait`, `cancel --wait` | `1000` |
| `--timeout-ms` | integer ≥ 0 | `wait`, `cancel --wait` | `0` |
| `--result` | valueless | `wait` | off |
| `--wait` | valueless | `cancel` | off |
| `--signal` | `SIGINT` \| `SIGTERM` \| `SIGHUP` | `cancel` | `SIGINT` |
| `--out-dir`, `--output-path` | path | `archive` | `<state-root>/archive/<jobId>.json` |
| `--plain` / `--format plain` / `--progress plain` | valueless / `plain` | job commands, `skills`, `setup`, `run --validate` | JSON output |
| `--install` | valueless | `skills` | status only |

### Where defaults come from

Defaults marked above come from **the installed package's own `settings.json`**,
which is the only settings file the runtime reads — there is no project-level or
user-level settings file, no merge, and no environment override of a settings
key. To change a default persistently, edit that file in the installed package;
otherwise pass the flag.

Keys: `workflow.executionMode`, `workflow.progress`, `workflow.permission`,
`workflow.retryLimit`, `workflow.timeoutMs`, `workflow.heartbeatMs`,
`workflow.worktreeRetention`, `workflow.agentConcurrency`,
`workflow.nestedWorkflows`, `workflow.evidenceScope`, `workflow.refPolicy`,
`workflow.agentWebSearch`, `workflow.agentFileWrite`, `workflow.agentTypes`,
`workflow.agentMcp`, `workflow.background.{runDir,resultFile,progressFile,metadataFile,pidFile}`,
`codex.reasoningEffort`, `codex.verbosity`. A malformed file, or a missing
`workflow`, `workflow.background`, or `codex` block, is a hard startup error.

Environment variables:

| variable | effect | default |
| --- | --- | --- |
| `ULTRACODE_FOR_CODEX_HOME` | state root for background runs, per-workspace state, and archives | `~/.ultracode-for-codex` |
| `CODEX_HOME` | Codex home: skills target, `config.toml` and MCP sections, `agents/*.toml` | `~/.codex` |

Direct-provider credentials (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and the
equivalent `*_API_KEY` / `*_BASE_URL` / `*_ORG_ID` shapes for a dozen providers)
are **stripped** from the Codex child process environment. Everything else is
inherited.

### Not every flag fails fast

A background launch reports success immediately, so flags the parent does not
own are validated only in the detached child. The difference is observable:

```bash
# Parent-validated: rejected before anything runs.
$ ... run --worktree-retention bogus ...
worktree-retention must be one of preserve-all, remove-clean.   # exit 1

# Child-validated: the launch "succeeds", then the child dies.
$ ... run --reasoning-effort bogus ...
{ "kind": "ultracode.workflow.background", "status": "launched", ... }   # exit 0
```

In the second case `result.json` is 0 bytes, `progress.jsonl` holds the raw
error text instead of an event, `status` reports `exited_unknown`, and `result`
exits `2`. Validated in the parent: `--worktree-retention`,
`--agent-concurrency`, `--nested-workflows`, `--evidence-scope`, `--ref-policy`,
`--agent-web-search`, `--agent-file-write`, `--agent-mcp`, `--budget`,
`--progress`, `--execution`, `--args`, the selectors, and the resume source.
Validated only in the child: `--reasoning-effort`, `--verbosity`,
`--retry-limit`, `--heartbeat-ms`, `--permission`, `--agent-types`, `--model`.
Use `--execution attached`, or `--validate` first, when a value is uncertain.

### `--args` per built-in

Unknown keys, wrong types, and unresolvable refs are rejected **before any agent
runs**, on launch, on `--validate`, on resume, and for a nested child. Every
rejection names the rejected value, the cause, and the remediation. No key is
required; omitting one takes the built-in's default.

`code-review`:

| key | type | default | rejected when |
| --- | --- | --- | --- |
| `prompt` | non-empty string | a built-in review prompt | empty, whitespace-only, or not a string |
| `level` | `high` \| `xhigh` (case-insensitive) | `xhigh` | any other value |
| `diffBaseRef` | commit-ish | none (working tree only) | `git rev-parse --verify <ref>^{commit}` fails in `--cwd` |

`task`:

| key | type | default |
| --- | --- | --- |
| `prompt` | non-empty string | a built-in analysis prompt |

`batch`:

| key | type | default |
| --- | --- | --- |
| `prompts` | array of non-empty strings | `[]` (no agents) |

An unknown key is reported with the nearest accepted key: a miscased key, a
prefix (`diffBase` → `diffBaseRef`), or a small typo (`promt` → `prompt`).

### Preconditions and refusals

- **Install guide.** `run` without `--accept-llm-guide=v1` prints the guide and
  refuses.
- **One selector.** At most one of `--script`, `--script-file` (or the
  positional), `--script-path`, `--name`. At least one, unless
  `--resume-from-run-id` is given.
- **Resume shapes.** `--resume-from-run-id` alone resumes the source script.
  With exactly one selector it resumes an *edited* script: the unchanged chained
  prefix reuses cached agent results, the first edit and everything downstream
  run live. A selector supplied with a resume must not be empty.
- **`--validate` refuses a resume** — it validates a launch, not a replay.
- **Cross-policy replay is refused.** A resume whose source run executed under a
  different `--ref-policy`, and a `--script-path` launch of a persisted built-in
  generated under a different policy, are both refused: the policy is baked into
  the script text, so running it under another policy would execute one policy
  while reporting the other. Both refusals name the policy to pass instead.
- **A non-default `--ref-policy` is announced, not confirmed.** Built-ins are
  not permission-gated, so there is no prompt to carry it: the resolved policy
  is announced at launch instead (as a plain line, or as a `workflow.notice`
  event when stderr carries JSONL).
- **Permission review needs a terminal.** With the default `--permission ask`
  and no TTY, a workflow requiring review refuses; pass `allow` or `deny`.
- **`code-review` needs readable change evidence.** It fails before spending an
  agent when nothing in the working tree (or in a `diffBaseRef` range) produces
  evidence the reviewer can actually read. Check first with `--validate`, which
  reports the gate verdict, the citable refs, and every dropped path with the
  rule that dropped it.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | success; a completed workflow; an accepted background launch |
| `1` | refusal, invalid input, unknown command, a failed workflow or job, `setup` not ready |
| `2` | `result` (or `wait --result`) found no result yet and the job has not failed |
| `124` | `wait` or `cancel --wait` hit `--timeout-ms` |
| `130` | the run was cancelled (`workflow_aborted`) |

## Output Contract

Two channels, and they never mix roles: **stdout carries the answer**, **stderr
carries progress**. In background mode the detached child's stdout *is*
`result.json` and its stderr *is* `progress.jsonl`.

### Records on stdout

Every record is pretty-printed JSON with `kind` and `version`, except where noted.

| `kind` | written by | key fields |
| --- | --- | --- |
| `ultracode.workflow.background` | `run --execution background` | `status: "launched"`, `jobId`, `pid`, `resultPath`, `progressPath`, `metadataPath`, `pidPath` |
| `ultracode.workflow.background.status` | `status`, `wait` | `status: running \| completed \| failed \| exited_unknown`, `jobId`, `runId`, `pid`, `alive`, `resultReady`, `progressEventCount`, `malformedProgressLineCount`, `lastEvent`, `lastSummary`, `reason`, `error`, `completedAgentCount`, `knownAgentCount`, `phase`, `elapsedMs`; `waitTimedOut`/`waitTimeoutMs` on a `wait` timeout |
| `ultracode.workflow.background.jobs` | `jobs`, `list` | `cwd`, `backgroundRoot`, `count`, `jobs[]` (a full status record each, newest first), `invalidJobs[]` |
| `ultracode.workflow.background.cancel` | `cancel` | `status: signalled \| not_running \| identity_mismatch`, `jobId`, `pid`, `signal`, `identityVerified`, `processCommandLine` |
| `ultracode.workflow.background.cancel.wait` | `cancel --wait` | `cancel` (the record above), `terminalStatus` (a status record), `waitTimedOut` |
| `ultracode.workflow.background.archive.created` | `archive`, `export` | `jobId`, `archivePath`, `status`, `progressEventCount` |
| `ultracode.workflow.background.archive` | the file `archive` writes | `archivedAt`, `status` (full record), `metadata`, `progressEvents[]`, `malformedProgressLineCount`, `resultText` |
| `ultracode.workflow.validate` | `run --validate` | `status: "valid"`, `workflowName`, `workflowSource`, `scriptHash`, `agentCallSites`, `schemaCallSites`, `keyedCallSites`, `warnings[]`, and `evidence` for a change-evidence built-in |
| `ultracode.workflow.failure` | a failed `run`; a failed job's `result.json` | `status: "failed"`, `failure.reason`, `failure.error`, `failure.workflowName`, `failure.taskId`, `failure.runId`, `failure.phase`, `failure.agentsCompleted` |
| `ultracode.setup` | `setup`, `doctor` | **`version: 2`** — `ready`, `packageVersion`, `nodeVersion`, `codex{command,installed,version,appServerReachable}`, `auth{checked,loggedIn,method,account,requiresOpenaiAuth}`, `model{catalogChecked,selected,reasoningEffort,reasoningEffortSupported,supportedReasoningEfforts[]}`, `detail`, `codexSkillsRoot`, `skills[{name,state}]` |
| `ultracode.skills` | `skills` | `action: install \| status`, `packageVersion`, `codexSkillsRoot`, `skills[{name,state}]` |

Three commands print no wrapper at all:

- **A completed `run`** prints the workflow's result payload itself — no `kind`,
  no envelope. The same bytes become `result.json`.
- **`result`** prints `result.json` verbatim.
- **`logs`** prints the stored progress records verbatim, one per line.

`--validate`'s `evidence` block is `{ gated, allowedFileRefs, allowedEvidenceRefs[], reason?, dropped[{path, rule}] }`.
Read `evidence.gated`, not the top-level `status`: `status: "valid"` answers *is the
request well-formed*, and a well-formed request can still be gated.

### Progress events on stderr

Every line is `{"kind":"ultracode.workflow.progress","version":1,"event":…,"status":…,"summary":…}`
plus the per-event fields below. All events carry `taskId` and `runId` except
`workflow.notice`, which is emitted before the run exists.

| event | status | added fields |
| --- | --- | --- |
| `workflow.notice` | `notice` | — (launch-time notice: a non-default `--ref-policy`, agent-type registry warnings) |
| `workflow.permission.required` | `waiting_for_permission` | `permissionRequestId`, `workflowName`, `workflowSource`, `scriptHash`, `riskSummary`, `phases[]`, `requestedIsolationModes[]` |
| `workflow.started` | `running` | `workflowName`, `workflowSource`, `workflowSourcePath`, `scriptHash` |
| `workflow.plan.ready` | `planned` | `mode`, `rationale`, `phaseCount`, `planPhases[]` |
| `workflow.phase.planned` | `planned` | `phaseIndex`, `title`, `goal`, `plannedAgentCount`, `plannedAgents[]` |
| `workflow.phase.started` | `running` | `phaseIndex`, `title`, `detail`, `goal`, `plannedAgentCount`, `plannedAgents[]` |
| `workflow.log` | `running` | `message` |
| `workflow.heartbeat` | `running` | `elapsedMs`, `phase`, `completedAgentCount`, `knownAgentCount`, `seq` |
| `workflow.agent.started` | `running` | `agentIndex`, `agentId`, `label`, `phase`, `promptPreview` |
| `workflow.agent.completed` | `completed` | `agentIndex`, `agentId`, `label`, `phase`, `tokens`, `toolCalls`, `resultPreview`, `cached`, `elapsedMs`, `completedAgentCount`, `knownAgentCount`, `phaseCompletedAgentCount`, `phaseKnownAgentCount`, `worktreePreserved`, `preservedWorktrees[]` |
| `workflow.agent.failed` | `failed` | `agentIndex`, `agentId`, `label`, `phase`, `error`, `worktreePreserved`, `preservedWorktrees[]` |
| `workflow.completed` | `completed` | `resultPath`, `agentCount`, `tokens`, `toolCalls`, `durationMs` |
| `workflow.failed` | `failed` | `error`, `reason`, `retryable` |
| `workflow.terminal_failure` | `failed` | `workflowName`, `reason`, `error` |
| `workflow.retrying` | `retrying` | `workflowName`, `retryIndex`, `retryLimit` |
| `workflow.summary.ready` | `completed` | `workflowName`, `phasesSummary[]`, `totalPhaseCount`, `totalPlannedAgentCount` |
| `workflow.review.recommended` | `review_recommended` | `workflowName`, `recommendation` |
| `workflow.cancel.requested` | `cancelling` | `workflowName`, `signal` |
| `workflow.cancel.already_requested` | `cancelling` | `workflowName`, `signal` |
| `workflow.cancel.failed` | `failed` | `workflowName`, `error` |

A `cached: true` agent completion is a resume-cache hit: it reports zero tokens
because nothing was spent.

### Event ordering

- `workflow.notice` precedes everything; `workflow.permission.required` precedes
  `workflow.started`.
- `workflow.started` is the first event of **every attempt** — a retry emits a new
  one with a new `taskId` and `runId`.
- Success: `workflow.completed` → `workflow.summary.ready` →
  `workflow.review.recommended`. The last two are post-terminal guidance, which is
  why `status` reports `lastEvent: "workflow.completed"` for a completed job.
- Failure: `workflow.failed` → `workflow.terminal_failure`. No summary events.
- Retry: `workflow.failed` → `workflow.terminal_failure` → `workflow.retrying` →
  a fresh `workflow.started`. **`workflow.terminal_failure` is emitted per failed
  attempt, not per terminal run** — treat it as terminal only when it is the newest
  status event.
- Cancel: `workflow.cancel.requested` → `workflow.failed` (reason
  `workflow_aborted`) → `workflow.terminal_failure`.
- The runtime drops any of its own events after its terminal event; only the
  CLI-layer events above append after it.
- Permission review applies to `script_path`, `project`, `user`, and `plugin`
  sources only. An inline `--script` and a built-in `--name` are never gated, so
  they never emit `workflow.permission.required`.

### Plain mode

`--progress plain` replaces the run's stderr JSONL with readable lines:
`[workflow]`, `[plan]`, `[phase-plan]`, `[phase]`, `[agent:N]`, `[log]`,
`[heartbeat]`, `[workflow-summary]`, `[review-recommendation]`, `[permission]`,
and `[iterate]` — the last one printing the persisted script path and the exact
`--resume-from-run-id` command to re-run an edited copy. It is plain-mode only.

`--plain` (or `--format plain`) switches the *inspection* commands to
`[validate]`, `[job]`, `[jobs]`, `[cancel]`, `[archive]`, `[skills]`, `[setup]`
lines on stdout. It does not change a `run`'s stdout, which is always the result.

### Failure output

A job's `result.json` has two shapes, and consumers must branch on `kind`:

```json
{ "ok": true }                                                    // completed: the payload itself
{ "kind": "ultracode.workflow.failure", "version": 1,             // failed: an envelope
  "status": "failed",
  "failure": { "reason": "workflow_failed", "error": "boom", ... } }
```

A cancelled run produces the envelope with `reason: "workflow_aborted"`.

| `failure.reason` | meaning | retryable |
| --- | --- | --- |
| `workflow_failed` | any uncoded throw out of the script or backend | yes |
| `workflow_agent_failed` | transient or rate-limited subagent failure | yes |
| `workflow_agent_stalled` | an agent exceeded the stall timeout | yes |
| `workflow_journal_write_failed` | a journal append failed | yes |
| `workflow_structured_output_failed` | schema-constrained output could not be produced | yes |
| `workflow_agent_terminal` | terminal subagent failure: auth, bad request, config | no |
| `workflow_aborted` | cancelled (exit `130`) | no |
| `runtime_closed` | the runtime closed while the task was running | no |
| `workflow_input_invalid` | invalid request, unknown run id, agent-call cap, budget exhausted, bad resume source | no |
| `workflow_meta_invalid` | the script's `meta` block is invalid | no |
| `workflow_script_nondeterministic` | a banned construct in the script | no |
| `workflow_permission_denied` | permission review denied | no |
| `workflow_resume_running` | the resume source is still live | no |
| `workflow_timer_callback_failed` | a `setTimeout` callback threw | no |
| `workflow_promise_rejected` | an unhandled rejection of a workflow promise | no |

`--retry-limit` retries only the retryable reasons, and each retry resumes the
failed attempt instead of re-running finished agents.

### Background job files

Under `<state-root>/background/<jobId>/`, directory `0700`, files `0600`:

| file | contents | settings key |
| --- | --- | --- |
| `result.json` | the result payload, or the failure envelope | `workflow.background.resultFile` |
| `progress.jsonl` | one progress record per line (the child is always launched with `--progress jsonl`) | `workflow.background.progressFile` |
| `metadata.json` | the launch record plus `launchedAt`, `cwd`, the four paths, `nodePath`, `cliEntryPath`, `commandLineHint` | `workflow.background.metadataFile` |
| `pid` | the decimal pid and a newline | `workflow.background.pidFile` |

`nodePath` and `cliEntryPath` are the identity check `cancel` performs before
signalling: if the live pid's command line does not match, it reports
`identity_mismatch` and sends nothing.

### The run journal

`<state-root>/workspaces/<label>-<hash>/subagents/workflows/<runId>/journal.jsonl`,
append-only and hash-chained. Every entry carries `version`, `seq`,
`previousEntryHash`, `entryHash`, `recordedAt`, `taskId`, `runId`, `kind`.

| entry kind | load-bearing fields |
| --- | --- |
| `workflow.run.started` | `workflowName`, `workflowSource`, `scriptPath`, `scriptHash`, `args`, `runtime{cwd, model, workspaceFingerprint, refPolicy}` — always `seq 1` |
| `workflow.agent.started` | `agentIndex`, `agentId`, `previousAgentCallKey`, `agentCallKey`, `prompt`, `promptBounded`, `semanticOpts` |
| `workflow.agent.completed` | `agentCallKey`, `result` (what a resume replays), `usage`, `toolCalls` |
| `workflow.agent.failed` | `agentCallKey`, `reason`, `message` |
| `workflow.run.completed` | `result`, `resultPath`, `agentCount`, `usage`, `toolCalls`, `durationMs` |
| `workflow.run.failed` | `reason`, `message`, `durationMs` |

The journal is validated on write **and** on read: unknown fields, a `seq` gap, a
broken hash chain, an entry after a terminal entry, a duplicate agent id or call
key, and a prompt that no longer derives its recorded call key are all rejected.
That is what makes a resume trustworthy — and it is why a journal written by this
version needs this version or newer to read.

## Built-in Result Payloads

What `run --name <built-in>` returns on stdout (and writes to `result.json`).

### `task`

A **string**: the final agent's text. The workflow plans internally — single-agent
or phase-parallel with a synthesis agent — but neither path wraps the result.

### `batch`

An **array of strings**, one per prompt, in input order. An entry is `null` when
that item failed, so a caller must treat `null` as failure rather than as content.

### `code-review`

An object. `level`, `provenance`, `summary`, `findings`, `degraded`, `synthesis`,
and `stats` are always present.

| field | type | notes |
| --- | --- | --- |
| `level` | `"high" \| "xhigh"` | the resolved level |
| `provenance.sourceSnapshotId` | string | `git:<sha>:sha256:<hex>` |
| `provenance.contextHash` | string | `sha256:<hex>` |
| `provenance.allowedEvidenceIndexDigest` | string | `sha256:<hex>` |
| `provenance.diffBaseRef` | string \| null | `null` when no range was reviewed |
| `provenance.truncation` | `{raw: string}` | a **stringified** JSON object, not parsed |
| `summary` | string | when nothing survived a drop, it says so explicitly rather than reading clean |
| `findings[]` | array | one entry per reported decision; `[]` is a legitimate clean result |
| `findings[].candidateId`, `.candidateDigest` | string | stable identity of the candidate |
| `findings[].severity` | `P0 \| P1 \| P2 \| P3` | |
| `findings[].file`, `.line` | string, integer \| null | workspace-relative |
| `findings[].summary`, `.failureScenario`, `.evidence` | string | the claim, the failure path, the verifier's reasoning |
| `findings[].verdict` | `CONFIRMED \| PLAUSIBLE` | a refuted candidate never becomes a finding |
| `findings[].evidenceRefs[]` | string, ≥1 | `file:<path>`, `diff:<kind>:<path>`, or `hunk:<kind>:<path>:<n>` — every ref exists in the evidence index |
| `findings[].lens` | `{key, title}` | which review lens found it |
| `findings[].synthesisDecision` | `{action, reasonCategory, reason, mergeCandidates[]}` | why it was reported |
| `degraded` | object \| null | `null` unless a ref drop happened, so it is always `null` under `--ref-policy strict` |
| `degraded.refDrops` | integer | total drops |
| `degraded.entries[]` | array | first 20 drops; `truncated` says whether more exist |
| `degraded.entries[].subject` | `scope_file \| candidate \| verifier_result` | **which lifecycle event happened** — scope narrowing is not a rejected candidate |
| `degraded.entries[].stage`, `.label`, `.reason` | string | where it dropped and why |
| `degraded.entries[].dropped` | `{candidateId, file, claim}` | a bounded projection of what was lost, so the omission is judgeable |
| `synthesis.mode` | `agent \| script_fallback` | `script_fallback` means the synthesis agent's output was not usable |
| `synthesis.fallbackReason` | string \| null | `null` only when mode is `agent` |
| `synthesis.decisions[]` | array | one row per candidate decision, plus one per candidate-lifecycle ref drop (`droppedSubject`, `droppedFile`, `droppedClaim`) |
| `stats.finders`, `.candidates`, `.verified`, `.refuted`, `.reported` | integer | pipeline counters |
| `stats.verifierAttempts` | integer | includes cached attempts, so it is not a spend figure |
| `stats.normalizedRefs` | integer | refs repaired by grammar normalization |
| `stats.refDrops` | integer | all drops — the authoritative count |
| `stats.dropped` | `{duplicate, notMaterial, reportCap, unsupportedEvidence, superseded}` | `unsupportedEvidence` counts candidate-lifecycle drops only, so it can be lower than `refDrops` |

**Reading a `code-review` result safely:** `findings: []` alone does not mean
clean. Check `stats.refDrops` and `degraded` first — under `--ref-policy lenient`
a review can complete having dropped a candidate. A run where *everything*
dropped fails instead of returning empty, so a degraded review can never present
as a clean one.

Vocabularies used above: severity `P0`–`P3`; verdict `CONFIRMED`, `PLAUSIBLE`,
`REFUTED`; decision action `report`, `merge`, `drop`; `reasonCategory` `material`,
`duplicate`, `not_material`, `report_cap`, `unsupported_evidence`, `superseded`;
synthesis mode `agent`, `script_fallback`; drop subject `scope_file`, `candidate`,
`verifier_result`.

## Workflow Script Contract

`ultracode-for-codex --llm-guide` prints the authoritative authoring guide, and
`run` refuses until you acknowledge it. This section is the reference summary; the
guide is the contract.

### Globals

| global | signature | returns |
| --- | --- | --- |
| `agent` | `(prompt, options?)` | the agent's text, or the validated value when `schema` is passed |
| `parallel` | `(items)` | results in input order; a failed item is `null` |
| `pipeline` | `(items, ...stages)` | one result per item; each stage receives `(prev, originalItem, index)` |
| `workflow` | `(nameOrRef, args?)` | a nested child's result — requires `--nested-workflows`, one level deep |
| `workspaceContext` | `(options?)` | bounded repository context as **text** |
| `phase` | `(title)` | — emits a phase event |
| `announcePlan`, `announcePhasePlan` | `(plan)` | — emit the plan events the skill renders |
| `log`, `console.log/warn/error` | `(message)` | — emits a log event; never throws |
| `hash` | `(jsonValue)` | `sha256:<hex>` |
| `args` | value | the launch `args`, frozen |
| `budget` | object | `total`, `spent()`, `remaining()`, `maxAgentCalls`, `maxParallelism`, `agentConcurrency` |
| `setTimeout`, `clearTimeout` | | tracked timers |

`Date`, `Math.random`, `eval`, `Function`, `require`, `process`, and `globalThis`
are unavailable and statically rejected — scripts must be deterministic. Declaring
your own `async function` is also rejected; the body is already async, so use
top-level `await`.

### `agent()` options and the resume call key

A resume reuses a cached agent result only when its **call key** matches, so
knowing which options are in the key is the difference between a resume that
reuses work and one that re-runs it.

| option | values | in the call key |
| --- | --- | --- |
| the prompt | non-empty string | **yes** — always the full prompt |
| `schema` | JSON Schema subset | **yes** |
| `model` | model id | **yes** |
| `effort` | `none`…`max` | **yes** |
| `isolation` | `"worktree"` | **yes** |
| `agentType` | a registered type name | **yes** (the name) |
| `key` | `^[A-Za-z0-9_.:/@+-]+$`, ≤160 chars | **yes** — and it makes reuse position-independent |
| `label`, `phase` | string | no — display only |

Without `key`, keys chain positionally: inserting an agent invalidates the cache
for everything after it. With `key`, an unchanged call can reuse its result even
after a reorder.

### `meta`

`export const meta = { … }` must be the first statement and a **pure literal** —
no calls, no spreads, no computed keys, no template literals, no parentheses.
`name` is required; `description` is optional; `phases[]` entries need a `title`
and may carry a `detail`, which is what `phase(title)` displays. Scripts are
capped at 64 KiB.

### `workspaceContext()` text

Options: `query`, `files[]`, `includeDiff`, `diffBaseRef`, `maxFiles` (24),
`maxFileBytes` (12,000), `maxBytes` (80,000), `maxDiffBytes` (60,000). Out-of-range
values are clamped rather than rejected.

The returned text has a fixed section order, and scripts parse it by these exact
headings: `## Workspace Context`, `Root:`, then — only with `includeDiff: true` —
`Source Snapshot:`, `Context Hash:`, `evidenceGate:`, `evidenceGateReason:`,
`### Change Evidence` (whose body runs `sourceSnapshotId:`, `contextHash:`,
`allowedEvidenceIndexDigest:`, `diffBaseRef:`, `truncation:`, `evidenceScope:`,
`#### Evidence Ref Grammar`, `#### Changed Files`, `#### Dropped From Evidence`,
`#### Unstaged Diff`, `#### Staged Diff`, `#### Committed Diff`),
`### Allowed Evidence Refs`, `### Unavailable Evidence`, then `### Git Status` and
`### Included Files`.

### Caps and failure semantics

- 1000 agent calls per run; 16 concurrent items in `parallel`/`pipeline`; 4096
  items per call (exceeding it is an error, never a silent truncation).
- `parallel`: a thrown item becomes `null` and the run continues — **check for
  `null` and fail closed.**
- `pipeline`: only a *throwing* stage drops its item to `null`. A stage returning
  `null` or `undefined` passes that value on as the next stage's input.
- An agent that stalls is retried up to five times; its worktree is preserved.
- Catchable: input errors, script errors, structured-output failures, coded agent
  failures. **Not** catchable: a journal write failure and a throwing
  `setTimeout` callback — both fail the run.
- After cancellation `agent()` returns `null`, `log()` no-ops, and `phase()` and
  `workspaceContext()` throw.

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
workspace itself. Three directories live there: `background/<jobId>/` per job,
`workspaces/<label>-<hash>/` per project (journals, transcripts, persisted
scripts), and `archive/` for anything `archive` exports.

**Nothing prunes it.** There is no cleanup command: every background run leaves
its job directory behind, so the state root grows without bound and stays until
you delete it. A resume needs the source run's journal, so delete by age rather
than wholesale if you still want to recover recent work.

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
