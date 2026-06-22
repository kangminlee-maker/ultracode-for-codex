import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  codexChildProcessEnv,
  isDirectProviderEnvName,
} from '../dist/codex/env.js';

const names = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'AZURE_OPENAI_ENDPOINT',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENROUTER_API_KEY',
];
const original = new Map(names.map((name) => [name, process.env[name]]));
const originalTerm = process.env.TERM;

afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (originalTerm === undefined) delete process.env.TERM;
  else process.env.TERM = originalTerm;
});

test('Codex child process env strips direct provider credentials and routing', () => {
  for (const name of names) process.env[name] = `${name}_secret`;
  process.env.TERM = 'dumb';
  process.env.ULTRACODE_SAFE_ENV = 'safe';

  const env = codexChildProcessEnv({ CODEX_HOME: '/tmp/codex-home' });

  for (const name of names) {
    assert.equal(name in env, false, `${name} should be stripped`);
    assert.equal(isDirectProviderEnvName(name), true, `${name} should be classified`);
  }
  assert.equal(env.ULTRACODE_SAFE_ENV, 'safe');
  assert.equal(env.CODEX_HOME, '/tmp/codex-home');
  assert.equal(env.TERM, 'xterm-256color');
});
