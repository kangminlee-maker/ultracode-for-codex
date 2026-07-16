# Ultracode P9: Subagent MCP servers (Design)

Status: DESIGN. Branch `parity/agent-mcp` @ base `8490750` (post-P8). Stream step **(c)** of the
capability-expansion stream (b web ✓ → a editing ✓ → **c MCP** → then PG-AGENTTYPE). Parity item:
let a workflow subagent call the user's own MCP-server tools, **scoped to a named allowlist** and
**default-off**. This is the **largest authority jump** in the stream — the gap-map had filed
"MCP-via-ToolSearch absent" as an acceptable divergence; the stream reclassifies it as a parity gap
worth closing, gated tightly.

## Corrected premise (probed 2026-07-16)

The isolated codex home does NOT inherit the user's MCP servers today, by construction:
`createCodexIsolation` copies only `auth.json` and writes a `minimalCodexConfigToml` that declares
**no `[mcp_servers.*]`**. There is no `features.mcp` toggle in `DISABLED_CODEX_CONTEXT_FEATURES` — MCP
is simply absent because nothing provisions it. So (c) = **provision a chosen subset of the user's MCP
servers into the isolated home, and let the worker actually call them** — end to end through the
app-server path we already drive.

## GATE 0 — GO (real-path app-server probe, 2026-07-16)

Unlike web/editing, MCP needed a live probe because the *mechanism was unknown*: does MCP load under
our bounded posture, and what blocks a tool call? Built a raw app-server driver mirroring
`createCodexIsolation` + `codexContextIsolationArgs` + `startThread` EXACTLY (all
`DISABLED_CODEX_CONTEXT_FEATURES=false`, `sandbox_mode=read-only`, `approval_policy=never`,
`shell_environment_policy.inherit=none`) plus one **echo MCP server** provisioned via
`[mcp_servers.echoprobe]` in the isolated `config.toml` (scratchpad `appserver-mcp-probe.mjs` +
`echo-mcp.mjs`). Findings, each observed on the wire:

1. **The server loads under the bounded posture.** `mcpServer/startupStatus/updated`:
   `starting` → `ready`. Provisioning `[mcp_servers.NAME]` into the isolated `config.toml` is
   sufficient; **no feature flag** is needed (MCP is not in the disabled-features set).
2. **The tool is offered and the model calls it.** `item/started` with `item.type = "mcpToolCall"`,
   `server = "echoprobe"`, `tool = "echo_probe"`, `arguments` correct.
3. **A tool call triggers an approval, delivered as an MCP *elicitation*, not a `requestApproval`.**
   The app-server sends a **server→client request** `mcpServer/elicitation/request` with params:
   ```
   { threadId, turnId, serverName: "echoprobe", mode: "form",
     _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session","always"],
              tool_description, tool_params, tool_params_display },
     message: 'Allow the echoprobe MCP server to run tool "echo_probe"?' }
   ```
   **This is the crux.** Our current `respondToServerRequest` (`subagent-backend.ts:571`) matches only
   `method.includes('requestApproval')` (→ `decline`) and otherwise returns `-32601 Unsupported`. So
   `mcpServer/elicitation/request` falls through to `-32601` → the app-server logs a client error and
   the call ends `status: "failed"`, `error.message = "user rejected MCP tool call"`. **That is why
   MCP is dead today even if a server were provisioned.**
4. **The accept response shape is exactly `{ result: { action: "accept" } }`.** Empirically:
   - `{ action: "accept" }` → tool `status: "completed"`, returns `ECHO_MCP_MARKER::hi-appserver`
     (the marker my server emits — proof it *executed*, not that the model guessed).
   - `{ action: "allow" }` (and any non-`accept`) → `status: "failed"`, `"user rejected MCP tool call"`.
   So the app-server treats **only `action:"accept"`** as approval; every other action = reject.

Conclusion: the full recipe is **(A) provision the allowlisted `[mcp_servers.*]` into the isolated
`config.toml`; (B) answer `mcpServer/elicitation/request` with `{action:"accept"}` iff the request is
an `mcp_tool_call` approval (`_meta.codex_approval_kind`) for an allowlisted `serverName`, else
`{action:"decline"}`.** Both halves proven on the real app-server path.

