# Codex Agent Prompting

How to write the natural-language `prompt` body of an `agent()` call for the
current Codex model family. This is the semantic complement to the structural
"Author A Workflow Script" contract in `ultracode-for-codex --llm-guide`: the
guide governs `meta`, `schema`, `key`, and `effort`; this reference governs the
prose you send to each Codex subagent.

## What The Runtime Already Guarantees — Do Not Restate It

Every delegated agent runs through the local runtime, which already provides:

- **Output shape** — when the call passes `schema`, the runtime forces a
  StructuredOutput submission and validates it. Do not describe JSON keys,
  ordering, or "return only JSON" in the prompt. Describe the *meaning* and
  *evidence rules* for each field instead.
- **Reasoning depth** — per-agent `effort` (and `model`). Do not write "think
  harder", "be thorough", or "use maximum reasoning". Raise `effort` in the
  script instead (see Effort Tiering).
- **Workspace access** — subagents get bounded read-only file-read and
  directory-list tools against the run `cwd`. They read and reason; they do not
  edit files. Do not ask an agent to apply a patch — return the change as
  structured findings for the orchestrator to act on.
- **Deterministic evidence** — `workspaceContext({ includeDiff })` injects the
  diff/status snapshot and allowed evidence refs. Reference that evidence; do
  not ask the agent to re-run `git`.

The prompt body therefore carries **intent, constraints, and evidence
discipline** — not structure and not effort.

## Model Context

Current Codex models are the **GPT-5.5 family** (`gpt-5.5`, `gpt-5.5-codex`);
the runtime default is `gpt-5.5`. Newer previews may appear over time — pin a
specific one with per-agent `model` only when a task needs it.

This family rewards **outcome-first** prompts, a shift from the XML-block-heavy
"operator" style tuned for older models. Do not port an old prompt verbatim;
start from the smallest prompt that preserves the task contract, then tighten.

- Describe the destination — what a good answer contains, which constraints
  matter, what evidence is available — not a step-by-step procedure, unless the
  exact path is itself the requirement.
- Reserve `ALWAYS`/`NEVER`/`MUST` for true invariants; overusing them degrades
  instruction following.
- Reasoning effort defaults to `medium` in this family. Treat `medium` as the
  balanced starting point and raise it only after the prompt contract is tight.

## The Outcome-First Prompt Shape

Include only the parts a given task needs. Light XML tags (`<task>`, etc.) are
optional structure, not required ritual.

1. **Task / outcome** — the concrete job, the relevant subsystem or failure, and
   what "done" looks like. One clear job per agent; split unrelated asks into
   separate agents (or phases).
2. **Success criteria & stop condition** — what must be true before finalizing,
   and when to stop digging. For review/finder agents, a retrieval/scope budget.
3. **Grounding & evidence** — "Ground every claim in the provided evidence or
   your tool reads. Label inferences as inferences. Do not invent file paths,
   symbols, line numbers, or facts; if required context is missing, say what
   remains unknown rather than guessing."
4. **Verification** — for diagnosis/analysis: "Before finalizing, re-check each
   conclusion against the evidence; revise rather than reporting a first draft."
5. **Scope** — keep the analysis tied to the stated task; call out adjacent
   risks separately instead of expanding scope.

## Per-Task Adjustments

- **Review / adversarial** — add a dig-deeper nudge: "After the first plausible
  issue, also check second-order failures, empty-state behavior, retries, stale
  state, and rollback paths." Keep findings evidence-bound and severity-ordered
  in the field semantics; the schema holds the shape.
- **Diagnosis** — ask for most-likely root cause, the supporting evidence, and
  the smallest safe next step — in that priority order.
- **Research / recommendation** — separate observed facts, reasoned inferences,
  and open questions. Prefer breadth first, then depth only where the evidence
  would change the recommendation. Cite only sources actually inspected; never
  fabricate citations.
- **Planning / implementation design** — ask for the plan, the disjoint write
  ownership per unit of work, the risks, and the verification each step needs.
  Remind the agent it is one of several in the codebase and must not assume it
  owns unrelated files.

## Effort Tiering

Match `effort` to the job, funnel-style, rather than begging for depth in prose:

- Wide sweeps, finders, and mechanical scans → `medium` (or `high` for
  correctness-sensitive finders).
- Verdicts, adversarial verification, and final synthesis → `high` or `xhigh`.
- Before raising effort to solve a weak result, first add success criteria, a
  verification step, and grounding rules — a tighter contract beats more tokens.

Note: `effort` accepts `none|minimal|low|medium|high|xhigh`, but the current
default model rejects `minimal`; an unsupported effort fails that agent loudly.

## Anti-Patterns

- Restating the JSON schema, key names, or "return only JSON" in the prompt —
  the runtime already enforces it.
- "Think harder / be very thorough" instead of raising `effort`.
- Vague framing ("take a look and let me know") with no outcome or success
  criteria.
- Mixing unrelated jobs (review + fix + docs + roadmap) into one agent.
- Asking an agent to edit files or run `git` — agents are read-only; return
  structured findings for the orchestrator.
- Presenting inferences as facts, or asserting file paths/symbols the agent did
  not actually read.
- Overusing `ALWAYS`/`NEVER`/`MUST`, or porting a whole legacy prompt stack
  instead of starting minimal and tightening.
