# Ultracode P10 — Agent Type (PG-AGENTTYPE), v1

Status: design (2026-07-16). Branch `parity/pg-agenttype` off `main@ba7f7f7`.
Owner-approved concept: **Option A (native-faithful)**.

## 1. Goal & native contract

Native Workflow `agent(prompt, {agentType})` selects a **registered subagent type** from the same
registry as the Agent tool; each type carries a model, reasoning effort, a tool profile, and a
system prompt (persona), and it **composes with `schema`** (the type's system prompt gets a
StructuredOutput instruction appended). Today in this runtime `agentType` is **inert**: 0 runtime
reads, not in `AgentOptions`, only reserved in the journal validator allow-list
(`workflow-journal.ts:615,617`) and in `WorkflowAgentSemanticOpts.agentType` (`:19`) which the
builder never emits (`workflow-runtime.ts:6700`).

### Premise correction (probed the real registry)

The parity roadmap assumed `agentType` = a per-agent `{web, file-write, MCP}` capability profile.
**That is false against the real backend.** The native Codex agent registry is
`~/.codex/agents/*.toml` (the owner already has `reviewer`, `workhorse`, `frontier`, `sweep`) with
schema:

```toml
name = "reviewer"
description = "..."
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """ ...persona... """
```

i.e. **model + effort + sandbox + persona**, *not* web/mcp toggles (those are this project's
run-level extensions, absent from native agent defs). Owner picked Option A: honor the native
registry.

## 2. Concept

**Agent type = a named model/effort/persona bundle resolved from the user's `~/.codex/agents/NAME.toml`.**
`agent(prompt, {agentType: 'reviewer'})` resolves that file and applies, **for that one agent call
only**: the type's `model`, `model_reasoning_effort`, and `developer_instructions` (persona).
`no agentType` → unchanged (byte-identical to today).

Persona injection is the genuinely-new capability: today `thread/start.developerInstructions` is a
fixed string (`subagent-backend.ts:473-475`); the type lets the workflow author give a specific
agent a specific persona, exactly as native does.

### v1 scope (smallest viable, native-faithful)

Applied per agent: **model, effort, persona (`developer_instructions`)**. Explicit
`opts.model`/`opts.effort` on the call still win over the type's (author's explicit choice > type
default > run/global default).

### Deferred (documented, NOT built in v1)

- **`sandbox_mode`** — NOT read in v1. Writes remain gated by `isolation:'worktree'` +
  `--agent-file-write` exactly as today. Consequence, by construction: a read-only agent type
  **cannot accidentally gain write** (writes require an explicit `isolation:'worktree'` on the call
  + the file-write run gate), and a `workspace-write` agent type **cannot bypass** the file-write
  gate. So non-application is *safe*, never a silent authority widening. (Follow-on: let a type
  force read-only, and let `workspace-write` request the write tools within the run's file-write
  grant.)
- **Per-type web/mcp** — web search and MCP stay **run-level** (`--agent-web-search`, `--agent-mcp`
  apply to every agent). Native agent defs don't express these, so there is nothing to port; a
  future extension could add per-type narrowing within the run grant.
- **`description`** — parsed-and-ignored (registry metadata; no consumer). Not surfaced.

## 3. Architecture & data flow

The runtime is backend-neutral; the registry (`~/.codex/agents`, TOML, persona) is Codex-adjacent.
Layering keeps the file location + parsing in `codex/`, hands the runtime a **backend-neutral map**,
and threads only the resolved persona to the backend via the request.

