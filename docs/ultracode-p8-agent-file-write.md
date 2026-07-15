# Ultracode P8: Subagent file write (Design)

Status: DESIGN. Branch `parity/agent-file-write` @ base `51b7c25` (post-P7). Stream step **(a)**
of the capability-expansion stream (b web ✓ → **a editing** → c MCP → agentType). Parity item:
make worktree-isolated subagents able to actually *write* files.

## Corrected premise (probed 2026-07-16)

Earlier framing said editing "already works under worktree isolation; (a) is about loosening it."
**That was wrong — editing is dormant.** A real-path probe (built `CodexSubagentBackend`, a detached
git worktree as cwd, `sandbox=workspace-write`) asked an agent to create a file; it replied *"no
filesystem write tool is available in this workflow"* and wrote nothing. Read-only (non-worktree)
correctly refused too. So worktree isolation currently grants a write-*permitted* sandbox with **no
write tool** — the `p3c` "workspace writes" contract is latent. (a) = **make writing work**, contained.

## Two enablement paths (probed)

- **Path A — native `apply_patch`.** `codex exec` writes fine even under our exact restrictive config
  (`sandbox=workspace-write` + all 10 `DISABLED_CODEX_CONTEXT_FEATURES` incl. `shell_tool=false` +
  `approval_policy=never`): a file was created, `file_change` events fired. **So `apply_patch` is
  contained and independent of `shell_tool`** (it edits files, it does not run arbitrary commands →
  NOT a fan-out escape). BUT the app-server `thread/start` we drive exposes **no inclusion knob** for
  it: the binary has `apply_patch_tool_type` only as a per-model *catalog capability* ("freeform"),
  no `include_apply_patch_tool` config, and `thread/start` accepts `dynamicTools`/`baseInstructions`/
  `developerInstructions` but no native-tool list. Native inclusion is not reachable through our
  surface → **deferred** (Path A is a future quality upgrade if the inclusion path is found).
- **Path B — our own workspace write dynamic tools (CHOSEN).** We already own the dynamic-tool
  dispatch: `handleDynamicToolCall` (`subagent-backend.ts:510`) routes `workspace.read_file`/
  `list_directory` to our handlers, path-guarded by `resolveWorkspaceToolPath` (`:842`). Adding
  `write_file` + `str_replace` there is symmetric, contained, `shell`-free, in-turn, and fully in our
  control. Owner picked tool shape **(i) both `write_file` + `str_replace`** (2026-07-16).

## Load-bearing fact: our dynamic-tool writes are NOT sandboxed

A dynamic tool call runs in **our backend process** (Node `fs`), not in the codex sandbox — the
app-server sends `item/tool/call` and we execute + respond. So the codex `sandbox_mode` does not
gate these writes; **our path guard is the sole containment enforcer.** Therefore:
- Write tools are offered ONLY to a **worktree thread** (`workspaceWrite === true`, i.e.
  `request.worktreePath` set) AND only when the gate is on; a read-only thread gets no write tools
  and no write root.
- Every write path is resolved and confined to the worktree root with a symlink-safe guard
  (below). A path escape would let an agent write anywhere, since we are unsandboxed.

## Design

### Gate: `agentFileWrite` boolean → setting + flag (mirror P7 `webSearch`)

`AgentFileWrite='disabled'|'enabled'` (`types.ts`), `workflow.agentFileWrite` (default `disabled`,
`settings.ts` + `settings.json`), `--agent-file-write` (`cli.ts` → `webSearch`-style parse → backend
option `agentFileWrite`). Default disabled → **byte-identical** (read-only tool set unchanged).

### Tool set is computed per thread, not a constant

`workspaceDynamicTools(writable: boolean)` returns the `workspace` namespace with `[read_file,
list_directory]` and, when `writable`, also `[write_file, str_replace]`. `startThread` already
receives `workspaceWrite: boolean`; compute `const writable = workspaceWrite && this.agentFileWrite;`
and pass `dynamicTools: workspaceDynamicTools(writable)`. When `writable`, also record
`threadWriteRoots.set(threadId, realpath(cwd))` (the worktree root). When off/read-only, the tool
list is exactly today's `[read_file, list_directory]` (proven by the existing dynamic-tools test).

### Handlers (in `handleDynamicToolCall`)

- `write_file({ path, content })` — create or overwrite a text file within the worktree.
  `resolveWorkspaceWritePath` (new, allows a not-yet-existing target), `mkdir -p` the parent (inside
  root), reject `content` over `MAX_WORKSPACE_TOOL_WRITE_BYTES`, `writeFile(utf8)`. Returns the
  relative path + byte count.
- `str_replace({ path, old_str, new_str })` — surgical edit. Resolve via the existing
  `resolveWorkspaceToolPath` (target must exist, already symlink-guarded), read, require `old_str`
  to occur **exactly once** (0 → "not found"; >1 → "appears N times; add context to disambiguate",
  mirroring the harness Edit tool), replace, `writeFile`.
- Both gated: if `threadWriteRoots` has no entry for the thread → `dynamicToolFailure` (defense in
  depth beyond tool-list omission). Routed only when `namespace==='workspace'`.

