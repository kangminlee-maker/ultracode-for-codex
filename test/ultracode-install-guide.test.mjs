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
