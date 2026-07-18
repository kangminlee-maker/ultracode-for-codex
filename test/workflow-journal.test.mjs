import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
  WorkflowJournalValidationError,
  WorkflowJournalWriter,
  boundJournalAuditString,
  computeWorkflowAgentCallKey,
  readWorkflowJournal,
  stableJson,
  workflowJournalHash,
  workflowJournalPath,
} from '../dist/runtime/workflow-journal.js';

test('boundJournalAuditString passes small strings through and truncates oversized ones with a correlatable marker', () => {
  const small = 'a short audit string';
  assert.equal(boundJournalAuditString(small), small, 'strings within the cap are byte-identical');

  // A ~490KiB prompt (like the real per-agent prompts) is still under the 512KiB cap → unchanged.
  const nearCap = 'x'.repeat(490 * 1024);
  assert.equal(boundJournalAuditString(nearCap), nearCap, 'a near-cap string is preserved in full');

  // A prompt over the 512KiB cap (the coloso synthesis case) is truncated, not rejected.
  const huge = 'y'.repeat(600 * 1024);
  const bounded = boundJournalAuditString(huge);
  assert.ok(Buffer.byteLength(bounded, 'utf8') < Buffer.byteLength(huge, 'utf8'), 'oversized string is shrunk');
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= 512 * 1024, 'bounded string fits under MAX_STRING_BYTES');
  assert.match(bounded, /truncated in journal/);
  // The marker carries the true byte length and a sha256 of the FULL value for audit correlation.
  assert.match(bounded, new RegExp(`${600 * 1024} bytes total`));
  assert.match(bounded, new RegExp(`sha256=${createHash('sha256').update(huge).digest('hex')}`));
  assert.ok(bounded.startsWith('y'.repeat(1024)), 'the head of the original is preserved as a preview');
});

test('workflow journal stableJson sorts object keys and rejects nondeterministic values', () => {
  assert.equal(stableJson({ z: 1, a: [true, { b: 'x', a: null }] }), '{"a":[true,{"a":null,"b":"x"}],"z":1}');
  assert.equal(stableJson({ b: 1, _: 2, A: 3, a: 4 }), '{"A":3,"_":2,"a":4,"b":1}');
  assert.throws(() => stableJson({ value: Number.NaN }), WorkflowJournalValidationError);
  assert.throws(() => stableJson({ value: 1n }), WorkflowJournalValidationError);
  assert.throws(() => stableJson({ value: new Date('2026-01-01T00:00:00.000Z') }), WorkflowJournalValidationError);
  assert.throws(() => stableJson({ value: new Map([['a', 1]]) }), WorkflowJournalValidationError);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => stableJson(cyclic), WorkflowJournalValidationError);
});

test('workflow journal logical agent keys are independent of prefix order', () => {
  const semanticOpts = { model: 'fake-local-model', effort: 'xhigh', logicalKey: 'review/candidate-1' };
  const first = computeWorkflowAgentCallKey({
    previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
    prompt: 'Verify candidate one.',
    semanticOpts,
  });
  const reordered = computeWorkflowAgentCallKey({
    previousAgentCallKey: 'a'.repeat(64),
    prompt: 'Verify candidate one.',
    semanticOpts,
  });
  const changedPrompt = computeWorkflowAgentCallKey({
    previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
    prompt: 'Verify candidate two.',
    semanticOpts,
  });
  assert.equal(reordered, first);
  assert.notEqual(changedPrompt, first);
});