```
CLI (--agent-types on)
  └─ loadAgentTypeRegistry(~/.codex/agents)  →  Map<name, ResolvedAgentType>   [once, at startup]
        (ResolvedAgentType = { name, model?, effort?, developerInstructions? })   ← backend-neutral
  └─ pass map into WorkflowTaskRegistry({ agentTypes })

runAgent(ctx, prompt, {agentType})                                       [workflow-runtime.ts]
  ├─ gate off  → workflowInputError('agentType requires --agent-types')   (fail-loud, opt-in)
  ├─ name ∉ map → workflowInputError('unknown agent type "<name>"')       (fail-loud)
  ├─ resolved = map.get(name)
  ├─ effort = normalizeAgentEffort(opts.effort) ?? resolved.effort ?? default   ← explicit wins
  ├─ model  = normalizeAgentModel(opts.model)  ?? resolved.model  ?? ctx.model  ← explicit wins
  ├─ semanticOpts = { model, effort, schema, isolation, agentType: name, logicalKey }  ← name in KEY
  ├─ computeWorkflowAgentCallKey(...)                                     ← per-agent → resume-correct
  └─ dispatch: agentRequest({ ..., developerInstructions: resolved.developerInstructions })
                 → SubagentRequest.developerInstructions?                 [runtime/types.ts]

CodexSubagentBackend.generate(request)                                   [subagent-backend.ts]
  └─ startThread(..., personaInstructions = request.developerInstructions)
       developerInstructions =
         persona ? `${persona}\n\n${returnContractLine(structured)}`      ← persona + our contract
                 : returnContractLine(structured)                         ← unchanged when absent
```

`returnContractLine(structured)` = the two existing fixed strings
(`'Return exactly one JSON value matching the provided outputSchema.'` /
`'Return exactly the raw result text for the workflow script.'`). Appending our return-contract to
the persona = native's "system prompt + StructuredOutput appended", and it preserves the
workflow return-value contract regardless of persona.

### Registry read location

The map is built from the **user's real Codex home** (`$CODEX_HOME/agents` or `~/.codex/agents`),
resolved at CLI startup — **not** the subagent's isolated home (which is ephemeral and has no
`agents/`). This mirrors how `--agent-mcp` reads the real `~/.codex/config.toml`.

## 4. Contracts & decisions

> Revised 2026-07-16 after adversarial design-verify (findings F1–F9, all re-verified against code).

