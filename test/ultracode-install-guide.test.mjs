import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('CLI prints the package version', () => {
  for (const flag of ['--version', '-v', 'version']) {
    const result = spawnSync(process.execPath, ['dist/cli.js', flag], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `ultracode-for-codex ${packageVersion}\n`);
    assert.equal(result.stderr, '');
  }
});

test('CLI prints the Ultracode install guide', () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', '--llm-guide'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Ultracode install and usage guide/);
  assert.match(result.stdout, /Runtime Contract/);
  assert.match(result.stdout, /ultracode-for-codex ULTRACODE INSTALL GUIDE START/);
});

test('the install guide documents every script global and agent() option', () => {
  // `run` refuses until the caller acknowledges this guide, so the guide IS the authoring contract a
  // script author reads. It had silently drifted: `workflow()`, `console.*`, the injected `meta` local,
  // and the `agentType` option all existed in the runtime and appeared nowhere in the guide, so an
  // author following it could not know they were available.
  const result = spawnSync(process.execPath, ['dist/cli.js', '--llm-guide'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const guide = result.stdout;

  const globals = [
    'agent(', 'parallel(', 'pipeline(', 'workflow(', 'workspaceContext(', 'phase(',
    'announcePlan', 'announcePhasePlan', 'log(', 'console.log', 'hash(', 'args', 'budget',
    'setTimeout',
  ];
  for (const name of globals) {
    assert.ok(guide.includes(name), `the guide must document the ${name} global`);
  }

  const agentOptions = ['schema', 'effort', 'model', 'key', 'agentType', 'label', 'isolation'];
  for (const option of agentOptions) {
    assert.ok(guide.includes(`\`${option}\``), `the guide must document the agent() option ${option}`);
  }

  // The caps and the un-catchable failures are the parts an author gets wrong without being told.
  for (const fact of ['4096', '1000 agent calls', 'Not catchable', 'async function']) {
    assert.ok(guide.includes(fact), `the guide must state: ${fact}`);
  }
});

test('postinstall prints the Ultracode install guide', () => {
  const result = spawnSync(process.execPath, ['postinstall.mjs'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Ultracode install and usage guide/);
  assert.match(result.stdout, /Runtime Contract/);
  assert.match(result.stdout, /ultracode-for-codex --llm-guide/);
});

test('run command requires Ultracode guide acknowledgement', () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'run', '--script', 'export const meta = { name: "x" }; return null;'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Ultracode install and usage guide/);
  assert.match(result.stderr, /--accept-llm-guide=v1/);
});
