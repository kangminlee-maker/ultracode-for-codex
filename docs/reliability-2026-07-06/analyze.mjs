#!/usr/bin/env node
// Deterministic analyzer for the reliability study JSONL.
// Computes per-cell completion rate, latency/agent/token characterization,
// failure-mode histogram, and resume success rate — with subject cardinality
// stated so no rate is claimed over an empty set.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? 'reliability-runs.jsonl');
const rows = readFileSync(OUT, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function mean(xs) { return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null; }
function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a (0 runs)'; }

const cells = [...new Set(rows.map((r) => r.cell))];
const report = { generatedAt: new Date().toISOString(), source: OUT, totalRuns: rows.length, cells: {}, failureModes: {} };

for (const cell of cells) {
  const cr = rows.filter((r) => r.cell === cell);
  const isResume = cell.includes('resume');
  const success = cr.filter((r) => (isResume ? r.resumeCompleted === true : r.outcome === 'completed'));
  const failed = cr.filter((r) => r.outcome === 'failed');
  const stalled = cr.filter((r) => r.outcome === 'stalled');
  const errored = cr.filter((r) => r.outcome === 'error');
  const aborted = cr.filter((r) => r.outcome === 'aborted');
  const wallS = cr.map((r) => Math.round((r.wallMs ?? 0) / 1000)).filter((x) => x > 0);
  const agents = success.map((r) => r.agents ?? 0).filter((x) => x > 0);
  const tokens = success.map((r) => r.tokens ?? 0).filter((x) => x > 0);
  report.cells[cell] = {
    n: cr.length,
    completed: success.length,
    failed: failed.length,
    stalled: stalled.length,
    errored: errored.length,
    aborted: aborted.length,
    completionRate: pct(success.length, cr.length),
    wallSeconds: { mean: mean(wallS), median: median(wallS), max: wallS.length ? Math.max(...wallS) : null },
    agentsPerRun: { mean: mean(agents), median: median(agents), max: agents.length ? Math.max(...agents) : null },
    tokensPerRun: { mean: mean(tokens), median: median(tokens) },
    ...(isResume ? { cacheReuse: { runsWithCachedPrefix: success.filter((r) => (r.cachedHits ?? 0) > 0).length, meanCachedHits: mean(success.map((r) => r.cachedHits ?? 0)) } } : {}),
    semanticOkAmongCompleted: isResume ? undefined : `${success.filter((r) => r.semanticOk !== false).length}/${success.length}`,
  };
}

// failure-mode histogram: every non-success outcome. aborted = exceeded the
// configured runtime deadline (tail latency), distinct from failed (terminal
// error record) and stalled (harness-killed process hang).
for (const r of rows.filter((x) => !(x.outcome === 'completed' || x.resumeCompleted === true))) {
  const key = r.outcome === 'aborted'
    ? 'aborted:runtime-deadline'
    : `${r.outcome}:${r.failureReason ?? '-'}@${r.failurePhase ?? '-'}`;
  report.failureModes[key] = (report.failureModes[key] ?? 0) + 1;
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