- **D1 — Call key + resume.** `agentType` name is emitted into `WorkflowAgentSemanticOpts` and thus
  into the agent call key (`computeWorkflowAgentCallKey` hashes `stableJson(semanticOpts)`). Required
  because the type is **per-agent**: two otherwise-identical calls differing only by type must get
  distinct keys. The **resolved** model/effort also enter `semanticOpts.model`/`.effort` (already
  keyed). **[F1 fix]** Unlike the run-level gates (web/file/mcp, *not* in the key → resume degrades
  gracefully), `agentType` **is** key-affecting, so resume must **restore** it, not rely on the user
  re-typing `--agent-types`: on resume the CLI scans the source journal for any
  `semanticOpts.agentType` (a new `usesAgentTypes` on the resume source info) and **auto-enables the
  gate + loads the registry** (mirrors `resolveResumeBackendModel`). This needs **no journal shape
  change** (byte-identical preserved). **[F6] Drift asymmetry (documented):** with an *unchanged*
  registry a typed resume replays faithfully (keys match); editing a type's `model`/
  `model_reasoning_effort` between runs changes that agent's identity → cache **miss** → that agent
  and (via the hash chain) every later non-`key()` agent **re-dispatch** (real spend) — exactly like
  editing the script; editing only `developer_instructions` does **not** bust the key (persona
  content isn't keyed) → the recorded result is replayed. Deleting a used type file → unknown-name at
  re-resolution. All are script-edit-class, not corruption.
- **D2 — Gate & fail-loud.** `workflow.agentTypes` / `--agent-types` (`disabled` | `enabled`,
  default `disabled`). Gate off + a script uses `agentType` on a **fresh** run → `workflowInputError`
  (opt-in, fail-loud; a cached resume auto-restores per D1 so it never mid-run-aborts). Gate off + no
  script use → **byte-identical** to today, held by three properties (F-verify): the semanticOpts
  builder uses conditional-spread so `agentType` is absent when unset; the gate is **not** written to
  `run.started.runtime`; the registry is **not read** when the flag is off.
- **D3 — Precedence + boundary validation.** Explicit `opts.model`/`opts.effort` > type's >
  run/global default (an author writing `{agentType:'sweep', effort:'high'}` wants sweep's
  persona/model at high effort). **[F2 fix — authority invariant]** the type's `model`/`effort` are
  **validated at use-time through the same normalizers as `opts`**: `isReasoningEffort` (rejects
  `ultra` — banned because it escapes this runtime's journal/cache/cost accounting, `types.ts:1-3` —
  and every non-member) and the `normalizeAgentModel` checks (non-empty, not the reserved
  `SUBAGENT_MODEL_PLACEHOLDER`). A `frontier.toml` with `model_reasoning_effort = "ultra"` used by a
  call → `workflowInputError` naming the type; it must never reach dispatch.
- **D4 — Lenient load, use-time validation.** **[F3 fix]** The registry loads **leniently**: per
  file, extract only the known string scalars we consume (`model`, `model_reasoning_effort`,
  `developer_instructions`); **ignore** unknown keys, `[sections]`, arrays, and non-string scalars
  (Codex owns and evolves these files — an unrelated/unsupported construct must not brick a run). A
  file that fails to parse is **skipped** (one-line stderr note), never a startup abort. **All
  validation is at use-time**: an `agentType` naming a missing/unloadable/invalid type →
  `workflowInputError` naming it, so only a run that *uses* the bad type fails (blast radius = the
  type asked for, not every `--agent-types` run). Empty/absent `~/.codex/agents` → empty map → any
  use errors as "unknown".
- **D5 — Lookup-token safety.** Map key = the **filename stem** (`reviewer.toml` → `reviewer`),
  matching the native lookup (`agentType:'reviewer'`); the in-file `name` is metadata (not the key,
  no collision by construction — one file per stem). **[F5 fix]** The script-supplied `agentType`
  value is a **map lookup token**, not concatenated into a live path (the map is built by directory
  enumeration), so a bad token (`../x`, `a/b`) simply misses the map → unknown-name error. The safe
  pattern (`^[A-Za-z0-9_.-]+$`) still validates the token to reject hostile input early; it is *not*
  a path-traversal defense (there is no path construction from the token).
- **D6 — Persona handling.** Only the type **name** enters `semanticOpts` (journaled); the persona
  **content** rides `SubagentRequest.developerInstructions` (not journaled — dodges the journal's
  `MAX_STRING_BYTES` path). We cap the raw file read (64 KiB/file) against pathological input. **[F9]
  Shape note:** a persona authored for a structured return (e.g. reviewer's "Return status,
  findings…") yields raw text unless the call passes `schema`; pair such types with `schema`.

## 5. Default-off / reversibility

Off by construction: `agentTypes` map is empty/undefined unless `--agent-types` is passed; `runAgent`
only consults it when `options.agentType` is set; `agentRequest`/`startThread` only diverge when
`developerInstructions` is present. With the gate off and no `agentType` in scripts, every code path
is the current one — the suite proves byte-identical dispatch.

## 6. Files to touch

- **NEW `src/codex/agent-type-registry.ts`** — lenient scalar-TOML parser (top-level `key = "value"`,
  basic + `"""multiline"""` strings; trims the leading newline after `"""`, CRLF-safe, `#` comments
  outside strings, ignores unknown/section/array/non-string constructs; the existing
  `parseTomlTableHeader` handles *section* headers only) + `loadAgentTypeRegistry(dir): Map<string,
  ResolvedAgentType>` keyed by filename stem, per-file skip-on-parse-fail. Registry dir =
  `join(codexSourceHome(), 'agents')` (**[F7] reuse `codexSourceHome()`** from `model-catalog.ts`).
- `src/runtime/types.ts` — `AgentTypes` gate type + `isAgentTypes` guard; `ResolvedAgentType`
  interface (`{ name; model?; effort?; developerInstructions? }`, backend-neutral);
  `SubagentRequest.developerInstructions?: string`.
- `src/settings.ts` — `agentTypes` setting + reader + `workflowDefaultAgentTypes()`.
- `src/settings.json` (packaged default) — `workflow.agentTypes: "disabled"`.
- `src/cli.ts` — `--agent-types` flag + `parseAgentTypes`; **[F1]** on resume, a
  `resolveResumeAgentTypesGate(cwd, runId)` preflight that auto-enables the gate when the source used
  types; when enabled, `loadAgentTypeRegistry(...)` and pass the map into `WorkflowTaskRegistry`; help
  text.
- `src/runtime/workflow-runtime.ts` — `AgentOptions.agentType`; `WorkflowTaskRegistryOptions.agentTypes`
  (the neutral map) + gate; `runAgent` resolution (D1–D5, use-time validation via
  `normalizeAgentEffort`/`normalizeAgentModel`); `workflowAgentSemanticOpts` gains `agentType`
  (conditional-spread); thread persona through `runAgentWithStallRetries` → `agentRequest` →
  `SubagentRequest.developerInstructions`; **[F1]** add `usesAgentTypes` to `WorkflowResumeSourceInfo`
  + `workflowResumeSourceInfoFromJournal` (scan `started` entries for `semanticOpts.agentType`) and
  surface it via `resumeSourceInfo`.
- `src/codex/subagent-backend.ts` — `generate` passes `request.developerInstructions` to
  `startThread`; `startThread` composes `developerInstructions` (persona + return-contract appended).
- Tests, `CHANGELOG.md` `[Unreleased]`, help text.

## 7. Done-when / verification

- **GATE-0 real-path probe (before coding):** build a `CodexSubagentBackend`, dispatch two requests
  differing only by a distinctive `developerInstructions` persona (+ a specific model/effort), and
  confirm the real codex thread **honors the persona** (output visibly changes) and the model/effort.
  Proves per-agent persona works in our isolated posture. Falsifiable: no-persona call must produce
  the default behavior.
- **Falsifiability:** temporarily drop `agentType` from `semanticOpts` → a resume/key test that
  distinguishes two same-prompt agents by type must fail; restore.
- **Unit:** registry parser (scalar, multiline, malformed→throw, name-safety); precedence (D3);
  gate-off fail-loud (D2); unknown-name (D4); call-key differs by type (D1); byte-identical when off.
- **`npm run test:all`** (unit + installed e2e — CLI output / effort paths).
- **Dogfood** built-in code-review on the diff + read `synthesis`/`findings`; re-verify each finding.
- **MERGE GATE:** read the `chatgpt-codex-connector` bot review; fold or consciously defer.

## 8. Known limits (v1)

- model/effort/persona only (no `sandbox_mode`/web/mcp per type — §2 deferred).
- Persona **content** not in the call key (only the name is) → a `developer_instructions` edit doesn't
  re-run; a `model`/`effort` edit does, and cascades down the hash chain (D1/F6).
- Registry read once per launch (no live reload); a typed resume auto-restores the gate + re-reads
  the registry (D1/F1).
- **[F8]** Resuming a **pre-feature** journal whose script now (gate-on) uses `agentType`: the
  pre-feature entry recorded `semanticOpts` without `agentType`, so the recomputed key differs →
  cache miss → re-dispatch with the new typed behavior. Not corruption (the validator already permits
  `agentType`, `workflow-journal.ts:615`), just a non-faithful replay of that agent onward.
- Frontier-class types may omit `model_reasoning_effort` (the real `frontier.toml` does) → the
  effort falls through to explicit-opts/run-default, as designed (D3).
All are documented; none widen authority.
