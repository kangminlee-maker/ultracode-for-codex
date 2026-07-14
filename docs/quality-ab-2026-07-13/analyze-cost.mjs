#!/usr/bin/env node
// Per-cell latency / token / agent distribution for a runs file (completed runs
// only). The depth arm's headline is the latency gradient, so this reports the
// cost side that grade.mjs (recall) does not. Usage: node analyze-cost.mjs runs.jsonl
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runs = readFileSync(resolve(process.argv[2] ?? 'runs.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const cells = ['medium', 'high', 'xhigh'];

function q(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const sec = (ms) => (ms == null ? 'n/a' : (ms / 1000).toFixed(0));

process.stdout.write(`\n=== Per-cell cost (completed runs) — ${process.argv[2] ?? 'runs.jsonl'} ===\n`);
process.stdout.write(`${'cell'.padEnd(8)}${'n'.padStart(4)}${'dur med'.padStart(9)}${'dur p90'.padStart(9)}${'dur max'.padStart(9)}${'tok med'.padStart(10)}${'agents med'.padStart(12)}${'stalled'.padStart(9)}\n`);
for (const cell of cells) {
  const all = runs.filter((r) => r.effort === cell);
  const done = all.filter((r) => r.outcome === 'completed');
  const stalled = all.filter((r) => r.outcome !== 'completed').length;
  const durs = done.map((r) => r.durationMs).filter((x) => typeof x === 'number');
  const toks = done.map((r) => r.tokens).filter((x) => typeof x === 'number' && x > 0);
  const ags = done.map((r) => r.agents).filter((x) => typeof x === 'number');
  process.stdout.write(
    `${cell.padEnd(8)}${String(done.length).padStart(4)}` +
    `${sec(q(durs, 0.5)).padStart(9)}${sec(q(durs, 0.9)).padStart(9)}${sec(q(durs, 1)).padStart(9)}` +
    `${String(Math.round(q(toks, 0.5) ?? 0)).padStart(10)}${String(Math.round(q(ags, 0.5) ?? 0)).padStart(12)}${String(stalled).padStart(9)}\n`,
  );
}
process.stdout.write('\n(dur in seconds; tok = agent tokens; stalled = ran past the cap without completing)\n');
