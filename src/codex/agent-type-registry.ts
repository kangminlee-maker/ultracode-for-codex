import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedAgentType } from '../runtime/types.js';

// Parse + load the user's native Codex agent registry (`~/.codex/agents/*.toml`) for PG-AGENTTYPE.
// The runtime consumes a backend-neutral Map<name, ResolvedAgentType>; only three top-level string
// scalars are read (model / model_reasoning_effort / developer_instructions). Parsing is LENIENT by
// design: Codex owns and evolves these files, so unknown keys, `[tables]`, arrays, and non-string
// scalars are ignored rather than fatal, and a file that cannot be parsed is skipped (surfaced as a
// warning) instead of aborting the run. Validation of a resolved type happens at use-time in the
// runtime, so only a workflow that actually names a bad type fails. See docs/ultracode-p10-agent-type.md.

// Cap each file read; a persona is small, this only guards against a pathological file.
const MAX_AGENT_TYPE_FILE_BYTES = 64 * 1024;

interface AgentTypeFileFields {
  model?: string;
  effort?: string;
  developerInstructions?: string;
}

export interface AgentTypeRegistryLoad {
  readonly registry: Map<string, ResolvedAgentType>;
  // Files that were present but skipped (unreadable, oversized, or with no usable agent-type keys),
  // paired with the reason. The CLI surfaces these on stderr; they never abort the load.
  readonly warnings: readonly string[];
}

// Load every `*.toml` in `dir` into a registry keyed by filename stem (`reviewer.toml` -> `reviewer`),
// matching the native lookup token. A missing/inaccessible directory yields an empty registry (a
// `--agent-types` run with no registry simply errors as "unknown type" at first use).
export async function loadAgentTypeRegistry(dir: string): Promise<AgentTypeRegistryLoad> {
  const registry = new Map<string, ResolvedAgentType>();
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { registry, warnings };
  }
  const tomlFiles = entries.filter((name) => name.toLowerCase().endsWith('.toml')).sort();
  for (const fileName of tomlFiles) {
    const stem = fileName.slice(0, fileName.length - '.toml'.length);
    if (!stem) continue;
    const filePath = join(dir, fileName);
    let text: string;
    try {
      const buffer = await readFile(filePath);
      if (buffer.byteLength > MAX_AGENT_TYPE_FILE_BYTES) {
        warnings.push(`agent type "${stem}" skipped: ${fileName} exceeds ${MAX_AGENT_TYPE_FILE_BYTES} bytes.`);
        continue;
      }
      text = buffer.toString('utf8');
    } catch (err) {
      warnings.push(`agent type "${stem}" skipped: ${fileName} could not be read (${(err as Error).message}).`);
      continue;
    }
    const fields = parseAgentTypeToml(text);
    // A usable type must contribute at least one consumed field; an all-unknown/garbage file is
    // skipped so a lookup fails loud as "unknown" rather than silently resolving to a no-op type.
    if (fields.model === undefined && fields.effort === undefined && fields.developerInstructions === undefined) {
      warnings.push(`agent type "${stem}" skipped: ${fileName} has no model, model_reasoning_effort, or developer_instructions.`);
      continue;
    }
    registry.set(stem, {
      name: stem,
      ...(fields.model !== undefined ? { model: fields.model } : {}),
      ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
      ...(fields.developerInstructions !== undefined ? { developerInstructions: fields.developerInstructions } : {}),
    });
  }
  return { registry, warnings };
}

