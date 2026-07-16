import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
import { SUBAGENT_MODEL_PLACEHOLDER, SubagentFailure, estimateTokens } from '../runtime/types.js';
import { subagentFailureFromNonCompletedStatus, subagentFailureFromTurnError } from './turn-failure.js';
import { ultracodePackageVersion } from '../runtime/package-info.js';
import { codexChildProcessEnv } from './env.js';
import {
  assertCodexModelSupportsEffort,
  codexSourceHome,
  parseCodexModelCatalogPage,
  readConfiguredCodexModel,
  selectCodexModelCapability,
  type CodexModelCapability,
} from './model-catalog.js';

interface CodexSubagentBackendOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly verbosity?: Verbosity;
  // Run-level gate for the native Responses web_search tool. Omitted/false keeps
  // web_search="disabled" at every config site (byte-identical to a no-web-search run);
  // true flips every site to "live". See docs/ultracode-p7-agent-web-search.md.
  readonly webSearch?: boolean;
  // Run-level gate for workspace file writes. Omitted/false offers only the read-only
  // workspace tools (byte-identical). True additionally offers write_file/str_replace to a
  // worktree-isolated agent, path-confined to that worktree. See docs/ultracode-p8-agent-file-write.md.
  readonly fileWrite?: boolean;
  // Named allowlist of the user's Codex MCP servers a subagent may call. Empty/omitted (the default)
  // provisions no `[mcp_servers.*]` into the isolated home and declines every MCP tool-call approval
  // (byte-identical to today). A non-empty list provisions exactly those servers (verbatim from the
  // user's config.toml) and auto-accepts their tool-call approvals. See docs/ultracode-p9-agent-mcp.md.
  readonly mcpServers?: readonly string[];
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
const WORKSPACE_DYNAMIC_TOOL_NAMESPACE = 'workspace';
const MAX_WORKSPACE_TOOL_READ_BYTES = 200_000;
const MAX_WORKSPACE_TOOL_WRITE_BYTES = 200_000;
const MAX_WORKSPACE_TOOL_DIRECTORY_ENTRIES = 200;
const CODEX_MODEL_CATALOG_PAGE_LIMIT = 100;
const CODEX_MODEL_CATALOG_MAX_PAGES = 20;
const NATIVE_MULTI_AGENT_MODE_HINT = 'Native subagent delegation is unavailable inside this Ultracode workflow worker. Complete only the assigned bounded unit; the Ultracode runtime owns fan-out, journaling, retries, and synthesis.';
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
const WORKSPACE_READ_TOOLS = [
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
] as const;
const WORKSPACE_WRITE_TOOLS = [
  {
    type: 'function',
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file inside the active workflow worktree (overwrites if it exists).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Relative path inside the active worktree.',
        },
        content: {
          type: 'string',
          description: 'Full UTF-8 text content to write.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    type: 'function',
    name: 'str_replace',
    description: 'Replace the single unique occurrence of old_str with new_str in a UTF-8 text file inside the active worktree. old_str must occur exactly once.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Relative path inside the active worktree.',
        },
        old_str: {
          type: 'string',
          description: 'Exact text to find; it must occur exactly once in the file.',
        },
        new_str: {
          type: 'string',
          description: 'Replacement text.',
        },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },
] as const;

// Bare (namespace-less) tool names the app-server may send without the `workspace.` prefix — the
// full read+write set, so a bare write name resolves the same as a bare read name.
const WORKSPACE_BARE_TOOL_NAMES = new Set<string>(
  [...WORKSPACE_READ_TOOLS, ...WORKSPACE_WRITE_TOOLS].map((tool) => tool.name),
);

// Read-only when `writable` is false (byte-identical to the pre-write tool set); read+write when
// true. Writes are only ever offered to a worktree-isolated thread whose write root is recorded.
function workspaceDynamicTools(writable: boolean): readonly unknown[] {
  return [
    {
      type: 'namespace',
      name: WORKSPACE_DYNAMIC_TOOL_NAMESPACE,
      description: writable
        ? 'Read and write files in the active workflow worktree.'
        : 'Read-only access to files in the active workflow workspace.',
      tools: writable
        ? [...WORKSPACE_READ_TOOLS, ...WORKSPACE_WRITE_TOOLS]
        : [...WORKSPACE_READ_TOOLS],
    },
  ];
}

