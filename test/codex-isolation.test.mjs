import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  codexContextIsolationArgs,
  createCodexIsolation,
  minimalCodexConfigToml,
} from '../dist/codex/subagent-backend.js';

const originalCodexHome = process.env.CODEX_HOME;
const tempDirs = [];

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('Codex isolation copies auth and writes deterministic workflow-only config', async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), 'codex-source-home-'));
  tempDirs.push(sourceHome);
  process.env.CODEX_HOME = sourceHome;
  await writeFile(join(sourceHome, 'auth.json'), '{"token":"secret"}\n');
  await writeFile(join(sourceHome, 'config.toml'), 'model = "gpt-source-model"\n');
  await mkdir(join(sourceHome, 'plugins'), { recursive: true });
  await writeFile(join(sourceHome, 'plugins', 'ignored.json'), '{}\n');

  const isolation = await createCodexIsolation({
    reasoningEffort: 'xhigh',
    verbosity: 'medium',
  });
  tempDirs.push(isolation.rootDir);

  assert.equal(isolation.defaultModel, 'gpt-source-model');
  assert.equal(await readFile(join(isolation.homeDir, 'auth.json'), 'utf8'), '{"token":"secret"}\n');
  await assert.rejects(() => readFile(join(isolation.homeDir, 'plugins', 'ignored.json'), 'utf8'));
  const config = await readFile(join(isolation.homeDir, 'config.toml'), 'utf8');
  assert.match(config, /model = "gpt-source-model"/);
  assert.match(config, /model_reasoning_effort = "xhigh"/);
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /image_generation = false/);
  assert.match(config, /\[features\.multi_agent_v2\]\nmax_concurrent_threads_per_session = 1/);
  assert.match(config, /Native subagent delegation is unavailable/);
  assert.match(config, /\[shell_environment_policy\]\ninherit = "none"/);
});

test('Codex app-server args pin runtime-owned config overrides', () => {
  const args = codexContextIsolationArgs({
    model: 'gpt-args-model',
    reasoningEffort: 'high',
    verbosity: 'low',
  }).join('\n');

  assert.match(args, /model="gpt-args-model"/);
  assert.match(args, /model_reasoning_effort="high"/);
  assert.match(args, /model_verbosity="low"/);
  assert.match(args, /web_search="disabled"/);
  assert.match(args, /shell_environment_policy\.inherit="none"/);
  assert.match(args, /features\.image_generation=false/);
  assert.match(args, /features\.multi_agent_v2\.max_concurrent_threads_per_session=1/);
  assert.match(args, /features\.multi_agent_v2\.multi_agent_mode_hint_text=/);
});

test('minimal Codex config is workflow-only and side-effect constrained', () => {
  const toml = minimalCodexConfigToml({
    model: 'gpt-config-model',
    reasoningEffort: 'xhigh',
    verbosity: 'high',
  });

  assert.match(toml, /model = "gpt-config-model"/);
  assert.match(toml, /model_reasoning_effort = "xhigh"/);
  assert.match(toml, /model_verbosity = "high"/);
  assert.match(toml, /approval_policy = "never"/);
  assert.match(toml, /sandbox_mode = "read-only"/);
  assert.match(toml, /web_search = "disabled"/);
  assert.match(toml, /image_generation = false/);
  assert.match(toml, /max_concurrent_threads_per_session = 1/);
});

test('agent-web-search gate flips web_search across every isolation config site', async () => {
  // Default-off byte-identical: omitting webSearch (and passing false) both emit "disabled".
  for (const webSearch of [undefined, false]) {
    assert.match(
      codexContextIsolationArgs({ reasoningEffort: 'high', verbosity: 'low', webSearch }).join('\n'),
      /web_search="disabled"/,
    );
    assert.match(
      minimalCodexConfigToml({ reasoningEffort: 'xhigh', verbosity: 'high', webSearch }),
      /web_search = "disabled"/,
    );
  }
  // Enabled: the same knob flips to "live" at both standalone config sites.
  assert.match(
    codexContextIsolationArgs({ reasoningEffort: 'high', verbosity: 'low', webSearch: true }).join('\n'),
    /web_search="live"/,
  );
  assert.match(
    minimalCodexConfigToml({ reasoningEffort: 'xhigh', verbosity: 'high', webSearch: true }),
    /web_search = "live"/,
  );

  // And through createCodexIsolation's written config.toml (the home-config site).
  const sourceHome = await mkdtemp(join(tmpdir(), 'codex-source-home-web-'));
  tempDirs.push(sourceHome);
  process.env.CODEX_HOME = sourceHome;
  await writeFile(join(sourceHome, 'auth.json'), '{"token":"secret"}\n');
  const isolation = await createCodexIsolation({ reasoningEffort: 'low', verbosity: 'low', webSearch: true });
  tempDirs.push(isolation.rootDir);
  assert.match(await readFile(join(isolation.homeDir, 'config.toml'), 'utf8'), /web_search = "live"/);
});
