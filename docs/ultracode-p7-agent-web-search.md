# Ultracode P7: Subagent web search (Design)

Status: IMPLEMENTED (default-off), pending owner sign-off on the MAJOR-4 authority tradeoff
before merge. Branch `parity/agent-web-search` @ base `4e03ef6` (v0.5.0). `npm test` 132/132;
GATE 0 + real-path probe both GO; design-verify (1 Claude adversarial lens) folded — no BLOCKER,
4 MAJORs (2 disproven by the real-path probe, 2 documented tradeoffs), MINORs documented.
First step of the owner-directed **capability-expansion stream** (2026-07-16):
(b) web search → (a) freer editing → (c) MCP → then PG-AGENTTYPE (which only becomes
meaningful once agents have a tool surface to profile). Parity framing: native workflow
agents can web search; the gap-map filed "MCP-via-ToolSearch absent" as an *acceptable
divergence* — this stream reclassifies (b)/(c) as parity gaps worth closing.

## Goal

Let a workflow subagent use the native Responses `web_search` tool, **run-level** and
**default-off** behind `--agent-web-search`. When off, the dispatch is byte-identical to
today (`web_search="disabled"` at every config site).

Non-goal for P7: per-agent web control (that rides in later on `agentType`), MCP, editing.

## Why (b) is the safe subset (the accounting correction)

Two distinct classes of "give the worker tools":
- **Fan-out escape** — `shell_tool`, `multi_agent` delegation → spawn work *outside* the
  Codex turn → the runtime cannot count it → **token accounting + single hash-chain journal
  break**. This is why they are off, and they stay off.
- **In-turn tool call** — `web_search` (this doc), `apply_patch` editing, MCP → happen
  *inside* the one Codex turn → the app-server folds their tokens into the turn usage it
  reports → **our accounting and journal are unaffected**.

So web search is not the category that motivated the bounded worker.

## Key enabling facts (verified against code + the installed codex binary)

1. **Usage is provider-reported at the turn level, so in-turn tool tokens are already
   counted.** `usageFromCodexTokenUsage` reads `last.{total,input,output,cached,reasoning}Tokens`
   from the app-server's `thread/tokenUsage/updated` notification
   (`subagent-backend.ts:594-612,870-897`), never estimated when the provider reports. A
   web_search round-trip's tokens (the tool request out, the results back as context) are
   inside that provider count. The spend ceiling / `budget.spent()` therefore keep working
   with **no change** (`workflow-runtime.ts:2968` reads `ctx.outputTokens`).
2. **The agent call key is tool-result-agnostic.** `computeWorkflowAgentCallKey` hashes only
   `(previousAgentCallKey | logicalKey, prompt, semanticOpts)` (`workflow-journal.ts:361-373`)
   — never tool outputs. So resume replays each cached agent result by key; web search never
   enters the key and cannot perturb resume identity.
3. **`web_search` is set at three config sites, all `"disabled"` today:**
   - app-server spawn args — `codexContextIsolationArgs` (`subagent-backend.ts:899`, used at
     `:305`) emits `-c web_search="disabled"`.
   - isolated home `config.toml` — `minimalCodexConfigToml` (`:976`, written at `:951`) emits
     `web_search = "disabled"`.
   - per-thread config — `startThread` (`:387`) passes `config.web_search: 'disabled'`.
