import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const ULTRACODE_HOME_ENV = 'ULTRACODE_FOR_CODEX_HOME';

export function defaultUltracodeStateRoot(): string {
  const configured = process.env[ULTRACODE_HOME_ENV]?.trim();
  if (configured) return resolveHomePath(configured);
  return join(homedir(), '.ultracode-for-codex');
}

export function defaultWorkflowStateDir(cwd: string = process.cwd()): string {
  const root = resolve(cwd);
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const label = safeWorkspaceLabel(basename(root) || 'workspace');
  return join(defaultUltracodeStateRoot(), 'workspaces', `${label}-${digest}`);
}

export function resolveUltracodeStatePath(value: string): string {
  return resolveHomePath(value.replaceAll('{stateRoot}', defaultUltracodeStateRoot()));
}

function resolveHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return resolve(value);
}

function safeWorkspaceLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';
}