export class CodexSubagentBackend implements SubagentBackend {
  readonly name = 'codex-subagent';

  private readonly command: string;
  private readonly cwd: string;
  private readonly configuredModel?: string;
  private readonly timeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly reasoningEffort: ReasoningEffort;
  private readonly verbosity: Verbosity;
  private readonly webSearch: boolean;
  private readonly fileWrite: boolean;
  // Allowlisted MCP server names (exact membership). Empty = MCP off (no provisioning, decline every
  // elicitation). Consulted at isolation setup (provisioning) and at the elicitation approval.
  private readonly mcpServers: readonly string[];
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;
  private stderr = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly bufferedTurnStates = new Map<string, BufferedTurnState>();
  private readonly threadReadRoots = new Map<string, string>();
  // Write root per thread, recorded ONLY for a worktree-isolated thread when file writes are
  // enabled. A thread absent from this map has no write capability; the write handlers reject
  // on a missing entry (defense in depth beyond omitting the tools from the tool list).
  private readonly threadWriteRoots = new Map<string, string>();
  private isolation: CodexIsolation | null = null;
  private resolvedModel?: string;
  private modelCatalog: readonly CodexModelCapability[] = [];

  get model(): string {
    return this.resolvedModel ?? this.configuredModel ?? SUBAGENT_MODEL_PLACEHOLDER;
  }

  constructor(options: CodexSubagentBackendOptions) {
    this.command = options.command ?? 'codex';
    this.cwd = options.cwd;
    this.configuredModel = options.model;
    this.timeoutMs = normalizeOptionalTimeoutMs(options.timeoutMs);
    this.rpcTimeoutMs = this.timeoutMs > 0 ? this.timeoutMs : DEFAULT_CODEX_RPC_TIMEOUT_MS;
    this.reasoningEffort = options.reasoningEffort ?? codexDefaultReasoningEffort();
    this.verbosity = options.verbosity ?? codexDefaultVerbosity();
    this.webSearch = options.webSearch ?? false;
    this.fileWrite = options.fileWrite ?? false;
    this.mcpServers = options.mcpServers ?? [];
  }

  async generate(request: SubagentRequest, signal?: AbortSignal): Promise<SubagentResult> {
    const startedAt = Date.now();
    await this.ensureStarted();
    const reasoningEffort = request.reasoningEffort ?? this.reasoningEffort;
    const requestedModel = request.model && request.model !== SUBAGENT_MODEL_PLACEHOLDER
      ? request.model
      : this.model;
    const capability = selectCodexModelCapability(this.modelCatalog, requestedModel);
    assertCodexModelSupportsEffort(capability, reasoningEffort);
    const structuredTool = structuredOutputToolFor(request);
    const prompt = workflowAgentPrompt(request);
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
      threadId = await this.startThread(capability.model, reasoningEffort, this.verbosity, Boolean(structuredTool), cwd, Boolean(request.worktreePath), request.developerInstructions);
      const turn = await this.send('turn/start', {
        threadId,
        cwd,
        runtimeWorkspaceRoots: [cwd],
        environments: [],
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        model: capability.model,
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
        model: capability.model,
        text: structuredTool ? '' : text,
        toolCalls: structuredTool ? [{
          id: `call_${randomUUID()}`,
          name: structuredTool.name,
          arguments: text,
        }] : [],
        usage,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      // Attach the Codex thread id as a diagnostic correlation id so a failed
      // agent can be traced to its app-server thread in run logs. The thread is
      // ephemeral and its isolated home is removed on close, so this is a
      // correlation id for live-run debugging, not a `codex resume` handle.
      throw withCodexThreadContext(error, threadId);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (threadId) this.archiveThread(threadId);
    }
  }

  async close(): Promise<void> {
    const child = this.child;
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
    this.threadWriteRoots.clear();
    this.lineReader?.close();
    if (child) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      terminateOwnedCodexProcess(child);
    }
    this.child = null;
    this.lineReader = null;
    this.initialized = null;
    this.resolvedModel = undefined;
    this.modelCatalog = [];
    await this.cleanupIsolation();
  }

