#!/usr/bin/env node
// Deterministic fixture generator for the 0.4.2 reliability study.
// Creates two git repos under <root>:
//   task-fixture/        committed baseline + a bounded semantic task target
//   review-fixture/      committed baseline + an UNCOMMITTED change carrying a
//                        plausible bug, so code-review has real pending diff
//                        evidence (and the 0.4.2 empty-evidence precondition is
//                        satisfied, not tripped).
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'fixtures');
await rm(root, { recursive: true, force: true });

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}
async function initRepo(dir) {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'reliability@example.invalid']);
  git(dir, ['config', 'user.name', 'Reliability Study']);
}

// --- task fixture -----------------------------------------------------------
const taskDir = join(root, 'task-fixture');
await initRepo(taskDir);
await writeFile(join(taskDir, 'README.md'), '# Task fixture\n\nA tiny utility module for the reliability study.\n');
await mkdir(join(taskDir, 'src'), { recursive: true });
await writeFile(join(taskDir, 'src', 'strings.js'), `// Small string utilities.
export function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export function wordCount(text) {
  return text.trim().split(/\\s+/).length;
}
`);
git(taskDir, ['add', '.']);
git(taskDir, ['commit', '-qm', 'init string utilities']);

// --- code-review fixture ----------------------------------------------------
const reviewDir = join(root, 'review-fixture');
await initRepo(reviewDir);
await writeFile(join(reviewDir, 'README.md'), '# Review fixture\n\nBaseline account balance helper.\n');
await mkdir(join(reviewDir, 'src'), { recursive: true });
// Baseline: correct, committed.
await writeFile(join(reviewDir, 'src', 'account.js'), `// Account balance helper.
export function applyTransactions(balance, transactions) {
  let next = balance;
  for (const tx of transactions) {
    next += tx.amount;
  }
  return next;
}
`);
git(reviewDir, ['add', '.']);
git(reviewDir, ['commit', '-qm', 'init account helper']);
// Uncommitted change carrying a plausible off-by-context bug: withdrawals are
// added instead of subtracted, and no overdraft guard. This is real reviewable
// diff evidence for code-review.
await writeFile(join(reviewDir, 'src', 'account.js'), `// Account balance helper.
export function applyTransactions(balance, transactions) {
  let next = balance;
  for (const tx of transactions) {
    // Withdrawals and deposits both use tx.amount; the sign is trusted.
    next += tx.amount;
  }
  return next;
}

export function withdraw(balance, amount) {
  // Bug: adds instead of subtracting, and no overdraft guard.
  return balance + amount;
}
`);

process.stdout.write(`${JSON.stringify({ root, taskDir, reviewDir }, null, 2)}\n`);
