#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const args = process.argv.slice(2);
const keepTemp = args.includes('--keep-temp');
const outDir = resolve(repoRoot, readValueArg('--out-dir') ?? 'artifacts');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const providerEndpointSegment = ['ap', 'i'].join('');

const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const artifactName = packageArtifactName(pkg.name, pkg.version);
const artifactPath = join(outDir, artifactName);

await mkdir(outDir, { recursive: true });
if (existsSync(artifactPath)) await unlink(artifactPath);

run(npm, ['pack', '--pack-destination', outDir], { env: npmEnvWithoutDryRun() });
if (!existsSync(artifactPath)) {
  throw new Error(`Expected package artifact was not created: ${artifactPath}`);
}

const entries = listTarball(artifactPath);
validateTarballEntries(entries);

const extractedDir = await mkdtemp(join(tmpdir(), 'ultracode-for-codex-package-'));
const consumerDir = await mkdtemp(join(tmpdir(), 'ultracode-for-codex-consumer-'));
try {
  run('tar', ['-xzf', artifactPath, '-C', extractedDir]);
  await validateExtractedPackage(join(extractedDir, 'package'));
  await validateConsumerInstall(consumerDir, artifactPath);
} finally {
  if (keepTemp) {
    process.stdout.write(`kept package temp dir: ${extractedDir}\n`);
    process.stdout.write(`kept consumer temp dir: ${consumerDir}\n`);
  } else {
    await rm(extractedDir, { recursive: true, force: true });
    await rm(consumerDir, { recursive: true, force: true });
  }
}

process.stdout.write(`ultracode-for-codex package ready: ${artifactPath}\n`);

function readValueArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
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

function packageArtifactName(name, version) {
  const normalizedName = String(name).replace(/^@/, '').replace(/\//g, '-');
  return `${normalizedName}-${version}.tgz`;
}

function listTarball(tarballPath) {
  return run('tar', ['-tzf', tarballPath], { capture: true })
    .split(/\r?\n/)
    .filter(Boolean);
}

function validateTarballEntries(entries) {
  const required = [
    'package/ULTRACODE_INSTALL.md',
    'package/postinstall.mjs',
    'package/package.json',
    'package/README.md',
    'package/settings.json',
    'package/dist/cli.js',
    'package/dist/settings.js',
    'package/dist/ultracode-install-guide.js',
    'package/dist/codex/subagent-backend.js',
    'package/dist/runtime/package-info.js',
    'package/dist/runtime/workflow-runtime.js',
    'package/dist/runtime/workflow-journal.js',
    'package/skills/ultracode-for-codex/SKILL.md',
    'package/skills/ultracode-for-codex/agents/openai.yaml',
    'package/docs/ultracode-p3a-journal-design.md',
    'package/docs/ultracode-p3b-resume-cache.md',
    'package/docs/ultracode-p3c-worktree-isolation.md',
  ];
  for (const item of required) {
    if (!entries.includes(item)) throw new Error(`Package is missing required file: ${item}`);
  }

  const disallowed = [
    'package/src/',
    'package/test/',
    'package/scripts/',
    'package/node_modules/',
    'package/package-lock.json',
    'package/IMPLEMENTATION_MAP.html',
  ];
  for (const entry of entries) {
    const matched = disallowed.find((prefix) => entry === prefix || entry.startsWith(prefix));
    if (matched) throw new Error(`Package contains non-runtime file: ${entry}`);
  }
}

async function validateExtractedPackage(packageDir) {
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (packageJson.private === true) {
    throw new Error('Package must be publishable and must not set private: true.');
  }
  if (packageJson.publishConfig?.access !== 'public') {
    throw new Error('Package publishConfig.access must be public.');
  }
  if (packageJson.publishConfig?.registry !== 'https://registry.npmjs.org/') {
    throw new Error('Package publishConfig.registry must target the public npm registry.');
  }
  if (packageJson.scripts?.prepublishOnly !== 'npm run test:all') {
    throw new Error('Package prepublishOnly must run the full verification suite.');
  }
  if (packageJson.bin?.['ultracode-for-codex'] !== 'dist/cli.js') {
    throw new Error('Package bin must point to dist/cli.js');
  }
  const cliStat = await stat(join(packageDir, 'dist', 'cli.js'));
  if ((cliStat.mode & 0o111) === 0) {
    throw new Error('Package CLI bin dist/cli.js must be executable.');
  }
  if (!packageJson.exports || typeof packageJson.exports !== 'object') {
    throw new Error('Package must declare an exports map for public entrypoints.');
  }
  const exportKeys = Object.keys(packageJson.exports);
  const allowedExports = new Set(['.', './ultracode-install-guide', './settings']);
  for (const exportKey of exportKeys) {
    if (!allowedExports.has(exportKey)) {
      throw new Error(`Package exports unsupported public entrypoint: ${exportKey}`);
    }
  }
  if (packageJson.scripts?.postinstall !== 'node postinstall.mjs') {
    throw new Error('Package postinstall must print the Ultracode install guide.');
  }
  if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) {
    throw new Error('Installable ultracode package must not declare runtime dependencies.');
  }
  await validateCompanionSkill(join(packageDir, 'skills', 'ultracode-for-codex'));

  const forbidden = [
    /link:\.\.\//,
    new RegExp(escapeRegExp(repoRoot)),
  ];
  for await (const filePath of walk(packageDir)) {
    const packageRelativePath = relative(packageDir, filePath);
    const content = await readFile(filePath, 'utf8');
    const found = forbidden.find((pattern) => pattern.test(content));
    if (found) {
      throw new Error(`Package file contains forbidden reference ${found}: ${packageRelativePath}`);
    }
    if (packageRelativePath.startsWith('dist/')) {
      validateRuntimeFileDoesNotCallDirectProvider(content, packageRelativePath);
    }
  }
}

