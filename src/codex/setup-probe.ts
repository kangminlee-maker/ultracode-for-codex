import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { ultracodePackageVersion } from '../runtime/package-info.js';
import type { ReasoningEffort } from '../runtime/types.js';
import { codexDefaultReasoningEffort } from '../settings.js';
import { codexChildProcessEnv } from './env.js';
import {
  assertCodexModelSupportsEffort,
  parseCodexModelCatalogPage,
  readConfiguredCodexModel,
  selectCodexModelCapability,
  ultracodeSupportedEfforts,
  type CodexModelCapability,
} from './model-catalog.js';

export type CodexAuthMethod = 'chatgpt' | 'apiKey' | 'provider' | null;

export interface CodexSetupProbe {
  readonly packageVersion: string;
  readonly nodeVersion: string;
  readonly command: string;
  readonly codexInstalled: boolean;
  readonly codexVersion: string | null;
  readonly appServerReachable: boolean;
  readonly authChecked: boolean;
  readonly loggedIn: boolean;
  readonly authMethod: CodexAuthMethod;
  readonly account: string | null;
  readonly requiresOpenaiAuth: boolean | null;
  readonly modelCatalogChecked: boolean;
  readonly selectedModel: string | null;
  readonly reasoningEffort: ReasoningEffort;
  readonly reasoningEffortSupported: boolean;
  readonly supportedReasoningEfforts: readonly ReasoningEffort[];
  readonly detail: string;
  readonly ready: boolean;
}

interface ProbeOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const MODEL_CATALOG_PAGE_LIMIT = 100;
const MODEL_CATALOG_MAX_PAGES = 20;

export async function probeCodexSetup(options: ProbeOptions): Promise<CodexSetupProbe> {
  const command = options.command?.trim() || 'codex';
  const reasoningEffort = options.reasoningEffort ?? codexDefaultReasoningEffort();
  const requestedModel = options.model?.trim() || await readConfiguredCodexModel();
  const base = {
    packageVersion: ultracodePackageVersion(),
    nodeVersion: process.versions.node,
    command,
  } as const;

  const codexVersion = await readCodexVersion(command);
  if (codexVersion === null) {
    return finalize({
      ...base,
      codexInstalled: false,
      codexVersion: null,
      appServerReachable: false,
      authChecked: false,
      loggedIn: false,
      authMethod: null,
      account: null,
      requiresOpenaiAuth: null,
      modelCatalogChecked: false,
      selectedModel: null,
      reasoningEffort,
      reasoningEffortSupported: false,
      supportedReasoningEfforts: [],
      detail: `Codex CLI not found for "${command}". Install it with: npm install -g @openai/codex`,
    });
  }

  const auth = await probeAppServerAuth(
    command,
    options.cwd,
    options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    requestedModel,
    reasoningEffort,
  );
  return finalize({
    ...base,
    codexInstalled: true,
    codexVersion,
    ...auth,
  });
}

function finalize(fields: Omit<CodexSetupProbe, 'ready'>): CodexSetupProbe {
  return {
    ...fields,
    ready: fields.codexInstalled
      && fields.appServerReachable
      && fields.loggedIn
      && fields.modelCatalogChecked
      && fields.reasoningEffortSupported,
  };
}

function readCodexVersion(command: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(command, ['--version'], { timeout: 5_000, env: codexChildProcessEnv() }, (error, stdout) => {
      if (error) {
        resolvePromise(null);
        return;
      }
      const text = String(stdout).trim();
      resolvePromise(text || 'unknown');
    });
  });
}

interface AuthFields {
  readonly appServerReachable: boolean;
  readonly authChecked: boolean;
  readonly loggedIn: boolean;
  readonly authMethod: CodexAuthMethod;
  readonly account: string | null;
  readonly requiresOpenaiAuth: boolean | null;
  readonly modelCatalogChecked: boolean;
  readonly selectedModel: string | null;
  readonly reasoningEffort: ReasoningEffort;
  readonly reasoningEffortSupported: boolean;
  readonly supportedReasoningEfforts: readonly ReasoningEffort[];
  readonly detail: string;
}

