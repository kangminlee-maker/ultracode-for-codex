#!/usr/bin/env node
// Live 3-cell quality A/B runner: built-in `task` at --reasoning-effort
// medium / high / xhigh, N runs each, on the committed cart-fixture. Measures
// finding QUALITY (recall of planted bugs, graded separately); W3 already
// established cost/latency are tier-independent for `task`.
//
// Cells are round-robin interleaved (medium,high,xhigh, medium,high,xhigh, ...)
// so any drift in account throttling / model state over the ~2h batch hits all
// three cells evenly instead of confounding one. The runner is resumable
// (keyed by cell#index), records each run immediately, and carries per-cell +
// global consecutive-failure circuit breakers with backoff (unattended-batch
// safety). Completion is event-driven (finalize on the terminal workflow event,
// then kill the child's process group) to sidestep the post-completion exit
// overhead some accounts show.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

import { readFileSync as readFileSyncTop } from 'node:fs';
const CLI = resolve(process.env.HOME, 'Documents/ultracode-for-codex/dist/cli.js');
const HERE = resolve('.');
const OUT = resolve(HERE, process.env.AB_OUT ?? 'runs.jsonl');
const FIXTURE = resolve(HERE, process.env.AB_FIXTURE ?? 'fixtures/cart-fixture');
const CELLS = (process.env.AB_CELLS ?? 'medium,high,xhigh').split(',').map((s) => s.trim()).filter(Boolean);
const N = Number.parseInt(process.env.AB_N ?? '15', 10);
const HARD_CAP_MS = Number.parseInt(process.env.AB_CAP_MS ?? '480000', 10); // genuine-stall threshold
const GRACE_MS = 4000;          // let stdout + post-completion events flush
const CELL_BREAKER = 3;         // consecutive failures within one cell
const GLOBAL_BREAKER = 4;       // consecutive failures across all cells
const BACKOFF_MS = 8000;        // base backoff after a failure
const RATE_BACKOFF_MS = 45000;  // longer backoff on a rate-limit signature

const DEFAULT_PROMPT = [
  'Review src/cart.js for correctness bugs. It holds pricing and inventory logic',
  'for a checkout flow. For each bug you find, name the function, describe the',
  'incorrect behavior, and give a one-line fix. Be thorough: consider edge cases',
  'and boundary conditions.',
].join(' ');
// AB_PROMPT_FILE points at a text file whose contents are the prompt (used for
// the multi-file depth arm); otherwise the default single-file cart prompt.
const PROMPT = process.env.AB_PROMPT_FILE
  ? readFileSyncTop(resolve(process.env.AB_PROMPT_FILE), 'utf8').trim()
  : DEFAULT_PROMPT;

const start = Date.now();
const log = (m) => process.stdout.write(`[ab +${Math.round((Date.now() - start) / 1000)}s] ${m}\n`);
const key = (cell, index) => `${cell}#${index}`;

const done = new Set();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); done.add(key(r.effort, r.index)); } catch { /* skip */ }
  }
  log(`resuming: ${done.size} recorded`);
}

function extractResultText(stdout) {
  // `task` returns a final synthesis string. The CLI prints the run result as
  // JSON on stdout; capture the string payload when present, else the raw text.
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.result === 'string') return parsed.result;
      return JSON.stringify(parsed);
    }
  } catch { /* not JSON */ }
  return stdout || '';
}

function runOne(cell) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [
      CLI, 'run', '--accept-llm-guide=v1', '--execution', 'attached', '--permission', 'allow',
      '--retry-limit', '0', '--timeout-ms', String(HARD_CAP_MS), '--reasoning-effort', cell,
      '--cwd', FIXTURE, '--name', 'task', '--args', JSON.stringify({ prompt: PROMPT }),
    ], { cwd: HERE, detached: true });

    let stdout = ''; let stderr = ''; let buf = '';
    let agents = 0; let tokens = 0; let durationMs = null; let terminal = null;
    let finished = false; let graceTimer = null;
    const t0 = Date.now();

    const reap = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ } };
    const finalize = (outcome) => {
      if (finished) return; finished = true;
      clearTimeout(hardTimer); if (graceTimer) clearTimeout(graceTimer);
      reap();
      resolveRun({ outcome, stdout, stderr, agents, tokens, durationMs, wallMs: Date.now() - t0 });
    };

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => {
      stderr += d; buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.event === 'workflow.agent.completed') { agents += 1; if (typeof e.tokens === 'number') tokens += e.tokens; }
        else if (e.event === 'workflow.completed') { durationMs = typeof e.durationMs === 'number' ? e.durationMs : null; if (!terminal) { terminal = 'completed'; graceTimer = setTimeout(() => finalize('completed'), GRACE_MS); } }
        else if ((e.event === 'workflow.failed' || e.event === 'workflow.terminal_failure') && !terminal) { terminal = 'failed'; graceTimer = setTimeout(() => finalize('failed'), GRACE_MS); }
      }
    });
    const hardTimer = setTimeout(() => finalize('stalled'), HARD_CAP_MS);
    child.on('error', () => finalize('error'));
    child.on('close', () => { if (!finished) finalize(terminal || 'exited'); });
  });
}

const total = CELLS.length * N;
let consecGlobal = 0;
const consecCell = Object.fromEntries(CELLS.map((c) => [c, 0]));

for (let index = 0; index < N; index += 1) {
  for (const cell of CELLS) {
    if (done.has(key(cell, index))) { log(`skip ${key(cell, index)}`); continue; }
    if (consecGlobal >= GLOBAL_BREAKER) { log(`GLOBAL BREAKER after ${consecGlobal} consecutive failures; stopping`); process.exit(2); }
    if (consecCell[cell] >= CELL_BREAKER) { log(`cell ${cell} breaker (${consecCell[cell]} fails); skipping remaining ${cell}`); continue; }

    const r = await runOne(cell);
    const resultText = extractResultText(r.stdout);
    const rec = {
      cell, effort: cell, index, outcome: r.outcome,
      durationMs: r.durationMs, observedWallMs: r.wallMs,
      agents: r.agents, tokens: r.tokens,
      resultChars: resultText.length, resultText,
      ts: new Date().toISOString(),
    };
    appendFileSync(OUT, `${JSON.stringify(rec)}\n`);
    const secs = r.durationMs != null ? Math.round(r.durationMs / 1000) : Math.round(r.wallMs / 1000);
    const recorded = done.size + 1; done.add(key(cell, index));
    log(`${key(cell, index)}: ${r.outcome} agents=${r.agents} tokens=${r.tokens} dur=${secs}s chars=${resultText.length}  [${recorded}/${total}]`);

    if (r.outcome === 'completed') { consecGlobal = 0; consecCell[cell] = 0; }
    else {
      consecGlobal += 1; consecCell[cell] += 1;
      const rateHit = /rate.?limit|429|too many requests/i.test(r.stderr);
      await sleep(rateHit ? RATE_BACKOFF_MS : BACKOFF_MS);
    }
  }
}
log(`DONE. records at ${OUT}. total ${Math.round((Date.now() - start) / 1000)}s`);
