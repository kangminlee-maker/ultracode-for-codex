#!/usr/bin/env node
// Split the blind judge inputs into K shard files for parallel judging.
// Each shard is a JSON array of { opaqueId, resultText } — no cell info — so the
// judging subagents stay blind. Usage: node make-shards.mjs [shardSize]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INPUTS = resolve(process.argv[2] ?? 'judge-inputs.jsonl');
const size = Number.parseInt(process.argv[3] ?? '5', 10);
const OUTPREFIX = process.argv[4] ?? 'shard';
if (!existsSync(INPUTS)) { process.stderr.write(`missing ${INPUTS}\n`); process.exit(1); }

const rows = readFileSync(INPUTS, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
let k = 0;
for (let i = 0; i < rows.length; i += size, k += 1) {
  const shard = rows.slice(i, i + size);
  writeFileSync(resolve(`${OUTPREFIX}-${k}.json`), JSON.stringify(shard, null, 2) + '\n');
}
process.stdout.write(`${rows.length} outputs -> ${k} shard(s) of up to ${size} (${OUTPREFIX}-0.json..${OUTPREFIX}-${k - 1}.json)\n`);
