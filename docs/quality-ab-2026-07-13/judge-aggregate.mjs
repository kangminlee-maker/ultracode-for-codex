#!/usr/bin/env node
// Aggregate blind-judge verdicts (SECONDARY signal) and cross-check them against
// the deterministic grader (PRIMARY signal). Un-seals the cell key only here,
// after the verdicts are fixed. Reports, per cell: judge-view detection recall,
// mean false-positive count, mean finding-quality; and the agreement between the
// judge's detection and the deterministic signatures per bug (a different-kind
// cross-check — divergence is informative, not error).
//
// Inputs: judge-verdicts.jsonl (opaqueId-keyed), judge-key.jsonl, graded.jsonl
// Usage: node judge-aggregate.mjs
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { BUGS } = await import(process.env.AB_TRUTH ?? './ground-truth.mjs');

function loadJsonl(p) {
  if (!existsSync(p)) { process.stderr.write(`missing ${p}\n`); process.exit(1); }
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const verdicts = loadJsonl(resolve(process.env.JUDGE_VERDICTS ?? 'judge-verdicts.jsonl'));
const key = loadJsonl(resolve(process.env.JUDGE_KEY ?? 'judge-key.jsonl'));
const gradedPath = resolve(process.env.AB_GRADED ?? 'graded.jsonl');
const graded = existsSync(gradedPath) ? loadJsonl(gradedPath) : [];

const cellOf = new Map(key.map((k) => [k.opaqueId, { cell: k.cell, index: k.index }]));
const gradedBy = new Map(graded.map((g) => [`${g.cell}#${g.index}`, g]));
const cells = ['medium', 'high', 'xhigh'];
const bugIds = BUGS.map((b) => b.id);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = (v, p = 1) => (v == null ? 'n/a' : v.toFixed(p));

const perCell = Object.fromEntries(cells.map((c) => [c, { recall: [], fp: [], quality: [] }]));
let agree = 0; let compared = 0;
const perBugAgree = Object.fromEntries(bugIds.map((id) => [id, { agree: 0, n: 0 }]));

for (const v of verdicts) {
  const meta = cellOf.get(v.opaqueId);
  if (!meta) continue;
  const det = v.detection ?? {};
  const foundCount = bugIds.filter((id) => det[id] === true).length;
  perCell[meta.cell].recall.push(foundCount / bugIds.length);
  if (typeof v.falsePositiveCount === 'number') perCell[meta.cell].fp.push(v.falsePositiveCount);
  if (typeof v.qualityScore === 'number') perCell[meta.cell].quality.push(v.qualityScore);

  // cross-check vs deterministic grader for the same run
  const g = gradedBy.get(`${meta.cell}#${meta.index}`);
  if (g) {
    for (const id of bugIds) {
      const detFound = det[id] === true;
      const sigFound = g.perBug.find((b) => b.id === id)?.found === true;
      compared += 1; perBugAgree[id].n += 1;
      if (detFound === sigFound) { agree += 1; perBugAgree[id].agree += 1; }
    }
  }
}

process.stdout.write(`\n=== Blind-judge signal by cell (secondary) ===\n`);
process.stdout.write(`${'cell'.padEnd(8)}${'n'.padStart(4)}${'recall%'.padStart(9)}${'FP/run'.padStart(9)}${'quality0-3'.padStart(12)}\n`);
for (const cell of cells) {
  const c = perCell[cell];
  const recall = mean(c.recall);
  process.stdout.write(
    `${cell.padEnd(8)}${String(c.recall.length).padStart(4)}` +
    `${(recall == null ? 'n/a' : (recall * 100).toFixed(1)).padStart(9)}` +
    `${fmt(mean(c.fp), 2).padStart(9)}${fmt(mean(c.quality), 2).padStart(12)}\n`,
  );
}

process.stdout.write(`\n=== Judge vs deterministic detection agreement ===\n`);
process.stdout.write(`overall: ${compared ? ((agree / compared) * 100).toFixed(1) : 'n/a'}%  (${agree}/${compared} bug-decisions agree)\n`);
for (const id of bugIds) {
  const b = perBugAgree[id];
  process.stdout.write(`  ${id.padEnd(16)} ${b.n ? ((b.agree / b.n) * 100).toFixed(0) : 'n/a'}%  (${b.agree}/${b.n})\n`);
}
