import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, before, test } from 'node:test';
import {
  CodexSubagentBackend,
  usageFromCodexTokenUsage,
} from '../dist/codex/subagent-backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, 'fixtures/fake-codex.cjs');
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const originalCodexHome = process.env.CODEX_HOME;
const originalProviderEnv = snapshotProviderEnv();
const tempDirs = [];

before(async () => {
  await chmod(fakeCodex, 0o755);
});

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  restoreProviderEnv(originalProviderEnv);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('CodexSubagentBackend returns raw workflow text and provider usage', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  setProviderEnv();
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    reasoningEffort: 'medium',
  });

  try {
    const result = await backend.generate(textRequest({ reasoningEffort: 'minimal' }));
    assert.equal(result.text, 'MINIMAL_OK');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.usage.source, 'provider');
    assert.equal(result.usage.inputTokens, 5);
    assert.equal(result.usage.outputTokens, 2);
    assert.equal(result.usage.cachedInputTokens, 2);
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend can wait for a turn without a turn timeout', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 0,
    reasoningEffort: 'xhigh',
  });

  try {
    const result = await backend.generate(textRequest({ prompt: 'Return OK.' }));
    assert.equal(result.text, 'OK');
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend maps structured output schema to StructuredOutput call', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    reasoningEffort: 'xhigh',
  });

  try {
    const result = await backend.generate({
      ...textRequest(),
      tools: [{
        name: 'StructuredOutput',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            detail: { type: 'string' },
            count: { type: 'integer' },
          },
          required: ['detail', 'count'],
        },
      }],
      toolChoice: { type: 'required' },
    });
    assert.equal(result.text, '');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'StructuredOutput');
    assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), {
      detail: 'OK',
      count: 2,
    });
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend prefers an explicit per-request model over the configured model', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    model: 'configured-model',
  });

  try {
    const overridden = await backend.generate(textRequest({ prompt: 'DEBUG_PAYLOAD', model: 'per-agent-model' }));
    assert.equal(JSON.parse(overridden.text).turnStart.model, 'per-agent-model');

    const defaulted = await backend.generate(textRequest({ prompt: 'DEBUG_PAYLOAD', model: 'configured-model' }));
    assert.equal(JSON.parse(defaulted.text).turnStart.model, 'configured-model');
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend resolves the inherited catalog model when no run-level model is configured', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    const overridden = await backend.generate(textRequest({ prompt: 'DEBUG_PAYLOAD', model: 'per-agent-model' }));
    assert.equal(JSON.parse(overridden.text).turnStart.model, 'per-agent-model');

    const defaulted = await backend.generate(textRequest({ prompt: 'DEBUG_PAYLOAD' }));
    assert.equal(JSON.parse(defaulted.text).turnStart.model, 'gpt-test-model');
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend uses an Ultracode-only app-server surface', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    reasoningEffort: 'xhigh',
  });

  try {
    const result = await backend.generate(textRequest({ prompt: 'DEBUG_PAYLOAD' }));
    const payload = JSON.parse(result.text);
    assert.equal(payload.initialize.clientInfo.name, 'ultracode_for_codex');
    assert.equal(payload.initialize.clientInfo.version, packageVersion);
    assert.match(payload.threadStart.baseInstructions, /Ultracode workflow subagent/);
    assert.match(payload.threadStart.developerInstructions, /raw result text/);
    assert.equal(payload.threadStart.personality, 'none');
    assert.equal(payload.threadStart.experimentalRawEvents, false);
    assert.equal(payload.threadStart.persistExtendedHistory, false);
    assert.equal(payload.threadStart.config.model_reasoning_effort, 'xhigh');
    assert.equal(payload.threadStart.config.model_verbosity, 'medium');
    assert.equal(payload.threadStart.config.web_search, 'disabled');
    assert.equal(payload.threadStart.cwd, process.cwd());
    assert.equal(payload.threadStart.model, 'gpt-test-model');
    assert.deepEqual(payload.threadStart.runtimeWorkspaceRoots, [process.cwd()]);
    assert.equal(payload.threadStart.dynamicTools[0].name, 'workspace');
    assert.deepEqual(payload.threadStart.dynamicTools[0].tools.map((tool) => tool.name), [
      'read_file',
      'list_directory',
    ]);
    assert.equal(payload.turnStart.effort, 'xhigh');
    assert.equal(payload.turnStart.summary, 'none');
    assert.equal(payload.turnStart.personality, 'none');
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend flips per-thread web_search to live when the gate is enabled', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    reasoningEffort: 'xhigh',
    webSearch: true,
  });

  try {
    const result = await backend.generate(textRequest({ prompt: 'DEBUG_PAYLOAD' }));
    const payload = JSON.parse(result.text);
    assert.equal(payload.threadStart.config.web_search, 'live');
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend validates model and effort against model/list before a turn', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    reasoningEffort: 'high',
  });

  try {
    await backend.prepare();
    assert.equal(backend.model, 'gpt-test-model');
    const max = await backend.generate(textRequest({ prompt: 'DEBUG_PAYLOAD', reasoningEffort: 'max' }));
    assert.equal(JSON.parse(max.text).turnStart.effort, 'max');
    await assert.rejects(
      () => backend.generate(textRequest({ model: 'missing-model' })),
      /model "missing-model" is unavailable/,
    );
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend serves read-only workspace dynamic tool calls', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const cwd = await mkdtemp(join(tmpdir(), 'codex-subagent-workspace-'));
  tempDirs.push(cwd);
  await writeFile(join(cwd, 'workspace-note.txt'), 'hello from workspace\n');
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd,
    timeoutMs: 30_000,
  });

  try {
    const read = await backend.generate(textRequest({ prompt: 'READ_WORKSPACE_TOOL' }));
    assert.match(read.text, /path: workspace-note\.txt/);
    assert.match(read.text, /hello from workspace/);

    const listed = await backend.generate(textRequest({ prompt: 'LIST_WORKSPACE_TOOL' }));
    assert.match(listed.text, /workspace-note\.txt/);
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend denies workspace dynamic tool path escapes', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const cwd = await mkdtemp(join(tmpdir(), 'codex-subagent-workspace-'));
  tempDirs.push(cwd);
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd,
    timeoutMs: 30_000,
  });

  try {
    const result = await backend.generate(textRequest({ prompt: 'READ_OUTSIDE_WORKSPACE_TOOL' }));
    assert.match(result.text, /Path escapes workspace/);
  } finally {
    await backend.close();
  }
});

