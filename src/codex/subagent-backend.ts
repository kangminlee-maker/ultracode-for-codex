import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import readline from 'node:readline';
import {
  codexDefaultReasoningEffort,
  codexDefaultVerbosity,
} from '../settings.js';
import type {
  ReasoningEffort,
  SubagentBackend,
  SubagentRequest,
  SubagentResult,
  SubagentTool,
  SubagentUsage,
  Verbosity,
} from '../runtime/types.js';
import { SUBAGENT_MODEL_PLACEHOLDER, estimateTokens } from '../runtime/types.js';
import { ultracodePackageVersion } from '../runtime/package-info.js';
import { codexChildProcessEnv } from './env.js';

interface CodexSubagentBackendOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly verbosity?: Verbosity;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: JsonRpcMessage) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface TurnWaiter {
  readonly threadId: string;
  readonly turnId: string;
  text: string;
  usage?: SubagentUsage;
  usageUpdatedAt?: number;
  completed: boolean;
  completedAt?: number;
  usageGraceTimer?: NodeJS.Timeout;
  resolve: (value: TurnResult) => void;
  reject: (err: Error) => void;
}

interface BufferedTurnState {
  textDeltas: string[];
  finalText?: string;
  usage?: SubagentUsage;
  usageUpdatedAt?: number;
  completed: boolean;
  completedAt?: number;
  error?: Error;
  cleanupTimer?: NodeJS.Timeout;
}

type JsonRpcMessage = Record<string, unknown>;

interface TurnResult {
  readonly text: string;
  readonly usage?: SubagentUsage;
  readonly usageWaitMs?: number;
}

interface DynamicToolCallResponse {
  readonly success: boolean;
  readonly contentItems: readonly [{ readonly type: 'inputText'; readonly text: string }];
}

export interface CodexIsolation {
  readonly rootDir: string;
  readonly homeDir: string;
  readonly workDir: string;
  readonly defaultModel?: string;
}

const USAGE_NOTIFICATION_GRACE_MS = 100;
const BUFFERED_TURN_STATE_TTL_MS = 30_000;
const DEFAULT_CODEX_RPC_TIMEOUT_MS = 30_000;
const FALLBACK_CODEX_MODEL = 'gpt-5.5';
const WORKSPACE_DYNAMIC_TOOL_NAMESPACE = 'workspace';
const MAX_WORKSPACE_TOOL_READ_BYTES = 200_000;
const MAX_WORKSPACE_TOOL_DIRECTORY_ENTRIES = 200;
const DISABLED_CODEX_CONTEXT_FEATURES = [
  'apps',
  'browser_use',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'multi_agent',
  'plugins',
  'shell_tool',
  'workspace_dependencies',
] as const;
const WORKSPACE_DYNAMIC_TOOLS = [
  {
    type: 'namespace',
    name: WORKSPACE_DYNAMIC_TOOL_NAMESPACE,
    description: 'Read-only access to files in the active workflow workspace.',
    tools: [
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a UTF-8 text file inside the active workflow workspace.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              description: 'Relative path inside the active workspace.',
            },
          },
          required: ['path'],
        },
      },
      {
        type: 'function',
        name: 'list_directory',
        description: 'List direct entries in a directory inside the active workflow workspace.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              description: 'Relative directory path inside the active workspace. Defaults to the workspace root.',
            },
          },
        },
      },
    ],
  },
] as const;

export class CodexSubagentBackend implements SubagentBackend {
  readonly name = 'codex-subagent';
  readonly model: string;

  private readonly command: string;
  private readonly cwd: string;
  private readonly configuredModel?: string;
  private readonly timeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly reasoningEffort: ReasoningEffort;
  private readonly verbosity: Verbosity;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;
  private stderr = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly bufferedTurnStates = new Map<string, BufferedTurnState>();
  private readonly threadReadRoots = new Map<string, string>();
  private isolation: CodexIsolation | null = null;