### `resolveWorkspaceWritePath(root, requestedPath)` — symlink-safe, allows non-existent

`resolveWorkspaceToolPath` requires the target to exist (`realpath`), which a create cannot satisfy.
The write resolver: lexical `pathInsideOrEqual(root, candidate)`; then walk **from the full candidate
itself** up the chain and `realpath` the **first path that exists** — crucially this is the *target
itself* when it already exists, so an **existing final-component symlink** pointing outside is
resolved and rejected (not just symlinked ancestors). Re-verify the canonicalized path is inside
`realpath(root)`; non-existent tail segments cannot be symlinks, so they append lexically under the
canonical existing prefix. Returns the canonical target (guaranteed inside root). Writes go through
`atomicWriteFile` (temp sibling + `rename`), which replaces the destination name without following a
destination symlink.

### Worktree lifecycle integration — no runtime change

The runtime already inspects the worktree with `git status` after each attempt and preserves a
**changed** worktree (`worktreeRetention`, `p3c`). Real writes simply make that existing "changed"
branch fire for real (it was effectively dead while writes were impossible). No
`workflow-runtime.ts` change is needed; enabling writes is confined to the backend.

## Invariants

1. **Default-off byte-identical.** `agentFileWrite=false` → `workspaceDynamicTools(false)` ===
   today's `[read_file, list_directory]`; no write root recorded. Proven by the existing dynamic-tools
   assertion + a diff review.
2. **Writes are worktree-only and path-confined.** Tools offered only when `workspaceWrite &&
   agentFileWrite`; every write resolved inside `realpath(worktreeRoot)` with symlink safety. Because
   our handler is unsandboxed, this guard is the containment — it is the load-bearing test.
3. **No call-key / journal / resume change.** Writes are a backend tool surface; `semanticOpts` and
   `computeWorkflowAgentCallKey` are untouched. Like `webSearch`, `agentFileWrite` is run-level, not
   in the key, and re-passed on resume (a resumed run replays cached results; only re-executed
   agents write).

## Scope

IN: `write_file` + `str_replace` for worktree-isolated agents, behind `--agent-file-write`,
default-off, path-confined to the worktree.

OUT (documented): non-worktree **direct workspace writes** (writing the user's real checkout — a
larger authority expansion, separate decision); **native `apply_patch`** (Path A — deferred until the
app-server inclusion path is found); binary writes; file delete/rename/mkdir-only ops (add later if
needed); per-agent write control (rides the future `agentType` step).

## Authority posture