async function probeAppServerAuth(
  command: string,
  cwd: string,
  timeoutMs: number,
  requestedModel: string | undefined,
  reasoningEffort: ReasoningEffort,
): Promise<AuthFields> {
  const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
    cwd,
    shell: false,
    env: codexChildProcessEnv(),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  // A broken pipe if the app-server dies mid-handshake must not crash the CLI.
  child.stdin.on('error', () => undefined);

  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  let nextId = 1;
  let closed = false;
  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(errorText(message.error)));
    } else {
      waiter.resolve(message.result);
    }
  });

  const failAll = (err: Error): void => {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  };
  child.on('error', (err) => failAll(err));
  child.on('close', () => {
    closed = true;
    failAll(new Error('codex app-server exited'));
  });

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (closed || !child.stdin.writable) return Promise.reject(new Error('codex app-server is not running'));
    const id = nextId;
    nextId += 1;
    return new Promise((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const notify = (method: string, params: unknown): void => {
    if (closed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    reader.close();
    child.removeAllListeners('close');
    child.removeAllListeners('error');
    try {
      child.stdin.destroy();
    } catch {
      // stdin may already be torn down
    }
    try {
      child.stdout.destroy();
    } catch {
      // stdout may already be torn down
    }
    if (!closed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // the child may have already exited
      }
    }
    // Detach so a lingering app-server child never blocks the CLI from exiting
    // once the probe has its answer.
    child.unref();
  };

  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`codex app-server did not respond within ${timeoutMs}ms`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  try {
    await Promise.race([
      (async (): Promise<void> => {
        await request('initialize', {
          clientInfo: { name: 'ultracode_for_codex', title: 'Ultracode for Codex', version: ultracodePackageVersion() },
          capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
        });
        notify('initialized', {});
      })(),
      deadline,
    ]);
  } catch (error) {
    cleanup();
    return {
      appServerReachable: false,
      authChecked: false,
      loggedIn: false,
      authMethod: null,
      account: null,
      requiresOpenaiAuth: null,
      modelCatalogChecked: false,
      selectedModel: null,
      reasoningEffort,
      reasoningEffortSupported: false,
      supportedReasoningEfforts: [],
      detail: `Codex app-server unreachable: ${errorText(error)}`,
    };
  }

  try {
    const results = await Promise.race([
      Promise.allSettled([
        request('account/read', { refreshToken: false }),
        readModelCatalog(request),
      ]),
      deadline,
    ]);
    const auth = results[0]?.status === 'fulfilled'
      ? classifyAuth(results[0].value as { account?: { type?: string; email?: string }; requiresOpenaiAuth?: boolean } | undefined)
      : unavailableAuth(results[0]?.reason);
    const model = results[1]?.status === 'fulfilled'
      ? classifyModelCatalog(results[1].value as readonly CodexModelCapability[], requestedModel, reasoningEffort)
      : unavailableModelCatalog(results[1]?.reason, reasoningEffort);
    cleanup();
    return {
      ...auth,
      ...model,
      detail: `${auth.detail}; ${model.modelDetail}`,
    };
  } catch (error) {
    cleanup();
    return {
      ...unavailableAuth(error),
      ...unavailableModelCatalog(error, reasoningEffort),
      appServerReachable: true,
      detail: `Codex setup checks timed out or failed: ${errorText(error)}`,
    };
  }
}

type AuthOnlyFields = Pick<AuthFields, 'appServerReachable' | 'authChecked' | 'loggedIn' | 'authMethod' | 'account' | 'requiresOpenaiAuth' | 'detail'>;
type ModelOnlyFields = Pick<AuthFields, 'modelCatalogChecked' | 'selectedModel' | 'reasoningEffort' | 'reasoningEffortSupported' | 'supportedReasoningEfforts'> & { readonly modelDetail: string };

function classifyAuth(account: { account?: { type?: string; email?: string }; requiresOpenaiAuth?: boolean } | undefined): AuthOnlyFields {
  const info = account?.account ?? null;
  const requiresOpenaiAuth = typeof account?.requiresOpenaiAuth === 'boolean' ? account.requiresOpenaiAuth : null;
  if (info?.type === 'chatgpt') {
    const email = typeof info.email === 'string' && info.email.trim() ? info.email.trim() : null;
    return {
      appServerReachable: true,
      authChecked: true,
      loggedIn: true,
      authMethod: 'chatgpt',
      account: email,
      requiresOpenaiAuth,
      detail: email ? `ChatGPT login active for ${email}` : 'ChatGPT login active',
    };
  }
  if (info?.type === 'apiKey') {
    return {
      appServerReachable: true,
      authChecked: true,
      loggedIn: true,
      authMethod: 'apiKey',
      account: null,
      requiresOpenaiAuth,
      detail: 'API key configured',
    };
  }
  if (requiresOpenaiAuth === false) {
    return {
      appServerReachable: true,
      authChecked: true,
      loggedIn: true,
      authMethod: 'provider',
      account: null,
      requiresOpenaiAuth,
      detail: 'A custom provider is configured that does not require OpenAI authentication',
    };
  }
  return {
    appServerReachable: true,
    authChecked: true,
    loggedIn: false,
    authMethod: null,
    account: null,
    requiresOpenaiAuth,
    detail: 'Codex is installed but not authenticated. Sign in with: !codex login',
  };
}

function unavailableAuth(error: unknown): AuthOnlyFields {
  return {
    appServerReachable: true,
    authChecked: false,
    loggedIn: false,
    authMethod: null,
    account: null,
    requiresOpenaiAuth: null,
    detail: `auth check unavailable: ${errorText(error)}. Try upgrading Codex, then run: !codex login`,
  };
}

async function readModelCatalog(
  request: (method: string, params: unknown) => Promise<unknown>,
): Promise<readonly CodexModelCapability[]> {
  const catalog: CodexModelCapability[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < MODEL_CATALOG_MAX_PAGES; pageIndex += 1) {
    const page = parseCodexModelCatalogPage(await request('model/list', {
      cursor,
      limit: MODEL_CATALOG_PAGE_LIMIT,
      includeHidden: true,
    }));
    catalog.push(...page.models);
    if (!page.nextCursor) return catalog;
    if (seenCursors.has(page.nextCursor)) throw new Error('Codex model/list returned a repeated pagination cursor.');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error(`Codex model/list exceeded ${MODEL_CATALOG_MAX_PAGES} pages.`);
}

function classifyModelCatalog(
  catalog: readonly CodexModelCapability[],
  requestedModel: string | undefined,
  reasoningEffort: ReasoningEffort,
): ModelOnlyFields {
  try {
    const selected = selectCodexModelCapability(catalog, requestedModel);
    const supportedReasoningEfforts = ultracodeSupportedEfforts(selected);
    assertCodexModelSupportsEffort(selected, reasoningEffort);
    return {
      modelCatalogChecked: true,
      selectedModel: selected.model,
      reasoningEffort,
      reasoningEffortSupported: true,
      supportedReasoningEfforts,
      modelDetail: `model ${selected.model} supports Ultracode effort ${reasoningEffort}`,
    };
  } catch (error) {
    const selected = requestedModel
      ? catalog.find((entry) => entry.model === requestedModel || entry.id === requestedModel)
      : catalog.find((entry) => entry.isDefault);
    return {
      modelCatalogChecked: true,
      selectedModel: selected?.model ?? null,
      reasoningEffort,
      reasoningEffortSupported: false,
      supportedReasoningEfforts: selected ? ultracodeSupportedEfforts(selected) : [],
      modelDetail: errorText(error),
    };
  }
}

function unavailableModelCatalog(error: unknown, reasoningEffort: ReasoningEffort): ModelOnlyFields {
  return {
    modelCatalogChecked: false,
    selectedModel: null,
    reasoningEffort,
    reasoningEffortSupported: false,
    supportedReasoningEfforts: [],
    modelDetail: `model catalog unavailable: ${errorText(error)}. Upgrade Codex and retry`,
  };
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return String(value);
}