  async prepare(): Promise<void> {
    await this.ensureStarted();
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
      webSearch: this.webSearch,
      mcpServers: this.mcpServers,
    });
    this.isolation = isolation;
    const appServerArgs = [
      'app-server',
      ...codexContextIsolationArgs({
        model: this.configuredModel ?? isolation.defaultModel,
        reasoningEffort: this.reasoningEffort,
        verbosity: this.verbosity,
        webSearch: this.webSearch,
      }),
      '--listen',
      'stdio://',
    ];
    this.child = spawn(this.command, appServerArgs, {
      cwd: isolation.workDir,
      shell: false,
      detached: process.platform !== 'win32',
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
    this.modelCatalog = await this.readModelCatalog();
    const selected = selectCodexModelCapability(
      this.modelCatalog,
      this.configuredModel ?? isolation.defaultModel,
    );
    assertCodexModelSupportsEffort(selected, this.reasoningEffort);
    this.resolvedModel = selected.model;
  }

  private async startThread(
    model: string,
    reasoningEffort: ReasoningEffort,
    verbosity: Verbosity,
    structured: boolean,
    cwd: string,
    workspaceWrite: boolean,
    personaInstructions?: string,
  ): Promise<string> {
    // Writes are offered ONLY to a worktree-isolated thread (workspaceWrite) and only when the
    // gate is on. Because our dynamic-tool handlers run unsandboxed in this process, a read-only
    // thread must never receive write tools or a write root.
    const writable = workspaceWrite && this.fileWrite;
    const thread = await this.send('thread/start', {
      cwd,
      model,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: 'never',
      sandbox: workspaceWrite ? 'workspace-write' : 'read-only',
      environments: [],
      dynamicTools: workspaceDynamicTools(writable),
      ephemeral: true,
      baseInstructions: 'Ultracode workflow subagent. Produce only the workflow agent return value.',
      // A resolved agent-type persona (PG-AGENTTYPE) precedes the workflow return-value contract,
      // which is appended last so the later instruction wins (native parity: system prompt +
      // StructuredOutput appended). No persona → the fixed contract line alone, byte-identical.
      developerInstructions: composeDeveloperInstructions(personaInstructions, structured),
      personality: 'none',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      config: {
        model_reasoning_effort: reasoningEffort,
        model_reasoning_summary: 'none',
        model_verbosity: verbosity,
        web_search: webSearchConfigValue(this.webSearch),
      },
    });
    const threadId = readPath<string>(thread, ['result', 'thread', 'id']);
    if (!threadId) throw new Error('codex app-server did not return a thread id');
    const canonicalRoot = await realpath(cwd).catch(() => resolve(cwd));
    this.threadReadRoots.set(threadId, canonicalRoot);
    if (writable) this.threadWriteRoots.set(threadId, canonicalRoot);
    return threadId;
  }

  private async readModelCatalog(): Promise<readonly CodexModelCapability[]> {
    const catalog: CodexModelCapability[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < CODEX_MODEL_CATALOG_MAX_PAGES; pageIndex += 1) {
      const response = await this.send('model/list', {
        cursor,
        limit: CODEX_MODEL_CATALOG_PAGE_LIMIT,
        includeHidden: true,
      });
      const page = parseCodexModelCatalogPage(asRecord(response)?.result);
      catalog.push(...page.models);
      if (!page.nextCursor) return catalog;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error('Codex model/list returned a repeated pagination cursor.');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`Codex model/list exceeded ${CODEX_MODEL_CATALOG_MAX_PAGES} pages.`);
  }

  private archiveThread(threadId: string): void {
    this.threadReadRoots.delete(threadId);
    this.threadWriteRoots.delete(threadId);
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
    // Classify by `method` presence FIRST, per JSON-RPC 2.0: a response never carries `method`,
    // a request/notification always does. Keying on `pending.has(id)` first would misroute a
    // server-initiated request (e.g. item/tool/call) as a response whenever its id happens to
    // collide with an outstanding client request id, resolving the wrong promise and dropping the
    // tool call. Method-first makes the two id spaces independent.
    if (typeof message.method === 'string') {
      if (id !== null) this.respondToServerRequest(id, message.method, message.params);
      else this.handleNotification(message.method, message.params);
      return;
    }
    if (id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      else pending.resolve(message);
    }
  }

  private respondToServerRequest(id: number, method: string, params: unknown): void {
    void (async () => {
      if (method === 'mcpServer/elicitation/request') {
        // MCP tool-call approval (see docs/ultracode-p9-agent-mcp.md GATE 0). Accept ONLY an
        // `mcp_tool_call` approval for an allowlisted server; any other elicitation kind (a
        // data-collection form, an OAuth/login prompt) has no human here → decline, fail-closed.
        // `mcpServers` is empty by default → always decline → byte-identical to pre-MCP behavior.
        const record = asRecord(params);
        const serverName = typeof record?.serverName === 'string' ? record.serverName : '';
        const approvalKind = asRecord(record?._meta)?.codex_approval_kind;
        const accept = approvalKind === 'mcp_tool_call' && this.mcpServers.includes(serverName);
        this.writeResponse(id, { result: { action: accept ? 'accept' : 'decline' } });
        return;
      }
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
      : namespace === null && WORKSPACE_BARE_TOOL_NAMES.has(rawTool)
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
    if (tool === 'write_file' || tool === 'str_replace') {
      // Writes require a recorded write root: present only for a worktree-isolated thread with the
      // gate on. A read-only thread has none, so a stray write call fails closed here even if the
      // tool were somehow offered. The write root, not the read root, confines every write path.
      const writeRoot = this.threadWriteRoots.get(threadId);
      if (!writeRoot) return dynamicToolFailure('File writes are not enabled for this agent.');
      const handler = tool === 'write_file'
        ? this.writeWorkspaceFile(writeRoot, args)
        : this.strReplaceWorkspaceFile(writeRoot, args);
      return await handler.catch((err) => dynamicToolFailure(workflowToolErrorMessage(err)));
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

  private async writeWorkspaceFile(root: string, args: Record<string, unknown>): Promise<DynamicToolCallResponse> {
    const requestedPath = typeof args.path === 'string' ? args.path : '';
    if (!requestedPath.trim()) return dynamicToolFailure('write_file requires a non-empty path string.');
    if (typeof args.content !== 'string') return dynamicToolFailure('write_file requires a string content.');
    const bytes = Buffer.byteLength(args.content, 'utf8');
    if (bytes > MAX_WORKSPACE_TOOL_WRITE_BYTES) {
      return dynamicToolFailure(`content is ${bytes} bytes; write limit is ${MAX_WORKSPACE_TOOL_WRITE_BYTES} bytes.`);
    }
    const target = await resolveWorkspaceWritePath(root, requestedPath);
    if (isGitInternalPath(target.relativePath)) return dynamicToolFailure(`refusing to write git metadata path ${target.relativePath}.`);
    await mkdir(dirname(target.path), { recursive: true }).catch((err) => {
      throw new Error(`Cannot create parent directory for ${target.relativePath}: ${workflowToolErrorMessage(err)}`);
    });
    await atomicWriteFile(target.path, args.content).catch((err) => {
      throw new Error(`Cannot write ${target.relativePath}: ${workflowToolErrorMessage(err)}`);
    });
    return dynamicToolSuccess(`wrote ${target.relativePath} (${bytes} bytes)`);
  }

  private async strReplaceWorkspaceFile(root: string, args: Record<string, unknown>): Promise<DynamicToolCallResponse> {
    const requestedPath = typeof args.path === 'string' ? args.path : '';
    if (!requestedPath.trim()) return dynamicToolFailure('str_replace requires a non-empty path string.');
    if (typeof args.old_str !== 'string' || args.old_str === '') return dynamicToolFailure('str_replace requires a non-empty old_str string.');
    if (typeof args.new_str !== 'string') return dynamicToolFailure('str_replace requires a string new_str.');
    // Existing-file resolver: realpaths the target and re-verifies it is inside root (symlink-safe),
    // so the read-then-write-back lands on the same in-root canonical path.
    const target = await resolveWorkspaceToolPath(root, requestedPath);
    if (isGitInternalPath(target.relativePath)) return dynamicToolFailure(`refusing to edit git metadata path ${target.relativePath}.`);
    const fileStat = await stat(target.path).catch((err) => {
      throw new Error(`Cannot stat ${target.relativePath}: ${workflowToolErrorMessage(err)}`);
    });
    if (!fileStat.isFile()) return dynamicToolFailure(`${target.relativePath} is not a file.`);
    if (fileStat.size > MAX_WORKSPACE_TOOL_READ_BYTES) {
      return dynamicToolFailure(`${target.relativePath} is ${fileStat.size} bytes; limit is ${MAX_WORKSPACE_TOOL_READ_BYTES} bytes.`);
    }
    // Read as bytes and require a lossless UTF-8 round-trip: rejects binary AND invalid-UTF-8 text
    // (not just NUL bytes), so a write-back cannot silently corrupt non-UTF-8 content.
    const raw = await readFile(target.path).catch((err) => {
      throw new Error(`Cannot read ${target.relativePath}: ${workflowToolErrorMessage(err)}`);
    });
    const text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) {
      return dynamicToolFailure(`${target.relativePath} is not valid UTF-8 text; str_replace only edits UTF-8 files.`);
    }
    const occurrences = countOccurrences(text, args.old_str);
    if (occurrences === 0) return dynamicToolFailure(`old_str was not found in ${target.relativePath}.`);
    if (occurrences > 1) {
      return dynamicToolFailure(`old_str appears ${occurrences} times in ${target.relativePath}; add surrounding context so it matches exactly once.`);
    }
    // Function replacement so `$&`/`$1`/`$$` in new_str are inserted literally, not treated as
    // String.prototype.replace substitution patterns. Exactly one occurrence, verified above.
    const newStr = args.new_str;
    const next = text.replace(args.old_str, () => newStr);
    const bytes = Buffer.byteLength(next, 'utf8');
    if (bytes > MAX_WORKSPACE_TOOL_WRITE_BYTES) {
      return dynamicToolFailure(`result is ${bytes} bytes; write limit is ${MAX_WORKSPACE_TOOL_WRITE_BYTES} bytes.`);
    }
    await atomicWriteFile(target.path, next).catch((err) => {
      throw new Error(`Cannot write ${target.relativePath}: ${workflowToolErrorMessage(err)}`);
    });
    return dynamicToolSuccess(`edited ${target.relativePath} (${bytes} bytes)`);
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
          if (turn?.status === 'completed') {
            state.completed = true;
            state.completedAt = Date.now();
          } else {
            state.error = turnCompletionFailure(turn);
          }
        });
        return;
      }
      // Only `completed` is a success. `failed` carries a structured error we classify;
      // `interrupted`/`inProgress`/unknown must not resolve as an empty successful turn.
      if (turn?.status === 'completed') {
        this.markWaiterCompleted(threadId, turnId, waiter, Date.now());
      } else {
        this.turnWaiters.delete(key);
        waiter.reject(turnCompletionFailure(turn));
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

function workflowAgentPrompt(request: SubagentRequest): string {
  return request.messages.map((message) => message.content).join('\n\n').trim();
}

// Single source for the Codex `web_search` config value across all three sites (app-server
// spawn args, isolated home config.toml, per-thread config). `false` reproduces today's
// literal "disabled" exactly; `true` enables the native Responses web_search tool.
function webSearchConfigValue(webSearch: boolean | undefined): 'live' | 'disabled' {
  return webSearch ? 'live' : 'disabled';
}

// Compose a thread's developer instructions: an optional agent-type persona followed by the fixed
// workflow return-value contract (appended last so it is never overridden). Absent persona yields the
// contract line alone — byte-identical to the pre-agent-type instructions.
export function composeDeveloperInstructions(persona: string | undefined, structured: boolean): string {
  const returnContract = structured
    ? 'Return exactly one JSON value matching the provided outputSchema.'
    : 'Return exactly the raw result text for the workflow script.';
  const trimmed = persona?.trim();
  return trimmed ? `${trimmed}\n\n${returnContract}` : returnContract;
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

// Write-path resolver that permits a not-yet-existing target (create) while staying symlink-safe.
// `root` is already canonical (realpath at thread start). It rejects any path outside root, then
// canonicalizes the NEAREST EXISTING ancestor and re-verifies it is inside root: an existing target
// or ancestor that is a symlink pointing outside is caught by realpath; not-yet-existing tail
// segments cannot be symlinks, so they append lexically under the canonical ancestor.
async function resolveWorkspaceWritePath(
  root: string,
  requestedPath: string,
): Promise<{ readonly path: string; readonly relativePath: string }> {
  const requested = requestedPath.trim();
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!pathInsideOrEqual(root, candidate)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
  let existing = candidate;
  const tail: string[] = [];
  for (;;) {
    const canonical = await realpath(existing).catch(() => null);
    if (canonical !== null) {
      if (!pathInsideOrEqual(root, canonical)) {
        throw new Error(`Path escapes workspace: ${requestedPath}`);
      }
      const resolved = tail.length ? join(canonical, ...tail.slice().reverse()) : canonical;
      if (!pathInsideOrEqual(root, resolved)) {
        throw new Error(`Path escapes workspace: ${requestedPath}`);
      }
      return { path: resolved, relativePath: relative(root, resolved) || '.' };
    }
    const parent = dirname(existing);
    if (parent === existing) {
      throw new Error(`Path escapes workspace: ${requestedPath}`);
    }
    tail.push(basename(existing));
    existing = parent;
  }
}

// A path is git-internal if any segment is `.git` (the linked-worktree pointer file or, in a normal
// checkout, the repo metadata dir). Writing it can corrupt worktree linkage or plant hooks, so it is
// refused even though it stays inside the workspace root. Split on BOTH separators: on Windows
// `relative()` returns backslash-separated paths, so a `/`-only split would let `.git\config` slip
// past the denylist (Windows-only, defense in depth — worktree confinement still holds).
function isGitInternalPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => segment === '.git');
}

// Write via a temp sibling + rename so a crash mid-write can never truncate/partially overwrite the
// target (important for str_replace, which would otherwise destroy the original). rename replaces the
// destination name atomically and does not follow a destination symlink. The temp file shares the
// target's directory (same filesystem, already confined inside root) so the rename is atomic.
async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, targetPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

// Counts OVERLAPPING occurrences (advance by 1, not needle.length) so a self-overlapping old_str
// (e.g. "aa" in "aaa") is reported as ambiguous (>1) and rejected, rather than silently editing the
// first non-overlapping match — the uniqueness guard must treat overlapping matches as non-unique.
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
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
  readonly model?: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly verbosity: Verbosity;
  readonly webSearch?: boolean;
}): string[] {
  return [
    ...(options.model ? ['-c', `model=${tomlString(options.model)}`] : []),
    '-c',
    `model_reasoning_effort=${tomlString(options.reasoningEffort)}`,
    '-c',
    'model_reasoning_summary="none"',
    '-c',
    `model_verbosity=${tomlString(options.verbosity)}`,
    '-c',
    `web_search=${tomlString(webSearchConfigValue(options.webSearch))}`,
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
    'features.multi_agent_v2.max_concurrent_threads_per_session=1',
    '-c',
    `features.multi_agent_v2.multi_agent_mode_hint_text=${tomlString(NATIVE_MULTI_AGENT_MODE_HINT)}`,
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
  readonly webSearch?: boolean;
  readonly mcpServers?: readonly string[];
}): Promise<CodexIsolation> {
  const rootDir = await mkdtemp(join(tmpdir(), 'ultracode-for-codex-codex-'));
  const homeDir = join(rootDir, 'codex-home');
  const workDir = join(rootDir, 'workspace');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
  ]);

  const sourceHome = codexSourceHome();
  const defaultModel = options.configuredModel ?? await readConfiguredCodexModel(sourceHome);
  await copyCodexAuth(sourceHome, homeDir);
  // Build the whole config in memory, then write ONCE with mode 0o600. An allowlisted MCP block may
  // carry per-server secrets (e.g. a `[mcp_servers.NAME.env]` token), so it must ride the single
  // restricted-mode write — never a second, un-moded append (design-verify F5).
  let configToml = minimalCodexConfigToml({
    model: defaultModel,
    reasoningEffort: options.reasoningEffort,
    verbosity: options.verbosity,
    webSearch: options.webSearch,
  });
  const mcpBlock = await provisionMcpServersToml(sourceHome, options.mcpServers ?? []);
  if (mcpBlock) configToml = `${configToml}${mcpBlock}\n`;
  await writeFile(join(homeDir, 'config.toml'), configToml, { mode: 0o600 });

  return {
    rootDir,
    homeDir,
    workDir,
    defaultModel,
  };
}

