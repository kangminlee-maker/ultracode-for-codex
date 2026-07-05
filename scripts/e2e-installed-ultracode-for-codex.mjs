#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  cp,
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
const ultracodeHome = `${consumerDir}-ultracode-home`;
const fakeCodexPath = join(consumerDir, 'fake-codex.cjs');
// Keep turn records outside the consumer workspace so they never perturb
// review evidence snapshots or resume cache identity.
const fakeTurnsPath = `${consumerDir}-fake-codex-turns.jsonl`;

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

  const installedPackageDir = join(consumerDir, 'node_modules', 'ultracode-for-codex');
  const installedCli = join(installedPackageDir, 'dist', 'cli.js');
  assertInstalledVersion(installedCli);
  await assertSkillCommandPackageContents(installedPackageDir);
  await assertSkillCommandInstall(installedPackageDir, installedCli);
  await assertNpmExecRun();
  await assertBackgroundDefault(installedCli);
  await assertCliSmoke(installedCli);
  await assertBuiltinPlanProgress(installedCli);
  const codeReviewRun = await assertBuiltinCodeReviewJsonl(installedCli);
  await assertBuiltinCodeReviewResume(installedCli, codeReviewRun);
  await assertBuiltinCodeReviewPlain(installedCli);
  await assertBuiltinCodeReviewInvalidEvidence(installedCli);
  await assertInstalledReviewEvidenceContext(installedCli);
  await assertValidateMode(installedCli);
  await assertPlainProgress(installedCli);
  await assertPermissionAllow(installedCli);
  await assertRetry(installedCli);
  await assertCancel(installedCli);
  await assertBackgroundCancel(installedCli);

  const journals = await findFiles(ultracodeHome, 'journal.jsonl');
  assert.ok(journals.length >= 4);
  process.stdout.write('installed ultracode-for-codex E2E passed (boundary_stub: fake Codex app-server, CLI run)\n');
} finally {
  if (keepTemp) {
    process.stdout.write(`kept E2E consumer temp dir: ${consumerDir}\n`);
    process.stdout.write(`kept E2E ultracode home: ${ultracodeHome}\n`);
  } else {
    await rm(consumerDir, { recursive: true, force: true });
    await rm(externalWorktreeStore, { recursive: true, force: true });
    await rm(ultracodeHome, { recursive: true, force: true });
    await rm(fakeTurnsPath, { force: true });
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

async function assertSkillCommandPackageContents(installedPackageDir) {
  const nativeSkill = await readFile(join(installedPackageDir, 'skills', 'ultracode-for-codex', 'SKILL.md'), 'utf8');
  const nativeAgent = await readFile(join(installedPackageDir, 'skills', 'ultracode-for-codex', 'agents', 'openai.yaml'), 'utf8');
  const nativeProgressVisuals = await readFile(join(installedPackageDir, 'skills', 'ultracode-for-codex', 'references', 'progress-visuals.md'), 'utf8');
  const cliSkill = await readFile(join(installedPackageDir, 'skills', 'ultracode-for-codex-cli', 'SKILL.md'), 'utf8');
  const cliAgent = await readFile(join(installedPackageDir, 'skills', 'ultracode-for-codex-cli', 'agents', 'openai.yaml'), 'utf8');
  assert.match(nativeSkill, /^name: ultracode-for-codex$/m);
  assert.match(nativeSkill, /Codex main context as the orchestrator/);
  assert.match(nativeSkill, /delegate fan-out phases to the local CLI runtime/);
  assert.match(nativeSkill, /--resume-from-run-id/);
  assert.match(nativeSkill, /--validate/);
  assert.match(nativeSkill, /Situation Choice Matrix/);
  assert.match(nativeSkill, /cumulative ledger/);
  assert.match(nativeSkill, /references\/progress-visuals\.md/);
  assert.match(nativeAgent, /Run hybrid phase-wise parallel orchestration/);
  assert.match(nativeProgressVisuals, /Cumulative Ledger Rule/);
  assert.match(nativeProgressVisuals, /Situation Choice Matrix/);
  assert.match(nativeProgressVisuals, /Each row has at most three user-facing/);
  assert.match(nativeProgressVisuals, /Do not present profile names/);
  assert.match(nativeProgressVisuals, /Ordinary or mixed work/);
  assert.match(nativeProgressVisuals, /Review or audit/);
  assert.match(nativeProgressVisuals, /Release or install/);
  assert.equal(countSituationRows(nativeProgressVisuals), 6);
  assert.doesNotMatch(nativeProgressVisuals, /Default Visualization Profile/);
  assert.doesNotMatch(nativeProgressVisuals, /Work Progress/);
  assert.doesNotMatch(nativeProgressVisuals, /Review And Evidence/);
  assert.doesNotMatch(nativeProgressVisuals, /Release And Recovery/);
  assert.match(nativeProgressVisuals, /Default Live Snapshot/);
  assert.match(nativeProgressVisuals, /Completion Impact Summary/);
  assert.match(nativeProgressVisuals, /Plan-Style Result Summary/);
  assert.match(nativeProgressVisuals, /Research Pattern Map/);
  assert.match(nativeProgressVisuals, /Building Block Examples/);
  assert.match(nativeProgressVisuals, /Risk Or Audit Table/);
  assert.match(nativeProgressVisuals, /Context Coverage Matrix/);
  assert.match(cliSkill, /^name: ultracode-for-codex-cli$/m);
  assert.match(cliSkill, /npm package and CLI runtime surface/);
  assert.match(cliSkill, /The default `\$ultracode-for-codex` skill is Codex-native/);
  assert.match(cliSkill, /dynamic lenses/);
  assert.match(cliSkill, /candidate verification/);
  assert.match(cliSkill, /--resume-from-run-id/);
  assert.match(cliAgent, /Operate the Ultracode for Codex npm CLI runtime/);
}

async function assertSkillCommandInstall(installedPackageDir, installedCli) {
  const skillsRoot = join(codexHome, 'skills');
  await rm(skillsRoot, { recursive: true, force: true });

  const missing = runCliCommand(installedCli, 'skills');
  assert.equal(missing.status, 0, missing.stderr);
  const missingReport = JSON.parse(missing.stdout);
  assert.equal(missingReport.kind, 'ultracode.skills');
  assert.equal(missingReport.action, 'status');
  assert.deepEqual(missingReport.skills.map((skill) => skill.state), ['missing', 'missing']);

  const install = runCliCommand(installedCli, 'skills', ['--install']);
  assert.equal(install.status, 0, install.stderr);
  const installReport = JSON.parse(install.stdout);
  assert.equal(installReport.action, 'install');
  assert.deepEqual(installReport.skills.map((skill) => skill.state), ['current', 'current']);

  for (const name of ['ultracode-for-codex', 'ultracode-for-codex-cli']) {
    const destination = join(skillsRoot, name);
    const installedSkill = await readFile(join(destination, 'SKILL.md'), 'utf8');
    const installedAgent = await readFile(join(destination, 'agents', 'openai.yaml'), 'utf8');
    assert.match(installedSkill, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(installedAgent, /display_name:/);
    assert.match(installedAgent, /default_prompt:/);
  }
  const installedVisuals = await readFile(join(skillsRoot, 'ultracode-for-codex', 'references', 'progress-visuals.md'), 'utf8');
  assert.match(installedVisuals, /Cumulative Ledger Rule/);
  assert.match(installedVisuals, /Situation Choice Matrix/);
  assert.equal(countSituationRows(installedVisuals), 6);
  assert.doesNotMatch(installedVisuals, /Default Visualization Profile/);
  assert.match(installedVisuals, /Default Live Snapshot/);
  assert.match(installedVisuals, /Completion Impact Summary/);
  assert.match(installedVisuals, /Research Pattern Map/);

  // A locally edited skill file is reported stale and repaired by --install.
  const nativeSkillPath = join(skillsRoot, 'ultracode-for-codex', 'SKILL.md');
  await writeFile(nativeSkillPath, `${await readFile(nativeSkillPath, 'utf8')}\nlocal drift\n`);
  const stale = runCliCommand(installedCli, 'skills');
  assert.deepEqual(JSON.parse(stale.stdout).skills.map((skill) => skill.state), ['stale', 'current']);
  const repaired = runCliCommand(installedCli, 'skills', ['--install']);
  assert.deepEqual(JSON.parse(repaired.stdout).skills.map((skill) => skill.state), ['current', 'current']);

  // A foreign skill folder with the same name is never overwritten.
  await rm(join(skillsRoot, 'ultracode-for-codex-cli'), { recursive: true, force: true });
  await mkdir(join(skillsRoot, 'ultracode-for-codex-cli'), { recursive: true });
  await writeFile(join(skillsRoot, 'ultracode-for-codex-cli', 'SKILL.md'), '---\nname: something-else\n---\n');
  const unmanaged = runCliCommand(installedCli, 'skills');
  assert.deepEqual(JSON.parse(unmanaged.stdout).skills.map((skill) => skill.state), ['current', 'unmanaged']);
  const refused = runCliCommand(installedCli, 'skills', ['--install']);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /refusing to overwrite/);
  await rm(join(skillsRoot, 'ultracode-for-codex-cli'), { recursive: true, force: true });
  const restored = runCliCommand(installedCli, 'skills', ['--install']);
  assert.deepEqual(JSON.parse(restored.stdout).skills.map((skill) => skill.state), ['current', 'current']);
}

function countSituationRows(content) {
  return [...content.matchAll(/^\| (Ordinary or mixed work|Design or planning|Implementation|Review or audit|Release or install|Retry, cancellation, or long-running work) \| [^|]+ \| [^|]+ \| [^|]+ \|$/gm)].length;
}

async function assertNpmExecRun() {
  const result = spawnSync(npm, [
    'exec',
    '--',
    'ultracode-for-codex',
    'run',
    '--accept-llm-guide',
    'v1',
    '--command',
    fakeCodexPath,
    '--cwd',
    consumerDir,
    '--timeout-ms',
    String(REQUEST_TIMEOUT_MS),
    '--execution',
    'attached',
    '--script',
    'export const meta = { name: "installed-npm-exec-run" };\nphase("NpmExec");\nreturn await agent("Return OK for npm exec workflow.", { label: "npm-exec-agent" });',
    '--permission',
    'allow',
  ], {
    cwd: consumerDir,
    encoding: 'utf8',
    env: cliEnv(),
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  assert.equal(result.status, 0);
  assertProgressEvent(progressEvents(result.stderr), 'workflow.started', {
    status: 'running',
    workflowName: 'installed-npm-exec-run',
  });
  assertProgressEvent(progressEvents(result.stderr), 'workflow.agent.completed', {
    label: 'npm-exec-agent',
  });
  assert.equal(JSON.parse(result.stdout), 'OK');
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

  const exportPath = join(ultracodeHome, 'archive', `${launch.jobId}-export.json`);
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

async function assertValidateMode(installedCli) {
  // Keep authored validation fixtures outside the consumer workspace so they
  // never perturb review evidence snapshots.
  const authoredPath = `${consumerDir}-validate-authored.js`;
  await writeFile(authoredPath, [
    'export const meta = { name: "validate-authored", description: "Authored phase demo" };',
    'return await parallel([() => agent("a"), () => agent("b")]);',
    '',
  ].join('\n'));
  try {
    const valid = runCli(installedCli, ['--validate', '--script-file', authoredPath]);
    assert.equal(valid.status, 0, valid.stderr);
    const report = JSON.parse(valid.stdout);
    assert.equal(report.kind, 'ultracode.workflow.validate');
    assert.equal(report.status, 'valid');
    assert.equal(report.workflowName, 'validate-authored');
    assert.equal(report.agentCallSites, 2);
    assert.equal(report.schemaCallSites, 0);
    assert.equal(report.warnings.length, 2);
    assert.match(report.warnings[0], /do not declare a structured output schema/);
    assert.match(report.warnings[1], /logical \{ key \}/);

    await writeFile(authoredPath, [
      'export const meta = { name: "validate-bad" };',
      'return Date.now();',
      '',
    ].join('\n'));
    const invalid = runCli(installedCli, ['--validate', '--script-file', authoredPath]);
    assert.notEqual(invalid.status, 0);
    assert.match(`${invalid.stdout}\n${invalid.stderr}`, /workflow_script_nondeterministic/);
  } finally {
    await rm(authoredPath, { force: true });
  }
}

async function assertBuiltinCodeReviewJsonl(installedCli) {
  await writeCodeReviewFixture();
  await rm(fakeTurnsPath, { force: true });
  const result = runCliAttached(installedCli, [
    '--name',
    'code-review',
    '--args',
    '{"prompt":"Review docs/client-package-plan.md for runtime contract risks."}',
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 0);
  // Funnel tiering: finder-class turns run at high; scope, verifier, and
  // synthesis turns keep the xhigh verdict tier.
  const turnRecords = (await readFile(fakeTurnsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const finderTurns = turnRecords.filter((record) => /^Code-review (Sweep )?Finder/.test(record.promptHead));
  assert.equal(finderTurns.length, 3);
  assert.ok(finderTurns.every((record) => record.effort === 'high'), JSON.stringify(finderTurns));
  const verdictTurns = turnRecords.filter((record) => !/^Code-review (Sweep )?Finder/.test(record.promptHead));
  assert.ok(verdictTurns.length >= 4, JSON.stringify(turnRecords));
  assert.ok(verdictTurns.every((record) => record.effort === 'xhigh'), JSON.stringify(verdictTurns));
  const progress = progressEvents(result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.level, 'xhigh');
  assert.equal(output.findings.length, 1);
  assert.equal(output.findings[0].severity, 'P1');
  assert.equal(output.stats.finders, 3);
  assert.equal(output.stats.candidates, 2);
  assert.equal(output.stats.verifierAttempts, 2);
  assert.equal(output.stats.reported, 1);
  assert.match(output.provenance.sourceSnapshotId, /^git:[0-9a-f]{40}:sha256:[0-9a-f]{64}$/);

  assertProgressEvent(progress, 'workflow.plan.ready', { status: 'planned', phaseCount: 1 });
  assertProgressEvent(progress, 'workflow.phase.started', { title: 'Evidence' });
  assertProgressEvent(progress, 'workflow.phase.planned', { title: 'Scope', plannedAgentCount: 1 });
  assertProgressEvent(progress, 'workflow.phase.started', { title: 'Scope', plannedAgentCount: 1 });
  const findPlan = assertProgressEvent(progress, 'workflow.phase.planned', { title: 'Find', plannedAgentCount: 2 });
  assert.deepEqual(findPlan.plannedAgents.map((agent) => agent.label), [
    'code-review-find-runtime-contract',
    'code-review-find-security-boundary',
  ]);
  assertProgressEvent(progress, 'workflow.phase.planned', { title: 'Verify', plannedAgentCount: 1 });
  assertProgressEvent(progress, 'workflow.phase.started', { title: 'Verify', plannedAgentCount: 1 });
  assertProgressEvent(progress, 'workflow.agent.started', { label: 'code-review-verify-runtime-contract-c1', phase: 'Verify' });
  assertProgressEvent(progress, 'workflow.agent.started', { label: 'code-review-verify-runtime-contract-c2', phase: 'Verify' });
  const firstVerifyCompletion = assertProgressEvent(progress, 'workflow.agent.completed', {
    label: 'code-review-verify-runtime-contract-c1',
    phase: 'Verify',
    phaseKnownAgentCount: 2,
  });
  assert.match(firstVerifyCompletion.summary, /Phase Verify \(1\/2\)/);
  assert.ok(
    progress.findIndex((event) => event.event === 'workflow.agent.started' && event.label === 'code-review-verify-runtime-contract-c1')
      < progress.findIndex((event) => event.event === 'workflow.agent.completed' && event.label === 'code-review-find-security-boundary'),
    'expected verifier for an early finder to start before the delayed finder completed',
  );
  assertProgressEvent(progress, 'workflow.phase.planned', { title: 'Sweep', plannedAgentCount: 1 });
  assertProgressEvent(progress, 'workflow.agent.started', { label: 'code-review-sweep-finder', phase: 'Sweep' });
  assertProgressEvent(progress, 'workflow.phase.planned', { title: 'Synthesize', plannedAgentCount: 1 });
  assertProgressEvent(progress, 'workflow.agent.started', { label: 'code-review-synthesis', phase: 'Synthesize' });
  assertProgressEvent(progress, 'workflow.completed', { status: 'completed' });
  const summary = assertProgressEvent(progress, 'workflow.summary.ready', { status: 'completed' });
  const verifySummary = summary.phasesSummary.find((phase) => phase.title === 'Verify');
  assert.ok(verifySummary, 'expected Verify phase in completion summary');
  assert.deepEqual(verifySummary.agents.map((agent) => agent.label), [
    'code-review-verify-dynamic',
    'code-review-verify-runtime-contract-c1',
    'code-review-verify-runtime-contract-c2',
  ]);
  assertProgressEvent(progress, 'workflow.review.recommended', { status: 'review_recommended' });
  const started = assertProgressEvent(progress, 'workflow.started', { workflowName: 'code-review' });
  return { runId: started.runId, output };
}

async function assertBuiltinCodeReviewResume(installedCli, previousRun) {
  assert.equal(typeof previousRun.runId, 'string');
  const result = runCliAttached(installedCli, [
    '--resume-from-run-id',
    previousRun.runId,
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.findings, previousRun.output.findings);
  assert.deepEqual(output.stats, previousRun.output.stats);
  const progress = progressEvents(result.stderr);
  const completions = progress.filter((event) => event.event === 'workflow.agent.completed');
  assert.equal(completions.length, 7);
  assert.ok(completions.every((event) => event.cached === true), 'resumed code-review should use cached agent completions');
  assertProgressEvent(progress, 'workflow.completed', { status: 'completed', agentCount: 7 });
  const summary = assertProgressEvent(progress, 'workflow.summary.ready', { status: 'completed' });
  assert.equal(summary.phasesSummary.find((phase) => phase.title === 'Verify')?.agentCount, 3);

  const conflictingSource = runCliAttached(installedCli, [
    '--resume-from-run-id',
    previousRun.runId,
    '--name',
    'code-review',
    '--permission',
    'allow',
  ]);
  assert.equal(conflictingSource.status, 1);
  assert.match(conflictingSource.stderr, /--resume-from-run-id cannot be combined/);

  const conflictingBackgroundSource = runCli(installedCli, [
    '--resume-from-run-id',
    previousRun.runId,
    '--name',
    'code-review',
    '--permission',
    'allow',
  ]);
  assert.equal(conflictingBackgroundSource.status, 1);
  assert.match(conflictingBackgroundSource.stderr, /--resume-from-run-id cannot be combined/);

  const emptyResume = runCli(installedCli, [
    '--resume-from-run-id=',
    '--permission',
    'allow',
  ]);
  assert.equal(emptyResume.status, 1);
  assert.match(emptyResume.stderr, /resumeFromRunId must be a non-empty workflow runId string/);

  const unknownBackgroundResume = runCli(installedCli, [
    '--resume-from-run-id',
    'run_00000000-0000-0000-0000-000000000000',
    '--permission',
    'allow',
  ]);
  assert.equal(unknownBackgroundResume.status, 1);
  assert.match(unknownBackgroundResume.stderr, /Unknown workflow run for resume/);

  const [resultPath] = await findFiles(ultracodeHome, `${previousRun.runId}.result.json`);
  assert.ok(resultPath, `expected result record for ${previousRun.runId}`);
  const originalResultRecord = JSON.parse(await readFile(resultPath, 'utf8'));
  await writeFile(resultPath, `${JSON.stringify({ ...originalResultRecord, scriptHash: 'sha256:bad' }, null, 2)}\n`);
  const corruptBackgroundResume = runCli(installedCli, [
    '--resume-from-run-id',
    previousRun.runId,
    '--permission',
    'allow',
  ]);
  assert.equal(corruptBackgroundResume.status, 1);
  assert.match(corruptBackgroundResume.stderr, /Unknown workflow run for resume|Workflow run cannot be used as a resume source/);
  await writeFile(resultPath, `${JSON.stringify(originalResultRecord, null, 2)}\n`);
}

async function assertBuiltinCodeReviewPlain(installedCli) {
  await writeCodeReviewFixture();
  const result = runCliAttached(installedCli, [
    '--name',
    'code-review',
    '--args',
    '{"prompt":"Review docs/client-package-plan.md for runtime contract risks.","level":"high"}',
    '--permission',
    'allow',
    '--progress',
    'plain',
  ]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.level, 'high');
  assert.equal(output.stats.finders, 2);
  assert.equal(output.stats.candidates, 2);
  assert.doesNotMatch(result.stderr, /code-review-sweep-finder/);
  assert.match(result.stderr, /\[phase\] Evidence/);
  assert.match(result.stderr, /\[phase-plan\] Scope \(1 agents\)/);
  assert.match(result.stderr, /\[phase-plan\] Find \(2 agents\)/);
  assert.match(result.stderr, /\[phase-plan\] Verify \(1 agents\)/);
  assert.match(result.stderr, /\[agent:\d+\] started code-review-verify-runtime-contract-c1/);
  assert.match(result.stderr, /\[agent:\d+\] completed code-review-verify-runtime-contract-c1 \| Phase Verify \(1\/2\), \d+ out of \d+ agents have completed the task, \d+s elapsed \| tokens=/);
  assert.match(result.stderr, /\[workflow-summary\] Phase Verify: 3 agents/);
  assert.match(result.stderr, /code-review-verify-runtime-contract-c2/);
  assert.match(result.stderr, /\[review-recommendation\]/);
}

async function assertBuiltinCodeReviewInvalidEvidence(installedCli) {
  await writeCodeReviewFixture();
  const result = runCliAttached(installedCli, [
    '--name',
    'code-review',
    '--args',
    '{"prompt":"INVALID_EVIDENCE_REF Review docs/client-package-plan.md."}',
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 1);
  const progress = progressEvents(result.stderr);
  assertProgressEvent(progress, 'workflow.failed', { status: 'failed' });
  assertProgressEvent(progress, 'workflow.terminal_failure', { status: 'failed' });
  assert.ok(
    !progress.some((event) => event.event === 'workflow.agent.started' && /code-review-verify-/.test(event.label ?? '')),
    'invalid finder evidence should fail before verifier agents start',
  );
  const failureRecord = JSON.parse(result.stdout);
  assert.equal(failureRecord.kind, 'ultracode.workflow.failure');
  assert.equal(failureRecord.version, 1);
  assert.equal(failureRecord.status, 'failed');
  assert.equal(failureRecord.failure.workflowName, 'code-review');
  assert.match(
    failureRecord.failure.error,
    /includes unsupported evidence ref file:outside\.md: not in allowed evidence refs \(\d+ entries\) derived from /,
  );
  assert.match(failureRecord.failure.error, /; populated by /);
  assert.ok(failureRecord.failure.runId.length > 0);
}

async function assertInstalledReviewEvidenceContext(installedCli) {
  await writeReviewEvidenceFixture();
  const result = runCliAttached(installedCli, [
    '--script',
    [
      'export const meta = { name: "installed-review-evidence-context" };',
      'return await workspaceContext({',
      '  query: "src/evidence-large.txt src/evidence-deleted.txt",',
      '  files: ["src/evidence-large.txt", "src/evidence-deleted.txt"],',
      '  includeDiff: true,',
      '  diffBaseRef: "missing-diff-base",',
      '  maxDiffBytes: 1000',
      '});',
    ].join('\n'),
    '--permission',
    'allow',
  ]);
  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout);
  assert.match(context, /### Review Evidence/);
  assert.match(context, /truncation: \{"unstaged":true,"staged":false,"committed":false\}/);
  assert.match(context, /diff:unstaged:src\/evidence-large\.txt/);
  assert.match(context, /diff:unstaged:src\/evidence-deleted\.txt/);
  assert.match(context, /unavailable:diff-base:missing-diff-base:/);
  assert.match(context, /### Allowed Evidence Refs/);
  assert.match(context, /file:src\/evidence-large\.txt/);
  assert.match(context, /file:src\/evidence-deleted\.txt/);
}

async function writeCodeReviewFixture() {
  await mkdir(join(consumerDir, 'docs'), { recursive: true });
  await writeFile(join(consumerDir, 'docs', 'client-package-plan.md'), [
    '# Client Package Plan',
    '',
    'The client package must bind authority to the platform token.',
    'Runtime validation must stay deterministic.',
    '',
  ].join('\n'));
}

async function writeReviewEvidenceFixture() {
  await mkdir(join(consumerDir, 'src'), { recursive: true });
  await writeFile(join(consumerDir, 'src', 'evidence-large.txt'), 'base\n');
  await writeFile(join(consumerDir, 'src', 'evidence-deleted.txt'), 'delete me\n');
  run('git', ['add', 'docs/client-package-plan.md', 'src/evidence-large.txt', 'src/evidence-deleted.txt'], { cwd: consumerDir });
  run('git', ['commit', '-m', 'add review evidence fixture'], { cwd: consumerDir });
  await writeFile(join(consumerDir, 'src', 'evidence-large.txt'), Array.from({ length: 180 }, (_, index) => `changed line ${index}`).join('\n') + '\n');
  await rm(join(consumerDir, 'src', 'evidence-deleted.txt'));
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
    FAKE_TURNS_PATH: fakeTurnsPath,
    OPENAI_API_KEY: 'fake-openai-key',
    OPENAI_BASE_URL: 'https://example.invalid/openai',
    ULTRACODE_FOR_CODEX_HOME: ultracodeHome,
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

function isReviewScopeSchema(schema) {
  return Boolean(schema?.properties?.lensDecisions && schema?.properties?.lenses && schema?.properties?.files);
}

function isReviewFinderSchema(schema) {
  return Boolean(schema?.properties?.candidates);
}

function isReviewVerifierSchema(schema) {
  return Boolean(schema?.properties?.verdict && schema?.properties?.evidenceRefs);
}

function isReviewSynthesisSchema(schema) {
  return Boolean(schema?.properties?.decisions && schema?.properties?.summary);
}

function fakeReviewScope() {
  return {
    files: ['docs/client-package-plan.md'],
    summary: 'Review the client package plan and authority binding claims.',
    instructions: 'Prioritize material runtime contract and boundary risks.',
    lensDecisions: [
      {
        seedId: 'cross-file-contract',
        action: 'select',
        selectedLensId: 'runtime-contract',
        reasonCategory: 'matched_change',
        decisionRefs: ['file:docs/client-package-plan.md'],
        reason: 'The plan changes runtime and package contract behavior.',
      },
      {
        seedId: 'security-boundary',
        action: 'select',
        selectedLensId: 'security-boundary',
        reasonCategory: 'prompt_risk',
        decisionRefs: ['file:docs/client-package-plan.md'],
        reason: 'Authority binding requires boundary review.',
      },
    ],
    lenses: [
      {
        id: 'runtime-contract',
        title: 'Runtime Contract',
        focus: 'Check whether the client package runtime contract can fail materially.',
        kind: 'contract',
      },
      {
        id: 'security-boundary',
        title: 'Security Boundary',
        focus: 'Check whether platform token authority can leak or be misbound.',
        kind: 'security',
      },
    ],
  };
}

function fakeReviewFinder(input) {
  const prompt = reviewPromptText(input);
  if (reviewUserRequest(prompt).includes('INVALID_EVIDENCE_REF')) {
    return {
      candidates: [{
        file: 'docs/client-package-plan.md',
        line: 3,
        summary: 'This candidate intentionally references unsupported evidence.',
        failureScenario: 'The workflow should fail before verifier agents start.',
        evidenceRefs: ['file:outside.md'],
        kind: 'contract',
      }],
    };
  }
  if (prompt.startsWith('Code-review Sweep Finder')) {
    return { candidates: [] };
  }
  const lensKey = currentReviewLensKey(prompt);
  if (lensKey === 'runtime-contract') {
    return {
      candidates: [
        {
          file: 'docs/client-package-plan.md',
          line: 3,
          summary: 'Package plan may under-specify authority binding.',
          failureScenario: 'A client could treat a token-like artifact as authority without verifying the platform binding.',
          evidenceRefs: ['file:docs/client-package-plan.md'],
          kind: 'contract',
        },
        {
          file: 'docs/client-package-plan.md',
          line: 4,
          summary: 'The runtime contract may omit a deterministic validation gate.',
          failureScenario: 'A release could pass docs review while missing a local schema gate.',
          evidenceRefs: ['file:docs/client-package-plan.md'],
          kind: 'coverage',
        },
      ],
    };
  }
  if (lensKey === 'security-boundary') {
    return { candidates: [] };
  }
  return {
    candidates: [],
  };
}

function currentReviewLensKey(input) {
  const prompt = reviewPromptText(input);
  const marker = 'Lens key: ';
  const start = prompt.indexOf(marker);
  if (start < 0) return '';
  const rest = prompt.slice(start + marker.length);
  const match = /^[A-Za-z0-9_.:/@+-]+/.exec(rest);
  return match ? match[0] : '';
}

function reviewUserRequest(input) {
  const prompt = reviewPromptText(input);
  const start = prompt.indexOf('User request:');
  if (start < 0) return '';
  const scope = prompt.indexOf('Scope:', start);
  if (scope < 0) return prompt.slice(start);
  return prompt.slice(start, scope);
}

function fakeReviewVerifier(input) {
  const prompt = reviewPromptText(input);
  const second = prompt.includes('candidate_runtime-contract_2') || prompt.includes('candidate_sweep_2');
  return {
    verdict: 'CONFIRMED',
    evidence: second
      ? 'The candidate is real but lower materiality than the authority binding issue.'
      : 'The plan discusses platform token authority but does not show a validation gate.',
    evidenceRefs: ['file:docs/client-package-plan.md'],
    severity: second ? 'P2' : 'P1',
  };
}

function reviewPromptText(input) {
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item?.text === 'string') return item.text;
      }
    }
  } catch (_err) {
    // Fall back to the original string for direct unit-style invocations.
  }
  return input;
}

function fakeReviewSynthesis() {
  return {
    summary: 'One material runtime contract issue should be reported; the lower-risk coverage point is dropped.',
    decisions: [
      {
        index: 0,
        action: 'report',
        merge: null,
        severity: 'P1',
        reasonCategory: 'material',
        reason: 'Authority binding is a material runtime contract risk.',
      },
      {
        index: 1,
        action: 'drop',
        merge: null,
        severity: 'P2',
        reasonCategory: 'not_material',
        reason: 'The validation gate point is useful follow-up but not material enough for the final report.',
      },
    ],
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
    if (process.env.FAKE_TURNS_PATH) {
      require('node:fs').appendFileSync(process.env.FAKE_TURNS_PATH, JSON.stringify({
        promptHead: reviewPromptText(input).split('\n')[0] || '',
        effort: effort || null,
      }) + '\n');
    }
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
    if (isReviewScopeSchema(outputSchema)) {
      setTimeout(() => emitTurn(threadId, turnId, JSON.stringify(fakeReviewScope())), 0);
      return;
    }
    if (isReviewFinderSchema(outputSchema)) {
      const delay = currentReviewLensKey(input) === 'security-boundary' ? 120 : 0;
      setTimeout(() => emitTurn(threadId, turnId, JSON.stringify(fakeReviewFinder(input))), delay);
      return;
    }
    if (isReviewVerifierSchema(outputSchema)) {
      setTimeout(() => emitTurn(threadId, turnId, JSON.stringify(fakeReviewVerifier(input))), 0);
      return;
    }
    if (isReviewSynthesisSchema(outputSchema)) {
      setTimeout(() => emitTurn(threadId, turnId, JSON.stringify(fakeReviewSynthesis())), 0);
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
