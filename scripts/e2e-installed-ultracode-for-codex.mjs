#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const args = process.argv.slice(2);
const keepTemp = args.includes('--keep-temp');
const outDir = resolve(repoRoot, readValueArg('--out-dir') ?? 'artifacts');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const REQUEST_TIMEOUT_MS = 10_000;

const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const artifactPath = join(outDir, packageArtifactName(pkg.name, pkg.version));

run(process.execPath, [join(repoRoot, 'scripts/package-ultracode-for-codex.mjs'), '--out-dir', outDir]);

const consumerDir = await mkdtemp(join(tmpdir(), 'ultracode-for-codex-e2e-consumer-'));
const externalWorktreeStore = join(dirname(consumerDir), '.ultracode-for-codex-worktrees');
const codexHome = join(consumerDir, '.codex-home');
const fakeCodexPath = join(consumerDir, 'fake-codex.cjs');

try {
  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2));
  await mkdir(join(consumerDir, '.codex', 'workflows'), { recursive: true });
  await writeFile(
    join(consumerDir, '.codex', 'workflows', 'installed-project-permission.js'),
    installedProjectPermissionWorkflowSource(),
  );
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), '{"token":"local-e2e"}\n');
  await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-e2e-model"\n');
  await writeFile(fakeCodexPath, fakeCodexSource());
  await chmod(fakeCodexPath, 0o755);

  run(npm, ['install', '--save-dev', '--no-audit', '--no-fund', artifactPath], { cwd: consumerDir });
  await initializeGitRepo(consumerDir);

  const installedCli = join(consumerDir, 'node_modules', 'ultracode-for-codex', 'dist', 'cli.js');
  assertInstalledVersion(installedCli);
  await assertBackgroundDefault(installedCli);
  await assertCliSmoke(installedCli);
  await assertBuiltinPlanProgress(installedCli);
  await assertPlainProgress(installedCli);
  await assertPermissionAllow(installedCli);
  await assertRetry(installedCli);
  await assertCancel(installedCli);
  await assertBackgroundCancel(installedCli);

  const journals = await findFiles(join(consumerDir, '.ultracode-for-codex'), 'journal.jsonl');
  assert.ok(journals.length >= 4);
  process.stdout.write('installed ultracode-for-codex E2E passed (boundary_stub: fake Codex app-server, CLI run)\n');
} finally {
  if (keepTemp) {
    process.stdout.write(`kept E2E consumer temp dir: ${consumerDir}\n`);
  } else {
    await rm(consumerDir, { recursive: true, force: true });
    await rm(externalWorktreeStore, { recursive: true, force: true });
  }
}

function readValueArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: options.env ?? (command === npm ? npmEnvWithoutDryRun() : process.env),
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout ?? '';
}

function npmEnvWithoutDryRun() {
  const env = { ...process.env };
  delete env.npm_config_dry_run;
  return env;
}

async function initializeGitRepo(dir) {
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n.ultracode-for-codex/\n');
  await writeFile(join(dir, 'README.md'), '# installed ultracode-for-codex e2e\n');
  run('git', ['init'], { cwd: dir });
  run('git', ['config', 'user.email', 'ultracode@example.invalid'], { cwd: dir });
  run('git', ['config', 'user.name', 'Ultracode for Codex E2E'], { cwd: dir });
  run('git', ['add', '.gitignore', 'README.md'], { cwd: dir });
  run('git', ['commit', '-m', 'init'], { cwd: dir });
}

