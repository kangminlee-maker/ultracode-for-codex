// `ultra` is intentionally excluded: Codex interprets it as proactive native
// delegation, which would escape this runtime's journal, cache, and cost
// accounting. `max` remains a single-agent reasoning tier inside that boundary.
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Verbosity = 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