// Extract the three consumed string scalars from a Codex agent-type TOML file. Top-level keys precede
// any `[table]` in valid TOML, so scanning stops at the first table header. Everything not a
// recognized string assignment is skipped. Never throws — a fully-unparseable file yields {}.
export function parseAgentTypeToml(text: string): AgentTypeFileFields {
  const out: AgentTypeFileFields = {};
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const n = s.length;
  let i = 0;
  const skipToLineEnd = (): void => { while (i < n && s[i] !== '\n') i += 1; };
  while (i < n) {
    while (i < n && isInlineOrNewlineSpace(s[i])) i += 1;
    if (i >= n) break;
    const c = s[i];
    if (c === '#') { skipToLineEnd(); continue; }
    if (c === '[') break; // first table header ends the top-level scalar region
    // Read a key (bare, or quoted — quoted keys are still consumed to stay aligned).
    let key: string | null;
    if (c === '"' || c === "'") {
      const parsed = readTomlString(s, i);
      if (!parsed) { skipToLineEnd(); continue; }
      key = parsed.value; i = parsed.next;
    } else {
      let bare = '';
      while (i < n && isBareKeyChar(s[i])) { bare += s[i]; i += 1; }
      key = bare === '' ? null : bare;
    }
    while (i < n && isInlineSpace(s[i])) i += 1;
    if (key === null || s[i] !== '=') { skipToLineEnd(); continue; }
    i += 1; // consume '='
    while (i < n && isInlineSpace(s[i])) i += 1;
    const vc = s[i];
    if (vc !== '"' && vc !== "'") { skipToLineEnd(); continue; } // non-string scalar/array → skip
    const parsedValue = readTomlString(s, i);
    if (!parsedValue) { skipToLineEnd(); continue; }
    i = parsedValue.next;
    assignAgentTypeField(out, key, parsedValue.value);
    skipToLineEnd(); // ignore any trailing whitespace/comment after the value
  }
  return out;
}

function assignAgentTypeField(out: AgentTypeFileFields, key: string, value: string): void {
  // First occurrence wins (TOML forbids duplicate keys; be defensive rather than throw).
  if (key === 'model') { if (out.model === undefined) out.model = value; return; }
  if (key === 'model_reasoning_effort') { if (out.effort === undefined) out.effort = value; return; }
  if (key === 'developer_instructions') { if (out.developerInstructions === undefined) out.developerInstructions = value; return; }
}

interface TomlStringRead {
  readonly value: string;
  readonly next: number;
}

// Read a TOML string starting at `s[start]` (a `"` or `'`). Handles single-line basic (`"..."` with
// escape processing), single-line literal (`'...'` verbatim), and both multiline forms (`"""..."""`,
// `'''...'''`) which trim a single leading newline immediately after the opening delimiter — the shape
// every real persona file uses. Returns null on an unterminated string.
export function readTomlString(s: string, start: number): TomlStringRead | null {
  const quote = s[start];
  if (quote !== '"' && quote !== "'") return null;
  const triple = s[start + 1] === quote && s[start + 2] === quote;
  const literal = quote === "'";
  if (triple) {
    let i = start + 3;
    // A newline immediately after the opening delimiter is trimmed (TOML spec).
    if (s[i] === '\n') i += 1;
    let value = '';
    const n = s.length;
    while (i < n) {
      if (s[i] === quote && s[i + 1] === quote && s[i + 2] === quote) {
        return { value, next: i + 3 };
      }
      if (!literal && s[i] === '\\' && i + 1 < n) {
        const esc = readBasicEscape(s, i);
        if (esc) { value += esc.value; i = esc.next; continue; }
      }
      value += s[i];
      i += 1;
    }
    return null; // unterminated
  }
  let i = start + 1;
  let value = '';
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '\n') return null; // single-line string cannot span a newline
    if (ch === quote) return { value, next: i + 1 };
    if (!literal && ch === '\\' && i + 1 < n) {
      const esc = readBasicEscape(s, i);
      if (esc) { value += esc.value; i = esc.next; continue; }
    }
    value += ch;
    i += 1;
  }
  return null; // unterminated
}

// Process the common TOML basic-string escapes. Unknown escapes are passed through verbatim (lenient).
function readBasicEscape(s: string, at: number): { readonly value: string; readonly next: number } | null {
  const e = s[at + 1];
  switch (e) {
    case 'n': return { value: '\n', next: at + 2 };
    case 't': return { value: '\t', next: at + 2 };
    case 'r': return { value: '\r', next: at + 2 };
    case '"': return { value: '"', next: at + 2 };
    case '\\': return { value: '\\', next: at + 2 };
    case 'b': return { value: '\b', next: at + 2 };
    case 'f': return { value: '\f', next: at + 2 };
    case 'u': {
      const hex = s.slice(at + 2, at + 6);
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) return { value: String.fromCharCode(parseInt(hex, 16)), next: at + 6 };
      return null;
    }
    default: return null;
  }
}

function isInlineSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

function isInlineOrNewlineSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n';
}

function isBareKeyChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_.-]/.test(ch);
}
