#!/usr/bin/env node
// Live reliability study harness for ultracode-for-codex 0.4.2.
//
// Runs built-in workflows against the REAL Codex backend and tallies per-run
// outcomes. Safety (required for an unattended live LLM batch):
//   - per-run timeout with hard kill (stall detection);
//   - per-cell + global consecutive-failure circuit breaker;
//   - backoff after any failure (longer on rate-limit signature);
//   - hard global wall-clock budget;
//   - immediate append of each run record to JSONL (dead-letter + resumable);
//   - resume skips (cell,index) pairs already recorded.
//
// It never retries a failed run in place: a failure is recorded as data, not
// hidden by a retry. The runtime's own --retry-limit is set to 0 so each run is
// a single honest attempt.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const CLI = resolve(process.env.HOME, 'Documents/ultracode-for-codex/dist/cli.js');
const HERE = resolve('.');
const OUT = resolve(HERE, process.env.STUDY_OUT ?? 'reliability-runs.jsonl');
const TASK_FIXTURE = resolve(HERE, 'fixtures/task-fixture');
const REVIEW_FIXTURE = resolve(HERE, 'fixtures/review-fixture');

const N = Number.parseInt(process.env.STUDY_N ?? '15', 10);
const N_RESUME = Number.parseInt(process.env.STUDY_N_RESUME ?? '8', 10);
const PER_RUN_TIMEOUT_MS = Number.parseInt(process.env.STUDY_RUN_TIMEOUT_MS ?? '480000', 10);
const GLOBAL_BUDGET_MS = Number.parseInt(process.env.STUDY_BUDGET_MS ?? String(165 * 60 * 1000), 10);
const CELL_BREAKER = 3; // consecutive failures within a cell → skip rest of cell
const GLOBAL_BREAKER = 4; // consecutive failures across cells → abort study
const BACKOFF_MS = 6000;
const RATELIMIT_BACKOFF_MS = 45000;

const startedAt = Date.now();
function elapsedMs() { return Date.now() - startedAt; }
function log(msg) { process.stdout.write(`[study +${Math.round(elapsedMs() / 1000)}s] ${msg}\n`); }

// --- resumability -----------------------------------------------------------
const recorded = new Set();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.cell && Number.isInteger(r.index)) recorded.add(`${r.cell}#${r.index}`);
    } catch { /* skip malformed */ }
  }
  log(`resuming: ${recorded.size} runs already recorded`);
}

function record(rec) {
  appendFileSync(OUT, `${JSON.stringify(rec)}\n`);
}

function looksRateLimited(text) {
  return /rate.?limit|\b429\b|quota|too many requests|overloaded/i.test(text || '');
}

// --- one attached completion run -------------------------------------------
function runAttached({ cwd, name, args }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [
      CLI, 'run',
      '--accept-llm-guide=v1',
      '--execution', 'attached',
      '--permission', 'allow',
      '--retry-limit', '0',
      '--timeout-ms', String(PER_RUN_TIMEOUT_MS),
      '--cwd', cwd,
      '--name', name,
      '--args', JSON.stringify(args),
    ], { cwd: HERE });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const runStart = Date.now();
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
    }, PER_RUN_TIMEOUT_MS + 15000);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      resolveRun({ code, signal, stdout, stderr, wallMs: Date.now() - runStart });
    });
  });
}

function progressMetrics(stderr) {
  let agents = 0;
  let tokens = 0;
  let knownAgents = 0;
  let lastPhase = null;
  let startedSeen = false;
  for (const line of stderr.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event === 'workflow.started') startedSeen = true;
    if (e.event === 'workflow.agent.completed') {
      agents += 1;
      if (typeof e.tokens === 'number') tokens += e.tokens;
      if (typeof e.knownAgentCount === 'number') knownAgents = Math.max(knownAgents, e.knownAgentCount);
    }
    if (e.event === 'workflow.phase.started' && e.title) lastPhase = e.title;
  }
  return { agents, tokens, knownAgents, lastPhase, startedSeen };
}