async function validateCompanionSkill(skillDir) {
  const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
  const metadata = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
  if (!/^name:\s*ultracode-for-codex\s*$/m.test(metadata)) {
    throw new Error('Companion skill must declare name: ultracode-for-codex.');
  }
  const description = /^description:\s*(.+)$/m.exec(metadata)?.[1] ?? '';
  if (!description || /\bTODO\b/i.test(description)) {
    throw new Error('Companion skill must declare a completed description.');
  }
  if (/\bTODO\b/i.test(skill)) {
    throw new Error('Companion skill must not contain TODO placeholders.');
  }
  const openaiYaml = await readFile(join(skillDir, 'agents', 'openai.yaml'), 'utf8');
  for (const required of ['display_name:', 'short_description:', 'default_prompt:']) {
    if (!openaiYaml.includes(required)) throw new Error(`Companion skill metadata missing ${required}`);
  }
}

function validateRuntimeFileDoesNotCallDirectProvider(content, filePath) {
  const forbidden = [
    new RegExp(String.raw`https:\/\/${providerEndpointSegment}\.(?:openai|anthropic)\.com`),
    new RegExp(String.raw`\b${providerEndpointSegment}\.(?:openai|anthropic)\.com\b`),
    /auth\.openai\.com\/oauth\/token/,
    new RegExp(String.raw`chatgpt\.com\/backend-${providerEndpointSegment}\/codex`),
    /Bearer\s+\$\{process\.env/,
    new RegExp(String.raw`x-${providerEndpointSegment}-key['"]?\s*:\s*process\.env`),
  ];
  const found = forbidden.find((pattern) => pattern.test(content));
  if (found) throw new Error(`Runtime file contains direct provider egress reference ${found}: ${filePath}`);
}

async function validateConsumerInstall(consumerDir, tarballPath) {
  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2));
  run(npm, ['install', '--save-dev', '--no-audit', '--no-fund', tarballPath], { cwd: consumerDir });
  const help = run(npm, ['exec', '--', 'ultracode-for-codex', '--help'], {
    cwd: consumerDir,
    capture: true,
  });
  const version = run(npm, ['exec', '--', 'ultracode-for-codex', '--version'], {
    cwd: consumerDir,
    capture: true,
  });
  if (version !== `ultracode-for-codex ${pkg.version}\n`) {
    throw new Error(`Installed CLI --version did not match package.json: ${version.trim()}`);
  }
  if (!help.includes('Commands:') || !help.includes('run')) {
    throw new Error('Installed CLI help is missing the run command.');
  }
  if (!help.includes('--version')) {
    throw new Error('Installed CLI help is missing --version.');
  }
  if (!help.includes('--llm-guide')) {
    throw new Error('Installed CLI help is missing --llm-guide.');
  }
  if (!help.includes('--accept-llm-guide')) {
    throw new Error('Installed CLI help is missing --accept-llm-guide.');
  }
  const llmGuide = run(npm, ['exec', '--', 'ultracode-for-codex', '--llm-guide'], {
    cwd: consumerDir,
    capture: true,
  });
  if (
    !llmGuide.includes('Ultracode install and usage guide')
    || !llmGuide.includes('Runtime Contract')
  ) {
    throw new Error('Installed CLI --llm-guide did not print the Ultracode install guide.');
  }
  await writeFile(join(consumerDir, 'typecheck.ts'), [
    'import type { WorkflowAgentPreservedWorktree, WorkflowEvent, WorkflowLaunchInput } from "ultracode-for-codex";',
    '',
    'const preserved: WorkflowAgentPreservedWorktree = {',
    '  path: "/tmp/worktree",',
    '  attemptIndex: 0,',
    '  reason: "changed",',
    '};',
    'const input: WorkflowLaunchInput = { name: "code-review", args: { prompt: "review" } };',
    'const event: WorkflowEvent = {',
    '  type: "workflow.agent.completed",',
    '  taskId: "task",',
    '  runId: "run",',
    '  agentIndex: 0,',
    '  agentId: "agent_1",',
    '  label: "review-agent",',
    '  tokens: 1,',
    '  toolCalls: 0,',
    '  resultPreview: "ok",',
    '  elapsedMs: 10,',
    '  completedAgentCount: 1,',
    '  knownAgentCount: 1,',
    '};',
    'void preserved;',
    'void input;',
    'void event;',
    '',
  ].join('\n'));
  run(process.execPath, [
    join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--strict',
    '--noEmit',
    'typecheck.ts',
  ], { cwd: consumerDir });
  const commandsSection = sectionBetween(help, 'Commands:', '\n\n');
  const commandLines = commandsSection
    .split(/\r?\n/)
    .filter((line) => /^  [a-z][a-z-]*\s+/.test(line));
  const exposedCommands = commandLines.map((line) => line.trim().split(/\s+/)[0]);
  if (exposedCommands.some((command) => command !== 'run')) {
    throw new Error('Installed CLI exposes commands other than run.');
  }
}

function sectionBetween(text, start, end) {
  const startIndex = text.indexOf(start);
  if (startIndex === -1) return '';
  const contentStart = startIndex + start.length;
  const endIndex = text.indexOf(end, contentStart);
  return text.slice(contentStart, endIndex === -1 ? undefined : endIndex);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function* walk(dir) {
  for (const name of await readdir(dir)) {
    const filePath = join(dir, name);
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      yield* walk(filePath);
    } else if (fileStat.isFile()) {
      yield filePath;
    }
  }
}