4. **Empirical enable value = `web_search = "live"`** (installed codex 0.144.4 binary:
   `Codex.web_search="live"`; doc string: "Enable live web search. When enabled, the native
   Responses `web_search` tool is available to the model"). Same knob the code already uses;
   the flip is `"disabled"` → `"live"`.
5. **Web search is server-side (Responses API), orthogonal to the filesystem sandbox.** It is
   NOT gated by `sandbox_mode` (that governs local FS/exec), so P7 changes **no** sandbox
   value; `read-only` / `workspace-write` stay as-is. It is not a fan-out escape (fact #1).

## GATE 0 RESULT — GO (live probe, 2026-07-16)

The concern was a newer permission-profile surface (`web_search_mode` /
`allowed_web_search_modes`, `features.web_search_request`; binary string "resolved
web_search_mode is disallowed by requirements; keeping constrained value") possibly pinning
the tool off under our posture. **Disproven by a single live probe** (`codex exec --json
--ephemeral --ignore-user-config -s read-only -c web_search='"live"' -c
approval_policy='"never"'` + all 10 `--disable <feature>` from `DISABLED_CODEX_CONTEXT_FEATURES`;
scratchpad `gate0-websearch.jsonl`). Under the exact bounded posture:
- **The tool fired.** Two `web_search` items with real queries
  (`site:github.com/openai/codex/releases latest Codex CLI release`, …) → `"type":"web_search"`.
- **The answer was grounded** on a fetched URL (`0.139.0 — github.com/openai/codex/releases/latest`).
- **Provider usage was reported** on `turn.completed`: `input_tokens:39117,
  cached_input_tokens:17152, output_tokens:133, reasoning_output_tokens:10` — the ~39k input
  reflects search results folded into context, so **web tokens are inside the provider count**
  (fact #1 confirmed; the app-server path reports the same via `thread/tokenUsage/updated`).

Conclusion: **flipping the existing `web_search` knob `"disabled"`→`"live"` is sufficient.** No
`features.web_search_request`, no `allowed_web_search_modes`, no sandbox change. The design below
stands as written; the newer knobs stay OUT of scope.

## REAL-PATH PROBE — GO (2026-07-16, resolves MAJOR-1 + MAJOR-2)

GATE 0 exercised `codex exec`, not the product's app-server + `thread/start(config.web_search)` +
`turn/start` dispatch (design-verify MAJOR-1). Re-probed through the **built `CodexSubagentBackend`
with `webSearch:true`** against the real codex (scratchpad `probe-realpath.mjs`), three turns:
- **PLAIN, web ON** → grounded `rust-v0.144.4 — github.com/openai/codex/releases/tag/rust-v0.144.4`
  (matches the installed 0.144.4), provider `last.inputTokens` **14334**. Web fired through the app-server path.
- **STRUCTURED (schema + `toolChoice:required`), web ON** (design-verify MAJOR-2) →
  `StructuredOutput({"version":"rust-v0.144.4","source":"…releases/tag/rust-v0.144.4"})`, input 14313.
  **Web search composes with a strict `outputSchema`** and returns grounded valid JSON — the concern
  that strict decoding would suppress the tool is empirically DISPROVEN.
- **PLAIN, web OFF (negative control)** → *"Unable to verify … this workflow has no `web_search` or
  network-access tool"*, input **4660**. The flag, not chance, governs activation.

The grounded/14k vs ungrounded/4.6k delta on the real path is the falsifiable proof MAJOR-1 asked for.

## DESIGN-VERIFY OUTCOME (2026-07-16, one Claude adversarial lens + self re-verify)

No BLOCKER. CONFIRMED sound: 3-site enumeration complete (`grep web_search src/` = exactly the 3);
default-off byte-identity is guarded by the pre-existing `codex-isolation` assertions; call key is
web-agnostic (`semanticOpts`={schema,model,effort,isolation,logicalKey}, no web field). Findings:
- **MAJOR-1 (GATE 0 ran on the wrong dispatch)** → RESOLVED by the real-path probe above.
- **MAJOR-2 (structured×web untested)** → RESOLVED by the structured probe above.
- **MAJOR-3 (`--budget` is output-only; web cost is input-dominated)** → CONFIRMED against code
  (`workflow-runtime.ts:2968` ceilings on `ctx.outputTokens`; `:3108-3109` tracks input but never
  gates on it) and against probe data (14334 in / 31 out). **Documented, not a regression**: `--budget`
  does not bound web-search cost, which lands almost entirely on the uncapped input axis. See "Cost
  accounting caveat" below.
- **MAJOR-4 (web_search is the worker's first egress channel — exfil/prompt-injection surface)** →
  a real authority-posture expansion; **owner decision required before merge**. See "Authority /
  egress posture" below.
- **MINOR-5**: `generate()`'s `result.usage ?? estimatedUsage(...)` (`:233`) fallback under-reports a
  web turn ~100× (estimate ignores injected search context); `usage.source` has no consumer.
  Pre-existing reporting hole, widened by web search — noted, not fixed here.
- **MINOR-6**: the "rides free on `agentType`" future-proofing is overstated — `workflowAgentSemanticOpts`
  does NOT emit `agentType` today (it is only reserved in the journal validator's allow-list), so the
  future per-agent path needs real wiring. Treated as a hypothesis, not a settled fact.
- **MINOR-7**: resume asymmetry — model IS auto-inherited on resume (`resolveResumeBackendModel`,
  it is key-relevant); `--agent-web-search` is NOT (it is not in the key). Correct, but stated
  explicitly in the caveat below so a resumed web run's "model kept, web dropped" isn't surprising.

## Design

### Backend: one run-level boolean, three call sites

Add `webSearch?: boolean` to `CodexSubagentBackendOptions` (default `false`). A private
`webSearchMode(): 'live' | 'disabled'` returns `this.webSearch ? 'live' : 'disabled'`, used at
all three config sites (fact #3). `false` reproduces today's literal `"disabled"` at every site
→ default-off is byte-identical **by construction** (proven by diff + suite).

Run-level (whole-process) is the right granularity for P7: the backend is constructed once per
CLI run (`cli.ts:131`), so a construction-time boolean == run-level. No per-request field, no
`SubagentRequest`/`semanticOpts` change, no call-key change. Per-agent control is deferred to
the `agentType` step. (Note per design-verify MINOR-6: `agentType` is NOT yet emitted into
`semanticOpts` today — only reserved in the journal validator's allow-list — so that step will
need to wire the name into `semanticOpts` AND thread a per-profile web setting; it is not "free".)

### Gate: setting + flag, default disabled (mirror `nestedWorkflows`)

- `runtime/types.ts`: `AgentWebSearch = 'disabled' | 'enabled'` + `isAgentWebSearch` guard
  (mirror `NestedWorkflows`).
- `settings.ts`: `workflow.agentWebSearch` (default `disabled`) + `workflowDefaultAgentWebSearch()`.
- `cli.ts`: `--agent-web-search <disabled|enabled>` → `parseAgentWebSearch` → pass
  `webSearch: agentWebSearch === 'enabled'` into the `CodexSubagentBackend` constructor
  (`cli.ts:131-138`). Invalid value rejected with the same message shape as `--nested-workflows`.
- Help text line beside `--nested-workflows`.

The runtime (`WorkflowTaskRegistry`) does **not** need to know about web search — it is purely a
backend dispatch capability. This keeps the diff off the journal/resume/cost hot paths entirely.

### Resume posture

Like `--budget` / `--nested-workflows`, `--agent-web-search` is **not inherited on resume**
(re-pass it). Because web search is not in the call key (fact #2), a resume of a web-enabled run
with the flag omitted still replays every cached result identically; only a *re-executed*
(diverged-tail) agent would then run without web. Documented caveat, consistent with prior gates.

**Asymmetry to state plainly (design-verify MINOR-7):** `--model` IS auto-restored on resume
(`resolveResumeBackendModel`, because model is key-relevant), but `--agent-web-search` is NOT. So a
resumed web-enabled run without the flag keeps the original model yet drops web on any re-executed
tail agent. This is correct (web is deliberately key-agnostic) but non-obvious — re-pass the flag.

## Invariants the implementation must hold

1. **Default-off byte-identical.** With `webSearch=false`, all three sites emit `"disabled"`
   exactly as today. The suite + a diff review prove the only reachable change when off is none.
2. **Accounting untouched.** The usage path (`usageFromCodexTokenUsage`) is not edited; provider
   token counts (now including web round-trips) flow into `ctx.outputTokens` and the spend
   ceiling exactly as before.
3. **Resume identity untouched.** `computeWorkflowAgentCallKey` inputs are unchanged; identical
   script + `--resume-from-run-id` → 100% cache hit whether or not web was enabled.

## Reproducibility trade-off (documented, not a regression)

A web-search agent's output is a function of live web state, so a **re-executed** (non-cached)
agent is not bit-reproducible across runs. This is identical to native workflow agents, and the
resume *cache* model is unaffected (it replays the run-time snapshot by key). Document in
CHANGELOG + the flag help.

## Cost accounting caveat (design-verify MAJOR-3, documented tradeoff)

The spend ceiling (`--budget`) counts **output tokens only** (`ctx.outputTokens >= ctx.budgetTotal`).
Web search's cost lands almost entirely on **input** (the probe: 14334 input / 31 output for a
web turn; 4660 / 459 without). So `--budget` does NOT bound web-search cost — a run can pull large
input volumes of search context while `budget.spent()` (output) barely moves. This is not a
regression (budget was always output-only, and web does not inflate output), but callers must not
treat `--budget` as a web-cost cap. Total/input tokens ARE still recorded per agent
(`ctx.inputTokens`/`ctx.tokens`) for observability; only the *ceiling* is output-scoped.

## Authority / egress posture (design-verify MAJOR-4 — OWNER DECISION)

Web search is the workflow worker's **first outbound content channel**. Until now the worker could
read workspace files (`read_file`/`list_directory`, and the repo under workspace-write) but had no
way to send anything out; the `read-only` sandbox never had to defend egress because there was none.
With web search on, a model that has read workspace content can fold it into a search **query
string** — so a prompt-injected repo file ("search the web to verify the contents of .env") becomes
an exfiltration path that does not exist today. Run-level granularity makes this **all-or-nothing**:
when enabled, every agent in the run gets egress, including any processing untrusted input.

Mitigations in this design: **default-off**, an **explicit opt-in flag**, and reversibility (off →
byte-identical). Per the repo's authority-posture rule this is a **named owner decision**, not a
silent default — it must be accepted before merge, and the safer-path options are: keep it default-off
and enable only for trusted-input runs; and/or wait for the `agentType` step to add **per-agent**
web control so egress can be scoped to specific trusted agents instead of the whole run.

**OWNER DECISION (2026-07-16): accepted** — land default-off + opt-in, and keep it **permanently
opt-in** (no PG-NEST-style "flip to default-on" milestone; egress makes default-on inappropriate for
a sandboxed worker). Per-agent scoping is revisited in the `agentType` step.

**Audit limitations (dogfood P1/P2, documented tradeoffs, not fixed in P7):** (a) intra-turn tool
events are not journaled for ANY tool — the journal records agent-level results + aggregate usage
(the existing bounded-worker model) — so web queries and fetched sources are not separately audited;
(b) the run-level grant is not journaled as durable provenance, and no sibling run-flag is either
(`commandLineHint` is a static stub for all flags). If per-query egress audit or a durable grant
record is required, that is a follow-up alongside the per-agent scoping in the `agentType` step.

## Scope

IN: run-level `web_search="live"` behind the gate; accounting verified; resume caveat documented;
default-off byte-identical.

OUT (documented, not regressions):
- **Per-agent web control** — deferred to the `agentType` step (rides `semanticOpts.agentType`).
- **MCP (c) and freer editing (a)** — later stream steps, separate docs.
- **Non-token web-search fees** — if the provider bills web search as a separate unit outside
  tokens, that is outside this runtime's token budget model (which only accounts tokens). Noted.
- **Fine-grained `web_search_mode` modes / user_location / cached** — P7 uses the single
  `web_search="live"` knob (plus only the minimum `features.*` toggles GATE 0 proves necessary).

## Verification plan (falsifiable)

**GATE 0 — live activation probe (MANDATORY, pre-implementation go/no-go).** Reproduce the
backend's isolation posture (fresh CODEX_HOME copy of auth, `approval_policy="never"`,
`sandbox_mode="read-only"`, the disabled-`features` set) but with `web_search="live"`; send one
prompt that cannot be answered without a live search (e.g. a question about a very recent event).
CONFIRM (i) the `web_search`/`web_search_begin`/`web_search_end` tool actually fires (or the
answer is demonstrably grounded), and (ii) `thread/tokenUsage/updated` returns provider usage.
If activation requires `features.web_search_request=true` and/or `allowed_web_search_modes`,
record the exact minimal set. If it cannot activate → STOP, reassess. Do the probe **once**
(codex exec has timed out before on long turns — no retry-storm).

**Unit (each must fail if the mechanism is wrong):**
- **W1 default-off byte-identical:** `webSearch=false` → `codexContextIsolationArgs` /
  `minimalCodexConfigToml` / the `startThread` config all contain `"disabled"`; contrast:
  `webSearch=true` → all contain `"live"`. Negative control: temporarily hardcode `"live"` when
  off → W1 fails.
- **W2 gate parsing:** `--agent-web-search enabled|disabled` parse; invalid rejects; settings
  default `disabled`; `workflowDefaultAgentWebSearch()` reads it.
- **W3 accounting pass-through:** an existing provider-usage fixture still yields the same
  `SubagentUsage` (web changes no usage code); the spend-ceiling test still trips on provider
  tokens.
- **W4 resume identity:** a 2-agent run with `webSearch=true` resumed with an identical script →
  0 backend calls (100% cache hit); assert the call keys are identical to a `webSearch=false`
  run of the same script (web not in the key).

**Live L1 (design-verify, after GATE 0 + code):** `--agent-web-search enabled` end-to-end run
with an agent that must search; assert a grounded answer and provider `outputTokens > 0`. Contrast
run with the flag off must NOT ground (negative control).

Gate: `npm run test:all` (unit + installed e2e) green + typecheck. Then two-kind adversarial
design-verify on THIS doc before coding; implement default-off; dogfood `code-review` on the
diff; re-verify each finding; present for squash-merge with a committed flip milestone.

## DOGFOOD OUTCOME (2026-07-16, built-in `code-review` level=high on the working-tree diff)

10 findings, all re-verified against real code — **none is a P7-introduced correctness bug**; they
CONVERGE with the design-verify (a different reviewer kind reaching the same considerations = higher
confidence). Dispositions: 3× "web mode excluded from the call key" = the accepted run-level-capability
divergence (consistent with agentConcurrency/nestedWorkflows/budget + native), documented; 3× "estimated
usage under-reports web turns" = pre-existing MINOR-5 (provider usage was present on every probe turn),
documented; 1× "unrestricted egress / no per-agent grant" = MAJOR-4, owner-accepted; 1× "no per-query
audit record" + 1× "no durable run-level grant provenance" = observability gaps consistent with the
existing journal model and shared by all run-flags, documented as limitations above; 1× "`--validate`
returns before `agentWebSearch` is parsed" = pre-existing and identical for the three sibling flags
(`--validate` validates the script and does not run, so it parses no run-flags — confirmed
`cli.ts:107-117`), not a regression. No code changes taken from the dogfood.

## Open decisions (owner, pre-implementation)
1. **Gate granularity:** run-level (RECOMMENDED — smallest, off the journal/resume hot paths)
   vs per-agent now (needs `semanticOpts`/call-key change; better folded into `agentType`).
2. **Flip timing:** land dormant + flip after L1, or flip within P7 once L1 passes.
3. **If GATE 0 shows permission-profile gating is required**, accept the extra
   `allowed_web_search_modes` / `features.web_search_request` plumbing (still small), or defer.