function classify({ code, signal, stdout, stderr, wallMs }) {
  const metrics = progressMetrics(stderr);
  const base = { code, signal: signal ?? null, wallMs, ...metrics };
  // stall: our timeout killed it (SIGKILL) or exit without terminal record
  if (signal === 'SIGKILL') return { outcome: 'stalled', ...base };
  if (code === 130) return { outcome: 'aborted', ...base };
  let record;
  try { record = JSON.parse(stdout); } catch { record = null; }
  if (code === 0) {
    // completed: verify it traversed the real path and produced real output
    let semanticOk = false;
    if (record != null) {
      if (typeof record === 'string') semanticOk = record.trim().length > 0;
      else if (record.findings) semanticOk = Array.isArray(record.findings);
      else semanticOk = true;
    }
    return { outcome: 'completed', semanticOk, ...base };
  }
  // exit 1: expect a failure record
  if (record && record.kind === 'ultracode.workflow.failure') {
    return {
      outcome: 'failed',
      failureReason: record.failure?.reason ?? null,
      failurePhase: record.failure?.phase ?? null,
      failureError: (record.failure?.error ?? '').slice(0, 400),
      rateLimited: looksRateLimited(record.failure?.error) || looksRateLimited(stderr),
      ...base,
    };
  }
  return {
    outcome: 'error',
    failureError: (stderr.split('\n').filter(Boolean).slice(-3).join(' | ')).slice(0, 400),
    rateLimited: looksRateLimited(stderr),
    ...base,
  };
}

// --- kill-window + resume run ----------------------------------------------
function launchBackground({ cwd, name, args }) {
  const res = spawnSync(process.execPath, [
    CLI, 'run',
    '--accept-llm-guide=v1',
    '--execution', 'background',
    '--permission', 'allow',
    '--retry-limit', '0',
    '--timeout-ms', String(PER_RUN_TIMEOUT_MS),
    '--cwd', cwd,
    '--name', name,
    '--args', JSON.stringify(args),
  ], { cwd: HERE, encoding: 'utf8' });
  return JSON.parse(res.stdout);
}
function statusOf(metadataPath) {
  const res = spawnSync(process.execPath, [CLI, 'status', '--metadata-path', metadataPath], { encoding: 'utf8' });
  try { return JSON.parse(res.stdout); } catch { return null; }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function resumeRun(index) {
  const runStart = Date.now();
  const launch = launchBackground({
    cwd: TASK_FIXTURE,
    name: 'task',
    args: { prompt: 'Investigate whether truncate() in src/strings.js is correct for max=0 and for a multi-line string; state findings and propose fixes if needed.' },
  });
  // wait until the first agent has started (so there is a prefix to reuse)
  let runId = null;
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    const st = statusOf(launch.metadataPath);
    if (st?.runId) runId = st.runId;
    if (st && (st.completedAgentCount ?? 0) >= 1) break;
    if (st && st.status !== 'running' && st.status !== 'exited_unknown') break;
  }
  // kill the process mid-flight
  const st = statusOf(launch.metadataPath);
  if (st?.pid && pidAlive(st.pid)) process.kill(st.pid, 'SIGKILL');
  for (let i = 0; i < 40 && st?.pid && pidAlive(st.pid); i += 1) await sleep(250);
  if (!runId) {
    return { outcome: 'error', phase: 'pre-kill', note: 'no runId before kill', wallMs: Date.now() - runStart };
  }
  await sleep(1000);
  // resume from the killed run
  const resumed = await new Promise((resolveRun) => {
    const child = spawn(process.execPath, [
      CLI, 'run',
      '--accept-llm-guide=v1',
      '--execution', 'attached',
      '--permission', 'allow',
      '--retry-limit', '0',
      '--timeout-ms', String(PER_RUN_TIMEOUT_MS),
      '--cwd', TASK_FIXTURE,
      '--resume-from-run-id', runId,
    ], { cwd: HERE });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), PER_RUN_TIMEOUT_MS + 15000);
    child.on('close', (code, signal) => { clearTimeout(killer); resolveRun({ code, signal, stdout, stderr }); });
  });
  const c = classify({ ...resumed, wallMs: Date.now() - runStart });
  // detect cache reuse: journal-cached agent completions appear as cached=true
  const cachedHits = (resumed.stderr.match(/"cached":true/g) || []).length;
  return { ...c, runId, cachedHits, resumeCompleted: c.outcome === 'completed' };
}

