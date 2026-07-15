// `ultra` is intentionally excluded: Codex interprets it as proactive native
// delegation, which would escape this runtime's journal, cache, and cost
// accounting. `max` remains a single-agent reasoning tier inside that boundary.
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Verbosity = 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// How isolated agent worktrees are retained after a run. `remove-clean` (the default)
// reclaims a completed worktree with no real changes, matching native "unchanged"
// semantics, and preserves changed/stalled/aborted ones for review; `preserve-all` opts
// out and keeps every worktree.
export type WorktreeRetention = 'preserve-all' | 'remove-clean';
export const WORKTREE_RETENTIONS: readonly WorktreeRetention[] = ['preserve-all', 'remove-clean'];
export function isWorktreeRetention(value: unknown): value is WorktreeRetention {
  return typeof value === 'string' && (WORKTREE_RETENTIONS as readonly string[]).includes(value);
}

// Bound on concurrent agent dispatches within one workflow run. `unbounded` (the
// current default) applies no pool -- every launch dispatches immediately, matching
// pre-pool behavior. `auto` derives a pool size from available CPUs. A positive
// integer pins the size. Distinct from `maxParallelism`, which bounds parallel()/
// pipeline() item fan-out and is unaffected by this setting.
export type AgentConcurrency = 'unbounded' | 'auto' | number;
export function isAgentConcurrencyKeyword(value: unknown): value is 'unbounded' | 'auto' {
  return value === 'unbounded' || value === 'auto';
}

// Gate for nested workflow() calls. `disabled` (the current default) keeps the throwing
// stub so existing behavior is byte-identical; `enabled` lets a workflow run a built-in or
// inline child workflow inline, sharing the parent run's pool/counter/budget/abort/journal.
export type NestedWorkflows = 'disabled' | 'enabled';
export const NESTED_WORKFLOWS_VALUES: readonly NestedWorkflows[] = ['disabled', 'enabled'];
export function isNestedWorkflows(value: unknown): value is NestedWorkflows {
  return typeof value === 'string' && (NESTED_WORKFLOWS_VALUES as readonly string[]).includes(value);
}

// Gate for the subagent web_search tool. `disabled` (the current default) keeps
// `web_search="disabled"` at every Codex config site, byte-identical to today; `enabled`
// flips it to `"live"` so workflow subagents can use the native Responses web_search tool.
// Run-level: it applies to every agent in the run and is not part of the agent call key.
export type AgentWebSearch = 'disabled' | 'enabled';
export const AGENT_WEB_SEARCH_VALUES: readonly AgentWebSearch[] = ['disabled', 'enabled'];
export function isAgentWebSearch(value: unknown): value is AgentWebSearch {
  return typeof value === 'string' && (AGENT_WEB_SEARCH_VALUES as readonly string[]).includes(value);
}

// Gate for subagent workspace file writes. `disabled` (the current default) offers only the
// read-only workspace tools, byte-identical to today; `enabled` additionally offers write_file
// and str_replace tools to a **worktree-isolated** agent (never a read-only thread), path-confined
// to that worktree. Run-level: applies to every isolated agent in the run, not in the call key.
export type AgentFileWrite = 'disabled' | 'enabled';
export const AGENT_FILE_WRITE_VALUES: readonly AgentFileWrite[] = ['disabled', 'enabled'];
export function isAgentFileWrite(value: unknown): value is AgentFileWrite {
  return typeof value === 'string' && (AGENT_FILE_WRITE_VALUES as readonly string[]).includes(value);
}

// Backend model name used when no run-level model is configured. It is a
// projection placeholder, never a real Codex model id.
export const SUBAGENT_MODEL_PLACEHOLDER = 'codex-subagent';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export interface SubagentMessage {
  readonly role: 'user';
  readonly content: string;
}

export interface SubagentTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export type SubagentToolChoice =
  | { readonly type: 'auto' }
  | { readonly type: 'required' };

export interface SubagentRequest {
  readonly model: string;
  readonly messages: readonly SubagentMessage[];
  readonly reasoningEffort?: ReasoningEffort;
  readonly tools: readonly SubagentTool[];
  readonly toolChoice: SubagentToolChoice;
  readonly worktreePath?: string;
  readonly raw?: unknown;
}

export interface SubagentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly source?: 'provider' | 'estimated';
  readonly raw?: unknown;
}

export interface SubagentToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface SubagentResult {
  readonly id: string;
  readonly model: string;
  readonly text: string;
  readonly toolCalls: readonly SubagentToolCall[];
  readonly usage: SubagentUsage;
  readonly latencyMs: number;
}

export interface SubagentBackend {
  readonly name: string;
  readonly model: string;
  prepare?(): Promise<void>;
  generate(request: SubagentRequest, signal?: AbortSignal): Promise<SubagentResult>;
  close(): Promise<void>;
}

// Backend-neutral classification of a subagent dispatch failure. The codex backend
// derives it from the provider's structured error at the boundary; the runtime maps it
// to a stable workflow failure code without ever learning codex-specific vocabulary.
// `terminal` retrying cannot fix (auth, bad request, config); `transient` and
// `rate_limited` are retryable. `rate_limited` is distinguished for observability and
// future backoff even though it currently shares `transient`'s retryable code.
export type SubagentFailureKind = 'terminal' | 'transient' | 'rate_limited';

export class SubagentFailure extends Error {
  constructor(
    message: string,
    readonly kind: SubagentFailureKind,
    // The provider wire variant that produced this kind, or undefined when the failure
    // carried no structured error. `recognized` is false when the variant fell through
    // to the default bucket (an unknown/other variant, or none) so the runtime can
    // surface a silent-degradation signal instead of retrying forever in the dark.
    readonly variant?: string,
    readonly recognized: boolean = true,
  ) {
    super(message);
    this.name = 'SubagentFailure';
  }
}

export function isSubagentFailure(err: unknown): err is SubagentFailure {
  return err instanceof SubagentFailure;
}

export class UltracodeRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly type = 'invalid_request_error',
    readonly param: string | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
