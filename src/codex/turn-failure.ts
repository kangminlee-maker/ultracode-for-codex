import { SubagentFailure, type SubagentFailureKind } from '../runtime/types.js';

// Classify a codex `turn.error` into a backend-neutral SubagentFailure.
//
// The mapping is pinned to the codex app-server protocol schema
// (definitions.CodexErrorInfo in v2/TurnCompletedNotification.json), whose wire form is
// camelCase and hybrid: 11 bare-string variants plus 5 externally-tagged objects. The
// pinned fixture lives at test/fixtures/codex-schema/ and test/turn-failure.test.mjs
// asserts every fixture variant is covered, so a codex upgrade that renames a variant
// fails the test instead of degrading silently.
//
// `terminal` is a STRICT allowlist: only the variants named below stop being retried.
// Everything else -- `transient`, `rate_limited`, `other`, a missing codexErrorInfo, or a
// variant added in a future codex version -- classifies as retryable, preserving today's
// behavior for anything not provably terminal. See docs/ultracode-p3d-dispatch-core.md 4C.

const TERMINAL_VARIANTS = new Set<string>([
  'unauthorized',
  'badRequest',
  'cyberPolicy',
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'sandboxError',
  'threadRollbackFailed',
  'activeTurnNotSteerable',
]);

const TRANSIENT_VARIANTS = new Set<string>([
  'serverOverloaded',
  'internalServerError',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
]);

const RATE_LIMITED_VARIANTS = new Set<string>([
  'usageLimitExceeded',
]);

export interface CodexErrorClassification {
  readonly kind: SubagentFailureKind;
  readonly variant?: string;
  readonly recognized: boolean;
}

export function classifyCodexErrorInfo(codexErrorInfo: unknown): CodexErrorClassification {
  const variant = codexErrorInfoVariant(codexErrorInfo);
  if (variant === undefined) return { kind: 'transient', recognized: false };
  if (RATE_LIMITED_VARIANTS.has(variant)) return { kind: 'rate_limited', variant, recognized: true };
  if (TERMINAL_VARIANTS.has(variant)) return { kind: 'terminal', variant, recognized: true };
  if (TRANSIENT_VARIANTS.has(variant)) return { kind: 'transient', variant, recognized: true };
  return { kind: 'transient', variant, recognized: false };
}

// CodexErrorInfo is a bare string ("usageLimitExceeded") or a single-key tagged object
// ({ httpConnectionFailed: { httpStatusCode } }). httpStatusCode carries no
// classification signal (it only rides the already-transient object variants), so the
// variant name alone decides the kind.
function codexErrorInfoVariant(info: unknown): string | undefined {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const keys = Object.keys(info);
    if (keys.length === 1) return keys[0];
  }
  return undefined;
}

// Build a SubagentFailure from a codex `TurnError` ({ message, additionalDetails,
// codexErrorInfo }). The provider message is preserved; the kind comes from codexErrorInfo.
export function subagentFailureFromTurnError(turnError: unknown): SubagentFailure {
  const record = turnError && typeof turnError === 'object' && !Array.isArray(turnError)
    ? turnError as Record<string, unknown>
    : undefined;
  const message = typeof record?.message === 'string' && record.message
    ? record.message
    : JSON.stringify(turnError ?? 'turn failed');
  const { kind, variant, recognized } = classifyCodexErrorInfo(record?.codexErrorInfo);
  return new SubagentFailure(message, kind, variant, recognized);
}

// A codex `turn/completed` with any status other than `completed`. Only `completed` is a
// success; `failed` carries a structured error (classified above), and `interrupted` /
// `inProgress` / any unknown status are non-success states that must not resolve as an
// empty successful turn. They are retryable (an interruption we did not initiate may
// succeed on retry) and flagged unrecognized so the runtime can surface them.
export function subagentFailureFromNonCompletedStatus(status: unknown): SubagentFailure {
  return new SubagentFailure(
    `codex turn ended with status "${String(status ?? 'unknown')}" without completion`,
    'transient',
    undefined,
    false,
  );
}