test('workflow journal writer appends durable hash-chained entries and reader validates them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-journal-'));
  try {
    const transcriptDir = join(root, 'subagents', 'workflows', 'run_test');
    const writer = await WorkflowJournalWriter.create({
      transcriptDir,
      taskId: 'task_test',
      runId: 'run_test',
    });
    const firstAgentKey = computeWorkflowAgentCallKey({
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      prompt: 'Return alpha.',
      semanticOpts: { model: 'fake-local-model', effort: 'xhigh' },
    });
    await writer.append({
      kind: 'workflow.run.started',
      workflowName: 'journal-demo',
      workflowSource: 'inline',
      scriptPath: '/tmp/journal-demo.js',
      scriptHash: 'sha256:abc',
      args: { topic: 'coverage' },
      runtime: { schemaVersion: 1, cwd: '/tmp' },
    });
    await writer.append({
      kind: 'workflow.agent.started',
      agentIndex: 0,
      agentId: 'agent_1',
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      agentCallKey: firstAgentKey,
      prompt: 'Return alpha.',
      semanticOpts: { model: 'fake-local-model', effort: 'xhigh' },
    });
    await writer.append({
      kind: 'workflow.agent.completed',
      agentIndex: 0,
      agentId: 'agent_1',
      agentCallKey: firstAgentKey,
      result: 'ALPHA',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      toolCalls: 0,
    });
    await writer.append({
      kind: 'workflow.run.completed',
      result: { value: 'ALPHA' },
      resultPath: '/tmp/result.json',
      agentCount: 1,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      toolCalls: 0,
      durationMs: 3,
    });

    const journal = await readWorkflowJournal(workflowJournalPath(transcriptDir));
    assert.equal(journal.truncatedTail, false);
    assert.deepEqual(journal.entries.map((entry) => entry.kind), [
      'workflow.run.started',
      'workflow.agent.started',
      'workflow.agent.completed',
      'workflow.run.completed',
    ]);
    assert.equal(journal.entries[0].previousEntryHash, '0'.repeat(64));
    assert.equal(journal.entries[1].previousEntryHash, journal.entries[0].entryHash);
    assert.equal(journal.entries[2].agentCallKey, firstAgentKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow journal reader rejects unknown fields and recovers only trailing invalid partial JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-journal-invalid-'));
  try {
    const transcriptDir = join(root, 'subagents', 'workflows', 'run_test');
    const writer = await WorkflowJournalWriter.create({
      transcriptDir,
      taskId: 'task_test',
      runId: 'run_test',
    });
    await writer.append({
      kind: 'workflow.run.started',
      workflowName: 'journal-demo',
      workflowSource: 'inline',
      scriptPath: '/tmp/journal-demo.js',
      scriptHash: 'sha256:abc',
      args: null,
      runtime: { schemaVersion: 1, cwd: '/tmp' },
    });
    const journalPath = workflowJournalPath(transcriptDir);
    const valid = await readFile(journalPath, 'utf8');
    await writeFile(join(root, 'unknown.jsonl'), valid.replace('"kind":"workflow.run.started"', '"kind":"workflow.run.started","extra":true'));
    await assert.rejects(() => readWorkflowJournal(join(root, 'unknown.jsonl')), WorkflowJournalValidationError);

    await writeFile(join(root, 'partial.jsonl'), `${valid}{ "kind": "workflow.agent.started"`);
    const partial = await readWorkflowJournal(join(root, 'partial.jsonl'));
    assert.equal(partial.truncatedTail, true);
    assert.equal(partial.entries.length, 1);

    const firstAgentKey = computeWorkflowAgentCallKey({
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      prompt: 'Return alpha.',
      semanticOpts: { model: 'fake-local-model', effort: 'xhigh' },
    });
    await writer.append({
      kind: 'workflow.agent.started',
      agentIndex: 0,
      agentId: 'agent_1',
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      agentCallKey: firstAgentKey,
      prompt: 'Return alpha.',
      semanticOpts: { model: 'fake-local-model', effort: 'xhigh' },
    });
    const parseableTail = (await readFile(journalPath, 'utf8')).trimEnd();
    await writeFile(join(root, 'parseable-tail.jsonl'), parseableTail);
    await assert.rejects(
      () => readWorkflowJournal(join(root, 'parseable-tail.jsonl')),
      /non-newline-terminated JSON entry/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow journal reader rejects tampered agent semantic keys and final pairing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-journal-tamper-'));
  try {
    const transcriptDir = join(root, 'subagents', 'workflows', 'run_test');
    const journalPath = workflowJournalPath(transcriptDir);
    const writer = await WorkflowJournalWriter.create({
      transcriptDir,
      taskId: 'task_test',
      runId: 'run_test',
    });
    const firstAgentKey = computeWorkflowAgentCallKey({
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      prompt: 'Return alpha.',
      semanticOpts: { model: 'fake-local-model', effort: 'xhigh' },
    });
    await writer.append({
      kind: 'workflow.run.started',
      workflowName: 'journal-demo',
      workflowSource: 'inline',
      scriptPath: '/tmp/journal-demo.js',
      scriptHash: 'sha256:abc',
      args: null,
      runtime: { schemaVersion: 1, cwd: '/tmp' },
    });
    await writer.append({
      kind: 'workflow.agent.started',
      agentIndex: 0,
      agentId: 'agent_1',
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      agentCallKey: firstAgentKey,
      prompt: 'Return alpha.',
      semanticOpts: { model: 'fake-local-model', effort: 'xhigh' },
    });
    await writer.append({
      kind: 'workflow.agent.completed',
      agentIndex: 0,
      agentId: 'agent_1',
      agentCallKey: firstAgentKey,
      result: 'ALPHA',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      toolCalls: 0,
    });
    await writer.append({
      kind: 'workflow.run.completed',
      result: 'ALPHA',
      resultPath: '/tmp/result.json',
      agentCount: 1,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      toolCalls: 0,
      durationMs: 1,
    });
    const entries = (await readFile(journalPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));

    const wrongKeyEntries = rehashJournalEntries(entries.map((entry) => {
      if (entry.kind === 'workflow.agent.started' || entry.kind === 'workflow.agent.completed') {
        return { ...entry, agentCallKey: 'a'.repeat(64) };
      }
      return entry;
    }));
    await writeJournalEntries(join(root, 'wrong-key.jsonl'), wrongKeyEntries);
    await assert.rejects(
      () => readWorkflowJournal(join(root, 'wrong-key.jsonl')),
      /agent call key derivation mismatch/,
    );

    const wrongIndexEntries = rehashJournalEntries(entries.map((entry) => (
      entry.kind === 'workflow.agent.completed'
        ? { ...entry, agentIndex: 7 }
        : entry
    )));
    await writeJournalEntries(join(root, 'wrong-index.jsonl'), wrongIndexEntries);
    await assert.rejects(
      () => readWorkflowJournal(join(root, 'wrong-index.jsonl')),
      /agent final index mismatch/,
    );

    const openAgentCompletedEntries = rehashJournalEntries([entries[0], entries[1], entries[3]]);
    await writeJournalEntries(join(root, 'open-agent-completed.jsonl'), openAgentCompletedEntries);
    await assert.rejects(
      () => readWorkflowJournal(join(root, 'open-agent-completed.jsonl')),
      /unfinalized agent/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function rehashJournalEntries(entries) {
  let previousEntryHash = '0'.repeat(64);
  return entries.map((entry, index) => {
    const { entryHash: _entryHash, ...withoutHash } = {
      ...entry,
      seq: index + 1,
      previousEntryHash,
    };
    const entryHash = workflowJournalHash(withoutHash);
    previousEntryHash = entryHash;
    return { ...withoutHash, entryHash };
  });
}

async function writeJournalEntries(path, entries) {
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}
