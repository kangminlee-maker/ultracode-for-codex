import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { codexSkillState, parseOptions } from '../dist/cli.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('codexSkillState classifies installed Codex skill folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ultracode-skill-state-'));
  tempDirs.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(join(source, 'references'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: demo-skill\n---\nbody\n');
  await writeFile(join(source, 'references', 'notes.md'), 'reference\n');

  assert.equal(await codexSkillState(source, target, 'demo-skill'), 'missing');

  await mkdir(join(target, 'references'), { recursive: true });
  await writeFile(join(target, 'SKILL.md'), '---\nname: demo-skill\n---\nbody\n');
  await writeFile(join(target, 'references', 'notes.md'), 'reference\n');
  assert.equal(await codexSkillState(source, target, 'demo-skill'), 'current');

  // macOS metadata files must not mark an otherwise current skill stale.
  await writeFile(join(target, '.DS_Store'), 'noise\n');
  assert.equal(await codexSkillState(source, target, 'demo-skill'), 'current');

  await writeFile(join(target, 'references', 'notes.md'), 'edited reference\n');
  assert.equal(await codexSkillState(source, target, 'demo-skill'), 'stale');

  await writeFile(join(target, 'references', 'notes.md'), 'reference\n');
  await writeFile(join(target, 'extra.md'), 'left behind by an older package\n');
  assert.equal(await codexSkillState(source, target, 'demo-skill'), 'stale');

  await rm(join(target, 'extra.md'));
  await writeFile(join(target, 'SKILL.md'), '---\nname: something-else\n---\nbody\n');
  assert.equal(await codexSkillState(source, target, 'demo-skill'), 'unmanaged');
});

test('CLI parser keeps value-less flags from swallowing following tokens', () => {
  const options = parseOptions(['--validate', './phase-review.js', '--plain', 'positional-2']);
  assert.equal(options.validate, 'true');
  assert.equal(options.plain, 'true');
  assert.deepEqual(options._, ['./phase-review.js', 'positional-2']);
});

test('CLI parser pins a relative --cwd to an absolute recovery anchor', () => {
  const options = parseOptions(['--cwd', 'relative/dir']);
  assert.notEqual(options.cwd, 'relative/dir');
  assert.ok(options.cwd.startsWith('/'), options.cwd);
  assert.ok(options.cwd.endsWith('/relative/dir'), options.cwd);
});

test('CLI parser supports run options', () => {
  const options = parseOptions([
    '--accept-llm-guide=v1',
    '--script-file',
    'workflow.js',
    '--args',
    '{"topic":"demo"}',
    '--command',
    '/tmp/fake-codex',
    '--model=gpt-test',
    '--timeout-ms',
    '1234',
    '--cwd',
    '/tmp/project',
    '--permission',
    'allow',
    '--retry-limit',
    '2',
    '--reasoning-effort',
    'xhigh',
    '--verbosity=high',
    '--progress',
    'jsonl',
    '--execution',
    'attached',
    '--resume-from-run-id',
    'run_12345678-1234-4234-9234-123456789abc',
  ]);

  assert.equal(options.acceptLlmGuide, 'v1');
  assert.equal(options.scriptFile, 'workflow.js');
  assert.equal(options.args, '{"topic":"demo"}');
  assert.equal(options.command, '/tmp/fake-codex');
  assert.equal(options.model, 'gpt-test');
  assert.equal(options.timeoutMs, '1234');
  assert.equal(options.cwd, '/tmp/project');
  assert.equal(options.permission, 'allow');
  assert.equal(options.retryLimit, '2');
  assert.equal(options.reasoningEffort, 'xhigh');
  assert.equal(options.verbosity, 'high');
  assert.equal(options.progress, 'jsonl');
  assert.equal(options.execution, 'attached');
  assert.equal(options.resumeFromRunId, 'run_12345678-1234-4234-9234-123456789abc');
  assert.deepEqual(options._, []);
});
