import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { probeCodexSetup } from '../dist/codex/setup-probe.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');
const originalCodexHome = process.env.CODEX_HOME;
const tempDirs = [];

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('setup probe reports the selected catalog model and medium/high/max support', async () => {
  await chmod(fakeCodex, 0o755);
  const codexHome = await mkdtemp(join(tmpdir(), 'ultracode-setup-codex-home-'));
  tempDirs.push(codexHome);
  process.env.CODEX_HOME = codexHome;
  await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-test-model"\n');

  const probe = await probeCodexSetup({
    command: fakeCodex,
    cwd: process.cwd(),
    reasoningEffort: 'high',
  });

  assert.equal(probe.ready, true, probe.detail);
  assert.equal(probe.selectedModel, 'gpt-test-model');
  assert.equal(probe.reasoningEffort, 'high');
  assert.equal(probe.reasoningEffortSupported, true);
  assert.ok(probe.supportedReasoningEfforts.includes('medium'));
  assert.ok(probe.supportedReasoningEfforts.includes('high'));
  assert.ok(probe.supportedReasoningEfforts.includes('max'));
});

test('setup probe is not ready when the requested model is outside the live catalog', async () => {
  await chmod(fakeCodex, 0o755);
  const codexHome = await mkdtemp(join(tmpdir(), 'ultracode-setup-codex-home-'));
  tempDirs.push(codexHome);
  process.env.CODEX_HOME = codexHome;

  const probe = await probeCodexSetup({
    command: fakeCodex,
    cwd: process.cwd(),
    model: 'missing-model',
    reasoningEffort: 'medium',
  });

  assert.equal(probe.ready, false);
  assert.equal(probe.modelCatalogChecked, true);
  assert.equal(probe.selectedModel, null);
  assert.equal(probe.reasoningEffortSupported, false);
  assert.match(probe.detail, /model "missing-model" is unavailable/);
});
