import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions } from '../dist/cli.js';

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