  constructor(options: CodexSubagentBackendOptions) {
    this.command = options.command ?? 'codex';
    this.cwd = options.cwd;
    this.model = options.model ?? SUBAGENT_MODEL_PLACEHOLDER;
    this.configuredModel = options.model;
    this.timeoutMs = normalizeOptionalTimeoutMs(options.timeoutMs);
    this.rpcTimeoutMs = this.timeoutMs > 0 ? this.timeoutMs : DEFAULT_CODEX_RPC_TIMEOUT_MS;
    this.reasoningEffort = options.reasoningEffort ?? codexDefaultReasoningEffort();
    this.verbosity = options.verbosity ?? codexDefaultVerbosity();
  }

  async generate(request: SubagentRequest, signal?: AbortSignal): Promise<SubagentResult> {
    const startedAt = Date.now();
    await this.ensureStarted();
    const reasoningEffort = request.reasoningEffort ?? this.reasoningEffort;
    const structuredTool = structuredOutputToolFor(request);
    const prompt = workflowAgentPrompt(request, structuredTool);
    let threadId: string | null = null;
    let turnId: string | null = null;
    const interruptTurn = async (): Promise<void> => {
      if (!threadId || !turnId) return;
      await this.send('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    };
    const onAbort = (): void => {
      void interruptTurn();
    };
    if (signal?.aborted) throw new Error('request aborted');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const cwd = request.worktreePath ?? this.cwd;
      threadId = await this.startThread(reasoningEffort, this.verbosity, Boolean(structuredTool), cwd, Boolean(request.worktreePath));
      const turn = await this.send('turn/start', {
        threadId,
        cwd,
        runtimeWorkspaceRoots: [cwd],
        environments: [],
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        model: this.modelOverrideFor(request.model),
        effort: reasoningEffort,
        summary: 'none',
        personality: 'none',
        ...(structuredTool ? { outputSchema: structuredTool.inputSchema } : {}),
      });
      turnId = readPath<string>(turn, ['result', 'turn', 'id']);
      if (!turnId) throw new Error('codex app-server did not return a turn id');
      const result = await this.waitForTurn(threadId, turnId, signal);
      const text = result.text.trim();
      const usage = result.usage ?? estimatedUsage(prompt, text);
      return {
        id: `subagent_${randomUUID()}`,
        model: request.model,
        text: structuredTool ? '' : text,
        toolCalls: structuredTool ? [{
          id: `call_${randomUUID()}`,
          name: structuredTool.name,
          arguments: text,
        }] : [],
        usage,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (threadId) this.archiveThread(threadId);
    }
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('codex subagent backend closed'));
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(new Error('codex subagent backend closed'));
    }
    this.turnWaiters.clear();
    this.clearBufferedTurnStates();
    this.threadReadRoots.clear();
    this.lineReader?.close();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.lineReader = null;
    this.initialized = null;
    await this.cleanupIsolation();
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.start();
    return this.initialized;
  }