### GATE 0 addendum — server-startup blast radius is BENIGN (probe `f3-blast.mjs`, 2026-07-16)

Design-verify F3 asked: a `node_repl`/`onto`-style server carries `startup_timeout_sec = 120`, but our
`send()` uses a 30s `rpcTimeoutMs` — does a slow/broken provisioned server block `initialize` /
`model/list` / `thread/start` / `turn/start`, failing *every* agent? **Probed with three servers
provisioned at once — a working echo, a broken one (`command="/nonexistent"`), and a 12s-slow one —
and it degrades gracefully:** every RPC returned in ≤0.5s; `mcpServer/startupStatus/updated` is a
**purely async notification** (broken → `failed` at +0.5s, slow → `ready` at +12.5s), and NONE blocked
a call. The turn completed and the working tool fired (`echoFired=true, turnDone=true`). So a bad
allowlisted server degrades to "that server's tools are absent," never a hung backend or a failed
sibling agent. F3's blast-radius concern is disproven; no timeout change needed.

## Why (c) stays in the safe (accounting-intact) subset

MCP tool calls are **in-turn** (fact class from p7): the app-server runs the tool inside the one Codex
turn and folds its tokens into the provider-reported turn usage (`thread/tokenUsage/updated` →
`usageFromCodexTokenUsage`). The probe showed each MCP call as an `item` within the turn. So
`budget.spent()` / the spend ceiling / the hash-chain journal are **unaffected** — MCP is NOT a fan-out
escape like `shell_tool`/`multi_agent` (those spawn work outside the turn and break accounting, and
stay off). Caveat inherited from p7: `--budget` ceilings **output** tokens only; an MCP call that pulls
large tool results inflates **input**, which budget never bounded. Documented, not a regression.

## Authority model — named allowlist (OWNER DECISION 2026-07-16)

**MCP is the biggest authority expansion in the stream, so the gate is a per-server allowlist, not a
boolean.** Two reasons MCP is more dangerous than web (p7) or worktree writes (p8):

- **stdio MCP servers run as **local unsandboxed subprocesses** as the user** — codex spawns the
  server command; `sandbox_mode`/`shell_tool=false` do NOT contain it (same unsandboxed reality as our
  own dynamic-tool handlers, p8). The owner's real config includes `node_repl` (**arbitrary Node code
  execution**) and `computer-use` (**desktop control**). Exposing such a server to a worker that may
  process untrusted input = handing it that server's full, unsandboxed capability.
- **streamable-http MCP servers reach external side-effecting endpoints** (e.g. `day1-mcp` =
  Google Workspace read/write) — a broader egress + write channel than web search's read-only queries.

Owner chose **명시적 allowlist (named allowlist)**: when the feature is on, only servers the user names
by `--agent-mcp <name1,name2>` are provisioned into the isolated home AND auto-approved at the
elicitation. Everything else stays unreachable. `node_repl`/`computer-use`/`day1-mcp` are invisible to
the worker unless explicitly named. Default (no flag / empty list) = **off, byte-identical to today**.

**Auto-accept is inherent and scoped.** A headless CLI has no human at the elicitation prompt, so for
an allowlisted server we auto-`accept`; the *allowlist* is the human decision, made once at launch. The
elicitation handler re-checks `serverName ∈ allowlist` (defense in depth beyond provisioning), mirroring
p8's `threadWriteRoots` fail-closed check. Permanently opt-in — no default-on flip (like p7/p8).

## Design

### Provisioning: verbatim section-slice of the user's `config.toml` (no dependency, no re-serialize)

The project has **zero runtime dependencies** (deliberate); adding a TOML parser is out. `codex mcp list
--json` gives structured data but re-serializing risks fidelity loss. Instead: **read the user's
`config.toml` and copy the allowlisted `[mcp_servers.<name>]` sections VERBATIM** into the isolated
home's `config.toml`. A section spans from its table header to the line before the next table header; a
server NAME owns `[mcp_servers.NAME]` **plus any subtables** `[mcp_servers.NAME.<sub>]` (e.g. `.env`).
Verbatim copy preserves the user's exact definitions — command, args, `cwd`, the full `[...env]` block,
`url`, `bearer_token_env_var`, `startup_timeout_sec`, `enabled = false` — with no round-trip bug and no
new concept. Prototyped against the owner's real config (scratchpad `slice-mcp.mjs`): single, multi,
`node_repl`+`.env` subtable, hyphenated `day1-mcp`, and missing-name detection all correct.