// Read the user's config.toml and return the VERBATIM `[mcp_servers.NAME]` sections (plus their
// subtables) for every allowlisted name, or '' when the allowlist is empty (→ byte-identical config).
// Fails loud if an allowlisted name has no matching `[mcp_servers.NAME]` table header, so an
// "MCP enabled but nothing provisioned" state can never pass silently (design-verify F2/F6).
export async function provisionMcpServersToml(
  sourceHome: string,
  allowlist: readonly string[],
): Promise<string> {
  if (allowlist.length === 0) return '';
  let configText: string;
  try {
    configText = await readFile(join(sourceHome, 'config.toml'), 'utf8');
  } catch (err) {
    throw new Error(`--agent-mcp is set but the Codex config was unreadable at ${join(sourceHome, 'config.toml')}: ${workflowToolErrorMessage(err)}`);
  }
  const { block, found } = sliceMcpServerSections(configText, allowlist);
  const missing = allowlist.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(`Unknown MCP server(s): ${missing.join(', ')}. Declared servers must use a [mcp_servers.NAME] table header in ${join(sourceHome, 'config.toml')}.`);
  }
  return block;
}

// Extract, VERBATIM, the union of `[mcp_servers.NAME]` sections owned by any allowlisted name. A
// server NAME owns its own table plus any subtables (`[mcp_servers.NAME.env]`). The match is
// SEGMENT-EXACT (`segments[1]` equals an allowlisted name) — never a prefix/substring test — because
// provisioning spawns the server subprocess at app-server start, so over-inclusion would launch an
// unallowed server (its later tool calls are declined, but the process already ran). Returns the
// concatenated raw section text and the set of names actually found. See docs/ultracode-p9-agent-mcp.md.
export function sliceMcpServerSections(
  configText: string,
  allowlist: readonly string[],
): { readonly block: string; readonly found: Set<string> } {
  const allow = new Set(allowlist);
  const lines = configText.split('\n');
  // Record EVERY table header — single-bracket `[table]` AND array-of-tables `[[table]]` — as a
  // section boundary. An array-of-tables is never an mcp_servers section, but it MUST still terminate
  // the preceding one; missing it would swallow an unrelated `[[...]]` block into the sliced output.
  const headers: { readonly idx: number; readonly header: TomlTableHeader }[] = [];
  lines.forEach((line, idx) => {
    const header = parseTomlTableHeader(line);
    if (header) headers.push({ idx, header });
  });
  const sections: string[] = [];
  const found = new Set<string>();
  for (let h = 0; h < headers.length; h += 1) {
    const entry = headers[h];
    if (!entry) continue;
    const end = h + 1 < headers.length ? (headers[h + 1]?.idx ?? lines.length) : lines.length;
    // Array-of-tables is a boundary only, never a slice target.
    if (entry.header.arrayOfTables) continue;
    const [top, name] = entry.header.segments;
    if (top !== 'mcp_servers' || name === undefined || !allow.has(name)) continue;
    found.add(name);
    // Trim trailing whitespace/CRLF per line block so the concatenation is stable across newlines.
    sections.push(lines.slice(entry.idx, end).join('\n').replace(/\s+$/, ''));
  }
  return { block: sections.length > 0 ? `\n${sections.join('\n\n')}\n` : '', found };
}