test('a server tool-call request is serviced even when its id collides with a pending client request', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const cwd = await mkdtemp(join(tmpdir(), 'codex-subagent-collide-'));
  tempDirs.push(cwd);
  await writeFile(join(cwd, 'collide-note.txt'), 'COLLIDE_OK\n');
  const backend = new CodexSubagentBackend({ command: fakeCodex, cwd, timeoutMs: 30_000 });

  try {
    // The fake sends item/tool/call reusing the turn/start id before answering turn/start; a
    // pending-first classifier would misroute it and fail to return a turn id.
    const res = await backend.generate(textRequest({ prompt: 'COLLIDE_ID_TOOL' }));
    assert.match(res.text, /COLLIDE_OK/);
  } finally {
    await backend.close();
  }
});

test('file write tools are offered only to a worktree agent with the gate on', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-subagent-worktree-'));
  tempDirs.push(worktreePath);
  const toolNames = async (opts, req) => {
    const backend = new CodexSubagentBackend({ command: fakeCodex, cwd: process.cwd(), timeoutMs: 30_000, ...opts });
    try {
      const r = await backend.generate({ ...textRequest({ prompt: 'DEBUG_PAYLOAD' }), ...req });
      return JSON.parse(r.text).threadStart.dynamicTools[0].tools.map((t) => t.name);
    } finally {
      await backend.close();
    }
  };
  // gate on + worktree (workspace-write) -> read + write tools
  assert.deepEqual(await toolNames({ fileWrite: true }, { worktreePath }), ['read_file', 'list_directory', 'write_file', 'str_replace']);
  // gate on + no worktree (read-only) -> read-only tools
  assert.deepEqual(await toolNames({ fileWrite: true }, {}), ['read_file', 'list_directory']);
  // gate off + worktree -> read-only tools (byte-identical to today)
  assert.deepEqual(await toolNames({ fileWrite: false }, { worktreePath }), ['read_file', 'list_directory']);
});

