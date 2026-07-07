#!/usr/bin/env node
// W3 A/B: run the built-in `task` at --reasoning-effort high, same fixture /
// prompt as the reliability baseline (which ran at the default xhigh). Compare
// to decide whether task should default to a lower effort tier. No product code
// changes — measures the runtime as-is via the effort knob.
//
// Event-driven completion: the CLI currently hangs ~2min on process EXIT after
// a run completes in seconds (an account/auth-layer cleanup issue, not the
// workflow). So we stream stderr, record on the terminal event using the
// workflow.completed durationMs (exit overhead excluded = the true workflow
// latency), then kill the child's process group. Genuine stalls (no terminal
// event within the cap) are recorded as stalled.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const CLI = resolve(process.env.HOME, 'Documents/ultracode-for-codex/dist/cli.js');
const HERE = resolve('.');
const OUT = resolve(HERE, 'w3-high-runs.jsonl');
const FIXTURE = resolve(HERE, 'fixtures/task-fixture');
const N = Number.parseInt(process.env.W3_N ?? '15', 10);
const EFFORT = process.env.W3_EFFORT ?? 'high';
const HARD_CAP_MS = 480000;      // genuine-stall threshold (no terminal event)
const GRACE_MS = 4000;           // let stdout + post-completion events flush
const CELL_BREAKER = 3;
const BACKOFF_MS = 6000;
const PROMPT = 'Review src/strings.js for correctness: check truncate() and wordCount() against edge cases (empty string, max=0, whitespace-only). Report any bugs with a one-line fix each.';

const start = Date.now();
const log = (m) => process.stdout.write(`[w3 +${Math.round((Date.now() - start) / 1000)}s] ${m}\n`);

const done = new Set();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).index); } catch { /* skip */ }
  }
  log(`resuming: ${done.size} recorded`);
}

function runTask() {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [
      CLI, 'run', '--accept-llm-guide=v1', '--execution', 'attached', '--permission', 'allow',
      '--retry-limit', '0', '--timeout-ms', String(HARD_CAP_MS), '--reasoning-effort', EFFORT,
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

let consecFail = 0;
for (let index = 0; index < N; index += 1) {
  if (done.has(index)) { log(`skip #${index}`); continue; }
  if (consecFail >= CELL_BREAKER) { log(`BREAKER after ${consecFail} consecutive failures; stopping`); break; }
  const r = await runTask();
  const text = (() => { try { return JSON.stringify(JSON.parse(r.stdout)); } catch { return r.stdout || ''; } })();
  const foundWordCountBug = /wordCount/i.test(text) && /(empty|''|"")/.test(text);
  const rec = {
    index, effort: EFFORT, outcome: r.outcome,
    durationMs: r.durationMs, observedWallMs: r.wallMs,
    agents: r.agents, tokens: r.tokens, foundWordCountBug,
    resultChars: (r.stdout || '').length, ts: new Date().toISOString(),
  };
  appendFileSync(OUT, `${JSON.stringify(rec)}\n`);
  const secs = r.durationMs != null ? Math.round(r.durationMs / 1000) : Math.round(r.wallMs / 1000);
  log(`#${index}: ${r.outcome} agents=${r.agents} tokens=${r.tokens} dur=${secs}s bugFound=${foundWordCountBug}`);
  if (r.outcome === 'completed') consecFail = 0;
  else { consecFail += 1; await sleep(BACKOFF_MS); }
}
log(`DONE. records at ${OUT}. total ${Math.round((Date.now() - start) / 1000)}s`);