interface TomlTableHeader {
  readonly segments: string[];
  readonly arrayOfTables: boolean;
}

// Parse a TOML table header into its dotted-key segments + whether it is an array-of-tables. Handles
// BOTH single-bracket `[a.b."c.d"]` and double-bracket `[[a.b]]`, honoring bare keys and
// basic/literal-quoted segments. Returns null for a non-header line. Comments and trailing content
// after the closing bracket are ignored. Both bracket forms are boundaries; only single-bracket
// `mcp_servers.NAME` tables are sliced (an array-of-tables can never be an mcp server section).
function parseTomlTableHeader(line: string): TomlTableHeader | null {
  const trimmed = line.replace(/^\s+/, '');
  if (!trimmed.startsWith('[')) return null;
  const arrayOfTables = trimmed.startsWith('[[');
  let inner = '';
  let inBasic = false;
  let inLiteral = false;
  let closed = false;
  for (let i = arrayOfTables ? 2 : 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i] ?? '';
    if (inBasic) {
      inner += ch;
      if (ch === '\\') { inner += trimmed[i + 1] ?? ''; i += 1; continue; }
      if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      inner += ch;
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') { inBasic = true; inner += ch; continue; }
    if (ch === "'") { inLiteral = true; inner += ch; continue; }
    // The first unquoted `]` closes the header (for `[[...]]` this is the first of `]]`, which is
    // sufficient to treat the line as a boundary).
    if (ch === ']') { closed = true; break; }
    inner += ch;
  }
  if (!closed) return null;
  const segments = splitTomlDottedKey(inner);
  if (!segments) return null;
  return { segments, arrayOfTables };
}