function assertInstalledVersion(installedCli) {
  const result = spawnSync(process.execPath, [installedCli, '--version'], {
    cwd: consumerDir,
    encoding: 'utf8',
    env: cliEnv(),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `ultracode-for-codex ${pkg.version}\n`);
  assert.equal(result.stderr, '');
}

function packageArtifactName(name, version) {
  const normalizedName = String(name).replace(/^@/, '').replace(/\//g, '-');
  return `${normalizedName}-${version}.tgz`;
}

function installedProjectPermissionWorkflowSource() {
  return `export const meta = {
  name: "installed-project-permission",
  description: "Verify packaged project workflow permission review"
};
return { source: "installed-project", value: args.value };`;
}

async function assertBackgroundDefault(installedCli) {
  const result = runCli(installedCli, [
    '--script',
    'export const meta = { name: "installed-background-default", phases: [{ title: "Background", detail: "Verify default execution mode" }] };\nphase("Background");\nlog("background default done");\nreturn { background: true };',
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const launch = JSON.parse(result.stdout);
  assert.equal(launch.kind, 'ultracode.workflow.background');
  assert.equal(launch.version, 1);
  assert.equal(launch.status, 'launched');
  assert.equal(typeof launch.jobId, 'string');
  assert.equal(typeof launch.pid, 'number');
  assert.match(launch.resultPath, /result\.json$/);
  assert.match(launch.progressPath, /progress\.jsonl$/);
  assert.match(launch.metadataPath, /metadata\.json$/);
  assert.match(launch.pidPath, /pid$/);

  const resultJson = await waitForJsonFile(launch.resultPath, REQUEST_TIMEOUT_MS);
  assert.deepEqual(resultJson, { background: true });
  const progress = await waitForProgressFile(launch.progressPath, REQUEST_TIMEOUT_MS);
  assertProgressEvent(progress, 'workflow.started', { workflowName: 'installed-background-default' });
  assertProgressEvent(progress, 'workflow.phase.started', { title: 'Background', detail: 'Verify default execution mode' });
  assertProgressEvent(progress, 'workflow.log', { message: 'background default done' });
  assertProgressEvent(progress, 'workflow.completed', { status: 'completed' });
  await waitForProgressEvent(launch.progressPath, 'workflow.review.recommended', REQUEST_TIMEOUT_MS);
  const metadata = JSON.parse(await readFile(launch.metadataPath, 'utf8'));
  assert.equal(metadata.jobId, launch.jobId);
  assert.equal(metadata.pid, launch.pid);

  const waitResult = runCliCommand(installedCli, 'wait', [
    launch.jobId,
    '--cwd',
    consumerDir,
    '--timeout-ms',
    String(REQUEST_TIMEOUT_MS),
    '--interval-ms',
    '50',
  ]);
  assert.equal(waitResult.status, 0);
  const waitStatus = JSON.parse(waitResult.stdout);
  assert.equal(waitStatus.kind, 'ultracode.workflow.background.status');
  assert.equal(waitStatus.status, 'completed');
  assert.equal(waitStatus.jobId, launch.jobId);
  assert.equal(waitStatus.resultReady, true);

  const waitResultJson = runCliCommand(installedCli, 'wait', [
    launch.jobId,
    '--cwd',
    consumerDir,
    '--result',
    '--timeout-ms',
    String(REQUEST_TIMEOUT_MS),
    '--interval-ms',
    '50',
  ]);
  assert.equal(waitResultJson.status, 0);
  assert.deepEqual(JSON.parse(waitResultJson.stdout), { background: true });

  const statusResult = runCliCommand(installedCli, 'status', [launch.jobId, '--cwd', consumerDir]);
  assert.equal(statusResult.status, 0);
  const status = JSON.parse(statusResult.stdout);
  assert.equal(status.status, 'completed');
  assert.equal(status.lastEvent, 'workflow.completed');

  const statusPlain = runCliCommand(installedCli, 'status', [launch.jobId, '--cwd', consumerDir, '--plain']);
  assert.equal(statusPlain.status, 0);
  assert.match(statusPlain.stdout, new RegExp(`\\[job\\] ${launch.jobId} completed`));

  const logsResult = runCliCommand(installedCli, 'logs', [launch.jobId, '--cwd', consumerDir, '--tail', '20']);
  assert.equal(logsResult.status, 0);
  const logEvents = progressEvents(logsResult.stdout);
  assertProgressEvent(logEvents, 'workflow.completed', { status: 'completed' });
  const summaryEvent = assertProgressEvent(logEvents, 'workflow.summary.ready', { status: 'completed' });
  assert.equal(summaryEvent.totalPhaseCount, 1);
  assert.equal(summaryEvent.phasesSummary[0].title, 'Background');
  assert.equal(summaryEvent.phasesSummary[0].agentCount, 0);
  assertProgressEvent(logEvents, 'workflow.review.recommended', { status: 'review_recommended' });

  const logsFiltered = runCliCommand(installedCli, 'logs', [launch.jobId, '--cwd', consumerDir, '--event', 'workflow.completed']);
  assert.equal(logsFiltered.status, 0);
  const filteredEvents = progressEvents(logsFiltered.stdout);
  assert.equal(filteredEvents.length, 1);
  assert.equal(filteredEvents[0].event, 'workflow.completed');

  const logsPlain = runCliCommand(installedCli, 'logs', [launch.jobId, '--cwd', consumerDir, '--event', 'workflow.completed', '--plain']);
  assert.equal(logsPlain.status, 0);
  assert.match(logsPlain.stdout, /\[workflow\.completed\] status=completed/);

  const resultCommand = runCliCommand(installedCli, 'result', [launch.jobId, '--cwd', consumerDir]);
  assert.equal(resultCommand.status, 0);
  assert.deepEqual(JSON.parse(resultCommand.stdout), { background: true });

  const jobsCommand = runCliCommand(installedCli, 'jobs', ['--cwd', consumerDir]);
  assert.equal(jobsCommand.status, 0);
  const jobs = JSON.parse(jobsCommand.stdout);
  assert.equal(jobs.kind, 'ultracode.workflow.background.jobs');
  assert.ok(jobs.jobs.some((job) => job.jobId === launch.jobId && job.status === 'completed'));

  const listPlain = runCliCommand(installedCli, 'list', ['--cwd', consumerDir, '--plain']);
  assert.equal(listPlain.status, 0);
  assert.match(listPlain.stdout, new RegExp(`${launch.jobId} completed`));

  const archiveCommand = runCliCommand(installedCli, 'archive', [launch.jobId, '--cwd', consumerDir]);
  assert.equal(archiveCommand.status, 0);
  const archive = JSON.parse(archiveCommand.stdout);
  assert.equal(archive.kind, 'ultracode.workflow.background.archive.created');
  assert.equal(archive.jobId, launch.jobId);
  const archiveRecord = JSON.parse(await readFile(archive.archivePath, 'utf8'));
  assert.equal(archiveRecord.kind, 'ultracode.workflow.background.archive');
  assert.equal(archiveRecord.status.status, 'completed');
  assert.deepEqual(JSON.parse(archiveRecord.resultText), { background: true });

  const exportPath = join(consumerDir, '.ultracode-for-codex', 'archive', `${launch.jobId}-export.json`);
  const exportCommand = runCliCommand(installedCli, 'export', [
    launch.jobId,
    '--cwd',
    consumerDir,
    '--output-path',
    exportPath,
    '--plain',
  ]);
  assert.equal(exportCommand.status, 0);
  assert.match(exportCommand.stdout, /\[archive\]/);
  JSON.parse(await readFile(exportPath, 'utf8'));
}

async function assertCliSmoke(installedCli) {
  const workflowPath = join(consumerDir, 'installed-workflow-smoke.js');
  await writeFile(workflowPath, `export const meta = {
  name: "installed-workflow-smoke",
  description: "Verify packaged ultracode workflow runtime",
  phases: [{ title: "Run", detail: "Call the installed fake Codex backend" }]
};
phase("Run");
const result = await agent("Return OK for installed workflow.", { label: "installed-agent" });
const structured = await agent("Return structured installed workflow result.", {
  label: "installed-structured-agent",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      detail: { type: "string" },
      count: { type: "integer" }
    },
    required: ["detail", "count"]
  }
});
log("installed workflow done");
return { topic: args.topic, result, structured };`);
  const result = runCliAttached(installedCli, [
    '--script-file',
    workflowPath,
    '--args',
    '{"topic":"installed-e2e"}',
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 0);
  const progress = progressEvents(result.stderr);
  assertProgressEvent(progress, 'workflow.started', { status: 'running', workflowName: 'installed-workflow-smoke' });
  assertProgressEvent(progress, 'workflow.phase.started', { title: 'Run', detail: 'Call the installed fake Codex backend' });
  assertProgressEvent(progress, 'workflow.agent.started', { agentIndex: 0, label: 'installed-agent' });
  const firstCompletion = assertProgressEvent(progress, 'workflow.agent.completed', {
    agentIndex: 0,
    label: 'installed-agent',
    completedAgentCount: 1,
    knownAgentCount: 1,
    phaseCompletedAgentCount: 1,
    phaseKnownAgentCount: 1,
  });
  assert.match(firstCompletion.summary, /Phase Run \(1\/1\), 1 out of 1 agents have completed the task, \d+s elapsed/);
  assertProgressEvent(progress, 'workflow.completed', { status: 'completed', agentCount: 2 });
  const summary = assertProgressEvent(progress, 'workflow.summary.ready', { status: 'completed' });
  assert.deepEqual(summary.phasesSummary.map((phase) => phase.title), ['Run']);
  assert.deepEqual(summary.phasesSummary[0].agents.map((agent) => agent.label), [
    'installed-agent',
    'installed-structured-agent',
  ]);
  const recommendation = assertProgressEvent(progress, 'workflow.review.recommended', { status: 'review_recommended' });
  assert.match(recommendation.recommendation, /critically re-check/);
  assert.deepEqual(JSON.parse(result.stdout), {
    topic: 'installed-e2e',
    result: 'OK',
    structured: { detail: 'OK', count: 2 },
  });
}

async function assertBuiltinPlanProgress(installedCli) {
  const result = runCliAttached(installedCli, [
    '--name',
    'task',
    '--args',
    '{"prompt":"Check the packaged built-in phase plan progress."}',
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 0);
  const progress = progressEvents(result.stderr);
  const plan = assertProgressEvent(progress, 'workflow.plan.ready', {
    status: 'planned',
    mode: 'phase_parallel',
    phaseCount: 1,
  });
  assert.equal(plan.planPhases[0].title, 'Inspect');
  assert.deepEqual(plan.planPhases[0].agents.map((agent) => agent.label), [
    'task-inspect-runtime',
    'task-inspect-tests',
  ]);
  const phasePlan = assertProgressEvent(progress, 'workflow.phase.planned', { title: 'Inspect', plannedAgentCount: 2 });
  assert.deepEqual(phasePlan.plannedAgents.map((agent) => agent.label), [
    'task-inspect-runtime',
    'task-inspect-tests',
  ]);
  const phase = assertProgressEvent(progress, 'workflow.phase.started', { title: 'Inspect', plannedAgentCount: 2 });
  assert.deepEqual(phase.plannedAgents.map((agent) => agent.label), [
    'task-inspect-runtime',
    'task-inspect-tests',
  ]);
  assertProgressEvent(progress, 'workflow.agent.started', { label: 'task-inspect-runtime' });
  assertProgressEvent(progress, 'workflow.agent.started', { label: 'task-inspect-tests' });
  assertProgressEvent(progress, 'workflow.completed', { status: 'completed' });
  const summary = assertProgressEvent(progress, 'workflow.summary.ready', { status: 'completed' });
  assert.equal(summary.totalPhaseCount, 1);
  assert.deepEqual(summary.phasesSummary[0].agents.map((agent) => agent.label), [
    'task-inspect-runtime',
    'task-inspect-tests',
  ]);
  assertProgressEvent(progress, 'workflow.review.recommended', { status: 'review_recommended' });
}

async function assertPlainProgress(installedCli) {
  const result = runCliAttached(installedCli, [
    '--script',
    'export const meta = { name: "installed-plain-progress" };\nphase("Plain");\nreturn await agent("Return OK for plain progress.", { label: "plain-agent" });',
    '--permission',
    'allow',
    '--progress',
    'plain',
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /\[workflow\] started installed-plain-progress/);
  assert.match(result.stderr, /\[phase\] Plain/);
  assert.match(result.stderr, /\[agent:1\] started plain-agent/);
  assert.match(result.stderr, /\[agent:1\] completed plain-agent \| Phase Plain \(1\/1\), 1 out of 1 agents have completed the task, \d+s elapsed \| tokens=/);
  assert.match(result.stderr, /\[workflow\] completed/);
  assert.equal(JSON.parse(result.stdout), 'OK');
}

async function assertPermissionAllow(installedCli) {
  const result = runCliAttached(installedCli, [
    '--name',
    'installed-project-permission',
    '--args',
    '{"value":7}',
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 0);
  assertProgressEvent(progressEvents(result.stderr), 'workflow.permission.required', {
    status: 'waiting_for_permission',
    workflowName: 'installed-project-permission',
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    source: 'installed-project',
    value: 7,
  });
}

async function assertRetry(installedCli) {
  const result = runCliAttached(installedCli, [
    '--script',
    'export const meta = { name: "installed-retry" };\nreturn await agent("FAIL_ONCE");',
    '--retry-limit',
    '1',
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 0);
  const progress = progressEvents(result.stderr);
  assertProgressEvent(progress, 'workflow.agent.failed', { agentIndex: 0, label: 'FAIL_ONCE' });
  assertProgressEvent(progress, 'workflow.failed', { status: 'failed' });
  assertProgressEvent(progress, 'workflow.terminal_failure', { status: 'failed' });
  assertProgressEvent(progress, 'workflow.retrying', { status: 'retrying', retryIndex: 1, retryLimit: 1 });
  assertProgressEvent(progress, 'workflow.completed', { status: 'completed' });
  assert.equal(JSON.parse(result.stdout), 'OK');
}

async function assertCancel(installedCli) {
  const child = spawnCliAttached(installedCli, [
    '--script',
    'export const meta = { name: "installed-cancel-smoke" };\nawait agent("WAIT");\nreturn "never";',
    '--permission',
    'allow',
  ]);
  await waitForOutput(child, '"event":"workflow.agent.started"', REQUEST_TIMEOUT_MS);
  child.kill('SIGINT');
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 130);
  const progress = progressEvents(child.collectedStderr);
  assertProgressEvent(progress, 'workflow.cancel.requested', { status: 'cancelling' });
  assertProgressEvent(progress, 'workflow.failed', { reason: 'workflow_aborted' });
  assertProgressEvent(progress, 'workflow.terminal_failure', { reason: 'workflow_aborted' });
  assert.equal(progress.some((event) => event.event === 'workflow.review.recommended'), false);
}

async function assertBackgroundCancel(installedCli) {
  const result = runCli(installedCli, [
    '--script',
    'export const meta = { name: "installed-background-cancel" };\nawait agent("WAIT");\nreturn "never";',
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 0);
  const launch = JSON.parse(result.stdout);
  await waitForProgressEvent(launch.progressPath, 'workflow.agent.started', REQUEST_TIMEOUT_MS);

  const cancelResult = runCliCommand(installedCli, 'cancel', [
    launch.jobId,
    '--cwd',
    consumerDir,
    '--wait',
    '--timeout-ms',
    String(REQUEST_TIMEOUT_MS),
    '--interval-ms',
    '50',
  ]);
  assert.equal(cancelResult.status, 0);
  const cancel = JSON.parse(cancelResult.stdout);
  assert.equal(cancel.kind, 'ultracode.workflow.background.cancel.wait');
  assert.equal(cancel.cancel.status, 'signalled');
  assert.equal(cancel.cancel.jobId, launch.jobId);
  assert.equal(cancel.cancel.signal, 'SIGINT');
  assert.equal(cancel.cancel.identityVerified, true);
  assert.equal(cancel.terminalStatus.status, 'failed');
  assert.equal(cancel.terminalStatus.reason, 'workflow_aborted');

  const logsResult = runCliCommand(installedCli, 'logs', [launch.jobId, '--cwd', consumerDir]);
  assert.equal(logsResult.status, 0);
  const progress = progressEvents(logsResult.stdout);
  assertProgressEvent(progress, 'workflow.cancel.requested', { status: 'cancelling' });
  assertProgressEvent(progress, 'workflow.terminal_failure', { reason: 'workflow_aborted' });
}

function runCli(installedCli, extraArgs) {
  return spawnSync(process.execPath, [installedCli, ...baseCliArgs(), ...extraArgs], {
    cwd: consumerDir,
    encoding: 'utf8',
    env: cliEnv(),
  });
}

function runCliCommand(installedCli, command, extraArgs = []) {
  return spawnSync(process.execPath, [installedCli, command, ...extraArgs], {
    cwd: consumerDir,
    encoding: 'utf8',
    env: cliEnv(),
  });
}

function runCliAttached(installedCli, extraArgs) {
  return runCli(installedCli, ['--execution', 'attached', ...extraArgs]);
}

function spawnCliAttached(installedCli, extraArgs) {
  const child = spawn(process.execPath, [installedCli, ...baseCliArgs(), '--execution', 'attached', ...extraArgs], {
    cwd: consumerDir,
    env: cliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.collectedStdout = '';
  child.collectedStderr = '';
  child.stdout.on('data', (chunk) => {
    child.collectedStdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    child.collectedStderr += chunk;
  });
  return child;
}

function baseCliArgs() {
  return [
    'run',
    '--accept-llm-guide',
    'v1',
    '--command',
    fakeCodexPath,
    '--cwd',
    consumerDir,
    '--timeout-ms',
    String(REQUEST_TIMEOUT_MS),
  ];
}

function cliEnv() {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: 'fake-anthropic-key',
    ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic',
    CODEX_HOME: codexHome,
    FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV: '1',
    FAKE_EXPECT_CLIENT_VERSION: pkg.version,
    OPENAI_API_KEY: 'fake-openai-key',
    OPENAI_BASE_URL: 'https://example.invalid/openai',
  };
}

async function waitForOutput(child, text, timeoutMs) {
  if (child.collectedStdout.includes(text) || child.collectedStderr.includes(text)) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error([
        `Timed out waiting for CLI output: ${text}`,
        '--- stdout ---',
        child.collectedStdout,
        '--- stderr ---',
        child.collectedStderr,
      ].join('\n')));
    }, timeoutMs);

    const onData = () => {
      if (!child.collectedStdout.includes(text) && !child.collectedStderr.includes(text)) return;
      cleanup();
      resolve();
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error([
        `CLI exited before expected output: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        '--- stdout ---',
        child.collectedStdout,
        '--- stderr ---',
        child.collectedStderr,
      ].join('\n')));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

function progressEvents(stderr) {
  return stderr
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForJsonFile(path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = await readFile(path, 'utf8');
      if (text.trim()) return JSON.parse(text);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for JSON file: ${path}`);
}

async function waitForProgressFile(path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = await readFile(path, 'utf8');
      const events = progressEvents(text);
      if (events.some((event) => event.event === 'workflow.completed' || event.event === 'workflow.failed')) {
        return events;
      }
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for progress file: ${path}`);
}

async function waitForProgressEvent(path, eventName, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = await readFile(path, 'utf8');
      const events = progressEvents(text);
      const match = events.find((event) => event.event === eventName);
      if (match) return match;
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for progress event ${eventName}: ${path}`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assertProgressEvent(events, eventName, expected = {}) {
  const match = events.find((event) => (
    event.kind === 'ultracode.workflow.progress'
    && event.version === 1
    && event.event === eventName
    && Object.entries(expected).every(([key, value]) => event[key] === value)
  ));
  assert.ok(match, `Expected progress event ${eventName} with ${JSON.stringify(expected)} in ${JSON.stringify(events, null, 2)}`);
  assert.equal(typeof match.summary, 'string');
  assert.ok(match.summary.length > 0);
  return match;
}

async function findFiles(root, fileName) {
  const found = [];
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const filePath = join(dir, name);
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) await walk(filePath);
      else if (fileStat.isFile() && name === fileName) found.push(filePath);
    }
  }
  await walk(root);
  return found;
}

function fakeCodexSource() {
  return String.raw`#!/usr/bin/env node
const readline = require('node:readline');

assertNoDirectProviderEnv();

let threadSeq = 0;
let turnSeq = 0;
const failOnceCounts = new Map();

function write(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function result(id, value = {}) {
  write({ id, result: value });
}

function inputText(payload) {
  return JSON.stringify(payload.params && payload.params.input || []);
}

function usage() {
  return {
    totalTokens: 9,
    inputTokens: 5,
    cachedInputTokens: 2,
    outputTokens: 2,
    reasoningOutputTokens: 0,
  };
}

function emitTurn(threadId, turnId, text) {
  write({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, delta: text },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
  setTimeout(() => {
    write({
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage: { last: usage() } },
    });
  }, 0);
}

function emitFailedTurn(threadId, turnId, message) {
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'failed', error: { message } },
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }

  if (payload.id === undefined) return;
  if (payload.method === 'initialize') {
    if (process.env.FAKE_EXPECT_CLIENT_VERSION && payload.params?.clientInfo?.version !== process.env.FAKE_EXPECT_CLIENT_VERSION) {
      process.stderr.write('unexpected clientInfo.version: ' + payload.params?.clientInfo?.version + '\n');
      process.exit(92);
    }
    result(payload.id);
    return;
  }
  if (payload.method === 'thread/start') {
    threadSeq += 1;
    result(payload.id, { thread: { id: 'thread_' + threadSeq } });
    return;
  }
  if (payload.method === 'turn/start') {
    turnSeq += 1;
    const threadId = payload.params && payload.params.threadId || 'thread_' + threadSeq;
    const turnId = 'turn_' + turnSeq;
    const input = inputText(payload);
    const hasWorkspaceContext = input.includes('Use the deterministic workspace context below')
      || input.includes('## Workspace Context');
    result(payload.id, { turn: { id: turnId } });
    const effort = payload.params && payload.params.effort;
    const outputSchema = payload.params && payload.params.outputSchema;
    if (outputSchema?.properties?.phases) {
      setTimeout(() => emitTurn(threadId, turnId, JSON.stringify({
        mode: 'phase_parallel',
        rationale: 'E2E fake planner defaulted to parallel phase execution.',
        phases: [{
          id: 'inspect',
          title: 'Inspect',
          goal: 'Inspect runtime behavior before synthesis.',
          agents: [
            { id: 'runtime', title: 'Runtime', focus: 'Check runtime behavior.' },
            { id: 'tests', title: 'Tests', focus: 'Check tests and coverage.' },
          ],
        }],
      })), 0);
      return;
    }
    if (input.includes('WAIT') && !hasWorkspaceContext) return;
    if (input.includes('FAIL_ONCE') && !hasWorkspaceContext) {
      const count = failOnceCounts.get(input) || 0;
      failOnceCounts.set(input, count + 1);
      if (count === 0) {
        setTimeout(() => emitFailedTurn(threadId, turnId, 'failed once'), 0);
        return;
      }
    }
    const text = input.includes('Return structured installed workflow result.')
      ? outputSchema?.properties?.detail && outputSchema?.properties?.count && effort === 'xhigh'
        ? '{"detail":"OK","count":2}'
        : '{"detail":"NOT_XHIGH","count":0}'
      : input.includes('Return OK for installed workflow.')
      ? effort === 'xhigh' ? 'OK' : 'NOT_XHIGH'
      : effort === 'medium' ? 'MEDIUM_OK' : 'OK';
    setTimeout(() => emitTurn(threadId, turnId, text), 0);
    return;
  }
  if (payload.method === 'turn/interrupt' || payload.method === 'thread/archive') {
    result(payload.id);
    return;
  }

  write({
    id: payload.id,
    error: { code: -32601, message: 'unsupported fake Codex method: ' + payload.method },
  });
});

rl.on('close', () => process.exit(0));

function assertNoDirectProviderEnv() {
  if (process.env.FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV !== '1') return;
  const found = Object.keys(process.env).filter(isDirectProviderEnvName);
  if (found.length > 0) {
    process.stderr.write('direct provider env leaked to installed fake codex: ' + found.join(',') + '\n');
    process.exit(91);
  }
}

function isDirectProviderEnvName(name) {
  const prefixes = [
    'ANTHROPIC',
    'AZURE_OPENAI',
    'COHERE',
    'DEEPSEEK',
    'GEMINI',
    'GOOGLE',
    'GROQ',
    'MISTRAL',
    'OPENAI',
    'OPENROUTER',
    'PERPLEXITY',
    'TOGETHER',
    'XAI',
  ];
  const suffixes = [
    'ACCESS_TOKEN',
    'API_BASE',
    'API_KEY',
    'AUTH_TOKEN',
    'BASE_URL',
    'ENDPOINT',
    'ORG_ID',
    'ORGANIZATION',
    'PROJECT',
  ];
  return prefixes.some((prefix) => suffixes.some((suffix) => name === prefix + '_' + suffix));
}
`;
}
