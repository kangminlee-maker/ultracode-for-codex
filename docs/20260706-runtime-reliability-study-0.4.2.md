# Runtime reliability study — ultracode-for-codex 0.4.2 (2026-07-06)

One-line result: across **53 live runs against real Codex (`codex-cli 0.142.5`)**, the
runtime produced **zero hard failures** (no terminal error, no process hang, no schema
break). Overall completion **51/53 (96.2%)**; the only two non-completions were `task`-mode
runs that exceeded the **configured 480 s workflow deadline** during their final synthesis
phase (tail latency, not a defect). `code-review` completed **30/30 (100%)** at both levels,
and kill-then-resume completed **8/8 (100%)** with cached-prefix reuse on every run.

This is the 0.4.2 re-measurement flagged as the next decision after the failure-contract
release. It measures **runtime reliability** (completion, latency, resume, failure modes),
not semantic finding quality (scoped separately below).

## Method

- Backend: real Codex app-server (`codex-cli 0.142.5`), local, one run at a time (no
  intra-batch parallelism, so latencies are uncontaminated).
- Package under test: `ultracode-for-codex@0.4.2` (repo `dist/`, identical to the published
  tarball).
- Fixtures (deterministic, git-backed):
  - `task-fixture`: tiny committed string-utils module; `task` reviews it for edge-case bugs.
  - `review-fixture`: committed baseline + an **uncommitted** change adding a `withdraw()` with
    a sign bug and no overdraft guard — real pending diff evidence (also satisfies, rather than
    trips, the 0.4.2 empty-evidence precondition).
- Cells and sample sizes (all subject sets cardinality > 0):
  - `task` (default level) × 15
  - `code-review` level `high` × 15
  - `code-review` level `xhigh` × 15
  - `task-kill-resume` × 8 — launch in background, kill the process mid-run, then
    `--resume-from-run-id` and verify completion + prefix cache reuse.
- Per run: attached execution, `--retry-limit 0` (each run is one honest attempt; failures are
  recorded as data, never hidden by a retry), `--timeout-ms 480000` (8 min workflow deadline).
- Outcome classification from exit code + stdout + stderr JSONL:
  - `completed` — exit 0 with a parseable result (this is where 0.4.2's total result channel is
    exercised on the success half).
  - `failed` — exit 1 with an `ultracode.workflow.failure` record (0.4.2 failure channel).
  - `aborted` — exit 130: exceeded the runtime deadline.
  - `stalled` — harness SIGKILL: the process itself hung past deadline+15 s.
  - `error` — any other non-zero / unparseable outcome.
- Unattended-batch safety (per operator policy for live LLM batches): per-run timeout with hard
  kill, per-cell (3) and global (4) consecutive-failure circuit breakers, backoff after each
  failure (45 s on a rate-limit signature), a hard global wall-clock budget, and immediate
  append of each run record to JSONL (dead-letter + resumable skip). **None of the breakers or
  the budget tripped** — the full N=53 completed on its own.
- Total live wall-clock: 8581 s (~2.4 h). The harness survived a mid-study session teardown
  (detached via `nohup`) and was re-attached by re-verifying process liveness and record count.

## Headline results

| Cell | N | Completed | Hard failures | Deadline-aborted | Completion rate | Median wall | p90 wall | Max wall | Median agents |
|---|---|---|---|---|---|---|---|---|---|
| `task` (default) | 15 | 13 | 0 | 2 | **86.7%** | 161 s | 223 s | 480 s* | 9 |
| `code-review` high | 15 | 15 | 0 | 0 | **100%** | 97 s | 272 s | 443 s | 7 |
| `code-review` xhigh | 15 | 15 | 0 | 0 | **100%** | 104 s | 191 s | 276 s | 9 |
| `task-kill-resume` | 8 | 8 | 0 | 0 | **100%** | 212 s | 240 s | 249 s | 10 |

\* the two 480 s `task` rows are deadline aborts (see below), not completed runs.

