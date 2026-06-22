#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const cliPath = join(repoRoot, 'dist', 'cli.js');
const timeoutMs = Number.parseInt(process.env.ULTRACODE_LIVE_SMOKE_TIMEOUT_MS ?? '180000', 10);

if (process.env.ULTRACODE_LIVE_SMOKE !== '1') {
  process.stdout.write('Skipping live smoke. Set ULTRACODE_LIVE_SMOKE=1 to run against the local Codex CLI.\n');
  process.exit(0);
}

run('npm', ['run', 'build']);

const workDir = await mkdtemp(join(tmpdir(), 'ultracode-for-codex-live-smoke-'));
try {
  await writeFile(join(workDir, 'README.md'), '# Ultracode for Codex live smoke\n');
  run('git', ['init'], { cwd: workDir });
  run('git', ['config', 'user.email', 'ultracode@example.invalid'], { cwd: workDir });
  run('git', ['config', 'user.name', 'Ultracode for Codex Live Smoke'], { cwd: workDir });
  run('git', ['add', 'README.md'], { cwd: workDir });
  run('git', ['commit', '-m', 'init'], { cwd: workDir });

  const launch = cli('run', [
    '--accept-llm-guide=v1',
    '--cwd',
    workDir,
    '--permission',
    'allow',
    '--timeout-ms',
    String(timeoutMs),
    '--script',
    'export const meta = { name: "live-smoke" };\nphase("Smoke");\nreturn await agent("Return exactly LIVE_SMOKE_OK.");',
  ]);
  assert.equal(launch.status, 0);
  const launchRecord = JSON.parse(launch.stdout);
  assert.equal(launchRecord.kind, 'ultracode.workflow.background');

  const wait = cli('wait', [
    launchRecord.jobId,
    '--cwd',
    workDir,
    '--timeout-ms',
    String(timeoutMs),
    '--interval-ms',
    '1000',
  ]);
  assert.equal(wait.status, 0, wait.stderr || wait.stdout);
  const status = JSON.parse(wait.stdout);
  assert.equal(status.status, 'completed');

  const result = cli('result', [launchRecord.jobId, '--cwd', workDir]);
  assert.equal(result.status, 0);
  const text = JSON.parse(result.stdout);
  assert.equal(typeof text, 'string');
  assert.match(text, /LIVE_SMOKE_OK/);
  process.stdout.write(`live smoke passed: ${workDir}\n`);
} finally {
  if (process.env.ULTRACODE_LIVE_SMOKE_KEEP_TEMP === '1') {
    process.stdout.write(`kept live smoke temp dir: ${workDir}\n`);
  } else {
    await rm(workDir, { recursive: true, force: true });
  }
}

function cli(command, args) {
  return spawnSync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout ?? '';
}