// Split a dotted key path (`a.b."c.d".e`) into segments, honoring quoted segments; null on malformed.
function splitTomlDottedKey(inner: string): string[] | null {
  const segments: string[] = [];
  let i = 0;
  const n = inner.length;
  while (i < n) {
    while (i < n && /\s/.test(inner[i] ?? '')) i += 1;
    if (i >= n) break;
    let segment = '';
    const ch = inner[i] ?? '';
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < n && inner[i] !== quote) {
        if (quote === '"' && inner[i] === '\\') { segment += (inner[i + 1] ?? ''); i += 2; continue; }
        segment += inner[i] ?? '';
        i += 1;
      }
      if (i >= n) return null;
      i += 1;
    } else {
      while (i < n && inner[i] !== '.' && !/\s/.test(inner[i] ?? '')) { segment += inner[i] ?? ''; i += 1; }
    }
    segments.push(segment);
    while (i < n && /\s/.test(inner[i] ?? '')) i += 1;
    if (i < n) {
      if (inner[i] !== '.') return null;
      i += 1;
    }
  }
  return segments.length > 0 ? segments : null;
}

function withCodexThreadContext(error: unknown, threadId: string | null): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (!threadId || base.message.includes(threadId)) return base;
  base.message = `${base.message} [codex thread ${threadId}]`;
  return base;
}

