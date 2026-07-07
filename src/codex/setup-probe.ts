import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { ultracodePackageVersion } from '../runtime/package-info.js';
import { codexChildProcessEnv } from './env.js';

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
  readonly detail: string;
  readonly ready: boolean;
}

interface ProbeOptions {
  readonly command?: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export async function probeCodexSetup(options: ProbeOptions): Promise<CodexSetupProbe> {
  const command = options.command?.trim() || 'codex';
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
      detail: `Codex CLI not found for "${command}". Install it with: npm install -g @openai/codex`,
    });
  }

  const auth = await probeAppServerAuth(command, options.cwd, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  return finalize({
    ...base,
    codexInstalled: true,
    codexVersion,
    ...auth,
  });
}

function finalize(fields: Omit<CodexSetupProbe, 'ready'>): CodexSetupProbe {
  return { ...fields, ready: fields.codexInstalled && fields.appServerReachable && fields.loggedIn };
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
  readonly detail: string;
}

async function probeAppServerAuth(command: string, cwd: string, timeoutMs: number): Promise<AuthFields> {
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
      detail: `Codex app-server unreachable: ${errorText(error)}`,
    };
  }

  try {
    const account = (await Promise.race([request('account/read', { refreshToken: false }), deadline])) as
      | { account?: { type?: string; email?: string }; requiresOpenaiAuth?: boolean }
      | undefined;
    cleanup();
    return classifyAuth(account);
  } catch (error) {
    cleanup();
    return {
      appServerReachable: true,
      authChecked: false,
      loggedIn: false,
      authMethod: null,
      account: null,
      requiresOpenaiAuth: null,
      detail: `Codex is installed and reachable, but the auth check is unavailable: ${errorText(error)}. Try upgrading Codex, then run: !codex login`,
    };
  }
}

function classifyAuth(account: { account?: { type?: string; email?: string }; requiresOpenaiAuth?: boolean } | undefined): AuthFields {
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

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return String(value);
}
