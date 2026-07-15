import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyCodexErrorInfo,
  subagentFailureFromTurnError,
  subagentFailureFromNonCompletedStatus,
} from '../dist/codex/turn-failure.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures/codex-schema/TurnCompletedNotification.v0.144.1.json');

// Pull every CodexErrorInfo variant name out of the pinned protocol schema: the string
// enum (bare-string variants) plus each single-key object variant.
function fixtureVariants() {
  const schema = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const info = schema.definitions.CodexErrorInfo;
  const variants = [];
  for (const branch of info.oneOf) {
    if (branch.type === 'string' && Array.isArray(branch.enum)) variants.push(...branch.enum);
    else if (Array.isArray(branch.required) && branch.required.length === 1) variants.push(branch.required[0]);
  }
  return variants;
}

test('every pinned schema variant is classified; only `other` is intentionally unrecognized (DW-C5)', () => {
  const variants = fixtureVariants();
  // Guard against a vacuous pass: the fixture really did yield the 11+5 variants.
  assert.equal(variants.length, 16, 'expected 16 CodexErrorInfo variants in the pinned schema');
  assert.ok(variants.includes('other'));

  for (const variant of variants) {
    const classification = classifyCodexErrorInfo(variant);
    if (variant === 'other') {
      assert.equal(classification.recognized, false, '`other` is the explicit catch-all');
      assert.equal(classification.kind, 'transient');
    } else {
      assert.equal(
        classification.recognized,
        true,
        `schema variant "${variant}" is not in any allowlist — a codex upgrade added it; update turn-failure.ts`,
      );
      assert.ok(['terminal', 'transient', 'rate_limited'].includes(classification.kind));
    }
  }
});

test('classifyCodexErrorInfo maps representative variants by name, not message text (DW-C1)', () => {
  // Terminal allowlist: retrying cannot fix these.
  for (const v of ['unauthorized', 'badRequest', 'contextWindowExceeded', 'sandboxError']) {
    assert.deepEqual(classifyCodexErrorInfo(v), { kind: 'terminal', variant: v, recognized: true });
  }
  // Rate limited.
  assert.deepEqual(classifyCodexErrorInfo('usageLimitExceeded'), { kind: 'rate_limited', variant: 'usageLimitExceeded', recognized: true });
  // Transient (bare string and tagged-object forms both key on the variant name).
  assert.deepEqual(classifyCodexErrorInfo('serverOverloaded'), { kind: 'transient', variant: 'serverOverloaded', recognized: true });
  assert.deepEqual(
    classifyCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 503 } }),
    { kind: 'transient', variant: 'httpConnectionFailed', recognized: true },
  );
});

test('unknown/other/missing codexErrorInfo falls back to retryable-transient, flagged unrecognized (D-3)', () => {
  assert.deepEqual(classifyCodexErrorInfo('someFutureVariant'), { kind: 'transient', variant: 'someFutureVariant', recognized: false });
  assert.deepEqual(classifyCodexErrorInfo('other'), { kind: 'transient', variant: 'other', recognized: false });
  assert.deepEqual(classifyCodexErrorInfo(null), { kind: 'transient', recognized: false });
  assert.deepEqual(classifyCodexErrorInfo(undefined), { kind: 'transient', recognized: false });
});

test('subagentFailureFromTurnError preserves the provider message and derives the kind', () => {
  const failure = subagentFailureFromTurnError({
    message: 'you are not authorized',
    additionalDetails: null,
    codexErrorInfo: 'unauthorized',
  });
  assert.equal(failure.name, 'SubagentFailure');
  assert.equal(failure.kind, 'terminal');
  assert.equal(failure.variant, 'unauthorized');
  assert.equal(failure.recognized, true);
  assert.equal(failure.message, 'you are not authorized');

  // No codexErrorInfo: retryable-transient, unrecognized, message falls back to JSON.
  const bare = subagentFailureFromTurnError({ message: 'boom' });
  assert.equal(bare.kind, 'transient');
  assert.equal(bare.recognized, false);
  assert.equal(bare.message, 'boom');
});

test('subagentFailureFromNonCompletedStatus makes interrupted a retryable failure, not a success', () => {
  const failure = subagentFailureFromNonCompletedStatus('interrupted');
  assert.equal(failure.kind, 'transient');
  assert.equal(failure.recognized, false);
  assert.match(failure.message, /interrupted/);
});