- **Header parse** honors bare keys and basic/literal-quoted segments (`[mcp_servers."odd.name"]`),
  and skips array-of-tables `[[...]]` boundaries correctly.
- **The name match is SEGMENT-EXACT, and this is load-bearing (design-verify F2).** The predicate is
  `segments[0]==='mcp_servers' && allowlist.includes(segments[1])` — NEVER a `header.startsWith(...)` /
  substring test. Why it matters: provisioning **spawns the stdio subprocess at app-server start**, so
  an over-included server's process launches (unsandboxed) and its tools get offered — the elicitation
  re-check only declines the later *calls*, it cannot un-spawn the process. So provisioning-time
  exactness is a containment boundary, not a nicety. Concrete trap on the owner's machine: they run an
  `ontology-docs` MCP server, and `'ontology-docs'.startsWith('onto')` — a prefix bug would provision a
  filesystem server when the user allowlisted only `onto`. Locked by a **prefix-negative** unit fixture
  (`onto` allowlisted, `[mcp_servers.ontology_docs]` present → NOT sliced), because a real-path probe on
  the current config would not exercise this pair.
- **Fail loud on a missing name.** An allowlisted name with no matching `[mcp_servers.NAME]` **table
  header** → throw at backend start (`Unknown MCP server(s): X. Declared servers must use a
  [mcp_servers.NAME] table header; found: ...`). A silent no-op would look like "MCP enabled" while
  nothing is provisioned — a falsifiable failure the design forbids. Note the error phrasing points at
  the table-header form so a user who wrote an inline-table / dotted-key definition (F6, not recognized
  by the slicer) understands why their configured server reads as missing.
