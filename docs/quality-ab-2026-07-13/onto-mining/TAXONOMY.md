# Real hard-review problem taxonomy (mined from onto review records)

Source: 5,010 `finding-ledger.yaml` across ~20 projects → **15,752 findings**.
Only **1,345 have code-file evidence**; of those, **799 span >1 code file** and
the causal chains are dominated by **3–4 reasoning steps** (607 at 3, 508 at 4).
Severity of code findings skews to high (many) with a handful of blocker/critical.
Harvest + sampler: `harvest.py`, `sample_hard.py`, `findings.jsonl`.

## Headline

Real hard code-review findings are **NOT local single-function logic bugs** (the
shape of the shallow fixture, which all tiers saturated). They are almost all
**cross-file contract / authority disconnections**: a concept, field, guard, or
authority is changed or defined in one place, and a consumer, sibling path,
verifier, or projection still holds the old/wrong/narrow version. Each file reads
plausibly in isolation; the defect lives in the **relationship** between files, so
finding it requires reading 2–4 files and tracing a concept across them — exactly
the reasoning-depth regime where effort tier could matter, and which the shallow
fixture never exercised.

## The six recurring families (with sampled evidence #)

1. **Concept/authority disconnection** — implemented/updated in surface A, but a
   consumer/verifier/ledger still points at the old contract. (#3,#4,#28–30,#34,
   #39,#26,#48) e.g. verifier DB-auth gate added to one script, sibling verifier
   still connects raw; runtime dependency wired into validator call path but not
   mirrored into the execution-ledger graph.
2. **Field-name / alias drift** — producer writes canonical field `by_observation`,
   consumer reads stale `observations` → gate reads a missing field and silently
   yields `-1`/`undefined`, never passing. (#28,#29,#30)
3. **Authority / identity split** — two independent authorities for one entity
   (A1 sheet qualifier vs numeric `sheet_id`; auth-bearing identity vs
   provider-call config in one `synthConfig`; `blob_ref` as self-authenticating
   key vs user-scoped capability) → operation confirms one, acts on the other, or
   crosses a user boundary. (#5,#8,#14,#24)
4. **Guard scoped too narrowly for a sibling path** — path A validates, sibling
   path B reaches the same mutation without the guard; or a rule is duplicated
   across two render/response paths and one drops a segment. (#6,#7,#19,#22,#23,
   #27,#41,#52)
5. **Cache/reuse currentness keyed on the wrong sentinel** — reuse decided by
   downstream artifact/sentinel existence rather than the upstream authority it
   consumes → stale reuse after the input changes. (#16,#17)
6. **Vacuous verifier / semantic overload** — a test/verifier asserts over an
   artificial precondition the real producer never materializes, passing without
   proving the real path (#2,#44,#45,#50,#42,#43); or one name carries multiple
   lifecycle meanings (`Copied`, `inspectable`, `density_phase`) so consumers
   misread state. (#13,#35,#54)

## Difficulty properties to reproduce in the depth fixture

- **2–4 interacting files**, not one function.
- Each file **locally plausible** (a decoy of local correctness); the bug is only
  visible by cross-referencing producer ↔ consumer ↔ verifier.
- The defect is a **mismatch / omission in a relationship**, not a wrong operator.
- Detection requires **holding a contract in mind** and finding where it is not
  honored — the reasoning-depth axis effort tiers are supposed to buy.

The depth fixture (`make-depth-fixture.mjs`) plants 8 bugs, one per family plus
extras, in a small order-processing service, to test whether medium/high/xhigh
separate where the shallow local-bug fixture saturated.