Writes are confined to an **isolated detached worktree** (a sibling checkout, reviewable via git,
**not** the user's working tree). No data leaves the machine, and every change is reviewable and
reclaimable. **But containment rests ENTIRELY on the path guard** — our dynamic-tool handler runs
unsandboxed as the user, so a guard bypass would be an arbitrary local file write (e.g. `~/.ssh/…`,
shell rc, git hooks, `~/.codex/config.toml` → persistence/credential/RCE), which is *worse*, not
milder, than P7 web egress. So the guard is **security-critical**, not "contained by construction":
it must realpath the target itself (final-component symlink defense, design-verify B1), reject
git-internal paths, and is the load-bearing subject of the W4 tests. Mitigations: default-off,
explicit opt-in flag, worktree-only, path-confined, atomic writes. Non-worktree direct writes (the
real authority jump) stay OUT and are a separate owner decision.

## Verification plan (falsifiable)

- **W1 tool inclusion by gate × workspace-write:** `agentFileWrite=true` + worktree thread →
  `dynamicTools` workspace tools = `[read_file, list_directory, write_file, str_replace]`; contrast:
  `agentFileWrite=false` (any) OR read-only thread → `[read_file, list_directory]` (byte-identical).
  Via the fake-codex `DEBUG_PAYLOAD` harness that captures `threadStart.dynamicTools`.
- **W2 write_file creates within the worktree:** unit-drive `writeWorkspaceFile(root, {...})` → file
  exists with content; `resolveWorkspaceWritePath` creates parent dirs inside root.
- **W3 str_replace exactly-once:** 1 match → replaced; 0 → "not found" failure; 2 → "appears 2 times"
  failure (no write). Negative control: assert the file is unchanged on a rejected edit.
- **W4 path escape rejected (load-bearing):** `write_file`/`str_replace` with `../escape`, an absolute
  outside path, and a **symlink** whose target is outside root → all rejected; nothing written outside.
- **W5 gate/settings/flag parse:** settings default `disabled`; `--agent-file-write enabled` parses;
  invalid rejected; `workflowDefaultAgentFileWrite()` reads it.
- **W6 default-off byte-identical:** existing "Ultracode-only app-server surface" test still sees
  `[read_file, list_directory]` with no backend `agentFileWrite`.
- **Live L1 (design-verify):** backend with `agentFileWrite:true` + a real detached worktree → an
  agent asked to create/edit a file actually writes it (file on disk, `git status` shows the change);
  contrast: `agentFileWrite:false` → agent reports no write tool, nothing written.
- **Falsifiability:** break the gate (always include write tools) → W1/W6 read-only/off cases fail;
  restore → green.

Gate: `npm run test:all` + typecheck; two-kind design-verify on this doc before coding; implement
default-off; dogfood `code-review` on the diff; re-verify; squash-merge (permanently opt-in, no flip).

## REAL-PATH PROBE — PASS (2026-07-16)

Built backend + real codex + a real detached worktree (`probe-write.mjs`): **write_file ON** →
`wrote NOTES.md (17 bytes)`, file on disk with the content; **str_replace ON** → `edited CONFIG.txt`,
`mode=off`→`mode=on` with the rest preserved; **write OFF (control)** → agent reports *"write_file tool
is not available"*, nothing written; **path-escape** (`../../…/tmp/ESCAPE`) → `Path escapes workspace:`,
nothing written outside. End-to-end through app-server → `item/tool/call` → our handler → fs.

## DESIGN-VERIFY OUTCOME (2026-07-16, one Claude adversarial lens + self re-verify)

The reviewer read the design + a mid-implementation tree. Re-verified against final code:
- **B1 [BLOCKER as written] — final-component symlink escape → NOT PRESENT in the implementation.**
  The doc prose said "nearest existing *ancestor*", which is ambiguous; the code walks from the
  **full candidate** and realpaths the first existing path — the target *itself* when it exists — so
  an existing symlink at the final component pointing outside is resolved and rejected. Proven by a
  new W4 symlink test + the live path-escape probe. Doc prose tightened; `atomicWriteFile` rename
  adds defense in depth.
- **M1 [MAJOR] authority framing** — folded: the guard is now stated as security-critical with the
  arbitrary-write worst case (see Authority posture), not "milder, contained by construction".
- **M2 [MAJOR] gitignored writes silently reclaimed** — REAL, documented as a limit (below); not a
  write bug (the write succeeds; `remove-clean` retention reclaims an ignored-only worktree). Mitigate
  by writing tracked paths or `--worktree-retention preserve-all`.
- **M3 [MAJOR] binary/non-UTF-8 corruption + caps** — fixed: `str_replace` now reads bytes and
  requires a lossless UTF-8 round-trip (rejects binary AND invalid-UTF-8, superseding the NUL check),
  plus the pre-existing read-size and result-size caps.
- **M4 [MAJOR] per-agent-private writes; not reproduced on resume** — REAL (documented limits below):
  each agent has its own worktree, so a sibling agent cannot read another's write, and a resumed run
  replays a cached agent's *result* without re-running its write (on-disk artifacts differ). This is
  a human-review artifact model, not a shared mutable workspace.
- **MINORs folded**: `close()` now clears `threadWriteRoots`; atomic temp+rename writes; `.git`-path
  writes refused (`isGitInternalPath`); empty `old_str` rejected explicitly.

## Known limits (documented, not regressions)
- **Writes to gitignored paths may be reclaimed** under the default `remove-clean` retention (git
  treats an ignored-only worktree as removable) — the write succeeds but the file can be deleted with
  the worktree. Use tracked paths or `--worktree-retention preserve-all` to keep such artifacts.
- **Per-agent-private + review-only**: writes live in the writing agent's own worktree; sibling agents
  do not see them, and they are surfaced for human review (preserved worktree), not fed to downstream
  agents. Resuming replays cached results without re-writing, so a resumed run's on-disk artifacts can
  differ from the original run's.

## DOGFOOD OUTCOME (2026-07-16, built-in `code-review` level=high on the working-tree diff)

6 findings, all re-verified. Fixed (P8-owned code): **str_replace overlapping matches** —
`countOccurrences` now counts overlapping occurrences so a self-overlapping `old_str` (e.g. `"aa"` in
`"aaa"`) is rejected as ambiguous (test added); **bare write-tool names** — the namespace-less
compatibility route now resolves `write_file`/`str_replace` too (still gated by `threadWriteRoots`).
No fix (consistent with existing precedent, documented): **write auth bound to `threadId` not
`turnId`** (same as the read tools — the thread scopes the worktree); **`trim()` on the path** (same
as the read resolver `resolveWorkspaceToolPath`); **`--validate` parses no run-flags** (identical for
all four sibling flags — validate does not run). **Pre-existing P1 — FIXED (owner asked to fold it in, 2026-07-16)**: the JSON-RPC line handler
classified by `pending.has(id)` before `method` presence, so a server-initiated request (e.g.
item/tool/call) whose id collided with an outstanding client request id was misrouted as a response
(resolving the wrong promise, dropping the tool call → turn hang). Now classifies by **`method`
presence first** (JSON-RPC 2.0: responses never carry `method`), making the client/server id spaces
independent. Proven by a deterministic collision test (fake reuses the turn/start id for a tool call
before answering turn/start) + falsifiability (reverting to pending-first → the test times out).
This also hardens the read-tool path P8 extends.

## Open decisions (owner)
1. Tool shape — **RESOLVED: (i) `write_file` + `str_replace`** (owner, 2026-07-16).
2. Worktree-only v1 (RECOMMENDED, containment) vs also non-worktree direct writes (deferred).
3. Default-off + permanently opt-in (recommended; mild vs web but still a capability add).