- **`enabled = false` is preserved verbatim.** If the user disabled a server it stays disabled even
  when allowlisted (correct — the user's own kill switch wins). Note (F7): a disabled server IS found
  (its section exists) so it is provisioned but won't load → its tools are simply absent; the
  "fail-loud on missing" path covers a *missing section*, not a disabled or late-typo'd server.

`createCodexIsolation` gains an `mcpServers?: readonly string[]` input; when non-empty it reads
`join(sourceHome, 'config.toml')`, slices, validates names, and **appends the sliced block into the
same config string passed to the single `writeFile(..., { mode: 0o600 })`** (design-verify F5 — one
moded write, no second un-moded write; the isolated `config.toml` is a new secret-at-rest location for
any `[...env]`/token the server carries, but it lives in the `mkdtemp` root removed on `close()`).
Empty/undefined → no read, no append → **byte-identical config**.

### Approval: handle the elicitation, gated by the allowlist

In `respondToServerRequest`, before the generic `requestApproval` decline, add (design-verify F1 —
gate on the approval KIND, not just the server):
```
if (method === 'mcpServer/elicitation/request') {
  const p = asRecord(params);
  const serverName = typeof p?.serverName === 'string' ? p.serverName : '';
  const kind = asRecord(p?._meta)?.codex_approval_kind;
  // Accept ONLY an mcp_tool_call approval for an allowlisted server. Any other elicitation kind
  // (data-collection form, OAuth/login) has no human here → decline, fail-closed.
  const ok = kind === 'mcp_tool_call' && this.mcpServers.includes(serverName);
  this.writeResponse(id, { result: { action: ok ? 'accept' : 'decline' } });
  return;
}
```
`this.mcpServers.includes(serverName)` is an **exact** membership test (never a prefix/substring — see
Provisioning F2). With the allowlist empty (default-off), `ok` is always false → decline → today's
behavior (no MCP could fire anyway, since none is provisioned). No change to `item/tool/call` (our
workspace read/write dynamic tools) or to the exec/patch `requestApproval` decline. A throw in the
handler falls to the outer `.catch` → `-32603` → codex treats it as a reject (no hang).

### Gate plumbing (mirror p7/p8, but list-shaped)

- `runtime/types.ts`: `AgentMcpServers = readonly string[]`; `parseAgentMcpServerList(raw: string):
  string[]` splits on comma, trims, drops empties, validates each name against `^[A-Za-z0-9_.-]+$`
  (rejects shell/TOML-hostile chars with a clear error); `isAgentMcpServerName` guard. Names are matched
  against the user's config, so an invalid/typo'd name fails loud at start (above), not silently.
- `settings.ts`: `workflow.agentMcp` — a `readonly string[]` (default `[]`);
  `workflowDefaultAgentMcpServers()`. `readAgentMcpSetting` validates it is an array of valid names
  (non-array or bad entry → clear settings error, mirroring `readAgentWebSearchSetting`).
- `settings.json`: `"agentMcp": []`.
- `cli.ts`: `--agent-mcp <server1,server2,...>` → `parseAgentMcpServers(value)` (undefined → settings
  default; else `parseAgentMcpServerList`) → pass `mcpServers` into the `CodexSubagentBackend`
  constructor (beside `webSearch`/`fileWrite`). Help line beside `--agent-file-write`.
- `CodexSubagentBackendOptions.mcpServers?: readonly string[]` (default `[]`). Stored as
  `this.mcpServers`; passed to `createCodexIsolation`; consulted in the elicitation handler.

The runtime (`WorkflowTaskRegistry`) does **not** learn about MCP — it is purely a backend dispatch +
isolation capability, off the journal/resume/cost hot paths (same as web/file-write).

### Resume posture

`--agent-mcp` is **run-level, not in the call key** (like web/file-write): a resume replays cached agent
results by key regardless of MCP; only a *re-executed* tail agent needs the flag re-passed. Not
auto-inherited on resume (re-pass it). Documented, consistent with the sibling flags.

## Invariants the implementation must hold

1. **Default-off byte-identical.** Empty allowlist → `createCodexIsolation` reads/append nothing (config
   identical to today) AND the elicitation handler declines (unreachable anyway). Proven by the existing
   isolation-config assertions + a diff review + a "no `[mcp_servers` in the default config" test.
2. **Accounting/journal/resume untouched.** `usageFromCodexTokenUsage`, `computeWorkflowAgentCallKey`,
   and the journal are not edited; MCP tokens ride the provider turn count; MCP is not in the key.
3. **Only allowlisted servers can fire.** Provisioning includes only allowlisted sections, AND the
   elicitation handler independently re-checks `serverName ∈ allowlist` (fail-closed if the two ever
   disagree). This is the load-bearing containment and the subject of the W-tests.

## Windows `.git` path fix (folded in — P8 P2, owner decision 2026-07-16)

`isGitInternalPath` (`subagent-backend.ts:1066`) splits on `'/'` only, so on Windows a `relative()`
result like `.git\config` bypasses the `.git` denylist for `write_file`/`str_replace` (Windows-only,
defense-in-depth — primary worktree confinement still holds). Found by the `chatgpt-codex-connector` bot
on PR #11 after merge. Fix: split on `/[\\/]/`; add a Windows-path unit test. Small, orthogonal, folded
here per the roadmap.

## Scope

IN: provision a **named-allowlist** subset of the user's MCP servers into the isolated home (verbatim
section-slice); auto-`accept` their tool-call elicitations; default-off; accounting/journal/resume
verified untouched; Windows `.git` fix.