test('write_file and str_replace edit files inside the worktree when enabled', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-subagent-worktree-'));
  tempDirs.push(worktreePath);
  await writeFile(join(worktreePath, 'edit-me.txt'), 'mode=off\nkeep\n');
  const backend = new CodexSubagentBackend({ command: fakeCodex, cwd: process.cwd(), timeoutMs: 30_000, fileWrite: true });
  try {
    const wrote = await backend.generate({ ...textRequest({ prompt: writeToolPrompt({ path: 'sub/new.txt', content: 'created' }) }), worktreePath });
    assert.match(wrote.text, /wrote sub\/new\.txt/);
    assert.equal(await readFile(join(worktreePath, 'sub', 'new.txt'), 'utf8'), 'created');

    const edited = await backend.generate({ ...textRequest({ prompt: strReplaceToolPrompt({ path: 'edit-me.txt', old_str: 'mode=off', new_str: 'mode=on' }) }), worktreePath });
    assert.match(edited.text, /edited edit-me\.txt/);
    assert.equal(await readFile(join(worktreePath, 'edit-me.txt'), 'utf8'), 'mode=on\nkeep\n');
  } finally {
    await backend.close();
  }
});

test('str_replace requires exactly one match and leaves the file untouched otherwise', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-subagent-worktree-'));
  tempDirs.push(worktreePath);
  await writeFile(join(worktreePath, 'dup.txt'), 'x x\n');
  const backend = new CodexSubagentBackend({ command: fakeCodex, cwd: process.cwd(), timeoutMs: 30_000, fileWrite: true });
  try {
    const many = await backend.generate({ ...textRequest({ prompt: strReplaceToolPrompt({ path: 'dup.txt', old_str: 'x', new_str: 'y' }) }), worktreePath });
    assert.match(many.text, /appears 2 times/);
    assert.equal(await readFile(join(worktreePath, 'dup.txt'), 'utf8'), 'x x\n');

    const none = await backend.generate({ ...textRequest({ prompt: strReplaceToolPrompt({ path: 'dup.txt', old_str: 'zzz', new_str: 'y' }) }), worktreePath });
    assert.match(none.text, /was not found/);
    assert.equal(await readFile(join(worktreePath, 'dup.txt'), 'utf8'), 'x x\n');

    // A self-overlapping old_str ("aa" in "aaa") is ambiguous and must be rejected as >1, not
    // silently editing the first non-overlapping match.
    await writeFile(join(worktreePath, 'overlap.txt'), 'aaa');
    const overlap = await backend.generate({ ...textRequest({ prompt: strReplaceToolPrompt({ path: 'overlap.txt', old_str: 'aa', new_str: 'b' }) }), worktreePath });
    assert.match(overlap.text, /appears 2 times/);
    assert.equal(await readFile(join(worktreePath, 'overlap.txt'), 'utf8'), 'aaa');
  } finally {
    await backend.close();
  }
});

test('file writes are rejected when the gate is off even if the tool is called', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-subagent-worktree-'));
  tempDirs.push(worktreePath);
  const backend = new CodexSubagentBackend({ command: fakeCodex, cwd: process.cwd(), timeoutMs: 30_000, fileWrite: false });
  try {
    const res = await backend.generate({ ...textRequest({ prompt: writeToolPrompt({ path: 'nope.txt', content: 'x' }) }), worktreePath });
    assert.match(res.text, /File writes are not enabled/);
    await assert.rejects(() => readFile(join(worktreePath, 'nope.txt'), 'utf8'));
  } finally {
    await backend.close();
  }
});

test('write_file rejects path escapes including a final-component symlink (design-verify B1)', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const outsideDir = await mkdtemp(join(tmpdir(), 'codex-subagent-outside-'));
  tempDirs.push(outsideDir);
  const outsideFile = join(outsideDir, 'target.txt');
  await writeFile(outsideFile, 'ORIGINAL\n');
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-subagent-worktree-'));
  tempDirs.push(worktreePath);
  await symlink(outsideFile, join(worktreePath, 'link'));
  const backend = new CodexSubagentBackend({ command: fakeCodex, cwd: process.cwd(), timeoutMs: 30_000, fileWrite: true });
  try {
    const escape = await backend.generate({ ...textRequest({ prompt: writeToolPrompt({ path: '../escape.txt', content: 'PWNED' }) }), worktreePath });
    assert.match(escape.text, /Path escapes workspace/);

    // Overwrite through a pre-existing symlink whose target is outside the root must be refused,
    // and the outside file must remain untouched.
    const viaSymlink = await backend.generate({ ...textRequest({ prompt: writeToolPrompt({ path: 'link', content: 'PWNED' }) }), worktreePath });
    assert.match(viaSymlink.text, /Path escapes workspace/);
    assert.equal(await readFile(outsideFile, 'utf8'), 'ORIGINAL\n');
  } finally {
    await backend.close();
  }
});

