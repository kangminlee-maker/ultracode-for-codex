import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const FAILING_SCRIPT = 'export const meta = { name: "always-fails", description: "Fail terminally without agents" };\nthrow new Error("intentional terminal failure");';
const SUCCEEDING_SCRIPT = 'export const meta = { name: "always-succeeds", description: "Succeed without agents" };\nreturn { ok: true };';
const RUN_ARGS = ['run', '--accept-llm-guide=v1', '--permission', 'allow', '--retry-limit', '0'];

async function makeCliContext() {
  const home = await mkdtemp(join(tmpdir(), 'ultracode-home-'));
  const work = await mkdtemp(join(tmpdir(), 'ultracode-work-'));
  tempDirs.push(home, work);
  return { cwd: work, env: { ...process.env, ULTRACODE_FOR_CODEX_HOME: home } };
}

function runCli(args, context) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], {
      cwd: context.cwd,
      env: context.env,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout,
        stderr,
      });
    });
  });
}

test('attached terminal failure writes a parseable failure record to stdout', async () => {
  const context = await makeCliContext();
  const result = await runCli([...RUN_ARGS, '--execution', 'attached', '--script', FAILING_SCRIPT], context);
  assert.equal(result.code, 1, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.kind, 'ultracode.workflow.failure');
  assert.equal(record.version, 1);
  assert.equal(record.status, 'failed');
  assert.equal(record.failure.workflowName, 'always-fails');
  assert.ok(record.failure.reason.length > 0);
  assert.match(record.failure.error, /intentional terminal failure/);
  assert.ok(record.failure.runId.length > 0);
});

test('attached success keeps stdout as the bare workflow result JSON', async () => {
  const context = await makeCliContext();
  const result = await runCli([...RUN_ARGS, '--execution', 'attached', '--script', SUCCEEDING_SCRIPT], context);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
});

test('background terminal failure leaves a parseable failure record in result.json', async () => {
  const context = await makeCliContext();
  const launch = await runCli([...RUN_ARGS, '--execution', 'background', '--script', FAILING_SCRIPT], context);
  assert.equal(launch.code, 0, launch.stderr);
  const launchRecord = JSON.parse(launch.stdout);

  const waited = await runCli(['wait', '--metadata-path', launchRecord.metadataPath, '--timeout-ms', '30000', '--interval-ms', '200'], context);
  assert.equal(waited.code, 1, waited.stdout + waited.stderr);
  assert.equal(JSON.parse(waited.stdout).status, 'failed');

  const record = JSON.parse(await readFile(launchRecord.resultPath, 'utf8'));
  assert.equal(record.kind, 'ultracode.workflow.failure');
  assert.equal(record.status, 'failed');
  assert.match(record.failure.error, /intentional terminal failure/);

  const printed = await runCli(['result', '--metadata-path', launchRecord.metadataPath], context);
  assert.equal(printed.code, 1);
  assert.equal(JSON.parse(printed.stdout).kind, 'ultracode.workflow.failure');

  // The failure record alone must classify the job when the progress JSONL
  // is lost: without it, a non-empty result file reads as completed.
  await writeFile(launchRecord.progressPath, '');
  const status = await runCli(['status', '--metadata-path', launchRecord.metadataPath], context);
  assert.equal(status.code, 0);
  const statusRecord = JSON.parse(status.stdout);
  assert.equal(statusRecord.status, 'failed');
  assert.equal(statusRecord.reason, record.failure.reason);
});

test('background success result.json still holds the bare workflow result', async () => {
  const context = await makeCliContext();
  const launch = await runCli([...RUN_ARGS, '--execution', 'background', '--script', SUCCEEDING_SCRIPT], context);
  assert.equal(launch.code, 0, launch.stderr);
  const launchRecord = JSON.parse(launch.stdout);

  const waited = await runCli(['wait', '--metadata-path', launchRecord.metadataPath, '--timeout-ms', '30000', '--interval-ms', '200', '--result'], context);
  assert.equal(waited.code, 0, waited.stdout + waited.stderr);
  assert.deepEqual(JSON.parse(waited.stdout), { ok: true });

  const printed = await runCli(['result', '--metadata-path', launchRecord.metadataPath], context);
  assert.equal(printed.code, 0);
  assert.deepEqual(JSON.parse(printed.stdout), { ok: true });
});