OUT (documented, not regressions):
- **All-servers / boolean enable** — rejected by the owner in favor of the allowlist (authority).
- **Per-agent MCP scoping** — rides the future `agentType` step (run-level for now, like web/file-write).
- **http-server egress is the p7 exfil surface (design-verify F4).** Naming a streamable-http server —
  or any server whose tools take arguments — re-opens exactly p7's MAJOR-4 exfiltration channel: a
  prompt-injected repo file can fold workspace content into a tool argument sent to the external
  endpoint. `openaiDeveloperDocs` (no-arg, read-only) is the benign case; `day1-mcp` (Workspace
  read/**write**) is egress AND write. http is NOT milder than web search — per-server naming is the
  only mitigation. Do not name arg-taking/http servers for untrusted-input runs.
- **Side-effecting MCP is non-idempotent across resume (design-verify F8, cf. p8 M4).** A *re-executed*
  tail agent that calls a write-capable server (e.g. `day1-mcp` → Sheets write) repeats the external
  side effect; a cached replay does not. The resume *cache* is unaffected (replays results by key), but
  on-disk/external state can diverge from the original run. Same artifact model as p8 file writes.
- **MCP OAuth login / interactive elicitation forms** — we auto-accept the *approval* elicitation
  (`codex_approval_kind: mcp_tool_call`); a server that raises a genuine data-collection elicitation
  (`mode:"form"` asking the *user* for input) is auto-declined for non-approval kinds (no human).
  Servers requiring interactive auth aren't supported headless (document; the user should `codex mcp
  login` in their real home first — the copied `auth.json` carries provider auth, not per-server OAuth).
- **Relative-path servers.** A server whose `command`/`cwd` is relative (e.g. `computer-use`:
  `cwd = "."`) resolves against the isolated `workDir`, not the user's dir → may fail to start. Prefer
  absolute-path servers; the allowlist means the user picks servers they know work. Documented limit.
- **MCP tool audit.** Intra-turn MCP tool calls are not separately journaled (same bounded-worker model
  as web/editing — the journal records agent-level results + aggregate usage). Startup + tool-call
  events exist on the wire; per-call provenance is a follow-up alongside `agentType` scoping.

## Authority posture (summary)

Default-off; opt-in per named server; provisioning + elicitation both allowlist-gated (fail-closed).
The containment is the allowlist: a server the user did not name is neither provisioned nor approvable.
But a **named** stdio server runs unsandboxed as the user (arbitrary capability of that server), and a
named http server reaches its external endpoint — so naming a server is a real trust grant, equivalent
to the user running that server in their normal codex session, now reachable by a worker that may
process untrusted repo/web input. Mitigations: default-off, per-server naming, `enabled=false`
preserved, permanently opt-in. The safer path the owner accepted: name only read-mostly / trusted
servers (e.g. `onto`, `openaiDeveloperDocs`), never `node_repl`/`computer-use`, for untrusted-input runs.

## Verification plan (falsifiable)

- **W1 section-slice extraction:** `sliceMcpServerSections(configText, allow)` → for `[onto]` returns
  exactly that block; for `[node_repl]` includes `[mcp_servers.node_repl]` AND `[mcp_servers.node_repl.env]`;
  hyphenated `day1-mcp` matches; a name with no section is reported missing. **Prefix-negative (F2):**
  `allow=['onto']` over a fixture containing BOTH `[mcp_servers.onto]` and `[mcp_servers.ontology_docs]`
  → slices ONLY `onto` (segment-exact, not `startsWith`). Fixture = a hand-written multi-server TOML.
- **W2 provisioning into isolated config:** `createCodexIsolation({mcpServers:['x']})` over a fixture
  source home → isolated `config.toml` contains `[mcp_servers.x]`; `mcpServers:[]` → contains no
  `[mcp_servers`; an unknown name → throws `Unknown MCP server`.
- **W3 elicitation accept/decline:** unit-drive `respondToServerRequest` with a
  `mcpServer/elicitation/request`: (a) allowlisted `serverName` + `_meta.codex_approval_kind:
  'mcp_tool_call'` → `{action:'accept'}`; (b) non-allowlisted name → `{action:'decline'}`; (c)
  allowlisted name but a NON-`mcp_tool_call` kind (e.g. a data-collection form) → `{action:'decline'}`
  (F1); (d) empty allowlist → always decline. Negative control: drop the `kind` check → case (c) fails;
  hardcode `accept` → cases (b)/(d) fail.
- **W4 gate/settings/flag parse:** settings default `[]`; `--agent-mcp a,b` → `['a','b']`; whitespace
  trimmed; `--agent-mcp ''` → `[]` (off); an invalid char → rejected; `workflowDefaultAgentMcpServers()`
  reads the setting.
- **W5 default-off byte-identical:** with no `mcpServers`, the isolation config equals today's
  (existing config assertion still passes) AND `respondToServerRequest` declines an elicitation.
- **W6 Windows `.git`:** `isGitInternalPath('.git\\config')` → true (fails before the fix).
- **Real-path L1 (design-verify) — PASS (2026-07-16, `l1-realpath.mjs`).** The BUILT `dist/` backend
  (not the hand-probe) with `mcpServers:['openaiDeveloperDocs']` (a real **read-only http** server from
  the owner's config) + a prompt needing that tool → the model **used the tool** and grounded ("Using
  the openaiDeveloperDocs MCP search tool, I found … [learn.chatgpt.com/docs/glossary]"), provider
  input **16196**; contrast `mcpServers:[]` → *"no openaiDeveloperDocs MCP tool is available"*, input
  **4624**. The grounded/16k vs ungrounded/4.6k delta on the real path — through our actual
  section-slice provisioning + `respondToServerRequest` auto-accept — is the falsifiable proof; the
  flag, not chance, governs activation. openaiDeveloperDocs is read-only (no side effects during L1).
- **Falsifiability:** (a) revert the elicitation handler to the old decline-all → L1 + W3 fail; restore.
  (b) hardcode the provision to skip the append → W2 fails; restore.

Gate: `npm run test:all` (unit + installed e2e) + typecheck. Then one Claude adversarial design-verify
on this doc before coding; implement default-off; dogfood `code-review` high on the diff; re-verify each
finding; wait for + read the `chatgpt-codex-connector` PR review; squash-merge (permanently opt-in).

## DESIGN-VERIFY OUTCOME (2026-07-16, one Claude adversarial lens + self re-verify)

No BLOCKER. Classification/routing, default-off byte-identity, fail-closed elicitation, and the
accounting/journal/resume-key claims were CONFIRMED sound against real code (the new
`mcpServer/elicitation/request` branch sits on the request side of P8's method-first `handleLine` fix
and is caught by no existing branch). Findings folded:
- **F1 [MAJOR] — elicitation snippet ignored `codex_approval_kind`.** FIXED: the handler now accepts
  only `kind === 'mcp_tool_call'` for an allowlisted server; every other elicitation kind (form/OAuth)
  declines. Re-verified the kind on two live probes (`kind=mcp_tool_call`). W3 case (c) added.
- **F2 [MAJOR] — name match must be segment-exact.** The prototype already is; hardened as a stated
  containment boundary (provisioning spawns the subprocess, so over-inclusion isn't contained by the
  call-layer re-check) + a prefix-negative W1 fixture (real `ontology-docs`/`onto` trap).
- **F3 [MAJOR] — startup blast radius.** RESOLVED by the `f3-blast.mjs` probe (GATE 0 addendum):
  MCP startup is async; a broken/slow allowlisted server degrades to tool-absent, never a hung backend.
- **F4/F5/F6/F7/F8 [MINOR]** — folded as documented limits (http exfil = p7 MAJOR-4; single 0o600
  write + secrets-at-rest; clearer missing-name error for inline-table configs; late existence check +
  `enabled=false` silent no-tool; side-effecting MCP non-idempotent on re-exec).

Guard the config append on `mcpServers.length > 0` (settings default is `[]`, not `undefined`).

## DOGFOOD OUTCOME (2026-07-16 — blocked by a pre-existing code-review Scope gap, documented)

The built-in `code-review` (level=high) on the working-tree diff **could not complete**: both runs
failed **deterministically at the Scope phase** with `code-review invalid: scope.lensDecisions[8]
includes unsupported decision ref file:package.json: not in allowed decision refs`. `package.json` is
**not in this diff** (git status confirms it is clean), so the code-review's own scope agent selected a
decision ref outside its allowed-evidence set, and the scope validator **hard-fails the whole run**
rather than dropping the invalid ref. This is a **pre-existing robustness gap in the code-review
workflow** (independent of the MCP change, which touches neither `package.json` nor the review
workflow) — filed as a non-blocking discovery, not a finding on this PR. The independent-review lens is
covered here by the adversarial design-verify (F1–F8, all folded) plus the `chatgpt-codex-connector` bot
review on the PR (merge gate). Other verification stands: W1–W6 unit + 4/4 falsifiability controls +
L1 real-path PASS + `test:all` (unit + e2e) green + typecheck clean.

## Open decisions (owner)
1. Authority model — **RESOLVED: named allowlist** (owner, 2026-07-16).
2. Include streamable-http servers (network egress) in scope, or stdio-only v1? — RECOMMEND include
   both (the allowlist scopes either; the mechanism is identical). The owner's read-only probe target
   (`openaiDeveloperDocs`) is http, so http is exercised.
3. Fold the Windows `.git` fix here (RECOMMENDED, per roadmap) vs a separate tiny PR.