  private async start(): Promise<void> {
    const isolation = await createCodexIsolation({
      configuredModel: this.configuredModel,
      reasoningEffort: this.reasoningEffort,
      verbosity: this.verbosity,
    });
    this.isolation = isolation;
    const appServerArgs = [
      'app-server',
      ...codexContextIsolationArgs({
        model: this.configuredModel ?? isolation.defaultModel ?? FALLBACK_CODEX_MODEL,
        reasoningEffort: this.reasoningEffort,
        verbosity: this.verbosity,
      }),
      '--listen',
      'stdio://',
    ];
    this.child = spawn(this.command, appServerArgs, {
      cwd: isolation.workDir,
      shell: false,
      env: codexChildProcessEnv({ CODEX_HOME: isolation.homeDir }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-12_000);
    });
    this.child.on('error', (err) => this.failAll(err));
    this.child.on('close', (code, signal) => {
      this.failAll(new Error(`codex app-server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      this.child = null;
      this.lineReader = null;
      this.initialized = null;
      void this.cleanupIsolation();
    });

    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on('line', (line) => this.handleLine(line));

    await this.send('initialize', {
      clientInfo: {
        name: 'ultracode_for_codex',
        title: 'Ultracode for Codex',
        version: ultracodePackageVersion(),
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify('initialized', {});
  }

  private async startThread(
    reasoningEffort: ReasoningEffort,
    verbosity: Verbosity,
    structured: boolean,
    cwd: string,
    workspaceWrite: boolean,
  ): Promise<string> {
    const thread = await this.send('thread/start', {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: 'never',
      sandbox: workspaceWrite ? 'workspace-write' : 'read-only',
      environments: [],
      dynamicTools: WORKSPACE_DYNAMIC_TOOLS,
      ephemeral: true,
      baseInstructions: 'Ultracode workflow subagent. Produce only the workflow agent return value.',
      developerInstructions: structured
        ? 'Return exactly one JSON value matching the provided outputSchema.'
        : 'Return exactly the raw result text for the workflow script.',
      personality: 'none',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      config: {
        model_reasoning_effort: reasoningEffort,
        model_reasoning_summary: 'none',
        model_verbosity: verbosity,
        web_search: 'disabled',
      },
    });
    const threadId = readPath<string>(thread, ['result', 'thread', 'id']);
    if (!threadId) throw new Error('codex app-server did not return a thread id');
    this.threadReadRoots.set(threadId, await realpath(cwd).catch(() => resolve(cwd)));
    return threadId;
  }

  private archiveThread(threadId: string): void {
    this.threadReadRoots.delete(threadId);
    void this.send('thread/archive', { threadId }).catch(() => undefined);
  }

  private async cleanupIsolation(): Promise<void> {
    const isolation = this.isolation;
    this.isolation = null;
    if (isolation) {
      await rm(isolation.rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }

  private send(method: string, params: unknown): Promise<JsonRpcMessage> {
    if (!this.child) return Promise.reject(new Error('codex app-server is not running'));
    const id = this.nextId;
    this.nextId += 1;
    this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.rpcTimeoutMs}ms`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    const id = typeof message.id === 'number' ? message.id : null;
    if (id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      else pending.resolve(message);
      return;
    }
    if (id !== null && typeof message.method === 'string') {
      this.respondToServerRequest(id, message.method, message.params);
      return;
    }
    if (typeof message.method === 'string') this.handleNotification(message.method, message.params);
  }

  private respondToServerRequest(id: number, method: string, params: unknown): void {
    void (async () => {
      if (method.includes('requestApproval')) {
        this.writeResponse(id, { result: { decision: 'decline' } });
        return;
      }
      if (method === 'item/tool/call') {
        this.writeResponse(id, { result: await this.handleDynamicToolCall(params) });
        return;
      }
      this.writeResponse(id, {
        error: { code: -32601, message: `Unsupported server request: ${method}` },
      });
    })().catch((err) => {
      this.writeResponse(id, {
        error: { code: -32603, message: workflowToolErrorMessage(err) },
      });
    });
  }

  private writeResponse(id: number, response: { readonly result?: unknown; readonly error?: unknown }): void {
    this.child?.stdin.write(`${JSON.stringify({ id, ...response })}\n`);
  }

  private async handleDynamicToolCall(params: unknown): Promise<DynamicToolCallResponse> {
    const data = asRecord(params);
    const threadId = typeof data?.threadId === 'string' ? data.threadId : '';
    const root = this.threadReadRoots.get(threadId);
    if (!root) return dynamicToolFailure('Workspace root is unavailable for this thread.');
    const namespace = data?.namespace === null || typeof data?.namespace === 'string'
      ? data.namespace
      : null;
    const rawTool = typeof data?.tool === 'string' ? data.tool : '';
    const tool = namespace === WORKSPACE_DYNAMIC_TOOL_NAMESPACE
      ? rawTool
      : namespace === null && (rawTool === 'read_file' || rawTool === 'list_directory')
        ? rawTool
      : rawTool.startsWith(`${WORKSPACE_DYNAMIC_TOOL_NAMESPACE}.`)
        ? rawTool.slice(WORKSPACE_DYNAMIC_TOOL_NAMESPACE.length + 1)
        : '';
    const args = asRecord(data?.arguments) ?? {};
    if (tool === 'read_file') {
      return await this.readWorkspaceFile(root, args).catch((err) => dynamicToolFailure(workflowToolErrorMessage(err)));
    }
    if (tool === 'list_directory') {
      return await this.listWorkspaceDirectory(root, args).catch((err) => dynamicToolFailure(workflowToolErrorMessage(err)));
    }
    return dynamicToolFailure(`Unsupported workspace tool: ${namespace ? `${namespace}.` : ''}${rawTool}`);
  }

  private async readWorkspaceFile(root: string, args: Record<string, unknown>): Promise<DynamicToolCallResponse> {
    const requestedPath = typeof args.path === 'string' ? args.path : '';
    if (!requestedPath.trim()) return dynamicToolFailure('read_file requires a non-empty path string.');
    const target = await resolveWorkspaceToolPath(root, requestedPath);
    const fileStat = await stat(target.path).catch((err) => {
      throw new Error(`Cannot stat ${target.relativePath}: ${workflowToolErrorMessage(err)}`);
    });
    if (!fileStat.isFile()) return dynamicToolFailure(`${target.relativePath} is not a file.`);
    if (fileStat.size > MAX_WORKSPACE_TOOL_READ_BYTES) {
      return dynamicToolFailure(`${target.relativePath} is ${fileStat.size} bytes; limit is ${MAX_WORKSPACE_TOOL_READ_BYTES} bytes.`);
    }
    const text = await readFile(target.path, 'utf8').catch((err) => {
      throw new Error(`Cannot read ${target.relativePath}: ${workflowToolErrorMessage(err)}`);
    });
    if (text.includes('\0')) return dynamicToolFailure(`${target.relativePath} appears to be binary.`);
    return dynamicToolSuccess([
      `path: ${target.relativePath}`,
      `bytes: ${Buffer.byteLength(text, 'utf8')}`,
      '',
      text,
    ].join('\n'));
  }

  private async listWorkspaceDirectory(root: string, args: Record<string, unknown>): Promise<DynamicToolCallResponse> {
    const requestedPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
    const target = await resolveWorkspaceToolPath(root, requestedPath);
    const entries = await readdir(target.path, { withFileTypes: true }).catch((err) => {
      throw new Error(`Cannot list ${target.relativePath}: ${workflowToolErrorMessage(err)}`);
    });
    const sorted = entries
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .sort((left, right) => left.localeCompare(right));
    const visible = sorted.slice(0, MAX_WORKSPACE_TOOL_DIRECTORY_ENTRIES);
    const truncated = sorted.length > visible.length
      ? `\n... ${sorted.length - visible.length} more entries omitted`
      : '';
    return dynamicToolSuccess([
      `path: ${target.relativePath}`,
      `entries: ${sorted.length}`,
      '',
      ...visible,
    ].join('\n') + truncated);
  }

  private handleNotification(method: string, params: unknown): void {
    const data = asRecord(params);
    if (!data) return;
    if (method === 'item/agentMessage/delta') {
      const key = turnStateKey(data.threadId, data.turnId);
      if (!key || typeof data.delta !== 'string') return;
      const waiter = this.turnWaiters.get(key);
      if (waiter) waiter.text += data.delta;
      else this.bufferTurnState(key, (state) => state.textDeltas.push(data.delta as string));
      return;
    }
    if (method === 'item/completed') {
      const key = turnStateKey(data.threadId, data.turnId);
      const item = asRecord(data.item);
      if (!key || item?.type !== 'agentMessage' || typeof item.text !== 'string') return;
      const waiter = this.turnWaiters.get(key);
      if (waiter) waiter.text = item.text;
      else this.bufferTurnState(key, (state) => {
        state.finalText = item.text as string;
      });
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const threadId = typeof data.threadId === 'string' ? data.threadId : null;
      const turnId = typeof data.turnId === 'string' ? data.turnId : null;
      if (!threadId || !turnId) return;
      const usage = usageFromCodexTokenUsage(data.tokenUsage);
      if (!usage) return;
      const key = `${threadId}:${turnId}`;
      const waiter = this.turnWaiters.get(key);
      if (waiter) {
        waiter.usage = usage;
        waiter.usageUpdatedAt = Date.now();
        if (waiter.completed) this.resolveTurnWaiter(threadId, turnId);
      } else {
        this.bufferTurnState(key, (state) => {
          state.usage = usage;
          state.usageUpdatedAt = Date.now();
        });
      }
      return;
    }
    if (method === 'turn/completed') {
      const threadId = typeof data.threadId === 'string' ? data.threadId : null;
      const turn = asRecord(data.turn);
      const turnId = typeof turn?.id === 'string' ? turn.id : null;
      if (!threadId || !turnId) return;
      const key = `${threadId}:${turnId}`;
      const waiter = this.turnWaiters.get(key);
      if (!waiter) {
        this.bufferTurnState(key, (state) => {
          if (turn?.status === 'failed') state.error = new Error(JSON.stringify(turn.error ?? 'turn failed'));
          else {
            state.completed = true;
            state.completedAt = Date.now();
          }
        });
        return;
      }
      if (turn?.status === 'failed') {
        this.turnWaiters.delete(key);
        waiter.reject(new Error(JSON.stringify(turn.error ?? 'turn failed')));
      } else {
        this.markWaiterCompleted(threadId, turnId, waiter, Date.now());
      }
    }
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    const key = `${threadId}:${turnId}`;
    return new Promise((resolve, reject) => {
      let waiter: TurnWaiter | undefined;
      const timer = this.timeoutMs > 0
        ? setTimeout(() => {
            this.turnWaiters.delete(key);
            cleanup();
            reject(new Error(`turn timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs)
        : null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (waiter?.usageGraceTimer) {
          clearTimeout(waiter.usageGraceTimer);
          waiter.usageGraceTimer = undefined;
        }
        if (signal) signal.removeEventListener('abort', abortFromSignal);
      };
      const abortFromSignal = (): void => {
        this.turnWaiters.delete(key);
        cleanup();
        reject(new Error('request aborted'));
      };
      waiter = {
        threadId,
        turnId,
        text: '',
        completed: false,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      this.turnWaiters.set(key, waiter);
      if (signal) {
        if (signal.aborted) {
          abortFromSignal();
          return;
        }
        signal.addEventListener('abort', abortFromSignal, { once: true });
      }
      const buffered = this.takeBufferedTurnState(key);
      if (!buffered) return;
      waiter.text = buffered.finalText ?? buffered.textDeltas.join('');
      waiter.usage = buffered.usage;
      waiter.usageUpdatedAt = buffered.usageUpdatedAt;
      if (buffered.error) {
        this.turnWaiters.delete(key);
        cleanup();
        reject(buffered.error);
        return;
      }
      if (buffered.completed) {
        this.markWaiterCompleted(threadId, turnId, waiter, buffered.completedAt ?? Date.now());
      }
    });
  }

  private markWaiterCompleted(threadId: string, turnId: string, waiter: TurnWaiter, completedAt: number): void {
    waiter.completed = true;
    waiter.completedAt = completedAt;
    if (waiter.usage) this.resolveTurnWaiter(threadId, turnId);
    else {
      waiter.usageGraceTimer = setTimeout(
        () => this.resolveTurnWaiter(threadId, turnId),
        USAGE_NOTIFICATION_GRACE_MS,
      );
    }
  }

  private resolveTurnWaiter(threadId: string, turnId: string): void {
    const key = `${threadId}:${turnId}`;
    const waiter = this.turnWaiters.get(key);
    if (!waiter) return;
    this.turnWaiters.delete(key);
    if (waiter.usageGraceTimer) {
      clearTimeout(waiter.usageGraceTimer);
      waiter.usageGraceTimer = undefined;
    }
    waiter.resolve({
      text: waiter.text.trim(),
      usage: waiter.usage,
      usageWaitMs: waiter.completedAt
        ? Math.max(0, (waiter.usageUpdatedAt ?? Date.now()) - waiter.completedAt)
        : 0,
    });
  }

  private failAll(err: Error): void {
    const detail = this.stderr ? `\n${this.stderr.slice(-2000)}` : '';
    const wrapped = new Error(`${err.message}${detail}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(wrapped);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(wrapped);
    this.turnWaiters.clear();
    this.clearBufferedTurnStates();
  }

  private modelOverrideFor(requestModel: string): string | undefined {
    if (requestModel && requestModel !== this.model && requestModel !== SUBAGENT_MODEL_PLACEHOLDER) {
      return requestModel;
    }
    return this.configuredModel;
  }

  private bufferTurnState(key: string, apply: (state: BufferedTurnState) => void): void {
    const state = this.bufferedTurnStates.get(key) ?? {
      textDeltas: [],
      completed: false,
    };
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    apply(state);
    state.cleanupTimer = setTimeout(() => {
      this.bufferedTurnStates.delete(key);
    }, BUFFERED_TURN_STATE_TTL_MS);
    this.bufferedTurnStates.set(key, state);
  }

  private takeBufferedTurnState(key: string): BufferedTurnState | undefined {
    const state = this.bufferedTurnStates.get(key);
    if (!state) return undefined;
    this.bufferedTurnStates.delete(key);
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = undefined;
    }
    return state;
  }

  private clearBufferedTurnStates(): void {
    for (const state of this.bufferedTurnStates.values()) {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    }
    this.bufferedTurnStates.clear();
  }
}

function structuredOutputToolFor(request: SubagentRequest): SubagentTool | null {
  if (request.toolChoice.type !== 'required') return null;
  return request.tools.length === 1 ? request.tools[0] ?? null : null;
}

function workflowAgentPrompt(request: SubagentRequest, structuredTool: SubagentTool | null): string {
  const prompt = request.messages.map((message) => message.content).join('\n\n').trim();
  if (!structuredTool) return prompt;
  return [
    prompt,
    '',
    'Return only the JSON value for StructuredOutput. No Markdown, code fence, or prose.',
  ].join('\n');
}

function estimatedUsage(prompt: string, text: string): SubagentUsage {
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(text);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: 'estimated',
  };
}

function normalizeOptionalTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function turnStateKey(threadId: unknown, turnId: unknown): string | null {
  return typeof threadId === 'string' && typeof turnId === 'string'
    ? `${threadId}:${turnId}`
    : null;
}

function readPath<T>(value: unknown, path: readonly string[]): T | null {
  let current = value;
  for (const part of path) {
    const obj = asRecord(current);
    if (!obj) return null;
    current = obj[part];
  }
  return current as T;
}

async function resolveWorkspaceToolPath(
  root: string,
  requestedPath: string,
): Promise<{ readonly path: string; readonly relativePath: string }> {
  const requested = requestedPath.trim();
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!pathInsideOrEqual(root, candidate)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
  const canonicalPath = await realpath(candidate).catch((err) => {
    throw new Error(`Path not found: ${requestedPath} (${workflowToolErrorMessage(err)})`);
  });
  if (!pathInsideOrEqual(root, canonicalPath)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
  return {
    path: canonicalPath,
    relativePath: relative(root, canonicalPath) || '.',
  };
}

function pathInsideOrEqual(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
}

function dynamicToolSuccess(text: string): DynamicToolCallResponse {
  return {
    success: true,
    contentItems: [{ type: 'inputText', text }],
  };
}

function dynamicToolFailure(text: string): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: 'inputText', text }],
  };
}

function workflowToolErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function usageFromCodexTokenUsage(value: unknown): SubagentUsage | null {
  const usage = asRecord(value);
  const last = asRecord(usage?.last);
  if (!last) return null;
  const totalTokens = readNumber(last.totalTokens);
  const inputTokens = readNumber(last.inputTokens);
  const outputTokens = readNumber(last.outputTokens);
  const cachedInputTokens = readNumber(last.cachedInputTokens);
  const reasoningOutputTokens = readNumber(last.reasoningOutputTokens);
  if (
    totalTokens === 0
    && inputTokens === 0
    && outputTokens === 0
    && cachedInputTokens === 0
    && reasoningOutputTokens === 0
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    source: 'provider',
    raw: value,
  };
}

export function codexContextIsolationArgs(options: {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly verbosity: Verbosity;
}): string[] {
  return [
    '-c',
    `model=${tomlString(options.model)}`,
    '-c',
    `model_reasoning_effort=${tomlString(options.reasoningEffort)}`,
    '-c',
    'model_reasoning_summary="none"',
    '-c',
    `model_verbosity=${tomlString(options.verbosity)}`,
    '-c',
    'web_search="disabled"',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    'shell_environment_policy.inherit="none"',
    ...DISABLED_CODEX_CONTEXT_FEATURES.flatMap((feature) => [
      '-c',
      `features.${feature}=false`,
    ]),
    '-c',
    'notify=[]',
    '-c',
    'analytics.enabled=false',
  ];
}

export async function createCodexIsolation(options: {
  readonly configuredModel?: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly verbosity: Verbosity;
}): Promise<CodexIsolation> {
  const rootDir = await mkdtemp(join(tmpdir(), 'ultracode-for-codex-codex-'));
  const homeDir = join(rootDir, 'codex-home');
  const workDir = join(rootDir, 'workspace');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
  ]);

  const sourceHome = sourceCodexHome();
  const defaultModel = options.configuredModel ?? await readTopLevelStringConfig(sourceHome, 'model');
  await copyCodexAuth(sourceHome, homeDir);
  await writeFile(
    join(homeDir, 'config.toml'),
    minimalCodexConfigToml({
      model: defaultModel ?? FALLBACK_CODEX_MODEL,
      reasoningEffort: options.reasoningEffort,
      verbosity: options.verbosity,
    }),
    { mode: 0o600 },
  );

  return {
    rootDir,
    homeDir,
    workDir,
    defaultModel,
  };
}

export function minimalCodexConfigToml(options: {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly verbosity: Verbosity;
}): string {
  return [
    `model = ${tomlString(options.model)}`,
    `model_reasoning_effort = ${tomlString(options.reasoningEffort)}`,
    'model_reasoning_summary = "none"',
    `model_verbosity = ${tomlString(options.verbosity)}`,
    'web_search = "disabled"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    ...DISABLED_CODEX_CONTEXT_FEATURES.map((feature) => `${feature} = false`),
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    '',
  ].join('\n');
}

function sourceCodexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME
    : join(homedir(), '.codex');
}

async function copyCodexAuth(sourceHome: string, targetHome: string): Promise<void> {
  try {
    await copyFile(join(sourceHome, 'auth.json'), join(targetHome, 'auth.json'));
  } catch {
    // Let Codex surface its normal auth error if the user has no local auth state.
  }
}

async function readTopLevelStringConfig(sourceHome: string, key: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(sourceHome, 'config.toml'), 'utf8');
  } catch {
    return undefined;
  }
  const match = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*$`, 'm').exec(text);
  if (!match?.[1]) return undefined;
  return match[1].replace(/\\(["\\])/g, '$1');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
