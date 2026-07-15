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
