import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codexDefaultReasoningEffort,
  codexDefaultVerbosity,
  isReasoningEffort,
  isVerbosity,
  isWorkflowExecutionMode,
  isWorkflowPermissionPolicy,
  isWorkflowProgressMode,
  loadSettings,
  workflowBackgroundDefaults,
  workflowDefaultExecutionMode,
  workflowDefaultPermissionPolicy,
  workflowDefaultProgressMode,
  workflowDefaultRetryLimit,
  workflowDefaultTimeoutMs,
} from '../dist/settings.js';

test('settings.json provides Codex workflow runtime defaults', () => {
  assert.deepEqual(loadSettings(), {
    workflow: {
      executionMode: 'background',
      progress: 'jsonl',
      permission: 'ask',
      retryLimit: 0,
      timeoutMs: 0,
      background: {
        runDir: '.ultracode-for-codex/background/{jobId}',
        resultFile: 'result.json',
        progressFile: 'progress.jsonl',
        metadataFile: 'metadata.json',
        pidFile: 'pid',
      },
    },
    codex: {
      reasoningEffort: 'xhigh',
      verbosity: 'medium',
    },
  });
  assert.equal(workflowDefaultExecutionMode(), 'background');
  assert.equal(workflowDefaultProgressMode(), 'jsonl');
  assert.equal(workflowDefaultPermissionPolicy(), 'ask');
  assert.equal(workflowDefaultRetryLimit(), 0);
  assert.equal(workflowDefaultTimeoutMs(), 0);
  assert.deepEqual(workflowBackgroundDefaults(), {
    runDir: '.ultracode-for-codex/background/{jobId}',
    resultFile: 'result.json',
    progressFile: 'progress.jsonl',
    metadataFile: 'metadata.json',
    pidFile: 'pid',
  });
  assert.equal(codexDefaultReasoningEffort(), 'xhigh');
  assert.equal(codexDefaultVerbosity(), 'medium');
});

test('settings validators accept only supported Codex model controls', () => {
  assert.equal(isReasoningEffort('medium'), true);
  assert.equal(isReasoningEffort('tiny'), false);
  assert.equal(isVerbosity('medium'), true);
  assert.equal(isVerbosity('tiny'), false);
  assert.equal(isWorkflowExecutionMode('background'), true);
  assert.equal(isWorkflowExecutionMode('daemon'), false);
  assert.equal(isWorkflowProgressMode('jsonl'), true);
  assert.equal(isWorkflowProgressMode('stream'), false);
  assert.equal(isWorkflowPermissionPolicy('ask'), true);
  assert.equal(isWorkflowPermissionPolicy('maybe'), false);
});
