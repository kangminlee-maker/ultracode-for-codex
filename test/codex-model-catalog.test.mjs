import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertCodexModelSupportsEffort,
  parseCodexModelCatalogPage,
  selectCodexModelCapability,
  ultracodeSupportedEfforts,
} from '../dist/codex/model-catalog.js';

test('Codex model catalog selects the live default and exposes only Ultracode-safe efforts', () => {
  const page = parseCodexModelCatalogPage({
    data: [
      model('gpt-5.6-luna', ['low', 'medium', 'high', 'xhigh', 'max']),
      model('gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], true),
    ],
    nextCursor: null,
  });

  const selected = selectCodexModelCapability(page.models);
  assert.equal(selected.model, 'gpt-5.6-sol');
  assert.deepEqual(ultracodeSupportedEfforts(selected), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.doesNotThrow(() => assertCodexModelSupportsEffort(selected, 'medium'));
  assert.doesNotThrow(() => assertCodexModelSupportsEffort(selected, 'high'));
  assert.doesNotThrow(() => assertCodexModelSupportsEffort(selected, 'max'));
});

test('Codex model catalog fails loudly for unknown models and unsupported efforts', () => {
  const page = parseCodexModelCatalogPage({
    data: [model('gpt-5.6-sol', ['medium', 'high'], true)],
    nextCursor: null,
  });

  assert.throws(
    () => selectCodexModelCapability(page.models, 'missing-model'),
    /model "missing-model" is unavailable/,
  );
  assert.throws(
    () => assertCodexModelSupportsEffort(page.models[0], 'max'),
    /does not support reasoning effort "max"/,
  );
});

function model(name, efforts, isDefault = false) {
  return {
    id: name,
    model: name,
    hidden: false,
    isDefault,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
  };
}