export function minimalCodexConfigToml(options: {
  readonly model?: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly verbosity: Verbosity;
  readonly webSearch?: boolean;
}): string {
  return [
    ...(options.model ? [`model = ${tomlString(options.model)}`] : []),
    `model_reasoning_effort = ${tomlString(options.reasoningEffort)}`,
    'model_reasoning_summary = "none"',
    `model_verbosity = ${tomlString(options.verbosity)}`,
    `web_search = ${tomlString(webSearchConfigValue(options.webSearch))}`,
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    ...DISABLED_CODEX_CONTEXT_FEATURES.map((feature) => `${feature} = false`),
    '',
    '[features.multi_agent_v2]',
    'max_concurrent_threads_per_session = 1',
    `multi_agent_mode_hint_text = ${tomlString(NATIVE_MULTI_AGENT_MODE_HINT)}`,
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    '',
  ].join('\n');
}

async function copyCodexAuth(sourceHome: string, targetHome: string): Promise<void> {
  try {
    await copyFile(join(sourceHome, 'auth.json'), join(targetHome, 'auth.json'));
  } catch {
    // Let Codex surface its normal auth error if the user has no local auth state.
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function terminateOwnedCodexProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // Fall through when the child exited between the state check and kill.
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // The owned child is already gone.
  }
}

// A non-success `turn/completed`: classify `failed` from its structured error, and treat
// every other non-`completed` status as a retryable, flagged-unrecognized failure.
function turnCompletionFailure(turn: Record<string, unknown> | null): SubagentFailure {
  if (turn?.status === 'failed') return subagentFailureFromTurnError(turn.error);
  return subagentFailureFromNonCompletedStatus(turn?.status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
