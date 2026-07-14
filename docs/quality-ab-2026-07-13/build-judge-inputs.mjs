#!/usr/bin/env node
// Build blind-judge inputs from runs.jsonl. Strips the effort cell, assigns a
// stable opaque id (hash of cell#index, so ordering is decorrelated from the
// run order), and SEALS the id->cell mapping in a separate key file. The judge
// (and the operator writing the judge prompt) sees only opaque ids + finding
// text, so neither can bias toward a tier. Cells are re-joined only after the
// judge verdicts are in.
//
// Usage: node build-judge-inputs.mjs [runs.jsonl]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUNS = resolve(process.argv[2] ?? 'runs.jsonl');
const PREFIX = process.argv[3] ?? 'judge';
const INPUTS = resolve(`${PREFIX}-inputs.jsonl`);
const KEY = resolve(`${PREFIX}-key.jsonl`);
if (!existsSync(RUNS)) { process.stderr.write(`no runs file at ${RUNS}\n`); process.exit(1); }

const runs = readFileSync(RUNS, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const completed = runs.filter((r) => r.outcome === 'completed' && typeof r.resultText === 'string' && r.resultText.trim());

const rows = completed.map((r) => {
  const opaqueId = createHash('sha256').update(`${r.effort}#${r.index}`).digest('hex').slice(0, 10);
  return { opaqueId, cell: r.effort, index: r.index, resultText: r.resultText };
});
// Shuffle by opaque id so the file order carries no tier information.
rows.sort((a, b) => (a.opaqueId < b.opaqueId ? -1 : a.opaqueId > b.opaqueId ? 1 : 0));

writeFileSync(INPUTS, rows.map((r) => JSON.stringify({ opaqueId: r.opaqueId, resultText: r.resultText })).join('\n') + '\n');
writeFileSync(KEY, rows.map((r) => JSON.stringify({ opaqueId: r.opaqueId, cell: r.cell, index: r.index })).join('\n') + '\n');

const perCell = {};
for (const r of rows) perCell[r.cell] = (perCell[r.cell] ?? 0) + 1;
process.stdout.write(`judge inputs: ${rows.length} blind outputs -> ${INPUTS}\n`);
process.stdout.write(`sealed key   -> ${KEY}\n`);
process.stdout.write(`per cell: ${JSON.stringify(perCell)}\n`);