// --- cells ------------------------------------------------------------------
const cells = [
  { cell: 'task', n: N, kind: 'attached', spec: { cwd: TASK_FIXTURE, name: 'task', args: { prompt: 'Review src/strings.js for correctness: check truncate() and wordCount() against edge cases (empty string, max=0, whitespace-only). Report any bugs with a one-line fix each.' } } },
  { cell: 'code-review-high', n: N, kind: 'attached', spec: { cwd: REVIEW_FIXTURE, name: 'code-review', args: { prompt: 'Review the pending change to src/account.js for correctness bugs.', level: 'high' } } },
  { cell: 'code-review-xhigh', n: N, kind: 'attached', spec: { cwd: REVIEW_FIXTURE, name: 'code-review', args: { prompt: 'Review the pending change to src/account.js for correctness bugs.', level: 'xhigh' } } },
  { cell: 'task-kill-resume', n: N_RESUME, kind: 'resume' },
];

let globalConsecFail = 0;
let abortStudy = false;

for (const cellDef of cells) {
  if (abortStudy) break;
  let cellConsecFail = 0;
  log(`=== cell ${cellDef.cell} (n=${cellDef.n}, kind=${cellDef.kind}) ===`);
  for (let index = 0; index < cellDef.n; index += 1) {
    if (recorded.has(`${cellDef.cell}#${index}`)) { log(`skip ${cellDef.cell}#${index} (recorded)`); continue; }
    if (elapsedMs() > GLOBAL_BUDGET_MS) { log(`GLOBAL WALL-CLOCK BUDGET reached; stopping`); abortStudy = true; break; }
    if (cellConsecFail >= CELL_BREAKER) { log(`CELL BREAKER tripped for ${cellDef.cell} after ${cellConsecFail} consecutive failures; skipping rest of cell`); break; }
    if (globalConsecFail >= GLOBAL_BREAKER) { log(`GLOBAL BREAKER tripped after ${globalConsecFail} consecutive failures; aborting study`); abortStudy = true; break; }

    const t0 = Date.now();
    let result;
    try {
      result = cellDef.kind === 'resume' ? await resumeRun(index) : classify(await runAttached(cellDef.spec));
    } catch (err) {
      result = { outcome: 'error', failureError: String(err?.message ?? err).slice(0, 400), wallMs: Date.now() - t0 };
    }
    const rec = { cell: cellDef.cell, index, ts: new Date().toISOString(), ...result };
    record(rec);
    const ok = rec.outcome === 'completed' || rec.resumeCompleted === true;
    log(`${cellDef.cell}#${index}: ${rec.outcome}${rec.failureReason ? ` (${rec.failureReason}/${rec.failurePhase})` : ''} agents=${rec.agents ?? '-'} tokens=${rec.tokens ?? '-'} wall=${Math.round((rec.wallMs ?? 0) / 1000)}s${rec.cachedHits !== undefined ? ` cached=${rec.cachedHits}` : ''}`);

    if (ok) { cellConsecFail = 0; globalConsecFail = 0; }
    else {
      cellConsecFail += 1; globalConsecFail += 1;
      const backoff = rec.rateLimited ? RATELIMIT_BACKOFF_MS : BACKOFF_MS;
      log(`failure #${globalConsecFail} global / #${cellConsecFail} cell; backing off ${Math.round(backoff / 1000)}s${rec.rateLimited ? ' (rate-limit signature)' : ''}`);
      await sleep(backoff);
    }
  }
}

log(`DONE. records at ${OUT}. total wall ${Math.round(elapsedMs() / 1000)}s`);