test('CodexSubagentBackend runs worktree-isolated turns in the requested workspace', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  const worktreePath = await mkdtemp(join(tmpdir(), 'codex-subagent-worktree-'));
  tempDirs.push(worktreePath);
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  try {
    const result = await backend.generate({
      ...textRequest({ prompt: 'DEBUG_PAYLOAD' }),
      worktreePath,
    });
    const payload = JSON.parse(result.text);
    assert.equal(payload.threadStart.cwd, worktreePath);
    assert.deepEqual(payload.threadStart.runtimeWorkspaceRoots, [worktreePath]);
    assert.equal(payload.threadStart.sandbox, 'workspace-write');
    assert.equal(payload.turnStart.cwd, worktreePath);
    assert.deepEqual(payload.turnStart.runtimeWorkspaceRoots, [worktreePath]);
  } finally {
    await backend.close();
  }
});

test('usageFromCodexTokenUsage returns provider token details', () => {
  assert.deepEqual(usageFromCodexTokenUsage({
    last: {
      totalTokens: 12,
      inputTokens: 7,
      cachedInputTokens: 3,
      outputTokens: 5,
      reasoningOutputTokens: 1,
    },
  }), {
    inputTokens: 7,
    outputTokens: 5,
    totalTokens: 12,
    cachedInputTokens: 3,
    reasoningOutputTokens: 1,
    source: 'provider',
    raw: {
      last: {
        totalTokens: 12,
        inputTokens: 7,
        cachedInputTokens: 3,
        outputTokens: 5,
        reasoningOutputTokens: 1,
      },
    },
  });
  assert.equal(usageFromCodexTokenUsage({ last: {} }), null);
});

test('CodexSubagentBackend classifies a failed turn error into a backend-neutral SubagentFailure', async () => {
  process.env.CODEX_HOME = await createCodexHome();
  setProviderEnv();
  const backend = new CodexSubagentBackend({
    command: fakeCodex,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    reasoningEffort: 'medium',
  });
  try {
    // Terminal: unauthorized must classify terminal, carry the provider message, and keep its variant.
    await assert.rejects(
      backend.generate(textRequest({ prompt: 'FAIL_TURN:unauthorized' })),
      (err) => {
        assert.equal(err.name, 'SubagentFailure');
        assert.equal(err.kind, 'terminal');
        assert.equal(err.variant, 'unauthorized');
        assert.match(err.message, /turn failed: unauthorized/);
        return true;
      },
    );
    // Rate limited stays a distinct, retryable kind.
    await assert.rejects(
      backend.generate(textRequest({ prompt: 'FAIL_TURN:usageLimitExceeded' })),
      (err) => {
        assert.equal(err.kind, 'rate_limited');
        assert.equal(err.variant, 'usageLimitExceeded');
        return true;
      },
    );
  } finally {
    await backend.close();
  }
});

function textRequest(overrides = {}) {
  return {
    model: overrides.model ?? 'codex-subagent',
    messages: [{ role: 'user', content: overrides.prompt ?? 'Return OK.' }],
    reasoningEffort: overrides.reasoningEffort,
    tools: [],
    toolChoice: { type: 'auto' },
  };
}

function writeToolPrompt(args) {
  return `WRITE_TOOL_B64 ${Buffer.from(JSON.stringify(args)).toString('base64')}`;
}

function strReplaceToolPrompt(args) {
  return `STR_REPLACE_TOOL_B64 ${Buffer.from(JSON.stringify(args)).toString('base64')}`;
}

async function createCodexHome() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-subagent-home-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'auth.json'), '{"token":"local-test"}\n');
  await writeFile(join(dir, 'config.toml'), 'model = "gpt-test-model"\n');
  return dir;
}

function snapshotProviderEnv() {
  const out = new Map();
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
    out.set(key, process.env[key]);
  }
  return out;
}

function restoreProviderEnv(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setProviderEnv() {
  process.env.FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV = '1';
  process.env.ANTHROPIC_API_KEY = 'secret-anthropic';
  process.env.ANTHROPIC_BASE_URL = 'https://example.invalid/anthropic';
  process.env.OPENAI_API_KEY = 'secret-openai';
  process.env.OPENAI_BASE_URL = 'https://example.invalid/openai';
}
