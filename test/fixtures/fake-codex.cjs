#!/usr/bin/env node
const readline = require('node:readline');

assertNoDirectProviderEnv();

let threadSeq = 0;
let turnSeq = 0;
let serverRequestSeq = 1000;
let lastInitializeParams = null;
let lastThreadStartParams = null;
let lastTurnStartParams = null;
const pendingServerRequests = new Map();

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value = {}) {
  write({ id, result: value });
}

function inputText(payload) {
  return JSON.stringify(payload.params?.input ?? []);
}

function emitTurn(threadId, turnId, text = 'OK') {
  write({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, delta: text },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
  setTimeout(() => {
    write({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId,
        tokenUsage: {
          last: {
            totalTokens: 9,
            inputTokens: 5,
            cachedInputTokens: 2,
            outputTokens: 2,
            reasoningOutputTokens: 0,
          },
        },
      },
    });
  }, 0);
}

function emitWorkspaceToolTurn(threadId, turnId, tool, args) {
  void requestWorkspaceTool(threadId, turnId, tool, args).then((response) => {
    const text = response.error
      ? JSON.stringify(response.error)
      : response.result?.contentItems?.map((item) => item.text).join('\n') ?? JSON.stringify(response.result ?? null);
    emitTurn(threadId, turnId, text);
  });
}

function requestWorkspaceTool(threadId, turnId, tool, args) {
  const id = serverRequestSeq;
  serverRequestSeq += 1;
  write({
    id,
    method: 'item/tool/call',
    params: {
      threadId,
      turnId,
      callId: `call_${id}`,
      namespace: 'workspace',
      tool,
      arguments: args,
    },
  });
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
  });
}

function emitEarlyTurn(threadId, turnId) {
  write({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, delta: 'EARLY_OK' },
  });
  write({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          totalTokens: 11,
          inputTokens: 7,
          cachedInputTokens: 3,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    },
  });
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }

  if (payload.id !== undefined && pendingServerRequests.has(payload.id) && payload.method === undefined) {
    const resolve = pendingServerRequests.get(payload.id);
    pendingServerRequests.delete(payload.id);
    resolve(payload);
    return;
  }

  if (payload.id === undefined) return;
  if (payload.method === 'initialize') {
    lastInitializeParams = payload.params ?? null;
    result(payload.id);
    return;
  }
  if (payload.method === 'thread/start') {
    threadSeq += 1;
    lastThreadStartParams = payload.params ?? null;
    result(payload.id, { thread: { id: `thread_${threadSeq}` } });
    return;
  }
  if (payload.method === 'turn/start') {
    turnSeq += 1;
    const threadId = payload.params?.threadId ?? `thread_${threadSeq}`;
    const turnId = `turn_${turnSeq}`;
    const input = inputText(payload);
    lastTurnStartParams = payload.params ?? null;
    if (input.includes('EARLY_DELTA')) {
      emitEarlyTurn(threadId, turnId);
      result(payload.id, { turn: { id: turnId } });
      return;
    }
    if (input.includes('DEBUG_PAYLOAD')) {
      result(payload.id, { turn: { id: turnId } });
      setTimeout(() => emitTurn(threadId, turnId, JSON.stringify(debugPayload())), 0);
      return;
    }
    if (input.includes('READ_WORKSPACE_TOOL')) {
      result(payload.id, { turn: { id: turnId } });
      setTimeout(() => emitWorkspaceToolTurn(threadId, turnId, 'read_file', { path: 'workspace-note.txt' }), 0);
      return;
    }
    if (input.includes('LIST_WORKSPACE_TOOL')) {
      result(payload.id, { turn: { id: turnId } });
      setTimeout(() => emitWorkspaceToolTurn(threadId, turnId, 'list_directory', { path: '.' }), 0);
      return;
    }
    if (input.includes('READ_OUTSIDE_WORKSPACE_TOOL')) {
      result(payload.id, { turn: { id: turnId } });
      setTimeout(() => emitWorkspaceToolTurn(threadId, turnId, 'read_file', { path: '/etc/passwd' }), 0);
      return;
    }
    const effort = payload.params?.effort;
    const outputSchema = payload.params?.outputSchema;
    const text = outputSchema
      ? outputSchema?.properties?.detail && outputSchema?.properties?.count && effort === 'xhigh'
        ? '{"detail":"OK","count":2}'
        : '{"detail":"NOT_XHIGH","count":0}'
      : effort === 'minimal'
        ? 'MINIMAL_OK'
        : effort === 'medium'
          ? 'MEDIUM_OK'
          : 'OK';
    result(payload.id, { turn: { id: turnId } });
    setTimeout(() => emitTurn(threadId, turnId, text), 0);
    return;
  }
  if (payload.method === 'turn/interrupt' || payload.method === 'thread/archive') {
    result(payload.id);
    return;
  }

  write({
    id: payload.id,
    error: { code: -32601, message: `unsupported fake Codex method: ${payload.method}` },
  });
});

rl.on('close', () => process.exit(0));

function assertNoDirectProviderEnv() {
  if (process.env.FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV !== '1') return;
  const found = Object.keys(process.env).filter(isDirectProviderEnvName);
  if (found.length > 0) {
    process.stderr.write(`direct provider env leaked to fake codex: ${found.join(',')}\n`);
    process.exit(91);
  }
}

function debugPayload() {
  return {
    initialize: pick(lastInitializeParams, [
      'clientInfo',
      'capabilities',
    ]),
    threadStart: pick(lastThreadStartParams, [
      'cwd',
      'runtimeWorkspaceRoots',
      'sandbox',
      'dynamicTools',
      'baseInstructions',
      'developerInstructions',
      'personality',
      'experimentalRawEvents',
      'persistExtendedHistory',
      'config',
    ]),
    turnStart: pick(lastTurnStartParams, [
      'cwd',
      'runtimeWorkspaceRoots',
      'effort',
      'summary',
      'personality',
      'outputSchema',
      'input',
    ]),
  };
}

function pick(value, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.hasOwn(value ?? {}, key)) out[key] = value[key];
  }
  return out;
}

function isDirectProviderEnvName(name) {
  const prefixes = [
    'ANTHROPIC',
    'AZURE_OPENAI',
    'COHERE',
    'DEEPSEEK',
    'GEMINI',
    'GOOGLE',
    'GROQ',
    'MISTRAL',
    'OPENAI',
    'OPENROUTER',
    'PERPLEXITY',
    'TOGETHER',
    'XAI',
  ];
  const suffixes = [
    'ACCESS_TOKEN',
    'API_BASE',
    'API_KEY',
    'AUTH_TOKEN',
    'BASE_URL',
    'ENDPOINT',
    'ORG_ID',
    'ORGANIZATION',
    'PROJECT',
  ];
  return prefixes.some((prefix) => suffixes.some((suffix) => name === `${prefix}_${suffix}`));
}
