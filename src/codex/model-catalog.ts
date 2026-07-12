import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isReasoningEffort, type ReasoningEffort } from '../runtime/types.js';

export interface CodexModelCapability {
  readonly id: string;
  readonly model: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly defaultReasoningEffort: string | null;
  readonly supportedReasoningEfforts: readonly string[];
}

export interface CodexModelCatalogPage {
  readonly models: readonly CodexModelCapability[];
  readonly nextCursor: string | null;
}

export function parseCodexModelCatalogPage(value: unknown): CodexModelCatalogPage {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.data)) {
    throw new Error('Codex model/list returned an invalid catalog response. Upgrade Codex and retry.');
  }
  const models = root.data.map((item, index) => parseCodexModel(item, index));
  const nextCursor = typeof root.nextCursor === 'string' && root.nextCursor
    ? root.nextCursor
    : null;
  return { models, nextCursor };
}

export function selectCodexModelCapability(
  catalog: readonly CodexModelCapability[],
  requestedModel?: string,
): CodexModelCapability {
  if (catalog.length === 0) {
    throw new Error('Codex model catalog is empty. Check authentication or upgrade Codex.');
  }
  const requested = requestedModel?.trim();
  if (requested) {
    const matched = catalog.find((entry) => entry.model === requested || entry.id === requested);
    if (matched) return matched;
    throw new Error(`Codex model "${requested}" is unavailable. Available models: ${availableModelSummary(catalog)}.`);
  }
  const selected = catalog.find((entry) => entry.isDefault)
    ?? catalog.find((entry) => !entry.hidden)
    ?? catalog[0];
  if (!selected) throw new Error('Codex model catalog did not provide a selectable model.');
  return selected;
}

export function assertCodexModelSupportsEffort(
  capability: CodexModelCapability,
  effort: ReasoningEffort,
): void {
  if (capability.supportedReasoningEfforts.includes(effort)) return;
  const supported = capability.supportedReasoningEfforts.filter(isReasoningEffort);
  throw new Error(
    `Codex model "${capability.model}" does not support reasoning effort "${effort}". `
    + `Ultracode-supported efforts for this model: ${supported.join(', ') || 'none'}.`,
  );
}

export function ultracodeSupportedEfforts(
  capability: CodexModelCapability,
): readonly ReasoningEffort[] {
  return capability.supportedReasoningEfforts.filter(isReasoningEffort);
}

export function codexSourceHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME
    : join(homedir(), '.codex');
}

export async function readConfiguredCodexModel(sourceHome = codexSourceHome()): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(sourceHome, 'config.toml'), 'utf8');
  } catch {
    return undefined;
  }
  const match = /^model\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*$/m.exec(text);
  if (!match?.[1]) return undefined;
  return match[1].replace(/\\(["\\])/g, '$1');
}

function parseCodexModel(value: unknown, index: number): CodexModelCapability {
  const record = asRecord(value);
  if (!record) throw new Error(`Codex model/list data[${index}] must be an object.`);
  const model = nonEmptyString(record.model);
  const id = nonEmptyString(record.id) ?? model;
  if (!model || !id) throw new Error(`Codex model/list data[${index}] is missing model/id.`);
  const supported = Array.isArray(record.supportedReasoningEfforts)
    ? record.supportedReasoningEfforts.flatMap((option) => {
        const effort = nonEmptyString(asRecord(option)?.reasoningEffort);
        return effort ? [effort] : [];
      })
    : [];
  return {
    id,
    model,
    hidden: record.hidden === true,
    isDefault: record.isDefault === true,
    defaultReasoningEffort: nonEmptyString(record.defaultReasoningEffort) ?? null,
    supportedReasoningEfforts: [...new Set(supported)],
  };
}

function availableModelSummary(catalog: readonly CodexModelCapability[]): string {
  const models = catalog.filter((entry) => !entry.hidden).map((entry) => entry.model);
  return (models.length > 0 ? models : catalog.map((entry) => entry.model)).slice(0, 12).join(', ');
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
