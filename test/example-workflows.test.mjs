import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { WorkflowTaskRegistry } from '../dist/runtime/workflow-runtime.js';

// Packaged example workflows are executable .js on the host API. This gate runs
// the real static validator over every one of them so a broken example fails
// `npm test` instead of rotting silently in the published package.
const examplesDir = fileURLToPath(new URL('../skills/ultracode-for-codex/references/example-workflows/', import.meta.url));
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const stubBackend = {
  name: 'stub',
  model: 'stub',
  async generate() { throw new Error('validation must not call the backend'); },
  async close() {},
};

test('every packaged example workflow validates statically', async () => {
  const files = (await readdir(examplesDir)).filter((name) => name.endsWith('.js'));
  // Guard the "all examples validate" claim against a vacuous empty set.
  assert.ok(files.length >= 3, `expected at least 3 example workflows, found ${files.length}`);

  const stateRoot = await mkdtemp(join(tmpdir(), 'example-workflows-'));
  tempDirs.push(stateRoot);
  const runtime = new WorkflowTaskRegistry({
    backend: stubBackend,
    cwd: stateRoot,
    stateDir: join(stateRoot, '.ultracode-for-codex'),
    requestTimeoutMs: 0,
  });
  try {
    for (const file of files) {
      const script = await readFile(join(examplesDir, file), 'utf8');
      const report = await runtime.validateWorkflowInput({ script });
      assert.ok(report.workflowName, `${file}: parsed no workflow name`);
      assert.ok(report.agentCallSites >= 1, `${file}: has no agent() call sites`);
    }
  } finally {
    await runtime.close();
  }
});

test('the migration example exercises change evidence via includeDiff (non-review consumer)', async () => {
  // Concept check: the renamed general "change evidence" primitive must have a
  // real non-code-review consumer, or its generality is only theoretical.
  const script = await readFile(join(examplesDir, 'migrate-pipeline.js'), 'utf8');
  assert.match(script, /workspaceContext\(\{[^}]*includeDiff:\s*true/);
});