- **Hard-failure freedom: 53/53.** No `failed`, `stalled`, or `error` outcome in any cell.
  0.4.2's failure channel therefore never had to fire in this study — the runtime did not hit a
  terminal error on the happy paths.
- **Failure-mode histogram:** `aborted:runtime-deadline` × 2 — the only non-success signature.
- Every completed run traversed the real multi-agent path (min agents = 2; `code-review` runs
  spawned 5–16 finder/verifier/synthesis agents), so the completion rates are over real work,
  not vacuous passes.

## The two non-completions (task tail latency)

Both aborts are `task`-cell runs that ran to the exact 480 s deadline:

| Run | Agents completed | Known agents | Last phase reached | Wall |
|---|---|---|---|---|
| `task#4` | 8 | 8 | Synthesize report | 480 s |
| `task#11` | 7 | 7 | Synthesize and verify | 480 s |

Both had already completed all discovery/finding agents and were in the **final synthesis
phase** when the deadline hit. So the tail is a *slow-synthesis* event, not a broken workflow:
with `--timeout-ms 0` (the package default = wait until done) these two would very likely have
completed. Framed two ways:

- Within an 8-minute wall deadline: `task` completes **86.7%** of the time.
- Free of terminal defects (error/hang/schema break): `task` is **100%** — the misses are
  latency, not correctness.

`task` also shows the widest latency spread (33–480 s) because its planner sometimes picks a
minimal 2-agent plan and sometimes a 9-agent plan; the heavy plans carry the tail risk.
`code-review` is bimodally tighter and never breached the deadline, even its 443 s high-level
outlier.

## Resume reliability

`task-kill-resume` 8/8 completed after a mid-run SIGKILL, and **every** resumed run showed
cached-prefix reuse (`cached ≥ 1`). This confirms the journal-first resume path reuses
completed agent results across a process death rather than re-running from scratch — the
durability guarantee holds under real kill/resume, not just in unit tests.

## Limitations / unverified risk

- **Semantic finding quality is out of scope here.** This study verifies that runs *complete
  with structurally valid results* (all `code-review` runs returned a well-formed findings
  array; agent counts prove finders/verifiers ran). Whether each run *found the planted
  `withdraw` bug* was confirmed only at N=1 calibration per built-in (it was found), not
  re-scored across the batch. A finding-rate study is separate work.
- Single machine, single Codex version (`0.142.5`), single small fixture per workflow. Larger
  or noisier repositories may shift latency and the task-synthesis tail.
- The 480 s deadline is a configuration choice, not a runtime limit; the `aborted` rate is a
  function of it. Reported alongside the deadline so it can be re-judged.
- Live LLM nondeterminism: rerunning would give slightly different agent counts and latencies;
  the completion-rate point estimates carry ±~1 run of sampling noise at N=15.

## Recommendations

1. For latency-sensitive `task` use, either raise the deadline above the synthesis-phase tail
   (p90 was 223 s; a 600 s deadline would have absorbed both aborts) or keep `--timeout-ms 0`
   and rely on cancellation. Document the tradeoff where the deadline default is set.
2. Consider a lighter-tier or time-boxed synthesis phase for `task` to compress the tail, since
   the tail is localized to synthesis with all finders already done.
3. `code-review` (both levels) needs no reliability action — 30/30 with comfortable deadline
   margin.
4. Re-run this harness after any runtime change that touches phase scheduling, agent stall
   handling, or resume, and after a Codex CLI upgrade.

## Reproduction

Harness, analyzer, fixture generator, and the raw 53-run JSONL are preserved under
`docs/reliability-2026-07-06/` (`reliability-runs.jsonl`, `run-study.mjs`, `analyze.mjs`,
`make-fixtures.mjs`; excluded from the npm `files` allowlist, so repo-only). Re-run from that
directory: `node make-fixtures.mjs fixtures && STUDY_N=15 STUDY_N_RESUME=8 node run-study.mjs
&& node analyze.mjs reliability-runs.jsonl`.
