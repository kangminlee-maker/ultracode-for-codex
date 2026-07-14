#!/usr/bin/env node
// Deterministic grader (PRIMARY signal) for the quality A/B.
// Reads runs.jsonl (one record per live `task` run, each carrying the run's
// final result text) and scores recall of the 7 ground-truth bugs per run,
// then aggregates per effort cell. No LLM, no judge: reproducible and
// falsifiable. Writes graded.jsonl and prints the recall table.
//
// Usage: node grade.mjs [runs.jsonl]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// AB_TRUTH selects the ground-truth module (shallow default, or the depth arm).
const TRUTH = process.env.AB_TRUTH ?? './ground-truth.mjs';
const { BUGS, gradeText } = await import(TRUTH);

const RUNS = resolve(process.argv[2] ?? 'runs.jsonl');
const OUT = resolve(process.env.AB_GRADED ?? 'graded.jsonl');
if (!existsSync(RUNS)) {
  process.stderr.write(`no runs file at ${RUNS}\n`);
  process.exit(1);
}

const runs = readFileSync(RUNS, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

function resultText(run) {
  // The runner stores the parsed final result under `resultText` when it could
  // extract it; fall back to raw stdout.
  if (typeof run.resultText === 'string' && run.resultText) return run.resultText;
  if (typeof run.stdout === 'string') {
    try { return JSON.stringify(JSON.parse(run.stdout)); } catch { return run.stdout; }
  }
  return '';
}

const graded = [];
for (const run of runs) {
  const g = gradeText(resultText(run));
  graded.push({
    index: run.index, cell: run.effort, outcome: run.outcome,
    recall: g.recall, foundCount: g.foundCount, total: g.total,
    perBug: g.perBug, durationMs: run.durationMs, agents: run.agents, tokens: run.tokens,
  });
}
writeFileSync(OUT, graded.map((g) => JSON.stringify(g)).join('\n') + '\n');

// Aggregate per cell (completed runs only — a deadline/stall run has no honest
// finding set to grade).
const cells = ['medium', 'high', 'xhigh'];
function stats(nums) {
  if (!nums.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const s = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: nums.length, mean, median, min: s[0], max: s[s.length - 1] };
}

process.stdout.write(`\n=== Deterministic recall by cell (completed runs) ===\n`);
process.stdout.write(`bugs=${BUGS.length}  runs graded=${graded.length}\n\n`);
const byCell = {};
for (const cell of cells) {
  const done = graded.filter((g) => g.cell === cell && g.outcome === 'completed');
  const recalls = done.map((g) => g.recall);
  const st = stats(recalls);
  byCell[cell] = { done, st };
  const pct = st.mean == null ? 'n/a' : `${(st.mean * 100).toFixed(1)}%`;
  const medPct = st.median == null ? 'n/a' : `${(st.median * 100).toFixed(0)}%`;
  process.stdout.write(
    `${cell.padEnd(7)} n=${String(st.n).padStart(2)}  mean recall=${pct.padStart(6)}  median=${medPct.padStart(4)}  ` +
    `foundCount[min..max]=${st.min == null ? '-' : Math.round(st.min * BUGS.length)}..${st.max == null ? '-' : Math.round(st.max * BUGS.length)}\n`,
  );
}

// Per-bug detection rate by cell — exposes which bug classes separate the tiers.
process.stdout.write(`\n=== Per-bug detection rate (fraction of completed runs that found it) ===\n`);
const header = 'bug'.padEnd(28) + cells.map((c) => c.padStart(9)).join('') + '   class/difficulty\n';
process.stdout.write(header);
for (const bug of BUGS) {
  const row = cells.map((cell) => {
    const done = byCell[cell].done;
    if (!done.length) return 'n/a'.padStart(9);
    const hit = done.filter((g) => g.perBug.find((b) => b.id === bug.id)?.found).length;
    return `${((hit / done.length) * 100).toFixed(0)}%`.padStart(9);
  }).join('');
  process.stdout.write(`${bug.id.padEnd(28)}${row}   ${bug.class}/${bug.difficulty}\n`);
}
process.stdout.write(`\ngraded -> ${OUT}\n`);
