import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import { WorkflowTaskRegistry, isRetryableFailureReason } from '../dist/runtime/workflow-runtime.js';
import { SubagentFailure } from '../dist/runtime/types.js';
import {
  WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
  WorkflowJournalWriter,
  computeWorkflowAgentCallKey,
  readWorkflowJournal,
  workflowJournalPath,
} from '../dist/runtime/workflow-journal.js';

const tempDirs = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('workflow runtime runs inline raw and structured agents with CLI-consumable events', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const launch = await runtime.launch({
      script: `export const meta = {
  name: "runtime-smoke",
  description: "Run raw and structured agents",
  phases: [{ title: "Run", detail: "Call subagents" }]
};
phase("Run");
const raw = await agent("process module text", { label: "raw-agent" });
const structured = await agent("structured please", {
  label: "structured-agent",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      detail: { type: "string" },
      count: { type: "integer" }
    },
    required: ["detail", "count"]
  }
});
log("done");
return { raw, structured };`,
      args: { topic: 'runtime-test' },
    });

    assert.equal(launch.status, 'async_launched');
    const events = await collectEvents(runtime, launch.taskId);
    assert.equal(events[0].type, 'workflow.started');
    assert.equal(events.at(-1).type, 'workflow.completed');
    assert.ok(events.some((event) => event.type === 'workflow.agent.started' && event.label === 'raw-agent'));
    const rawCompleted = events.find((event) => event.type === 'workflow.agent.completed' && event.label === 'raw-agent');
    assert.equal(rawCompleted.resultPreview, 'RAW:process module text');
    assert.equal(rawCompleted.completedAgentCount, 1);
    assert.equal(rawCompleted.knownAgentCount, 1);
    assert.equal(rawCompleted.phaseCompletedAgentCount, 1);
    assert.equal(rawCompleted.phaseKnownAgentCount, 1);
    assert.equal(typeof rawCompleted.elapsedMs, 'number');

    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.deepEqual(snapshot.result, {
      raw: 'RAW:process module text',
      structured: { detail: 'structured', count: 2 },
    });

    const journal = await readWorkflowJournal(workflowJournalPath(snapshot.transcriptDir));
    assert.deepEqual(journal.entries.map((entry) => entry.kind), [
      'workflow.run.started',
      'workflow.agent.started',
      'workflow.agent.completed',
      'workflow.agent.started',
      'workflow.agent.completed',
      'workflow.run.completed',
    ]);
    assert.equal(journal.entries[1].prompt, 'process module text');
    assert.equal(journal.entries[3].semanticOpts.schema.type, 'object');
    assert.equal(backend.requests.length, 2);
  } finally {
    await runtime.close();
  }
});

test('workflow agents pass per-agent effort and model overrides to the backend and journal', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const launch = await runtime.launch({
      script: `export const meta = {
  name: "agent-overrides",
  description: "Run default and tiered agent options",
  phases: [{ title: "Run", detail: "Call subagents" }]
};
phase("Run");
const first = await agent("default options agent", { label: "default-agent" });
const second = await agent("tiered agent", { label: "tiered-agent", effort: "high", model: "fake-model-mini" });
return { first, second };`,
    });

    const events = await collectEvents(runtime, launch.taskId);
    assert.equal(events.at(-1).type, 'workflow.completed');
    assert.equal(backend.requests.length, 2);
    assert.equal(backend.requests[0].reasoningEffort, 'xhigh');
    assert.equal(backend.requests[0].model, 'fake-model');
    assert.equal(backend.requests[1].reasoningEffort, 'high');
    assert.equal(backend.requests[1].model, 'fake-model-mini');

    const snapshot = runtime.get(launch.taskId);
    const journal = await readWorkflowJournal(workflowJournalPath(snapshot.transcriptDir));
    const started = journal.entries.filter((entry) => entry.kind === 'workflow.agent.started');
    assert.deepEqual(started[0].semanticOpts, { model: 'fake-model', effort: 'xhigh' });
    assert.deepEqual(started[1].semanticOpts, { model: 'fake-model-mini', effort: 'high' });
    // Pin the pre-P4 call-key byte contract: a default-options agent must keep
    // producing the exact key an older runtime journaled for the same call.
    assert.equal(started[0].agentCallKey, computeWorkflowAgentCallKey({
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      prompt: 'default options agent',
      semanticOpts: { model: 'fake-model', effort: 'xhigh' },
    }));
  } finally {
    await runtime.close();
  }
});

test('workflow agents inherit the run-level medium/high effort unless a script overrides it', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: { defaultReasoningEffort: 'medium' },
  });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "run-effort" };
const inherited = await agent("inherit medium");
const raised = await agent("raise for verdict", { effort: "high" });
const maxed = await agent("bounded max", { effort: "max" });
return { inherited, raised, maxed };`,
    });
    await collectEvents(runtime, launch.taskId);
    assert.deepEqual(
      backend.requests.map((request) => request.reasoningEffort),
      ['medium', 'high', 'max'],
    );
  } finally {
    await runtime.close();
  }
});

test('workflow prepares model capability truth only when a script can call an agent', async () => {
  const backend = new FakeSubagentBackend();
  backend.model = 'codex-subagent';
  let prepareCalls = 0;
  backend.prepare = async () => {
    prepareCalls += 1;
    backend.model = 'catalog-model';
  };
  const { runtime } = await createRuntime({ backend });
  try {
    const deterministic = await runtime.launch({
      script: 'export const meta = { name: "no-agent" };\n// agent("comment only")\nreturn { text: "agent( is literal text" };',
    });
    await collectEvents(runtime, deterministic.taskId);
    assert.equal(prepareCalls, 0);

    const delegated = await runtime.launch({
      script: 'export const meta = { name: "with-agent" };\nreturn await agent("inspect");',
    });
    await collectEvents(runtime, delegated.taskId);
    assert.equal(prepareCalls, 1);
    const journal = await readWorkflowJournal(workflowJournalPath(runtime.get(delegated.taskId).transcriptDir));
    assert.equal(journal.entries[0].runtime.model, 'catalog-model');
  } finally {
    await runtime.close();
  }
});

test('workflow emits non-destructive heartbeats while running and stays off by default', async () => {
  const script = `export const meta = { name: "heartbeat-demo", description: "Slow run for heartbeat", phases: [{ title: "Work" }] };
phase("Work");
await agent("SILENT_75MS one", { label: "slow-one" });
await agent("SILENT_75MS two", { label: "slow-two" });
return "done";`;

  // Heartbeat on: a short interval over a ~150ms run yields >=1 heartbeat, the
  // run still completes (proving the heartbeat never aborts), and each beat
  // carries elapsed/phase/agent progress with a strictly increasing seq.
  const beating = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { heartbeatMs: 20 } });
  try {
    const launch = await beating.runtime.launch({ script });
    const events = await collectEvents(beating.runtime, launch.taskId);
    const heartbeats = events.filter((event) => event.type === 'workflow.heartbeat');
    assert.ok(heartbeats.length >= 1, `expected at least one heartbeat, got ${heartbeats.length}`);
    assert.equal(events.at(-1).type, 'workflow.completed');
    for (const hb of heartbeats) {
      assert.equal(typeof hb.elapsedMs, 'number');
      assert.equal(typeof hb.completedAgentCount, 'number');
      assert.equal(typeof hb.knownAgentCount, 'number');
    }
    assert.deepEqual(
      heartbeats.map((hb) => hb.seq),
      heartbeats.map((_, index) => index + 1),
      'heartbeat seq must be a strictly increasing 1-based sequence',
    );
    // No heartbeat may leak after the terminal event.
    const terminalIndex = events.findIndex((event) => event.type === 'workflow.completed');
    assert.equal(events.slice(terminalIndex + 1).some((event) => event.type === 'workflow.heartbeat'), false);
  } finally {
    await beating.runtime.close();
  }

  // Default (no heartbeatMs) preserves the pre-heartbeat event stream exactly.
  const silent = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const launch = await silent.runtime.launch({ script });
    const events = await collectEvents(silent.runtime, launch.taskId);
    assert.equal(events.some((event) => event.type === 'workflow.heartbeat'), false);
    assert.equal(silent.runtime.get(launch.taskId).status, 'completed');
  } finally {
    await silent.runtime.close();
  }
});

test('a backend failure surfacing through an unawaited agent stays retryable', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    // Start both, await sequentially: a normal fan-out idiom where the second agent can
    // reject while the script is still blocked on the first, so it reaches the runtime as
    // an unhandled tracked-promise rejection rather than a throw from `await`.
    const launch = await runtime.launch({
      script: 'export const meta = { name: "unawaited-backend-failure" };\nconst first = agent("SILENT_75MS");\nconst second = agent("FAIL_AGENT");\nawait first;\nreturn await second;',
    });
    const events = await collectEvents(runtime, launch.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    // The backend throws a plain uncoded Error; coding it at the boundary keeps a transient
    // failure retryable instead of collapsing it into a deterministic-defect wrapper reason.
    assert.equal(events.at(-1).recovery.reason, 'workflow_agent_failed');
    assert.equal(events.at(-1).recovery.retryable, true);
  } finally {
    await runtime.close();
  }
});

test('a plain timer callback throw keeps its wrapper reason and stays non-retryable', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "timer-throw" };\nsetTimeout(function () { throw new Error("boom"); }, 1);\nreturn await agent("WAIT");',
    });
    const events = await collectEvents(runtime, launch.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    // Deriving purely from the underlying error would collapse this deterministic script
    // defect into the retryable `workflow_failed` catch-all and repeat it to the limit.
    assert.equal(events.at(-1).recovery.reason, 'workflow_timer_callback_failed');
    assert.equal(events.at(-1).recovery.retryable, false);
  } finally {
    await runtime.close();
  }
});

test('isRetryableFailureReason classifies transient reasons retryable and deterministic reasons non-retryable', () => {
  for (const reason of [
    'workflow_failed',
    'workflow_agent_failed',
    'workflow_agent_stalled',
    'workflow_journal_write_failed',
    'workflow_structured_output_failed',
  ]) {
    assert.equal(isRetryableFailureReason(reason), true, `${reason} should be retryable`);
  }
  for (const reason of [
    'workflow_meta_invalid',
    'workflow_input_invalid',
    'workflow_script_nondeterministic',
    'workflow_permission_denied',
    'workflow_resume_running',
    'runtime_closed',
    'workflow_aborted',
    'workflow_unrecognized_future_code',
    undefined,
  ]) {
    assert.equal(isRetryableFailureReason(reason), false, `${String(reason)} should be non-retryable`);
  }
});

test('an oversized agent prompt no longer aborts the run: full prompt dispatched, journal copy bounded, resume intact (coloso journal-write regression)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    // 600KiB prompt > the journal's 512KiB MAX_STRING_BYTES cap — the exact shape that killed the
    // coloso synthesis agent with workflow_journal_write_failed "before agent start". A STRUCTURED
    // agent mirrors the real synthesis case: a huge aggregating prompt but a small structured result
    // (results stay load-bearing and capped; only the audit prompt is bounded).
    const schema = '{ type: "object", additionalProperties: false, properties: { detail: { type: "string" }, count: { type: "number" } }, required: ["detail", "count"] }';
    const launch = await runtime.launch({
      script: `export const meta = { name: "big-prompt" };\nconst big = "z".repeat(600 * 1024);\nreturn await agent(big, { schema: ${schema} });`,
    });
    const events = await collectEvents(runtime, launch.taskId);
    // The run COMPLETES rather than failing with workflow_journal_write_failed.
    assert.equal(events.at(-1).type, 'workflow.completed', runtime.get(launch.taskId).error);
    assert.equal(runtime.get(launch.taskId).status, 'completed');

    // The FULL prompt reached the backend — only the journaled copy is bounded, not the dispatch.
    assert.equal(backend.requests.length, 1);
    assert.equal(backend.requests[0].messages[0].content.length, 600 * 1024);

    // The journaled started-entry prompt is truncated (marker present) and safely under the cap.
    const snapshot = runtime.get(launch.taskId);
    const journal = await readWorkflowJournal(workflowJournalPath(snapshot.transcriptDir));
    const started = journal.entries.find((e) => e.kind === 'workflow.agent.started');
    assert.match(started.prompt, /truncated in journal/);
    assert.ok(Buffer.byteLength(started.prompt, 'utf8') <= 512 * 1024);

    // Resume works despite the truncated journaled prompt: the call key was computed from the live
    // full prompt, so the resumed agent is a cache hit with no re-dispatch.
    const resumed = await runtime.launch({ resumeFromRunId: snapshot.runId });
    const resumedEvents = await collectEvents(runtime, resumed.taskId);
    assert.equal(resumedEvents.at(-1).type, 'workflow.completed');
    const completions = resumedEvents.filter((e) => e.type === 'workflow.agent.completed');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].cached, true, 'resumed oversized-prompt agent is a cache hit');
    assert.equal(backend.requests.length, 1, 'no re-dispatch on resume');
  } finally {
    await runtime.close();
  }
});

test('workflow agents reject invalid effort and model values before spending tokens', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const invalidEffort = await runtime.launch({
      script: 'export const meta = { name: "bad-effort", description: "Reject bad effort" };\nreturn await agent("never runs", { effort: "tiny" });',
    });
    let events = await collectEvents(runtime, invalidEffort.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');
    // Deterministic input failures are non-retryable; the event's retryable is now derived
    // from the reason (a hardcoded `true` here would fail this assertion).
    assert.equal(events.at(-1).recovery.retryable, false);

    const invalidModel = await runtime.launch({
      script: 'export const meta = { name: "bad-model", description: "Reject blank model" };\nreturn await agent("never runs", { model: "  " });',
    });
    events = await collectEvents(runtime, invalidModel.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');

    const placeholderModel = await runtime.launch({
      script: 'export const meta = { name: "placeholder-model", description: "Reject reserved placeholder" };\nreturn await agent("never runs", { model: "codex-subagent" });',
    });
    events = await collectEvents(runtime, placeholderModel.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');
    assert.match(runtime.get(placeholderModel.taskId).error, /reserved backend placeholder/);
    assert.equal(backend.requests.length, 0);
  } finally {
    await runtime.close();
  }
});

function agentTypeRegistry(entries) {
  return new Map(Object.entries(entries).map(([name, fields]) => [name, { name, ...fields }]));
}

test('agentType applies a resolved type model/effort/persona, and explicit opts override it', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: {
      agentTypes: agentTypeRegistry({
        reviewer: { model: 'fake-model-mini', effort: 'high', developerInstructions: 'REVIEW PERSONA' },
        scout: { model: 'fake-model-mini' }, // no persona, no effort
      }),
    },
  });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "typed", description: "typed agents" };
const a = await agent("review this", { agentType: "reviewer" });
const b = await agent("review harder", { agentType: "reviewer", effort: "low", model: "fake-model" });
const c = await agent("scout this", { agentType: "scout" });
return { a, b, c };`,
    });
    const events = await collectEvents(runtime, launch.taskId);
    assert.equal(events.at(-1).type, 'workflow.completed');
    assert.equal(backend.requests.length, 3);
    // Type supplies model/effort/persona.
    assert.equal(backend.requests[0].model, 'fake-model-mini');
    assert.equal(backend.requests[0].reasoningEffort, 'high');
    assert.equal(backend.requests[0].developerInstructions, 'REVIEW PERSONA');
    // Explicit opts win over the type; persona still applies.
    assert.equal(backend.requests[1].model, 'fake-model');
    assert.equal(backend.requests[1].reasoningEffort, 'low');
    assert.equal(backend.requests[1].developerInstructions, 'REVIEW PERSONA');
    // A persona-less type: model applied, no developerInstructions leaks.
    assert.equal(backend.requests[2].model, 'fake-model-mini');
    assert.equal(backend.requests[2].developerInstructions, undefined);

    const snapshot = runtime.get(launch.taskId);
    const journal = await readWorkflowJournal(workflowJournalPath(snapshot.transcriptDir));
    const started = journal.entries.filter((entry) => entry.kind === 'workflow.agent.started');
    // The type NAME (not the persona) enters semanticOpts and thus the call key.
    assert.deepEqual(started[0].semanticOpts, { model: 'fake-model-mini', effort: 'high', agentType: 'reviewer' });
    assert.equal(started[0].agentCallKey, computeWorkflowAgentCallKey({
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      prompt: 'review this',
      semanticOpts: { model: 'fake-model-mini', effort: 'high', agentType: 'reviewer' },
    }));
    // Same prompt/model/effort but NO type must produce a different key (agentType is key-affecting).
    assert.notEqual(started[0].agentCallKey, computeWorkflowAgentCallKey({
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      prompt: 'review this',
      semanticOpts: { model: 'fake-model-mini', effort: 'high' },
    }));
  } finally {
    await runtime.close();
  }
});

test('agentType fails loud when the gate is off, the name is unknown, or the type carries a banned effort', async () => {
  const gateOff = new FakeSubagentBackend();
  const off = await createRuntime({ backend: gateOff }); // no agentTypes option → gate off
  try {
    const launch = await off.runtime.launch({
      script: 'export const meta = { name: "gate-off" };\nreturn await agent("x", { agentType: "reviewer" });',
    });
    const events = await collectEvents(off.runtime, launch.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');
    assert.match(off.runtime.get(launch.taskId).error, /requires agent types to be enabled/);
    assert.equal(gateOff.requests.length, 0);
  } finally {
    await off.runtime.close();
  }

  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: { agentTypes: agentTypeRegistry({ reviewer: { model: 'fake-model-mini' }, danger: { effort: 'ultra' } }) },
  });
  try {
    const unknown = await runtime.launch({
      script: 'export const meta = { name: "unknown-type" };\nreturn await agent("x", { agentType: "ghost" });',
    });
    let events = await collectEvents(runtime, unknown.taskId);
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');
    assert.match(runtime.get(unknown.taskId).error, /unknown agent type "ghost".*reviewer/);

    // A registry file with model_reasoning_effort = "ultra" must be rejected at use-time — the banned
    // tier must never reach dispatch (it would escape the journal/cost accounting).
    const ultra = await runtime.launch({
      script: 'export const meta = { name: "ultra-type" };\nreturn await agent("x", { agentType: "danger" });',
    });
    events = await collectEvents(runtime, ultra.taskId);
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');
    assert.match(runtime.get(ultra.taskId).error, /unsupported model_reasoning_effort "ultra"/);
    assert.equal(backend.requests.length, 0);
  } finally {
    await runtime.close();
  }
});

test('resumeSourceInfo reports whether the source run used agent types (drives --agent-types auto-restore)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: { agentTypes: agentTypeRegistry({ reviewer: { model: 'fake-model-mini', developerInstructions: 'P' } }) },
  });
  try {
    const typed = await runtime.launch({
      script: 'export const meta = { name: "typed-run" };\nreturn await agent("t", { agentType: "reviewer" });',
    });
    await collectEvents(runtime, typed.taskId);
    const typedInfo = await runtime.resumeSourceInfo(runtime.get(typed.taskId).runId);
    assert.equal(typedInfo.usesAgentTypes, true);

    const plain = await runtime.launch({
      script: 'export const meta = { name: "plain-run" };\nreturn await agent("p");',
    });
    await collectEvents(runtime, plain.taskId);
    const plainInfo = await runtime.resumeSourceInfo(runtime.get(plain.taskId).runId);
    assert.equal(plainInfo.usesAgentTypes, false);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime validates workflow sources without running agents', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const report = await runtime.validateWorkflowInput({
      script: `export const meta = { name: "validate-demo", description: "Static authoring scan" };
const found = await parallel([
  () => agent("scan one", { schema: { type: "object", additionalProperties: false, properties: { detail: { type: "string" } }, required: ["detail"] } }),
  () => agent("scan two")
]);
return found;`,
    });
    assert.equal(report.workflowName, 'validate-demo');
    assert.equal(report.workflowSource, 'inline');
    assert.equal(report.agentCallSites, 2);
    assert.equal(report.schemaCallSites, 1);
    assert.equal(report.keyedCallSites, 0);
    assert.equal(report.warnings.length, 2);
    assert.match(report.warnings[0], /1 of 2 agent\(\) call site\(s\) do not declare a structured output schema/);
    assert.match(report.warnings[1], /No agent\(\) call site passes a logical \{ key \}/);
    assert.equal(backend.requests.length, 0);

    const keyed = await runtime.validateWorkflowInput({
      script: 'export const meta = { name: "validate-keyed" };\nreturn await agent("solo", { key: "solo", schema: { type: "object", additionalProperties: false, properties: { detail: { type: "string" } }, required: ["detail"] } });',
    });
    assert.deepEqual(keyed.warnings, []);

    // Parentheses inside prompt strings must not truncate the scanned
    // argument span and produce false schema/key warnings.
    const parenPrompt = await runtime.validateWorkflowInput({
      script: 'export const meta = { name: "validate-paren" };\nreturn await agent("fix the dangling ) in parser.ts (see init()", { key: "parse-fix", schema: { type: "object", additionalProperties: false, properties: { detail: { type: "string" } }, required: ["detail"] } });',
    });
    assert.equal(parenPrompt.agentCallSites, 1);
    assert.equal(parenPrompt.schemaCallSites, 1);
    assert.equal(parenPrompt.keyedCallSites, 1);
    assert.deepEqual(parenPrompt.warnings, []);

    await assertRejectCode(
      () => runtime.validateWorkflowInput({ script: 'export const meta = { name: "bad-date" };\nreturn Date.now();' }),
      'workflow_script_nondeterministic',
    );
    await assertRejectCode(
      () => runtime.validateWorkflowInput({ resumeFromRunId: 'run_a' }),
      'workflow_input_invalid',
    );
  } finally {
    await runtime.close();
  }
});

test('workflow runtime rejects invalid launch inputs before side effects', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    await assertRejectCode(
      () => runtime.launch({ resumeFromRunId: 'run_old' }),
      'workflow_input_invalid',
    );
    await assertRejectCode(
      () => runtime.launch({ resumeFromRunId: '../run_escape' }),
      'workflow_input_invalid',
    );
    assert.deepEqual(await findFiles(root, 'journal.jsonl'), []);

    await assertRejectCode(
      () => runtime.launch({ script: 'export const meta = { name: "" };\nreturn null;' }),
      'workflow_meta_invalid',
    );
    await assertRejectCode(
      () => runtime.launch({ script: 'export const meta = { name: "bad-date" };\nreturn Date.now();' }),
      'workflow_script_nondeterministic',
    );
  } finally {
    await runtime.close();
  }
});

test('built-in code-review runs dynamic lens finders, candidate verifiers, sweep, and synthesis', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'client-package-plan.md'), [
      '# Client Package Plan',
      '',
      'The client package must bind authority to the platform token.',
      '',
    ].join('\n'));

    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: 'Review docs/client-package-plan.md for runtime contract risks.' },
    });
    const events = await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed', snapshot.error || JSON.stringify(snapshot.events));
    assert.equal(backend.requests.length, 7);
    assert.ok(backend.maxActiveRequests >= 2);
    // Funnel tiering: wide finder sweeps run at high; scope, verifiers, and
    // synthesis keep the xhigh verdict tier.
    const requestEfforts = backend.requests.map((request) => ({
      finder: /^Code-review (Sweep )?Finder/.test(request.messages[0].content),
      effort: request.reasoningEffort,
    }));
    assert.equal(requestEfforts.filter((entry) => entry.finder).length, 3);
    assert.ok(requestEfforts.every((entry) => entry.effort === (entry.finder ? 'high' : 'xhigh')));
    assert.equal(snapshot.result.level, 'xhigh');
    assert.equal(snapshot.result.findings.length, 1);
    assert.equal(snapshot.result.findings[0].severity, 'P1');
    assert.equal(snapshot.result.stats.finders, 3);
    assert.equal(snapshot.result.stats.candidates, 2);
    assert.equal(snapshot.result.stats.verifierAttempts, 2);
    assert.equal(snapshot.result.stats.reported, 1);
    assert.match(snapshot.result.provenance.sourceSnapshotId, /^git:[0-9a-f]{40}:sha256:[0-9a-f]{64}$/);
    // No range was requested. The context prints "(none)" for display, and that string is truthy, so
    // reading it unguarded reported a commit range that was never reviewed.
    assert.equal(snapshot.result.provenance.diffBaseRef, null);
    const planEvent = events.find((event) => event.type === 'workflow.plan.ready');
    assert.equal(planEvent.mode, 'phase_parallel');
    assert.equal(planEvent.phases.length, 1);
    assert.deepEqual(planEvent.phases.map((phase) => phase.title), ['Scope']);
    assert.deepEqual(planEvent.phases[0].agents.map((agent) => agent.label), ['code-review-scope']);
    assert.ok(
      events.findIndex((event) => event.type === 'workflow.plan.ready')
        < events.findIndex((event) => event.type === 'workflow.phase.planned'),
    );
    assert.ok(
      events.findIndex((event) => event.type === 'workflow.phase.planned' && event.title === 'Scope')
        < events.findIndex((event) => event.type === 'workflow.phase.started' && event.title === 'Scope'),
    );
    const labels = events
      .filter((event) => event.type === 'workflow.agent.started')
      .map((event) => event.label);
    assert.deepEqual(labels, [
      'code-review-scope',
      'code-review-find-runtime-contract',
      'code-review-find-security-boundary',
      'code-review-verify-runtime-contract-c1',
      'code-review-verify-runtime-contract-c2',
      'code-review-sweep-finder',
      'code-review-synthesis',
    ]);
    const phaseTitles = events
      .filter((event) => event.type === 'workflow.phase.started')
      .map((event) => event.title);
    assert.deepEqual(phaseTitles, ['Evidence', 'Scope', 'Find', 'Verify', 'Sweep', 'Synthesize']);
    const phasePlans = events
      .filter((event) => event.type === 'workflow.phase.planned')
      .map((event) => event.title);
    assert.deepEqual(phasePlans, ['Scope', 'Find', 'Verify', 'Sweep', 'Synthesize']);
    const findPlan = events.find((event) => event.type === 'workflow.phase.planned' && event.title === 'Find');
    assert.deepEqual(findPlan.plannedAgents.map((agent) => agent.label), [
      'code-review-find-runtime-contract',
      'code-review-find-security-boundary',
    ]);
    assert.ok(
      events.findIndex((event) => event.type === 'workflow.agent.started' && event.label === 'code-review-verify-runtime-contract-c1')
        < events.findIndex((event) => event.type === 'workflow.agent.completed' && event.label === 'code-review-find-security-boundary'),
      'expected verifier for an early finder to start before the slower finder completed',
    );
    const scopePrompt = backend.requests
      .map((request) => request.messages[0].content)
      .find((content) => /Code-review Scope/.test(content));
    assert.match(scopePrompt, /### Change Evidence/);
    assert.match(scopePrompt, /file:docs\/client-package-plan\.md/);
    assert.match(scopePrompt, /platform token/);
    const journal = await readWorkflowJournal(workflowJournalPath(snapshot.transcriptDir));
    const verifierKeys = journal.entries
      .filter((entry) => entry.kind === 'workflow.agent.started' && entry.semanticOpts.logicalKey?.startsWith('code-review/verify/'))
      .map((entry) => entry.semanticOpts.logicalKey);
    assert.equal(verifierKeys.length, 2);
    assert.equal(new Set(verifierKeys).size, 2);
  } finally {
    await runtime.close();
  }
});

test('built-in code-review high level skips sweep', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'client-package-plan.md'), 'The platform token owns authority.\n');

    const launch = await runtime.launch({
      name: 'code-review',
      args: {
        prompt: 'Review docs/client-package-plan.md for runtime contract risks.',
        level: 'high',
      },
    });
    const events = await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed', snapshot.error || JSON.stringify(snapshot.events));
    assert.equal(snapshot.result.level, 'high');
    assert.equal(snapshot.result.stats.finders, 2);
    assert.equal(events.some((event) => event.type === 'workflow.agent.started' && event.label === 'code-review-sweep-finder'), false);
    const effortsByHead = backend.requests.map((request) => ({
      head: request.messages[0].content.split('\n')[0],
      effort: request.reasoningEffort,
    }));
    assert.equal(effortsByHead.find((entry) => entry.head === 'Code-review Scope')?.effort, 'medium');
    assert.ok(effortsByHead.filter((entry) => entry.head !== 'Code-review Scope').every((entry) => entry.effort === 'high'));
  } finally {
    await runtime.close();
  }
});

test('built-in code-review fails closed on unsupported finder evidence refs', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'client-package-plan.md'), 'The platform token owns authority.\n');

    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: 'INVALID_EVIDENCE_REF Review docs/client-package-plan.md.' },
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /unsupported evidence ref/);
    assert.match(
      snapshot.error,
      /includes unsupported evidence ref file:outside\.md: not in allowed evidence refs \(\d+ entries\) derived from /,
    );
    assert.match(snapshot.error, /; populated by /);
    assert.equal(
      snapshot.events.some((event) => event.type === 'workflow.agent.started' && /code-review-verify-/.test(event.label)),
      false,
    );
  } finally {
    await runtime.close();
  }
});

test('built-in code-review fails before spawning agents when the working tree has no reviewable change evidence', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);

    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: 'Review the current repository for correctness risks.' },
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /no reviewable change evidence in the working tree/);
    // Cause and remediation, not just the fact of failure.
    assert.match(snapshot.error, /git status reported no changed or untracked paths/);
    assert.match(snapshot.error, /change a file whose extension is in the evidence allowlist/);
    assert.match(snapshot.error, /re-run `--validate` to confirm before spending/);
    assert.equal(backend.requests.length, 0);
    assert.equal(snapshot.events.some((event) => event.type === 'workflow.agent.started'), false);
  } finally {
    await runtime.close();
  }
});

test('code-review normalizes ref grammar mistakes instead of discarding the run', async () => {
  for (const marker of ['LINE_SUFFIX_REF', 'KIND_MISMATCH_REF']) {
    const backend = new FakeSubagentBackend();
    const { runtime, root } = await createRuntime({ backend });
    try {
      await initializeGitRepo(root);
      await mkdir(join(root, 'docs'), { recursive: true });
      await writeFile(join(root, 'docs', 'client-package-plan.md'), 'The platform token owns authority.\n');

      const launch = await runtime.launch({
        name: 'code-review',
        args: { prompt: `${marker} Review docs/client-package-plan.md.` },
      });
      await collectEvents(runtime, launch.taskId);
      const snapshot = runtime.get(launch.taskId);
      assert.equal(snapshot.status, 'completed', `${marker}: ${snapshot.error ?? ''}`);
      assert.ok(snapshot.result.stats.normalizedRefs >= 1, marker);
      const refs = snapshot.result.findings.flatMap((finding) => finding.evidenceRefs);
      // Every surviving ref is a string the runtime actually published.
      for (const ref of refs) {
        assert.ok(
          ref === 'file:docs/client-package-plan.md' || /^(diff|hunk):/.test(ref),
          `${marker} normalized to an unpublished ref: ${ref}`,
        );
      }
      for (const finding of snapshot.result.findings) {
        assert.equal(finding.file, 'docs/client-package-plan.md', marker);
      }
    } finally {
      await runtime.close();
    }
  }
});

async function runCodeReview({ marker, refPolicy, evidenceScope, extraFiles = {} }) {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend, runtimeOptions: { refPolicy, evidenceScope } });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'client-package-plan.md'), 'The platform token owns authority.\n');
    for (const [name, contents] of Object.entries(extraFiles)) {
      await writeFile(join(root, name), contents);
    }
    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: `${marker} Review docs/client-package-plan.md.` },
    });
    await collectEvents(runtime, launch.taskId);
    return { snapshot: runtime.get(launch.taskId), backend };
  } finally {
    await runtime.close();
  }
}

test('refPolicy lenient drops the unusable candidate and keeps the rest of the review', async () => {
  const { snapshot } = await runCodeReview({ marker: 'PARTIAL_INVALID_REF', refPolicy: 'lenient' });
  assert.equal(snapshot.status, 'completed', snapshot.error ?? '');
  assert.equal(snapshot.result.stats.refDrops, 1);
  assert.equal(snapshot.result.degraded.refDrops, 1);
  assert.equal(snapshot.result.degraded.entries[0].stage, 'candidate');
  assert.equal(snapshot.result.degraded.entries[0].reasonCategory, 'unsupported_evidence');
  assert.match(snapshot.result.degraded.entries[0].reason, /unsupported evidence ref file:outside\.md/);
  // The sibling candidate survived, so the review still reports.
  assert.ok(snapshot.result.findings.length >= 1);
  for (const finding of snapshot.result.findings) {
    assert.ok(finding.evidenceRefs.every((ref) => !ref.includes('outside.md')));
  }
  // One drop-accounting surface. A candidate the runtime dropped never reaches synthesis, so without a
  // synthesized decision row refDrops rose while dropped.unsupportedEvidence stayed 0 and the two
  // accountings contradicted each other (docs/20260727-r6-ref-drop-policy-design.md).
  assert.equal(snapshot.result.stats.dropped.unsupportedEvidence, 1);
  const dropRow = snapshot.result.synthesis.decisions.find((row) => row.reasonCategory === 'unsupported_evidence');
  assert.ok(dropRow, JSON.stringify(snapshot.result.synthesis.decisions));
  assert.equal(dropRow.action, 'drop');
  assert.match(dropRow.candidateId, /^candidate:/);
});

test('a cited path that ends in a colon and digits is not read as an appended index', async () => {
  // `issue:123` is a legal filename. Stripping ":123" first redirected the citation to `issue`, a
  // different (nonexistent) file, so a review of a real change failed as unsupported evidence. An exact
  // path match is a fact; the index reading is a guess, and file:/diff: refs carry no index at all.
  const { snapshot } = await runCodeReview({
    marker: 'COLON_INDEX_REF',
    refPolicy: 'strict',
    evidenceScope: 'all',
    extraFiles: { 'issue:123': 'the tracked issue body\n' },
  });
  // Strict is the demanding side: before the fix this run failed outright on the candidate's ref.
  assert.equal(snapshot.status, 'completed', snapshot.error ?? '');
  assert.doesNotMatch(snapshot.error ?? '', /unsupported evidence ref/);
  assert.ok(snapshot.result.stats.normalizedRefs >= 1, JSON.stringify(snapshot.result.stats));
  assert.equal(snapshot.result.stats.refDrops, 0);

  // Control: the same kind-mismatch on a name WITHOUT a colon suffix already normalized, so the test is
  // about the suffix rather than about kind normalization in general.
  const plain = await runCodeReview({
    marker: 'COLON_INDEX_REF_PLAIN',
    refPolicy: 'strict',
    evidenceScope: 'all',
    extraFiles: { 'issue.md': 'the tracked issue body\n' },
  });
  assert.equal(plain.snapshot.status, 'completed', plain.snapshot.error ?? '');
  assert.ok(plain.snapshot.result.stats.normalizedRefs >= 1);
});

test('refPolicy strict fails the same run (lenient flag is wired, not inert)', async () => {
  const { snapshot, backend } = await runCodeReview({ marker: 'PARTIAL_INVALID_REF', refPolicy: 'strict' });
  assert.equal(snapshot.status, 'failed');
  assert.match(snapshot.error, /includes unsupported evidence ref file:outside\.md/);
  // Strict is also the default: no refPolicy option must behave the same way.
  const fallback = await runCodeReview({ marker: 'PARTIAL_INVALID_REF', refPolicy: undefined });
  assert.equal(fallback.snapshot.status, 'failed');
  assert.ok(backend.requests.length >= 1);
});

test('refPolicy lenient still fails when every candidate is dropped (no vacuous pass)', async () => {
  const { snapshot } = await runCodeReview({ marker: 'INVALID_EVIDENCE_REF', refPolicy: 'lenient' });
  assert.equal(snapshot.status, 'failed');
  assert.match(snapshot.error, /no candidate survived 1 unsupported-evidence drop\(s\) at candidate verification/);
  assert.match(snapshot.error, /this review is inconclusive, not clean/);
  assert.match(snapshot.error, /includes unsupported evidence ref file:outside\.md/);
});

test('the vacuous-pass guard covers sweep-only drops and does not pre-empt a sweep rescue', async () => {
  // The guard used to run before the sweep, so a sweep-only drop completed with an empty report while
  // a lens drop failed a run the sweep could still have rescued. Both directions are asserted here.
  const swept = await runCodeReview({ marker: 'SWEEP_ONLY_DROP', refPolicy: 'lenient' });
  assert.equal(swept.snapshot.status, 'failed');
  assert.match(swept.snapshot.error, /no candidate survived 1 unsupported-evidence drop\(s\)/);
  assert.match(swept.snapshot.error, /inconclusive, not clean/);

  const rescued = await runCodeReview({ marker: 'SWEEP_RESCUE', refPolicy: 'lenient' });
  assert.equal(rescued.snapshot.status, 'completed', rescued.snapshot.error ?? '');
  assert.equal(rescued.snapshot.result.stats.refDrops, 1);
  assert.ok(rescued.snapshot.result.findings.length >= 1);

  // Control: strict still fails both fixtures on the ref itself, not on the vacuous-pass rule.
  const strict = await runCodeReview({ marker: 'SWEEP_ONLY_DROP', refPolicy: 'strict' });
  assert.equal(strict.snapshot.status, 'failed');
  assert.match(strict.snapshot.error, /includes unsupported evidence ref file:outside\.md/);
});

test('a drive-relative name is not a structural violation', async () => {
  const { snapshot } = await runCodeReview({ marker: 'DRIVE_RELATIVE_REF', refPolicy: 'lenient' });
  assert.equal(snapshot.status, 'failed');
  // It is refused as unsupported evidence, but "C:foo.md" is a legal POSIX filename, not an escape.
  assert.doesNotMatch(snapshot.error, /structural/);
  assert.match(snapshot.error, /no candidate survived/);
});

test('a resumed built-in still validates its request contract', async () => {
  // Resume hands back the persisted scriptPath, so the run classifies as script_path and the built-in
  // contract used to be skipped entirely — a resumed review accepted a mistyped key and silently ran
  // the script's fallback.
  const backend = new FakeSubagentBackend();
  const root = await mkdtemp(join(tmpdir(), 'workflow-resume-contract-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  await initializeGitRepo(root);
  await writeFile(join(root, 'pending.ts'), 'export const pending = 1;\n');
  const runtime = new WorkflowTaskRegistry({ backend, cwd: root, stateDir, requestTimeoutMs: 30_000 });
  let runId;
  let firstScriptPath;
  try {
    const first = await runtime.launch({ name: 'code-review', args: { prompt: 'Review pending.ts' } });
    await collectEvents(runtime, first.taskId);
    runId = runtime.get(first.taskId).runId;
    firstScriptPath = runtime.get(first.taskId).scriptPath;
    assert.ok(runId);
    assert.ok(typeof firstScriptPath === 'string');

    await assert.rejects(
      () => runtime.launch({ resumeFromRunId: runId, args: { promt: 'typo on resume' } }),
      /unknown workflow arg "promt" for built-in "code-review"/,
    );
    await assert.rejects(
      () => runtime.launch({ resumeFromRunId: runId, args: { prompt: 'Review pending.ts', level: 'medium' } }),
      /has an unsupported value "medium"/,
    );

    // Control: valid args resume normally, so the contract is applied rather than the resume blocked.
    const resumed = await runtime.launch({ resumeFromRunId: runId, args: { prompt: 'Review pending.ts' } });
    await collectEvents(runtime, resumed.taskId);
    assert.ok(['completed', 'failed'].includes(runtime.get(resumed.taskId).status));

    // Edit-and-iterate: a co-supplied selector executes a DIFFERENT workflow, so its own contract
    // governs. Validating `prompts` against code-review's contract would break a shipped feature.
    const replaced = await runtime.launch({
      resumeFromRunId: runId,
      name: 'batch',
      args: { prompts: ['first', 'second'] },
    });
    await collectEvents(runtime, replaced.taskId);
    assert.ok(['completed', 'failed'].includes(runtime.get(replaced.taskId).status));

    // A co-supplied scriptPath naming the SAME persisted built-in still executes that built-in, so its
    // contract must apply even though the launch input carries no `name`.
    await assert.rejects(
      () => runtime.launch({
        resumeFromRunId: runId,
        scriptPath: firstScriptPath,
        args: { prompt: 'Review pending.ts', level: 'medium' },
      }),
      /workflow arg "level" for built-in "code-review" has an unsupported value "medium"/,
    );
  } finally {
    await runtime.close();
  }
});

test('a resume under a different ref policy is refused', async () => {
  const backend = new FakeSubagentBackend();
  const root = await mkdtemp(join(tmpdir(), 'workflow-resume-policy-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  await initializeGitRepo(root);
  await writeFile(join(root, 'pending.ts'), 'export const pending = 1;\n');
  const strictRuntime = new WorkflowTaskRegistry({ backend, cwd: root, stateDir, requestTimeoutMs: 30_000 });
  let runId;
  try {
    const first = await strictRuntime.launch({ name: 'code-review', args: { prompt: 'Review pending.ts' } });
    await collectEvents(strictRuntime, first.taskId);
    runId = strictRuntime.get(first.taskId).runId;
  } finally {
    await strictRuntime.close();
  }

  const lenientRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000, refPolicy: 'lenient',
  });
  try {
    // The source run's cached agent results were produced under strict failure semantics and the call
    // keys do not record the policy, so replaying them under lenient would be silent drift.
    await assert.rejects(
      () => lenientRuntime.launch({ resumeFromRunId: runId }),
      /the source run executed built-in "code-review" under --ref-policy strict/,
    );
    await assert.rejects(
      () => lenientRuntime.launch({ resumeFromRunId: runId }),
      /resume with --ref-policy strict, or start a fresh run under lenient/,
    );
  } finally {
    await lenientRuntime.close();
  }

  // Control: the same policy resumes, so the check keys on the mismatch rather than on resuming at all.
  const sameRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000, refPolicy: 'strict',
  });
  try {
    const resumed = await sameRuntime.launch({ resumeFromRunId: runId });
    await collectEvents(sameRuntime, resumed.taskId);
    assert.ok(['completed', 'failed'].includes(sameRuntime.get(resumed.taskId).status));
  } finally {
    await sameRuntime.close();
  }

  // The REVERSE direction: a lenient source resumed under the strict default. "strict is the default"
  // proves nothing about what the source ran, and testing only one direction is what let this through.
  const lenientRoot = await mkdtemp(join(tmpdir(), 'workflow-resume-policy-reverse-'));
  tempDirs.push(lenientRoot);
  const lenientStateDir = join(lenientRoot, '.ultracode-for-codex');
  await initializeGitRepo(lenientRoot);
  await writeFile(join(lenientRoot, 'pending.ts'), 'export const pending = 1;\n');
  const sourceLenient = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: lenientRoot, stateDir: lenientStateDir,
    requestTimeoutMs: 30_000, refPolicy: 'lenient',
  });
  let lenientRunId;
  try {
    const first = await sourceLenient.launch({ name: 'code-review', args: { prompt: 'Review pending.ts' } });
    await collectEvents(sourceLenient, first.taskId);
    lenientRunId = sourceLenient.get(first.taskId).runId;
  } finally {
    await sourceLenient.close();
  }
  const strictRuntime2 = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: lenientRoot, stateDir: lenientStateDir, requestTimeoutMs: 30_000,
  });
  try {
    await assert.rejects(
      () => strictRuntime2.launch({ resumeFromRunId: lenientRunId }),
      /under --ref-policy lenient, whose cached agent results were produced under different failure semantics/,
    );
  } finally {
    await strictRuntime2.close();
  }
});

test('a built-in whose recorded script no longer matches any variant is still policy-checked', async () => {
  // Simulates a source run created by an older generator: the script matches neither current variant,
  // so the script-derived policy is lost. The journaled run-level policy still proves it.
  const legacyReview = { name: 'code-review', script: 'export const meta = { name: "code-review", description: "legacy" };\nreturn { legacy: true };' };
  const root = await mkdtemp(join(tmpdir(), 'workflow-resume-legacy-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  const legacyRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    builtinWorkflows: [legacyReview],
  });
  let runId;
  try {
    const first = await legacyRuntime.launch({ name: 'code-review', args: {} });
    await collectEvents(legacyRuntime, first.taskId);
    runId = legacyRuntime.get(first.taskId).runId;
    assert.ok(runId);
  } finally {
    await legacyRuntime.close();
  }

  const lenientRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000, refPolicy: 'lenient',
  });
  try {
    await assert.rejects(
      () => lenientRuntime.launch({ resumeFromRunId: runId }),
      /under --ref-policy strict, whose cached agent results were produced under different failure semantics/,
    );
  } finally {
    await lenientRuntime.close();
  }

  // Control: the default policy resumes, so the refusal keys on the unprovable switch.
  const strictRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
  });
  try {
    const resumed = await strictRuntime.launch({ resumeFromRunId: runId });
    await collectEvents(strictRuntime, resumed.taskId);
    assert.ok(['completed', 'failed'].includes(strictRuntime.get(resumed.taskId).status));
  } finally {
    await strictRuntime.close();
  }
});

test('an unidentifiable source is refused for a policy switch only when nesting is enabled', async () => {
  const script = `export const meta = { name: "inline-parent", description: "parent" };\nreturn { ok: true };`;
  const root = await mkdtemp(join(tmpdir(), 'workflow-resume-nested-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  const first = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
  });
  let runId;
  try {
    const launched = await first.launch({ script, args: {} });
    await collectEvents(first, launched.taskId);
    runId = first.get(launched.taskId).runId;
  } finally {
    await first.close();
  }

  // A nested built-in child is journaled only as script-agnostic agent entries, so a cross-policy
  // replay could hide inside a parent this check cannot identify.
  const nested = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    refPolicy: 'lenient', nestedWorkflows: 'enabled',
  });
  try {
    await assert.rejects(
      () => nested.launch({ resumeFromRunId: runId }),
      /not identifiable as a built-in/,
    );
  } finally {
    await nested.close();
  }

  // Control: with an injected (static) registry no child can vary by policy, so nesting must not make
  // the policy relevant at all.
  const injectedNested = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    refPolicy: 'lenient', nestedWorkflows: 'enabled',
    builtinWorkflows: [{ name: 'only-static', script: 'export const meta = { name: "only-static", description: "s" };\nreturn {};' }],
  });
  try {
    const resumed = await injectedNested.launch({ resumeFromRunId: runId });
    await collectEvents(injectedNested, resumed.taskId);
    assert.ok(['completed', 'failed'].includes(injectedNested.get(resumed.taskId).status));
  } finally {
    await injectedNested.close();
  }

  // Control: the same policy switch without nesting is allowed, so the refusal is not blanket.
  const notNested = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000, refPolicy: 'lenient',
  });
  try {
    const resumed = await notNested.launch({ resumeFromRunId: runId });
    await collectEvents(notNested, resumed.taskId);
    assert.ok(['completed', 'failed'].includes(notNested.get(resumed.taskId).status));
  } finally {
    await notNested.close();
  }

  // Control: nesting enabled with the SAME policy as the source resumes, so the rule keys on the
  // mismatch rather than on nesting.
  const nestedSamePolicy = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    nestedWorkflows: 'enabled',
  });
  try {
    const resumed = await nestedSamePolicy.launch({ resumeFromRunId: runId });
    await collectEvents(nestedSamePolicy, resumed.taskId);
    assert.ok(['completed', 'failed'].includes(nestedSamePolicy.get(resumed.taskId).status));
  } finally {
    await nestedSamePolicy.close();
  }

  // The REVERSE direction: a lenient parent resumed under the strict default with nesting enabled.
  const lenientParentRoot = await mkdtemp(join(tmpdir(), 'workflow-resume-nested-reverse-'));
  tempDirs.push(lenientParentRoot);
  const lenientParentStateDir = join(lenientParentRoot, '.ultracode-for-codex');
  const lenientParent = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: lenientParentRoot, stateDir: lenientParentStateDir,
    requestTimeoutMs: 30_000, refPolicy: 'lenient', nestedWorkflows: 'enabled',
  });
  let lenientParentRunId;
  try {
    const launched = await lenientParent.launch({ script, args: {} });
    await collectEvents(lenientParent, launched.taskId);
    lenientParentRunId = lenientParent.get(launched.taskId).runId;
  } finally {
    await lenientParent.close();
  }
  const strictNested = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: lenientParentRoot, stateDir: lenientParentStateDir,
    requestTimeoutMs: 30_000, nestedWorkflows: 'enabled',
  });
  try {
    await assert.rejects(
      () => strictNested.launch({ resumeFromRunId: lenientParentRunId }),
      /under --ref-policy lenient, whose cached agent results were produced under different failure semantics/,
    );
  } finally {
    await strictNested.close();
  }
});

test('a built-in this version no longer recognizes is still policy-checked', async () => {
  // The journal says built_in but the name is not a built-in here (removed, renamed, or supplied
  // through builtinWorkflows). Treating that as "not a built-in" made policy irrelevant with nesting
  // off, so a journaled mismatch was ignored and a lenient source could resume as strict.
  const gone = { name: 'gone-review', script: 'export const meta = { name: "gone-review", description: "gone" };\nreturn { gone: true };' };
  const root = await mkdtemp(join(tmpdir(), 'workflow-resume-gone-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  const source = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    builtinWorkflows: [gone], refPolicy: 'lenient',
  });
  let runId;
  try {
    const first = await source.launch({ name: 'gone-review', args: {} });
    await collectEvents(source, first.taskId);
    runId = source.get(first.taskId).runId;
    assert.ok(runId);
  } finally {
    await source.close();
  }

  // Nesting is OFF here, which is exactly the combination that used to slip through.
  const strictRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
  });
  try {
    await assert.rejects(
      () => strictRuntime.launch({ resumeFromRunId: runId }),
      /which this version does not recognize/,
    );
  } finally {
    await strictRuntime.close();
  }

  // Control: the same policy resumes, so the refusal keys on the mismatch.
  const lenientRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    builtinWorkflows: [gone], refPolicy: 'lenient',
  });
  try {
    const resumed = await lenientRuntime.launch({ resumeFromRunId: runId });
    await collectEvents(lenientRuntime, resumed.taskId);
    assert.ok(['completed', 'failed'].includes(lenientRuntime.get(resumed.taskId).status));
  } finally {
    await lenientRuntime.close();
  }
});

test('a direct scriptPath launch of a persisted built-in is refused across ref policies', async () => {
  // The persisted script has its ref policy baked into its text. Promotion classifies the launch as the
  // built-in, so without this check the run executed the SOURCE policy while stderr and the journal
  // recorded the requested one — and a later resume trusted that false record. The dangerous direction
  // is a lenient script under requested strict: the review completes with candidates dropped where a
  // real strict run fails.
  const backend = new FakeSubagentBackend();
  const root = await mkdtemp(join(tmpdir(), 'workflow-scriptpath-policy-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  await initializeGitRepo(root);
  await writeFile(join(root, 'pending.ts'), 'export const pending = 1;\n');

  const lenientRuntime = new WorkflowTaskRegistry({
    backend, cwd: root, stateDir, requestTimeoutMs: 30_000, refPolicy: 'lenient',
  });
  let lenientScriptPath;
  try {
    const first = await lenientRuntime.launch({ name: 'code-review', args: { prompt: 'Review pending.ts' } });
    await collectEvents(lenientRuntime, first.taskId);
    lenientScriptPath = lenientRuntime.get(first.taskId).scriptPath;
    assert.ok(typeof lenientScriptPath === 'string');
  } finally {
    await lenientRuntime.close();
  }

  const strictRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000, refPolicy: 'strict',
  });
  try {
    await assert.rejects(
      () => strictRuntime.launch({ scriptPath: lenientScriptPath, args: { prompt: 'Review pending.ts' } }),
      /the persisted script was generated under --ref-policy lenient/,
    );
    await assert.rejects(
      () => strictRuntime.launch({ scriptPath: lenientScriptPath, args: { prompt: 'Review pending.ts' } }),
      /pass --ref-policy lenient to run the persisted script as written, or launch by name/,
    );
  } finally {
    await strictRuntime.close();
  }

  // Control: the policy that actually generated the script launches it, so the check keys on the
  // mismatch rather than on passing a scriptPath at all. What matters is that the launch is ACCEPTED —
  // how the review then turns out depends on the fixture's evidence, not on this rule.
  const sameRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000, refPolicy: 'lenient',
  });
  try {
    const again = await sameRuntime.launch({ scriptPath: lenientScriptPath, args: { prompt: 'Review pending.ts' } });
    await collectEvents(sameRuntime, again.taskId);
    const snapshot = sameRuntime.get(again.taskId);
    assert.doesNotMatch(snapshot.error ?? '', /persisted script was generated under --ref-policy/);
    assert.ok(['completed', 'failed'].includes(snapshot.status));
  } finally {
    await sameRuntime.close();
  }
});

test('a journal with no recorded ref policy is unprovable, not assumed strict', async () => {
  // The only population that can carry no field is a run from before the field existed — including an
  // intermediate build of this branch, where lenient WAS possible. Inferring strict there would let a
  // strict resume replay lenient cached results, so absence must stay unprovable.
  // Built by writing a journal that copies a real run's started entry with runtime.refPolicy omitted;
  // the writer owns the hash chain, so this is a real journal, not a hand-forged one.
  const legacy = {
    name: 'code-review',
    script: 'export const meta = { name: "code-review", description: "intermediate build" };\nreturn { legacy: true };',
  };
  const root = await mkdtemp(join(tmpdir(), 'workflow-resume-prefield-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  const source = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    builtinWorkflows: [legacy], refPolicy: 'lenient',
  });
  let started;
  try {
    const first = await source.launch({ name: 'code-review', args: {} });
    await collectEvents(source, first.taskId);
    const snapshot = source.get(first.taskId);
    const journal = await readWorkflowJournal(workflowJournalPath(snapshot.transcriptDir));
    started = journal.entries.find((entry) => entry.kind === 'workflow.run.started');
    assert.equal(started.runtime.refPolicy, 'lenient');
  } finally {
    await source.close();
  }

  // Same started entry, minus the policy field.
  const preFieldRunId = 'run_00000000-0000-4000-8000-00000000beef';
  const transcriptDir = join(stateDir, 'subagents', 'workflows', preFieldRunId);
  const writer = await WorkflowJournalWriter.create({
    transcriptDir, taskId: 'task_prefield', runId: preFieldRunId,
  });
  const { refPolicy, ...runtimeWithoutPolicy } = started.runtime;
  assert.equal(refPolicy, 'lenient');
  await writer.append({
    kind: 'workflow.run.started',
    workflowName: started.workflowName,
    workflowSource: started.workflowSource,
    ...(started.workflowSourcePath ? { workflowSourcePath: started.workflowSourcePath } : {}),
    scriptPath: started.scriptPath,
    scriptHash: started.scriptHash,
    args: started.args,
    runtime: runtimeWithoutPolicy,
  });
  await writer.append({
    kind: 'workflow.run.failed', reason: 'workflow_failed', message: 'intermediate build', durationMs: 1,
  });

  const strictRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
  });
  try {
    await assert.rejects(
      () => strictRuntime.launch({ resumeFromRunId: preFieldRunId }),
      /does not record the ref policy it ran under/,
    );
  } finally {
    await strictRuntime.close();
  }
});

test('a committed path containing a space survives into the evidence gate', async () => {
  // `diff --git a/foo bar.ts b/foo bar.ts` does not quote the space, so deriving committed paths from
  // the patch header lost the path and the gate then reported "no changed paths" for a valid range.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await writeFile(join(root, 'foo bar.ts'), 'export const spaced = 1;\n');
    await gitLines(root, ['add', '--', 'foo bar.ts']);
    await gitLines(root, ['commit', '-m', 'spaced']);

    const report = await runtime.validateWorkflowInput({
      name: 'code-review',
      args: { prompt: 'Review the last commit.', diffBaseRef: 'HEAD~1' },
    });
    assert.equal(report.evidence.gated, false);
    assert.equal(report.evidence.allowedEvidenceRefs.includes('file:foo bar.ts'), true,
      JSON.stringify(report.evidence.allowedEvidenceRefs));
    // Opening the gate is not enough: agents would spend without seeing the change. The committed diff
    // and hunk refs must survive too, and the file must reach an included-file block.
    assert.equal(report.evidence.allowedEvidenceRefs.includes('diff:committed:foo bar.ts'), true,
      JSON.stringify(report.evidence.allowedEvidenceRefs));
    assert.equal(report.evidence.allowedEvidenceRefs.includes('hunk:committed:foo bar.ts:1'), true,
      JSON.stringify(report.evidence.allowedEvidenceRefs));

  } finally {
    await runtime.close();
  }
});

test('the gate refuses to open when an admitted path produced nothing readable', async () => {
  // An untracked file larger than the byte budget yields no content block, and an untracked file has no
  // patch either — so a ref existed while the reviewer had nothing to look at. The gate is now decided
  // from readable evidence, not from the presence of a ref.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend, runtimeOptions: { evidenceScope: 'all' } });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    // maxFileBytes defaults to 12_000; workspaceContextFileBlock yields nothing for a larger file.
    await writeFile(join(root, 'src', 'Huge.java'), `class Huge { ${'/* pad */'.repeat(4000)} }\n`);

    const report = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review it' } });
    assert.equal(report.evidence.gated, true);
    assert.match(report.evidence.reason, /none produced readable evidence/);
    // The remediation has to be true for the path that closed the gate. A binary change cannot be
    // reviewed from evidence at all, so the message must not offer only text-file remedies.
    assert.match(report.evidence.reason, /a binary file produces neither/);

    const launch = await runtime.launch({ name: 'code-review', args: { prompt: 'Review it' } });
    await collectEvents(runtime, launch.taskId);
    assert.equal(runtime.get(launch.taskId).status, 'failed');
    assert.equal(backend.requests.length, 0, 'no agent may spend when nothing is readable');

    // Control: a small file of the same admitted kind opens the gate, so the rule keys on readability.
    await writeFile(join(root, 'src', 'Small.java'), 'class Small { void ok() {} }\n');
    const ready = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review it' } });
    assert.equal(ready.evidence.gated, false);
  } finally {
    await runtime.close();
  }
});

test('a filename ending in whitespace is not admitted as evidence', async () => {
  // Refs travel as lines and every consumer of that protocol trims a line — including the built-in
  // script's own section parser. Publishing `file:src/app.ts ` therefore handed the reviewer a ref that
  // reads back as a different, nonexistent file: citing the real path was rejected as unsupported while
  // citing the published ref pointed nowhere. Such a name is excluded, with the reason named.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend, runtimeOptions: { evidenceScope: 'all' } });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'app.ts '), 'export const trailing = 1;\n');

    const report = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review it' } });
    assert.equal(report.evidence.gated, true);
    assert.deepEqual(report.evidence.allowedEvidenceRefs, [], 'no ref may name a path the protocol cannot carry');
    assert.ok(
      report.evidence.unavailableEvidence.includes('unavailable:git-status-path:1:unrepresentable-path'),
      JSON.stringify(report.evidence.unavailableEvidence),
    );

    // Control: leading whitespace is interior to the ref line, so it survives and stays admissible.
    await writeFile(join(root, 'src', ' leading.ts'), 'export const leading = 1;\n');
    const withLeading = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review it' } });
    assert.equal(withLeading.evidence.gated, false);
    assert.equal(withLeading.evidence.allowedEvidenceRefs.includes('file:src/ leading.ts'), true);
    assert.equal(
      withLeading.evidence.allowedEvidenceRefs.some((ref) => ref.includes('app.ts')),
      false,
      'the unrepresentable path stays out even once the gate opens',
    );
  } finally {
    await runtime.close();
  }
});

test('an admitted path that cannot be read gets no citable file ref', async () => {
  // A `file:` ref is a licence to cite the file's contents. When one path is readable the gate opens, so
  // an unreadable sibling used to keep its ref and validation accepted citations to a change no agent
  // ever received. Readability now decides publication, not just the gate.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend, runtimeOptions: { evidenceScope: 'all' } });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    // Readable: small, so its content block fits. Opens the gate on its own.
    await writeFile(join(root, 'src', 'Small.java'), 'class Small { void ok() {} }\n');
    // Unreadable: untracked (no patch) and over maxFileBytes (12,000), so no content block either.
    await writeFile(join(root, 'src', 'Huge.java'), `class Huge { ${'/* pad */'.repeat(4000)} }\n`);

    const report = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review it' } });
    assert.equal(report.evidence.gated, false, 'the readable path must open the gate');
    assert.equal(report.evidence.allowedEvidenceRefs.includes('file:src/Small.java'), true);
    assert.equal(
      report.evidence.allowedEvidenceRefs.includes('file:src/Huge.java'),
      false,
      'an unreadable path must not be citable',
    );
    // Withheld, not silently absent: the count is disclosed as unavailable evidence.
    assert.ok(
      report.evidence.unavailableEvidence.some((token) => token === 'unavailable:file-evidence:1:no-content-block-or-hunk'),
      JSON.stringify(report.evidence.unavailableEvidence),
    );

    // Control: stage the big file so a diff exists, and its ref returns — the rule keys on readability,
    // not on file size.
    await gitLines(root, ['add', '--', 'src/Huge.java']);
    const staged = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review it' } });
    assert.equal(staged.evidence.allowedEvidenceRefs.includes('file:src/Huge.java'), true);
  } finally {
    await runtime.close();
  }
});

test('an evidence path is read before ordinary budget candidates', async () => {
  // With 24 ordinary allowlisted changed paths ahead of it, an evidence-only path used to lose the
  // maxFiles budget and reach the reviewer as a ref with no contents.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend, runtimeOptions: { evidenceScope: 'all' } });
  try {
    await initializeGitRepo(root);
    // 30 tracked files with uncommitted edits: each has a hunk, so the reviewer can see them through
    // the diff even without a content block. They fill the maxFiles budget (24) on their own.
    for (let index = 0; index < 30; index += 1) {
      const name = `a${String(index).padStart(2, '0')}.ts`;
      await writeFile(join(root, name), `export const f${index} = ${index};\n`);
    }
    await gitLines(root, ['add', '-A']);
    await gitLines(root, ['commit', '-m', 'tracked']);
    for (let index = 0; index < 30; index += 1) {
      await writeFile(join(root, `a${String(index).padStart(2, '0')}.ts`), `export const f${index} = ${index + 1};\n`);
    }
    // Untracked: git produces no patch for it, so a content block is the only way it can be seen.
    await writeFile(join(root, 'zz.java'), 'class Zz { void late() {} }\n');

    const launch = await runtime.launch({ name: 'code-review', args: { prompt: 'Review the change' } });
    await collectEvents(runtime, launch.taskId);
    assert.ok(backend.requests.length >= 1);
    const prompt = backend.requests[0].messages.map((message) => message.content).join('\n');
    assert.match(prompt, /--- zz\.java \(/, 'the evidence path must be read before the budget fills');
    assert.match(prompt, /void late\(\)/);
  } finally {
    await runtime.close();
  }
});

test('evidenceScope all shows the admitted file contents, not just its path', async () => {
  // An untracked .java has no unstaged patch, so if the budget allowlist also removed it from the
  // included files the gate would open and agents would spend with a path and a status and nothing
  // else — a blind review of the repositories this scope exists to support.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend, runtimeOptions: { evidenceScope: 'all' } });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'App.java'), 'class App { void authority() {} }\n');

    const launch = await runtime.launch({ name: 'code-review', args: { prompt: 'Review src/App.java' } });
    await collectEvents(runtime, launch.taskId);
    assert.ok(backend.requests.length >= 1, 'the gate must open under evidenceScope all');
    const prompt = backend.requests[0].messages.map((message) => message.content).join('\n');
    assert.match(prompt, /--- src\/App\.java \(/, 'the admitted file must reach an included-file block');
    assert.match(prompt, /void authority\(\)/, 'its contents must be present, not only its path');
  } finally {
    await runtime.close();
  }
});

test('an ambiguous rename header is left unparsed rather than misattributed', async () => {
  // Renaming into a name that contains the header separator produces a symmetric split whose halves
  // are a path that does not exist. Publishing a diff ref for it would let findings cite evidence
  // attributed to the wrong file, so the header stays unparsed.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await writeFile(join(root, 'foo.ts'), 'export const foo = 1;\n');
    await gitLines(root, ['add', '--', 'foo.ts']);
    await gitLines(root, ['commit', '-m', 'add foo']);
    await mkdir(join(root, 'bar.ts b', 'foo.ts b'), { recursive: true });
    await gitLines(root, ['mv', '--', 'foo.ts', join('bar.ts b', 'foo.ts b', 'bar.ts')]);
    await gitLines(root, ['commit', '-m', 'rename into an ambiguous name']);

    const report = await runtime.validateWorkflowInput({
      name: 'code-review',
      args: { prompt: 'Review the rename.', diffBaseRef: 'HEAD~1' },
    });
    const refs = report.evidence.allowedEvidenceRefs;
    // Positive control: the real (renamed) path is published from the NUL name listing.
    assert.equal(refs.includes('file:bar.ts b/foo.ts b/bar.ts'), true, JSON.stringify(refs));
    // The fabricated symmetric path — the halves of the ambiguous header — must appear nowhere.
    const fabricated = 'foo.ts b/bar.ts';
    for (const ref of refs) {
      const path = ref.startsWith('file:')
        ? ref.slice('file:'.length)
        : ref.replace(/^(diff|hunk):[a-z]+:/, '').replace(/:\d+$/, '');
      assert.notEqual(path, fabricated, `misattributed ref published: ${ref}`);
    }
  } finally {
    await runtime.close();
  }
});

test('an unsafe committed filename is excluded and reported', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await writeFile(join(root, 'safe.ts'), 'export const safe = 1;\n');
    // A newline in the name is exactly what the git-status parser already refuses.
    await writeFile(join(root, 'un\nsafe.ts'), 'export const unsafe = 1;\n');
    // Legal on POSIX, and safe by the same predicate: a backslash is not a control character. Normalizing
    // it to a slash would name a nested path that does not exist, so the ref could not be read or cited.
    await writeFile(join(root, 'back\\slash.ts'), 'export const literal = 1;\n');
    await gitLines(root, ['add', '-A']);
    await gitLines(root, ['commit', '-m', 'both']);

    const report = await runtime.validateWorkflowInput({
      name: 'code-review',
      args: { prompt: 'Review the last commit.', diffBaseRef: 'HEAD~1' },
    });
    assert.equal(report.evidence.allowedEvidenceRefs.includes('file:safe.ts'), true);
    assert.equal(report.evidence.allowedEvidenceRefs.includes('file:back\\slash.ts'), true);
    assert.equal(report.evidence.allowedEvidenceRefs.includes('file:back/slash.ts'), false);
    for (const ref of report.evidence.allowedEvidenceRefs) {
      assert.ok(!ref.includes('\n'), `unsafe name reached a ref: ${JSON.stringify(ref)}`);
    }
    assert.ok(
      report.evidence.unavailableEvidence.some((token) => token.includes('diff-committed-name')),
      JSON.stringify(report.evidence.unavailableEvidence),
    );

    // A range whose only touched name is unsafe produces no ref at all. The gate must close, and the
    // reason must account for the exclusion instead of claiming git reported nothing changed.
    await writeFile(join(root, 'un\nsafe.ts'), 'export const unsafe = 2;\n');
    await gitLines(root, ['add', '-A']);
    await gitLines(root, ['commit', '-m', 'unsafe only']);
    const gated = await runtime.validateWorkflowInput({
      name: 'code-review',
      args: { prompt: 'Review the last commit.', diffBaseRef: 'HEAD~1' },
    });
    assert.equal(gated.evidence.gated, true);
    assert.match(gated.evidence.reason, /1 committed name\(s\) were excluded as unsafe paths/);
  } finally {
    await runtime.close();
  }
});

test('a committed-range path is prioritized for an included-file block', async () => {
  // Opening the gate is not enough — agents would spend without seeing the change. In a repository
  // with more files than maxFiles, a committed-only path loses to the directory walk unless the
  // evidence file paths are prioritized ahead of it.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    // Root-level fillers whose names sort before the reviewed file, so they compete for the same
    // included-file budget (maxFiles is 24 by default).
    for (let index = 0; index < 40; index += 1) {
      const name = `a${String(index).padStart(2, '0')}.ts`;
      await writeFile(join(root, name), `export const filler${index} = ${index};\n`);
    }
    await gitLines(root, ['add', '-A']);
    await gitLines(root, ['commit', '-m', 'filler']);
    await writeFile(join(root, 'reviewed.ts'), 'export const reviewed = 1;\n');
    await gitLines(root, ['add', '--', 'reviewed.ts']);
    await gitLines(root, ['commit', '-m', 'the one under review']);

    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: 'Review the last commit.', diffBaseRef: 'HEAD~1' },
    });
    await collectEvents(runtime, launch.taskId);
    assert.ok(backend.requests.length >= 1);
    const prompt = backend.requests[0].messages.map((message) => message.content).join('\n');
    assert.match(prompt, /--- reviewed\.ts \(/, 'the committed path must reach an included-file block');
  } finally {
    await runtime.close();
  }
});

test('a nested built-in child is validated against its request contract', async () => {
  // The contract applied only at top-level launch, so a parent could run the default review with a
  // mistyped key — the silent spend the contract exists to stop.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({
    backend, runtimeOptions: { nestedWorkflows: 'enabled' },
  });
  try {
    await initializeGitRepo(root);
    await writeFile(join(root, 'pending.ts'), 'export const pending = 1;\n');
    const script = `export const meta = { name: "nested-parent", description: "calls a built-in" };
return await workflow("code-review", { promt: "typo reaches the child" });`;
    const launch = await runtime.launch({ script, args: {} });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /unknown workflow arg "promt" for built-in "code-review"/);
    assert.equal(backend.requests.length, 0, 'the child must not spend before its contract is checked');
  } finally {
    await runtime.close();
  }
});

test('a nested built-in child with valid args still runs (control)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({
    backend, runtimeOptions: { nestedWorkflows: 'enabled' },
  });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'client-package-plan.md'), 'The platform token owns authority.\n');
    const script = `export const meta = { name: "nested-parent", description: "calls a built-in" };
return await workflow("code-review", { prompt: "Review docs/client-package-plan.md." });`;
    const launch = await runtime.launch({ script, args: {} });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed', snapshot.error ?? '');
    assert.ok(backend.requests.length >= 1);
  } finally {
    await runtime.close();
  }
});

test('validation promotes a persisted built-in scriptPath like the launch path does', async () => {
  // Passing the persisted scriptPath used to skip both the contract and the evidence preview, so the
  // advertised zero-token pre-check disagreed with what a launch would do.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await writeFile(join(root, 'pending.ts'), 'export const pending = 1;\n');
    const launch = await runtime.launch({ name: 'code-review', args: { prompt: 'Review pending.ts' } });
    await collectEvents(runtime, launch.taskId);
    const scriptPath = runtime.get(launch.taskId).scriptPath;
    assert.ok(typeof scriptPath === 'string');

    // The contract applies through the promoted path.
    await assert.rejects(
      () => runtime.validateWorkflowInput({ scriptPath, args: { prompt: 'x', level: 'medium' } }),
      /workflow arg "level" for built-in "code-review" has an unsupported value "medium"/,
    );
    // And so does the evidence preview.
    const report = await runtime.validateWorkflowInput({ scriptPath, args: { prompt: 'Review pending.ts' } });
    assert.equal(report.workflowSource, 'built_in');
    assert.ok(report.evidence, 'a promoted built-in must still get an evidence preview');
    assert.equal(report.evidence.gated, false);
  } finally {
    await runtime.close();
  }
});

test('an unmatched injected script under a built-in name is unknown provenance, not insensitive', async () => {
  // The source ran the real policy-sensitive code-review under lenient; the resuming runtime injects a
  // DIFFERENT script under that name. Duplicating the injected script per policy made it look
  // insensitive and skipped the policy check entirely.
  const root = await mkdtemp(join(tmpdir(), 'workflow-resume-unmatched-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  await initializeGitRepo(root);
  await writeFile(join(root, 'pending.ts'), 'export const pending = 1;\n');
  const source = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000, refPolicy: 'lenient',
  });
  let runId;
  try {
    const first = await source.launch({ name: 'code-review', args: { prompt: 'Review pending.ts' } });
    await collectEvents(source, first.taskId);
    runId = source.get(first.taskId).runId;
  } finally {
    await source.close();
  }

  const impostor = {
    name: 'code-review',
    script: 'export const meta = { name: "code-review", description: "impostor" };\nreturn { impostor: true };',
  };
  const strictRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    builtinWorkflows: [impostor],
  });
  try {
    await assert.rejects(
      () => strictRuntime.launch({ resumeFromRunId: runId }),
      /under --ref-policy lenient, whose cached agent results were produced under different failure semantics/,
    );
  } finally {
    await strictRuntime.close();
  }
});

test('an injected built-in present in both runtimes resumes across policies', async () => {
  // An injected builtinWorkflows list is static — one script for every policy — so nothing in it can
  // depend on the ref policy and refusing its cross-policy resume is pure over-refusal. Contrast with
  // the gone-review case above, where the resuming runtime does not ship the name at all.
  const shared = {
    name: 'shared-review',
    script: 'export const meta = { name: "shared-review", description: "policy-independent" };\nreturn { shared: true };',
  };
  const root = await mkdtemp(join(tmpdir(), 'workflow-resume-injected-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  const source = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    builtinWorkflows: [shared], refPolicy: 'lenient',
  });
  let runId;
  try {
    const first = await source.launch({ name: 'shared-review', args: {} });
    await collectEvents(source, first.taskId);
    runId = source.get(first.taskId).runId;
    assert.ok(runId);
  } finally {
    await source.close();
  }

  const strictRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000,
    builtinWorkflows: [shared],
  });
  try {
    const resumed = await strictRuntime.launch({ resumeFromRunId: runId });
    await collectEvents(strictRuntime, resumed.taskId);
    assert.ok(['completed', 'failed'].includes(strictRuntime.get(resumed.taskId).status));
  } finally {
    await strictRuntime.close();
  }
});

test('the journal always records the ref policy', async () => {
  // Recorded unconditionally: omitting it for the default made absence ambiguous, because an
  // intermediate build could write a lenient run with no field, and a resume then inferred strict.
  for (const [refPolicy, expected] of [[undefined, 'strict'], ['strict', 'strict'], ['lenient', 'lenient']]) {
    const root = await mkdtemp(join(tmpdir(), 'workflow-journal-policy-'));
    tempDirs.push(root);
    const runtime = new WorkflowTaskRegistry({
      backend: new FakeSubagentBackend(), cwd: root, stateDir: join(root, '.ultracode-for-codex'),
      requestTimeoutMs: 30_000, ...(refPolicy ? { refPolicy } : {}),
    });
    try {
      const launch = await runtime.launch({ script: 'export const meta = { name: "policy-journal", description: "d" };\nreturn { ok: true };', args: {} });
      await collectEvents(runtime, launch.taskId);
      const snapshot = runtime.get(launch.taskId);
      const journal = await readWorkflowJournal(workflowJournalPath(snapshot.transcriptDir));
      const started = journal.entries.find((entry) => entry.kind === 'workflow.run.started');
      assert.equal(started.runtime.refPolicy, expected, `refPolicy=${String(refPolicy)}`);
    } finally {
      await runtime.close();
    }
  }
});

test('a policy-insensitive built-in resumes across policies (false-positive control)', async () => {
  // `task` generates the same script under every ref policy, so a cross-policy resume of it is not a
  // mismatch. Without the policy-sensitivity guard the identity check would match the first variant
  // and reject every such resume.
  const backend = new FakeSubagentBackend();
  const root = await mkdtemp(join(tmpdir(), 'workflow-resume-insensitive-'));
  tempDirs.push(root);
  const stateDir = join(root, '.ultracode-for-codex');
  const strictRuntime = new WorkflowTaskRegistry({ backend, cwd: root, stateDir, requestTimeoutMs: 30_000 });
  let runId;
  try {
    const first = await strictRuntime.launch({ name: 'task', args: { prompt: 'FAIL_AGENT analyze the package' } });
    await collectEvents(strictRuntime, first.taskId);
    runId = strictRuntime.get(first.taskId).runId;
    assert.ok(runId);
  } finally {
    await strictRuntime.close();
  }

  const lenientRuntime = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(), cwd: root, stateDir, requestTimeoutMs: 30_000, refPolicy: 'lenient',
  });
  try {
    const resumed = await lenientRuntime.launch({ resumeFromRunId: runId });
    await collectEvents(lenientRuntime, resumed.taskId);
    assert.ok(['completed', 'failed'].includes(lenientRuntime.get(resumed.taskId).status));
  } finally {
    await lenientRuntime.close();
  }
});

test('validation preview carries git-status failures like the run does', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    // No initializeGitRepo: the workspace is not a repository, so status collection fails.
    const report = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review.' } });
    assert.equal(report.evidence.gated, true);
    assert.ok(
      report.evidence.unavailableEvidence.some((token) => token.startsWith('unavailable:git-status')),
      `preview dropped the status failure: ${JSON.stringify(report.evidence.unavailableEvidence)}`,
    );
    assert.equal(backend.requests.length, 0);
  } finally {
    await runtime.close();
  }
});

test('validation preview reports no status failure inside a repository (control)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    const report = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review.' } });
    assert.equal(
      report.evidence.unavailableEvidence.some((token) => token.startsWith('unavailable:git-status')),
      false,
    );
  } finally {
    await runtime.close();
  }
});

test('a committed range narrowed by a path rule is named, not reported as "no changes"', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'App.java'), 'class App {}\n');
    await gitLines(root, ['add', 'src/App.java']);
    await gitLines(root, ['commit', '-m', 'ship java']);

    // Clean tree: the only evidence would come from the committed range, and its one file is
    // extension-excluded. The gate must name that rule rather than claim git status found nothing.
    const report = await runtime.validateWorkflowInput({
      name: 'code-review',
      args: { prompt: 'Review the last commit.', diffBaseRef: 'HEAD~1' },
    });
    assert.equal(report.evidence.gated, true);
    assert.deepEqual(report.evidence.dropped, [{ path: 'src/App.java', rule: 'extension-not-allowed' }]);
    assert.match(report.evidence.reason, /1 by extension-not-allowed \(src\/App\.java\)/);
    assert.doesNotMatch(report.evidence.reason, /no changed or untracked paths/);

    // Control: an admissible committed file opens the gate through the same range.
    await writeFile(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
    await gitLines(root, ['add', 'src/app.ts']);
    await gitLines(root, ['commit', '-m', 'ship ts']);
    const ready = await runtime.validateWorkflowInput({
      name: 'code-review',
      args: { prompt: 'Review the last commit.', diffBaseRef: 'HEAD~1' },
    });
    assert.equal(ready.evidence.gated, false);
    assert.equal(ready.evidence.allowedEvidenceRefs.includes('file:src/app.ts'), true);
  } finally {
    await runtime.close();
  }
});

test('verifierAttempts counts verifier agents that ran, including dropped results', async () => {
  const lenient = await runCodeReview({ marker: 'VERIFIER_BAD_REF', refPolicy: 'lenient' });
  assert.equal(lenient.snapshot.status, 'completed', lenient.snapshot.error ?? '');
  const stats = lenient.snapshot.result.stats;
  assert.equal(stats.refDrops, 1);
  assert.equal(lenient.snapshot.result.degraded.entries[0].stage, 'verifier');
  // Two verifiers ran and consumed tokens; one result was dropped.
  assert.equal(stats.verifierAttempts, 2);
  assert.equal(stats.candidates, 1);

  // Control: strict still fails on the same fixture.
  const strict = await runCodeReview({ marker: 'VERIFIER_BAD_REF', refPolicy: 'strict' });
  assert.equal(strict.snapshot.status, 'failed');
  assert.match(strict.snapshot.error, /includes unsupported evidence ref file:outside\.md/);
});

test('the change-evidence context has a pinned section order', async () => {
  // The cross-family review's highest-severity issue was that this context changed unconditionally
  // while the change claimed byte-identity. Identity with the previous release is genuinely broken and
  // is now disclosed; this test pins the CURRENT shape so the next accidental change to what agents
  // see — and therefore to contextHash and the agent cache keys derived from it — fails loudly here.
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'client-package-plan.md'), 'The platform token owns authority.\n');

    const launch = await runtime.launch({ name: 'code-review', args: { prompt: 'Review.' } });
    await collectEvents(runtime, launch.taskId);
    assert.ok(backend.requests.length >= 1);
    const prompt = backend.requests[0].messages.map((message) => message.content).join('\n');

    const expected = [
      // The gate now sits in the top-level header, because it is decided after file selection rather
      // than inside the change-evidence block.
      'evidenceGate: ',
      'evidenceGateReason: ',
      '### Change Evidence',
      'sourceSnapshotId: ',
      'contextHash: ',
      'allowedEvidenceIndexDigest: ',
      'diffBaseRef: ',
      'truncation: ',
      'evidenceScope: ',
      '#### Evidence Ref Grammar',
      '#### Changed Files',
      '#### Dropped From Evidence',
      '#### Unstaged Diff',
      '#### Staged Diff',
      '#### Committed Diff',
      '### Allowed Evidence Refs',
      '### Unavailable Evidence',
      '### Git Status',
      '### Included Files',
    ];
    let cursor = -1;
    for (const marker of expected) {
      const at = prompt.indexOf(marker, cursor + 1);
      assert.ok(at > cursor, `context marker out of order or missing: ${marker}`);
      cursor = at;
    }
  } finally {
    await runtime.close();
  }
});

test('the vacuous-pass rule also covers the no-active-lenses return', async () => {
  // A scope-file drop plus a scope that selects no lens used to complete with an empty report and the
  // scope agent's own summary — a degraded review that read as a clean one.
  const dropped = await runCodeReview({ marker: 'SCOPE_NO_LENSES', refPolicy: 'lenient' });
  assert.equal(dropped.snapshot.status, 'failed');
  assert.match(dropped.snapshot.error, /no candidate survived 1 unsupported-evidence drop\(s\) at scope selection \(no active lenses\)/);
  assert.match(dropped.snapshot.error, /inconclusive, not clean/);

  // Control: no drop and no lens still completes, so the guard keys on drops rather than on emptiness.
  const clean = await runCodeReview({ marker: 'SCOPE_NO_LENSES_CLEAN', refPolicy: 'lenient' });
  assert.equal(clean.snapshot.status, 'completed', clean.snapshot.error ?? '');
  assert.equal(clean.snapshot.result.degraded, null);
  assert.equal(clean.snapshot.result.findings.length, 0);
});

test('a drive-letter absolute cited path is structural at every policy', async () => {
  for (const refPolicy of ['lenient', 'strict']) {
    const { snapshot } = await runCodeReview({ marker: 'DRIVE_ABSOLUTE_REF', refPolicy });
    assert.equal(snapshot.status, 'failed', refPolicy);
    assert.match(snapshot.error, /structural/, refPolicy);
    assert.match(snapshot.error, /references a path outside the workspace: C:\/Users\/someone\/outside\.md/, refPolicy);
  }
});

test('refPolicy lenient leaves a clean run unchanged (degraded absent)', async () => {
  const lenient = await runCodeReview({ marker: 'CLEAN_RUN', refPolicy: 'lenient' });
  const strict = await runCodeReview({ marker: 'CLEAN_RUN', refPolicy: 'strict' });
  assert.equal(lenient.snapshot.status, 'completed', lenient.snapshot.error ?? '');
  assert.equal(lenient.snapshot.result.degraded, null);
  assert.equal(lenient.snapshot.result.stats.refDrops, 0);
  assert.equal(lenient.snapshot.result.findings.length, strict.snapshot.result.findings.length);
  assert.equal(lenient.snapshot.result.summary, strict.snapshot.result.summary);
});

test('refPolicy lenient drops one scope file, and fails when every scope file drops', async () => {
  const partial = await runCodeReview({ marker: 'SCOPE_FILE_PARTIAL', refPolicy: 'lenient' });
  assert.equal(partial.snapshot.status, 'completed', partial.snapshot.error ?? '');
  assert.equal(partial.snapshot.result.degraded.refDrops, 1);
  assert.equal(partial.snapshot.result.degraded.entries[0].stage, 'scope.files');
  // The second scope file is the one that dropped; the first survived and the review proceeded.
  assert.match(partial.snapshot.result.degraded.entries[0].label, /scope\.files\[1\]/);
  assert.ok(partial.snapshot.result.findings.length >= 1);

  const all = await runCodeReview({ marker: 'SCOPE_FILE_ALL_INVALID', refPolicy: 'lenient' });
  assert.equal(all.snapshot.status, 'failed');
  assert.match(all.snapshot.error, /every scope file was dropped as unsupported evidence/);

  const strict = await runCodeReview({ marker: 'SCOPE_FILE_PARTIAL', refPolicy: 'strict' });
  assert.equal(strict.snapshot.status, 'failed');
  assert.match(strict.snapshot.error, /references unsupported file/);
});

test('refPolicy lenient keeps a workspace-escaping path fatal (structural, not a grammar slip)', async () => {
  for (const refPolicy of ['lenient', 'strict']) {
    const { snapshot } = await runCodeReview({ marker: 'TRAVERSAL_REF', refPolicy });
    assert.equal(snapshot.status, 'failed', refPolicy);
    assert.match(snapshot.error, /structural/, refPolicy);
    assert.match(snapshot.error, /references a path outside the workspace: \.\.\/outside\.md/, refPolicy);
  }
});

test('refPolicy lenient keeps lens decisions fatal (a premise is not an item)', async () => {
  const { snapshot, backend } = await runCodeReview({ marker: 'SCOPE_DECISION_INVALID', refPolicy: 'lenient' });
  assert.equal(snapshot.status, 'failed');
  assert.match(snapshot.error, /includes unsupported decision ref file:outside\.md/);
  // It fails at scope, before any finder or verifier spends.
  assert.equal(backend.requests.length, 1);
});

test('code-review still fails closed on a ref whose path is not in evidence (normalization control)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'client-package-plan.md'), 'The platform token owns authority.\n');

    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: 'INVALID_EVIDENCE_REF Review docs/client-package-plan.md.' },
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /includes unsupported evidence ref file:outside\.md/);
  } finally {
    await runtime.close();
  }
});

test('an extension-only gate failure names --evidence-scope all', async () => {
  // Telling a Java-only repository to "change a file whose extension is in the allowlist" hides the
  // supported answer and reads as "rename your code".
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'App.java'), 'class App {}\n');

    const report = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review it' } });
    assert.equal(report.evidence.gated, true);
    assert.match(report.evidence.reason, /pass --evidence-scope all to forgive the extension allowlist/);
    assert.doesNotMatch(
      report.evidence.reason,
      /change a file whose extension is in the evidence allowlist/,
      'the extension-only case must not offer the rename remedy at all',
    );

    // Control: add an excluded-dir drop, so the rules are mixed and the generic remedy leads again.
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'bundle.js'), 'export const bundled = 1;\n');
    const mixed = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review it' } });
    assert.match(mixed.evidence.reason, /change a file whose extension is in the evidence allowlist/);
    assert.match(mixed.evidence.reason, /or pass --evidence-scope all to forgive the extension allowlist for those paths/);
  } finally {
    await runtime.close();
  }
});

test('built-in code-review gate names the rule that dropped each changed path', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'src', 'App.java'), 'class App {}\n');
    await writeFile(join(root, 'Dockerfile'), 'FROM scratch\n');
    await writeFile(join(root, 'dist', 'bundle.js'), 'export const built = 1;\n');

    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: 'Review the pending change.' },
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /git status reported 3 changed path\(s\), all dropped before becoming evidence/);
    assert.match(snapshot.error, /2 by extension-not-allowed/);
    assert.match(snapshot.error, /src\/App\.java/);
    assert.match(snapshot.error, /Dockerfile/);
    assert.match(snapshot.error, /1 by excluded-dir/);
    assert.match(snapshot.error, /dist\/bundle\.js/);
    assert.equal(backend.requests.length, 0);
  } finally {
    await runtime.close();
  }
});

test('workspace evidence discloses dropped paths and the ref grammar to the reviewer', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'App.java'), 'class App {}\n');
    await writeFile(join(root, 'notes.md'), 'A pending note.\n');

    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: 'Review the pending change.' },
    });
    await collectEvents(runtime, launch.taskId);
    // The gate opened on notes.md, so the scope agent ran and received the evidence context.
    assert.ok(backend.requests.length >= 1);
    const prompt = backend.requests[0].messages.map((message) => message.content).join('\n');
    assert.match(prompt, /#### Dropped From Evidence/);
    assert.match(prompt, /src\/App\.java \(extension-not-allowed: not citable, contents withheld\)/);
    assert.match(prompt, /#### Evidence Ref Grammar/);
    assert.match(prompt, /Do not append a line/);
    assert.match(prompt, /per-file hunk index, not a line number/);
  } finally {
    await runtime.close();
  }
});

test('built-in code-review reviews a committed range when diffBaseRef resolves on a clean tree', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await writeFile(join(root, 'shipped.ts'), 'export const shipped = 1;\n');
    await gitLines(root, ['add', 'shipped.ts']);
    await gitLines(root, ['commit', '-m', 'ship']);

    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: 'Review the last commit.', diffBaseRef: 'HEAD~1' },
    });
    await collectEvents(runtime, launch.taskId);
    // Gate opened from the committed range alone: the working tree is clean.
    assert.ok(backend.requests.length >= 1);
    const prompt = backend.requests[0].messages.map((message) => message.content).join('\n');
    assert.match(prompt, /evidenceGate: open/);
    assert.match(prompt, /file:shipped\.ts/);
    assert.match(prompt, /diff:committed:shipped\.ts/);
  } finally {
    await runtime.close();
  }
});

test('a clean tree without diffBaseRef stays gated (negative control for committed-range review)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await writeFile(join(root, 'shipped.ts'), 'export const shipped = 1;\n');
    await gitLines(root, ['add', 'shipped.ts']);
    await gitLines(root, ['commit', '-m', 'ship']);

    const launch = await runtime.launch({ name: 'code-review', args: { prompt: 'Review.' } });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /no reviewable change evidence in the working tree/);
    assert.equal(backend.requests.length, 0);
  } finally {
    await runtime.close();
  }
});

test('evidenceScope all admits extension-excluded sources and only those (both directions)', async () => {
  for (const scope of ['default', 'all']) {
    const backend = new FakeSubagentBackend();
    const { runtime, root } = await createRuntime({ backend, runtimeOptions: { evidenceScope: scope } });
    try {
      await initializeGitRepo(root);
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'src', 'App.java'), 'class App {}\n');
      await writeFile(join(root, 'dist', 'bundle.js'), 'export const built = 1;\n');

      const report = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review.' } });
      if (scope === 'default') {
        assert.equal(report.evidence.gated, true);
        assert.equal(report.evidence.allowedFileRefs, 0);
      } else {
        assert.equal(report.evidence.gated, false);
        assert.equal(report.evidence.allowedEvidenceRefs.includes('file:src/App.java'), true);
        // 'all' forgives the extension rule and nothing else.
        assert.equal(report.evidence.allowedEvidenceRefs.some((ref) => ref.includes('dist/bundle.js')), false);
        assert.deepEqual(report.evidence.dropped, [{ path: 'dist/bundle.js', rule: 'excluded-dir' }]);
      }
      // A preflight preview never spends an agent.
      assert.equal(backend.requests.length, 0);
    } finally {
      await runtime.close();
    }
  }
});

test('validateWorkflowInput reports the evidence precondition and rejects unreadable args', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'App.java'), 'class App {}\n');

    const gated = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review.' } });
    assert.equal(gated.evidence.gated, true);
    assert.match(gated.evidence.reason, /1 by extension-not-allowed \(src\/App\.java\)/);
    assert.deepEqual(gated.evidence.dropped, [{ path: 'src/App.java', rule: 'extension-not-allowed' }]);

    await writeFile(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
    const ready = await runtime.validateWorkflowInput({ name: 'code-review', args: { prompt: 'Review.' } });
    assert.equal(ready.evidence.gated, false);
    assert.equal(ready.evidence.allowedFileRefs, 1);
    assert.equal(ready.evidence.reason, undefined);

    // The free pre-check also answers the request-contract question.
    await assert.rejects(
      () => runtime.validateWorkflowInput({ name: 'code-review', args: { promt: 'typo' } }),
      /unknown workflow arg "promt"/,
    );
    // A non-evidence built-in reports no evidence section at all.
    const task = await runtime.validateWorkflowInput({ name: 'task', args: { prompt: 'Analyze.' } });
    assert.equal(task.evidence, undefined);
    assert.equal(backend.requests.length, 0);
  } finally {
    await runtime.close();
  }
});

test('built-in request contract rejects unreadable args at launch with value, cause, and remediation', async () => {
  const rejections = [
    {
      label: 'unknown key with a near match',
      args: { promt: 'review the auth path' },
      value: /unknown workflow arg "promt" for built-in "code-review"/,
      cause: /would be silently ignored \(3 accepted keys: prompt, level, diffBaseRef\)/,
      remediation: /did you mean "prompt"\?/,
    },
    {
      label: 'unknown key with a prefix match',
      args: { diffBase: 'HEAD~1' },
      value: /unknown workflow arg "diffBase"/,
      cause: /3 accepted keys/,
      remediation: /did you mean "diffBaseRef"\?/,
    },
    {
      label: 'unknown key with no near match',
      args: { reviewDepth: 'max' },
      value: /unknown workflow arg "reviewDepth"/,
      cause: /would be silently ignored/,
      remediation: /remove it, or use one of the accepted keys/,
    },
    {
      label: 'unsupported enum value',
      args: { level: 'medium' },
      value: /workflow arg "level" for built-in "code-review" has an unsupported value "medium"/,
      cause: /not one of the 2 supported values \("high", "xhigh"\), and an unrecognized value silently selects "xhigh"/,
      remediation: /pass one of "high" or "xhigh" \(case-insensitive\)/,
    },
    {
      label: 'wrong prompt type',
      args: { prompt: 123 },
      value: /workflow arg "prompt" for built-in "code-review" is not a non-empty string/,
      cause: /received number, which the workflow would silently replace with its default/,
      remediation: /omit "prompt" to accept the default deliberately/,
    },
    {
      label: 'args that are not an object',
      args: [],
      value: /workflow args for built-in "code-review" must be a JSON object/,
      cause: /received an array/,
      remediation: /pass an object with the 3 accepted keys/,
    },
    {
      label: 'unresolvable diffBaseRef',
      args: { diffBaseRef: 'no-such-ref' },
      value: /workflow arg "diffBaseRef" for built-in "code-review" does not resolve to a commit: "no-such-ref"/,
      cause: /git rev-parse --verify rejected it in /,
      remediation: /omit "diffBaseRef" to review only the working tree/,
    },
  ];
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await writeFile(join(root, 'pending.ts'), 'export const pending = 1;\n');
    for (const rejection of rejections) {
      let message = '';
      try {
        await runtime.launch({ name: 'code-review', args: rejection.args });
        assert.fail(`expected rejection for ${rejection.label}`);
      } catch (err) {
        message = err.message;
      }
      assert.match(message, rejection.value, rejection.label);
      assert.match(message, rejection.cause, rejection.label);
      assert.match(message, rejection.remediation, rejection.label);
    }
    // Rejections happen before any journal or spend.
    assert.equal(backend.requests.length, 0);
  } finally {
    await runtime.close();
  }
});

test('built-in request contract accepts documented args (negative control) and honors level case-insensitively', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await writeFile(join(root, 'pending.ts'), 'export const pending = 1;\n');

    const accepted = [
      { args: { prompt: 'Review pending.ts', level: 'high' }, effort: 'medium' },
      { args: { prompt: 'Review pending.ts', level: 'HIGH' }, effort: 'medium' },
      { args: { prompt: 'Review pending.ts', level: 'xhigh' }, effort: 'xhigh' },
      { args: { prompt: 'Review pending.ts' }, effort: 'xhigh' },
    ];
    for (const entry of accepted) {
      backend.requests.length = 0;
      const launch = await runtime.launch({ name: 'code-review', args: entry.args });
      await collectEvents(runtime, launch.taskId);
      assert.ok(backend.requests.length >= 1, JSON.stringify(entry.args));
      assert.equal(backend.requests[0].reasoningEffort, entry.effort, JSON.stringify(entry.args));
    }
  } finally {
    await runtime.close();
  }
});

test('built-in code-review file rejection names the allowed set, its source, and remediation', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'other-note.md'), 'An unrelated untracked note.\n');

    const launch = await runtime.launch({
      name: 'code-review',
      args: { prompt: 'Review the docs notes.' },
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.match(
      snapshot.error,
      /scope\.files\[0\] references unsupported file docs\/client-package-plan\.md: not in allowed file refs \(1 entries\) derived from file: entries in the evidence context/,
    );
    assert.match(snapshot.error, /; populated by uncommitted or untracked paths in the working tree/);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime supports phase plans that depend on prior phase results', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "dynamic-phase-plan" };
announcePlan({
  mode: "phase_parallel",
  rationale: "Start with discovery, then choose verification from the result.",
  phases: [{
    id: "discover",
    title: "Discover",
    goal: "Find whether deep verification is needed.",
    agents: [{ id: "scan", title: "Scan", focus: "Return NEED_DEEP." }]
  }]
});
announcePhasePlan({
  id: "discover",
  title: "Discover",
  goal: "Find whether deep verification is needed.",
  agents: [{ id: "scan", title: "Scan", label: "dynamic-scan", focus: "Return NEED_DEEP." }]
});
phase("Discover");
const discovery = await agent("NEED_DEEP", { label: "dynamic-scan", phase: "Discover" });
const verifyAgents = discovery.includes("NEED_DEEP")
  ? [
      { id: "runtime", title: "Runtime", label: "dynamic-runtime", focus: "Verify runtime behavior." },
      { id: "security", title: "Security", label: "dynamic-security", focus: "Verify boundary behavior." }
    ]
  : [
      { id: "quick", title: "Quick", label: "dynamic-quick", focus: "Do a quick check." }
    ];
announcePhasePlan({
  id: "verify",
  title: "Verify",
  goal: "Use the discovery result to choose the verification fan-out.",
  agents: verifyAgents
});
phase("Verify");
const results = await parallel(verifyAgents.map((item) => () => agent(item.focus, { label: item.label, phase: "Verify" })));
return { discovery, results };`,
    });
    const events = await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.result.results.length, 2);
    const initialPlan = events.find((event) => event.type === 'workflow.plan.ready');
    assert.deepEqual(initialPlan.phases.map((phase) => phase.title), ['Discover']);
    const verifyPlan = events.find((event) => event.type === 'workflow.phase.planned' && event.title === 'Verify');
    assert.deepEqual(verifyPlan.plannedAgents.map((agent) => agent.label), [
      'dynamic-runtime',
      'dynamic-security',
    ]);
    const verifyStarted = events.find((event) => event.type === 'workflow.phase.started' && event.title === 'Verify');
    assert.deepEqual(verifyStarted.plannedAgents.map((agent) => agent.label), [
      'dynamic-runtime',
      'dynamic-security',
    ]);
    assert.ok(
      events.findIndex((event) => event.type === 'workflow.agent.completed' && event.label === 'dynamic-scan')
        < events.findIndex((event) => event.type === 'workflow.phase.planned' && event.title === 'Verify'),
    );
  } finally {
    await runtime.close();
  }
});

test('workflow pipeline preserves item boundaries without stage barriers', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "pipeline-contract" };
const events = [];
const result = await pipeline([1, 2],
  (item) => {
    if (item === 1) {
      return new Promise((resolve) => setTimeout(() => {
        events.push("stage1:" + item);
        resolve([item, "wrapped"]);
      }, 50));
    }
    events.push("stage1:" + item);
    return [item, "wrapped"];
  },
  (value) => {
    events.push("stage2:" + value[0]);
    return value;
  }
);
return { result, events };`,
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.deepEqual(jsonValue(snapshot.result.result), [
      [1, 'wrapped'],
      [2, 'wrapped'],
    ]);
    assert.ok(
      snapshot.result.events.indexOf('stage2:2') < snapshot.result.events.indexOf('stage1:1'),
      `expected item 2 to pass stage 2 before item 1 leaves stage 1: ${snapshot.result.events.join(', ')}`,
    );
  } finally {
    await runtime.close();
  }
});

test('pipeline stages receive (prevResult, originalItem, index)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "pipeline-signature" };
return await pipeline(["a", "b"],
  (prev, original, index) => "s1(" + String(prev) + "," + String(original) + "," + String(index) + ")",
  (prev, original, index) => "s2(" + String(prev) + "," + String(original) + "," + String(index) + ")"
);`,
    });
    await collectEvents(runtime, launch.taskId);
    // Under the old single-arg call the originalItem/index args are undefined, so the
    // embedded strings would read "undefined" — this assertion pins the native signature.
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), [
      's2(s1(a,a,0),a,0)',
      's2(s1(b,b,1),b,1)',
    ]);
  } finally {
    await runtime.close();
  }
});

test('pipeline passes a stage-returned null onward instead of short-circuiting the item', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "pipeline-null-passthrough" };
const ran = [];
const result = await pipeline([1],
  () => null,
  (prev) => { ran.push("stage2:" + String(prev)); return "recovered"; }
);
return { result, ran };`,
    });
    await collectEvents(runtime, launch.taskId);
    // Negative control: the old short-circuit turned a returned null into a skipped item,
    // yielding { result: [null], ran: [] }. Native passes the null onward, so stage2 runs.
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), {
      result: ['recovered'],
      ran: ['stage2:null'],
    });
  } finally {
    await runtime.close();
  }
});

test('pipeline passes a stage-returned undefined onward as well (not only null)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "pipeline-undefined-passthrough" };
const ran = [];
const result = await pipeline([1],
  () => undefined,
  (prev) => { ran.push("stage2:" + String(prev)); return "recovered"; }
);
return { result, ran };`,
    });
    await collectEvents(runtime, launch.taskId);
    // The old short-circuit caught undefined too; native passes it onward so stage2 runs.
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), {
      result: ['recovered'],
      ran: ['stage2:undefined'],
    });
  } finally {
    await runtime.close();
  }
});

test('pipeline drops an item to null and skips remaining stages only when a stage throws', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "pipeline-throw-skips" };
const ran = [];
const result = await pipeline([1],
  () => { throw new Error("boom"); },
  (prev) => { ran.push("stage2"); return "reached"; }
);
return { result, ran };`,
    });
    await collectEvents(runtime, launch.taskId);
    // Regression guard: throw still drops the item to null and skips the remaining stage.
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), {
      result: [null],
      ran: [],
    });
  } finally {
    await runtime.close();
  }
});

test('parallel() and pipeline() reject more than 4096 items with an explicit error', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const over = Array.from({ length: 4097 }, (_, i) => i);
    const under = Array.from({ length: 4096 }, (_, i) => i);

    const parallelOver = await runtime.launch({
      script: 'export const meta = { name: "parallel-cap-over" };\nreturn await parallel(args);',
      args: over,
    });
    let events = await collectEvents(runtime, parallelOver.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');
    // Pin the hook name so a copy-pasted wrong name in the message is caught.
    assert.match(runtime.get(parallelOver.taskId).error, /parallel\(\) accepts at most 4096 items; got 4097/);

    const pipelineOver = await runtime.launch({
      script: 'export const meta = { name: "pipeline-cap-over" };\nreturn await pipeline(args, (x) => x);',
      args: over,
    });
    events = await collectEvents(runtime, pipelineOver.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');
    assert.match(runtime.get(pipelineOver.taskId).error, /pipeline\(\) accepts at most 4096 items; got 4097/);

    // Boundary: exactly 4096 items is accepted and completes — pinned for BOTH hooks so a
    // `>= 4096` off-by-one in either guard is caught (the pipeline guard is a separate copy).
    const parallelUnder = await runtime.launch({
      script: 'export const meta = { name: "parallel-cap-under" };\nconst r = await parallel(args);\nreturn r.length;',
      args: under,
    });
    events = await collectEvents(runtime, parallelUnder.taskId);
    assert.equal(events.at(-1).type, 'workflow.completed');
    assert.equal(jsonValue(runtime.get(parallelUnder.taskId).result), 4096);

    const pipelineUnder = await runtime.launch({
      script: 'export const meta = { name: "pipeline-cap-under" };\nconst r = await pipeline(args, (x) => x);\nreturn r.length;',
      args: under,
    });
    events = await collectEvents(runtime, pipelineUnder.taskId);
    assert.equal(events.at(-1).type, 'workflow.completed');
    assert.equal(jsonValue(runtime.get(pipelineUnder.taskId).result), 4096);
  } finally {
    await runtime.close();
  }
});

test('workflow() runs an inline child and returns its result (N1)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    const childScript = 'export const meta = { name: "child" };\nreturn await agent("from child");';
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
const childResult = await workflow({ script: ${JSON.stringify(childScript)} });
const own = await agent("from parent");
return { childResult, own };`,
    });
    await collectEvents(runtime, launch.taskId);
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), {
      childResult: 'RAW:from child',
      own: 'RAW:from parent',
    });
  } finally {
    await runtime.close();
  }
});

test('workflow() rejects an unknown name and a bad ref, catchably (N1 negative, C5f)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
const outcomes = [];
try { await workflow("no-such-builtin"); outcomes.push("no-throw"); } catch (e) { outcomes.push("unknown-threw"); }
try { await workflow(42); outcomes.push("no-throw"); } catch (e) { outcomes.push("badref-threw"); }
try { await workflow({ script: "this is ) not valid js" }); outcomes.push("no-throw"); } catch (e) { outcomes.push("syntax-threw"); }
return outcomes;`,
    });
    await collectEvents(runtime, launch.taskId);
    // All three reject, and the parent catches each — the run still completes (C5f catchable).
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), ['unknown-threw', 'badref-threw', 'syntax-threw']);
  } finally {
    await runtime.close();
  }
});

async function writeProjectWorkflow(root, name, script) {
  const dir = join(root, '.codex', 'workflows');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.js`), script);
}

async function approveAndRunNamed(runtime, name) {
  const req = await runtime.launch({ name });
  assert.equal(req.status, 'permission_required', `${name} should require approval`);
  const run = await runtime.approvePermissionRequest(req.permissionRequestId);
  await collectEvents(runtime, run.taskId);
}

test('workflow() nests an APPROVED project workflow by name and runs it (PG-NEST v2-A full-scope)', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    await writeProjectWorkflow(root, 'child-proj', 'export const meta = { name: "child-proj" };\nreturn await agent("from project child");');
    await approveAndRunNamed(runtime, 'child-proj'); // records the allow (and runs it once top-level)
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };\nreturn await workflow("child-proj");`,
    });
    await collectEvents(runtime, launch.taskId);
    assert.equal(runtime.get(launch.taskId).status, 'completed', runtime.get(launch.taskId).error);
    assert.equal(jsonValue(runtime.get(launch.taskId).result), 'RAW:from project child');
  } finally {
    await runtime.close();
  }
});

test('workflow() fails loud (catchably) when nesting an UNAPPROVED or DENIED project workflow (v2-A record gate)', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    await writeProjectWorkflow(root, 'unapproved', 'export const meta = { name: "unapproved" };\nreturn 1;');
    await writeProjectWorkflow(root, 'denied', 'export const meta = { name: "denied" };\nreturn 1;');
    const deny = await runtime.launch({ name: 'denied' });
    await runtime.denyPermissionRequest(deny.permissionRequestId); // records a deny
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
const out = [];
try { await workflow("unapproved"); out.push("no-throw"); } catch (e) { out.push("unapproved:" + (String(e.message).includes("not approved") ? "loud" : "other")); }
try { await workflow("denied"); out.push("no-throw"); } catch (e) { out.push("denied:" + (String(e.message).toLowerCase().includes("denied") ? "loud" : "other")); }
return out;`,
    });
    await collectEvents(runtime, launch.taskId);
    // Both fail loud and are caught — the run still completes (C5f), no unreviewed content ran.
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), ['unapproved:loud', 'denied:loud']);
  } finally {
    await runtime.close();
  }
});

test('workflow() nested name resolution follows project→built-in precedence: a shadowing unapproved project fails loud, not silently running the built-in (v2-A, MAJOR-3)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({
    backend,
    runtimeOptions: {
      nestedWorkflows: 'enabled',
      builtinWorkflows: [{ name: 'shadowed', script: 'export const meta = { name: "shadowed" };\nreturn "BUILTIN";' }],
    },
  });
  try {
    // A same-named project workflow shadows the built-in and is unapproved.
    await writeProjectWorkflow(root, 'shadowed', 'export const meta = { name: "shadowed" };\nreturn "PROJECT";');
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
let r; try { r = "ran:" + await workflow("shadowed"); } catch (e) { r = String(e.message).includes("not approved") ? "shadowed-fail-loud" : "other"; }
return r;`,
    });
    await collectEvents(runtime, launch.taskId);
    // v1 would silently run the built-in; v2-A resolves the shadowing project source and gates it.
    assert.equal(jsonValue(runtime.get(launch.taskId).result), 'shadowed-fail-loud');
  } finally {
    await runtime.close();
  }
});

test('concurrent nested workflow() by NAME both run under async full-scope resolution (v2-B, was v2-A sequential guard)', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    await writeProjectWorkflow(root, 'seq-child', 'export const meta = { name: "seq-child" };\nreturn await agent("c");');
    await approveAndRunNamed(runtime, 'seq-child');
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
const results = await parallel([() => workflow("seq-child"), () => workflow("seq-child")]);
return { nulls: results.filter((r) => r === null).length, ok: results.filter((r) => r !== null).length };`,
    });
    await collectEvents(runtime, launch.taskId);
    // v2-B removed the sequential guard: both concurrent named children resolve (async) + run, no null.
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), { nulls: 0, ok: 2 });
  } finally {
    await runtime.close();
  }
});

test('a nested child shares the parent token budget (N2, C5d)', async () => {
  // Each fake agent spends outputTokens=2. spent() reads the shared ctx.outputTokens, so the
  // child's agent must advance it — if the child had a fresh budget, s2 would equal s1.
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    const childScript = 'export const meta = { name: "child" };\nreturn await agent("c0");';
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
await agent("p0");
const s1 = budget.spent();
await workflow({ script: ${JSON.stringify(childScript)} });
const s2 = budget.spent();
return { s1, s2 };`,
    });
    await collectEvents(runtime, launch.taskId);
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), { s1: 2, s2: 4 });
  } finally {
    await runtime.close();
  }
});

test('workflow() cannot be nested more than one level (N3, C5e)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    const grandchild = 'export const meta = { name: "gc" };\nreturn 1;';
    const child = `export const meta = { name: "child" };\nreturn await workflow({ script: ${JSON.stringify(grandchild)} });`;
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
let outcome = "no-throw";
try { await workflow({ script: ${JSON.stringify(child)} }); }
catch (e) { outcome = "threw:" + String(e && e.message ? e.message : e); }
return outcome;`,
    });
    await collectEvents(runtime, launch.taskId);
    const result = jsonValue(runtime.get(launch.taskId).result);
    assert.match(result, /nested more than one level/);
  } finally {
    await runtime.close();
  }
});

test('a nested run journals exactly one run.started with child agents on the parent chain (N5)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    const childScript = 'export const meta = { name: "child" };\nawait agent("c0");\nreturn await agent("c1");';
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
await agent("p0");
await workflow({ script: ${JSON.stringify(childScript)} });
return "done";`,
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    const journal = await readWorkflowJournal(workflowJournalPath(snapshot.transcriptDir));
    const kinds = journal.entries.map((entry) => entry.kind);
    assert.equal(kinds.filter((k) => k === 'workflow.run.started').length, 1);
    assert.equal(kinds.filter((k) => k === 'workflow.run.completed').length, 1);
    // 3 agents total (p0 + child c0 + child c1) all on the single chain; validateWorkflowJournal
    // ran inside readWorkflowJournal without throwing, proving the chain is intact single-run.
    assert.equal(kinds.filter((k) => k === 'workflow.agent.completed').length, 3);
  } finally {
    await runtime.close();
  }
});

test('logical agent keys share one run-global namespace across parent and child (N6)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    const childScript = 'export const meta = { name: "child" };\nreturn await agent("c", { key: "x" });';
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
await agent("p", { key: "x" });
await workflow({ script: ${JSON.stringify(childScript)} });
return "done";`,
    });
    const events = await collectEvents(runtime, launch.taskId);
    // The child reusing the parent's logical key throws (shared namespace) → child fails →
    // the un-caught workflow() rejection fails the run.
    assert.equal(events.at(-1).type, 'workflow.failed');
    assert.match(runtime.get(launch.taskId).error, /key "x" was already used/);
  } finally {
    await runtime.close();
  }
});

test('nested workflow() is default-off and throws the unsupported stub (N7)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
let outcome = "no-throw";
try { await workflow({ script: "export const meta = { name: 'c' };\\nreturn 1;" }); }
catch (e) { outcome = "threw:" + String(e && e.message ? e.message : e); }
return outcome;`,
    });
    await collectEvents(runtime, launch.taskId);
    assert.match(jsonValue(runtime.get(launch.taskId).result), /not supported/);
  } finally {
    await runtime.close();
  }
});

test('resume replays a nested run from the shared chain and re-runs only the diverged tail (N4)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend, runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    // The child's second agent prompt depends on the child's args, which the parent derives
    // from ITS args — so changing the parent's args on resume changes exactly that one child
    // agent's call key. p0 and c0 are args-independent and must replay from cache.
    const childScript = 'export const meta = { name: "child" };\nawait agent("c0");\nreturn await agent("c1:" + args.tag);';
    const script = `export const meta = { name: "nested-resume" };
await agent("p0");
const c = await workflow({ script: ${JSON.stringify(childScript)} }, { tag: args.tag });
return c;`;

    const first = await runtime.launch({ script, args: { tag: 'v1' } });
    await collectEvents(runtime, first.taskId);
    assert.equal(jsonValue(runtime.get(first.taskId).result), 'RAW:c1:v1');
    assert.equal(backend.requests.length, 3); // p0, c0, c1:v1

    // Identical resume → 100% cache hit, zero new backend calls.
    const resumedSame = await runtime.launch({ resumeFromRunId: first.runId, args: { tag: 'v1' } });
    const sameEvents = await collectEvents(runtime, resumedSame.taskId);
    assert.equal(jsonValue(runtime.get(resumedSame.taskId).result), 'RAW:c1:v1');
    const sameCompletions = sameEvents.filter((e) => e.type === 'workflow.agent.completed');
    assert.equal(sameCompletions.length, 3);
    assert.equal(sameCompletions.every((e) => e.cached === true), true);
    assert.equal(backend.requests.length, 3);

    // Change the parent's args → only the child's c1 diverges; p0 and c0 stay cached, exactly
    // one new backend call runs (the diverged tail).
    const resumedDiverged = await runtime.launch({ resumeFromRunId: first.runId, args: { tag: 'v2' } });
    const divergedEvents = await collectEvents(runtime, resumedDiverged.taskId);
    assert.equal(jsonValue(runtime.get(resumedDiverged.taskId).result), 'RAW:c1:v2');
    const divergedCompletions = divergedEvents.filter((e) => e.type === 'workflow.agent.completed');
    assert.equal(divergedCompletions.filter((e) => e.cached === true).length, 2); // p0, c0
    assert.equal(divergedCompletions.filter((e) => e.cached !== true).length, 1); // c1:v2
    assert.equal(backend.requests.length, 4);
  } finally {
    await runtime.close();
  }
});

test('a parent structured agent after a nested child returns a usable object (toVmValue restore)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    const childScript = 'export const meta = { name: "child" };\nreturn await agent("c0");';
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['detail', 'count'],
      properties: { detail: { type: 'string' }, count: { type: 'number' } },
    };
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
await workflow({ script: ${JSON.stringify(childScript)} });
const r = await agent("structured please", { schema: ${JSON.stringify(schema)} });
// The projector is restored to the parent after the child, so this structured object is a
// parent-realm value: property access + arithmetic must work on it.
return { detail: r.detail, doubled: r.count * 2 };`,
    });
    await collectEvents(runtime, launch.taskId);
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), { detail: 'structured', doubled: 4 });
  } finally {
    await runtime.close();
  }
});

test('workflow(name) resolves a built-in child by name (C5a)', async () => {
  const greet = { name: 'greet', script: 'export const meta = { name: "greet" };\nreturn await agent("hi from greet");' };
  const { runtime } = await createRuntime({
    backend: new FakeSubagentBackend(),
    runtimeOptions: { nestedWorkflows: 'enabled', builtinWorkflows: [greet] },
  });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
return await workflow("greet");`,
    });
    await collectEvents(runtime, launch.taskId);
    assert.equal(jsonValue(runtime.get(launch.taskId).result), 'RAW:hi from greet');
  } finally {
    await runtime.close();
  }
});

test('concurrent nested workflow() children BOTH run and return value-correct structured results (N9 v2-B, PG-NEST concurrent)', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { nestedWorkflows: 'enabled' } });
  try {
    // v2-B removes the sequential guard: two children run CONCURRENTLY. Each runs a STRUCTURED agent
    // (the fake returns { detail, count }) and returns it tagged. The per-execution projector scope
    // (each createVmGlobals owns its own) is what makes this safe — the pre-v2-B single ctx.toVmValue
    // slot would be clobbered between concurrent siblings. (The realm mismatch that would cause is not
    // observable from inside the sandbox — no intrinsics, and projection preserves properties — so the
    // falsifiable signal is behavioral: with the guard restored one sibling is rejected → only 1 runs.)
    const schema = '{ type: "object", additionalProperties: false, properties: { detail: { type: "string" }, count: { type: "number" } }, required: ["detail", "count"] }';
    const childOf = (name) => `export const meta = { name: ${JSON.stringify(name)} };\nconst r = await agent("s", { schema: ${schema} });\nreturn { tag: ${JSON.stringify(name)}, detail: r.detail, count: r.count };`;
    const launch = await runtime.launch({
      script: `export const meta = { name: "parent" };
return await parallel([
  () => workflow({ script: ${JSON.stringify(childOf('a'))} }),
  () => workflow({ script: ${JSON.stringify(childOf('b'))} }),
]);`,
    });
    await collectEvents(runtime, launch.taskId);
    assert.equal(runtime.get(launch.taskId).status, 'completed', runtime.get(launch.taskId).error);
    const result = jsonValue(runtime.get(launch.taskId).result);
    assert.equal(result.filter((x) => x !== null).length, 2, 'both concurrent children run (no in-flight rejection)');
    assert.deepEqual(result.map((x) => x.tag).sort(), ['a', 'b']);
    // Each child's structured agent result is value-correct in the parent (projected through its own
    // scope on the way out): the fake returns { detail: 'structured', count: 2 }.
    assert.equal(result.every((x) => x.detail === 'structured' && x.count === 2), true, 'each concurrent child returns a value-correct structured result');
  } finally {
    await runtime.close();
  }
});

test('workspaceContext includeDiff returns deterministic change evidence refs', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    await initializeGitRepo(root);
    await gitLines(root, ['config', 'core.quotePath', 'true']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'demo.ts'), [
      'export function value() {',
      '  return 1;',
      '}',
      '',
    ].join('\n'));
    await writeFile(join(root, 'src', 'deleted.ts'), 'export const removed = true;\n');
    await writeFile(join(root, 'src', 'a -> b.ts'), 'export const arrow = 1;\n');
    await writeFile(join(root, 'src', 'é.ts'), 'export const accent = 1;\n');
    await writeFile(join(root, 'src', 'rename-source.ts'), 'export const renameSource = true;\n');
    await mkdir(join(root, '.ultracode-for-codex', 'workflows'), { recursive: true });
    await writeFile(join(root, '.ultracode-for-codex', 'workflows', 'journal.jsonl'), 'runtime state before\n');
    await writeFile(join(root, '.ultracode-for-codex', 'workflows', 'rename-source.json'), '{"secret":true}\n');
    await writeFile(join(root, '.ultracode-for-codex', 'workflows', 'secret\nname.json'), '{"quotedSecret":true}\n');
    await gitLines(root, ['add', 'src/demo.ts', 'src/deleted.ts', 'src/a -> b.ts', 'src/é.ts', 'src/rename-source.ts']);
    await gitLines(root, [
      'add',
      '-f',
      '.ultracode-for-codex/workflows/journal.jsonl',
      '.ultracode-for-codex/workflows/rename-source.json',
      '.ultracode-for-codex/workflows/secret\nname.json',
    ]);
    await gitLines(root, ['commit', '-m', 'add demo']);
    await writeFile(join(root, 'src', 'demo.ts'), [
      'export function value() {',
      '  return 2;',
      '}',
      '',
    ].join('\n'));
    await writeFile(join(root, 'src', 'a -> b.ts'), 'export const arrow = 2;\n');
    await writeFile(join(root, 'src', 'é.ts'), 'export const accent = 2;\n');
    await gitLines(root, ['mv', 'src/rename-source.ts', 'src/renamed -> target.ts']);
    await rm(join(root, 'src', 'deleted.ts'));
    await writeFile(join(root, '.ultracode-for-codex', 'workflows', 'journal.jsonl'), 'runtime state after\n');
    await writeFile(join(root, '.ultracode-for-codex', 'workflows', 'secret\nname.json'), '{"quotedSecret":false}\n');
    await gitLines(root, ['mv', '.ultracode-for-codex/workflows/rename-source.json', 'src/runtime-copy.json']);

    const launch = await runtime.launch({
      script: `export const meta = { name: "review-evidence-context" };
return await workspaceContext({
  query: "src/demo.ts",
  files: ["src/demo.ts"],
  includeDiff: true,
  diffBaseRef: "HEAD~1"
});`,
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.match(snapshot.result, /### Change Evidence/);
    assert.match(snapshot.result, /sourceSnapshotId: git:[0-9a-f]{40}:sha256:[0-9a-f]{64}/);
    assert.match(snapshot.result, /contextHash: sha256:[0-9a-f]{64}/);
    assert.match(snapshot.result, /allowedEvidenceIndexDigest: sha256:[0-9a-f]{64}/);
    assert.match(snapshot.result, /diffBaseRef: HEAD~1/);
    assert.match(snapshot.result, /diff:unstaged:src\/demo\.ts/);
    assert.match(snapshot.result, /file:src\/a -> b\.ts/);
    assert.match(snapshot.result, /file:src\/é\.ts/);
    assert.match(snapshot.result, /file:src\/renamed -> target\.ts/);
    assert.match(snapshot.result, /file:src\/deleted\.ts/);
    assert.match(snapshot.result, /diff:unstaged:src\/deleted\.ts/);
    assert.match(snapshot.result, /hunk:unstaged:src\/demo\.ts:1/);
    assert.match(snapshot.result, /-  return 1;/);
    assert.match(snapshot.result, /### Allowed Evidence Refs/);
    assert.doesNotMatch(snapshot.result, /\.ultracode-for-codex/);
    assert.doesNotMatch(snapshot.result, /runtime-copy\.json/);
    assert.doesNotMatch(snapshot.result, /runtime state after/);
    assert.doesNotMatch(snapshot.result, /quotedSecret/);
  } finally {
    await runtime.close();
  }
});

test('workspaceContext parses raw git status copy paths without delimiter guessing', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend() });
  const oldPath = process.env.PATH;
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'source.ts'), 'export const source = true;\n');
    await writeFile(join(root, 'src', 'auth.ts'), 'export const auth = true;\n');
    await writeFile(join(root, 'src', 'copied -> target.ts'), 'export const copied = true;\n');
    await writeFile(join(root, 'src', 'clean-target.ts'), 'export const cleanTarget = true;\n');
    await withFakeGit(root, `
if (args[0] === 'status' && args.includes('-z')) {
  process.stdout.write(Buffer.concat([
    Buffer.from('C  src/copied -> target.ts\\0src/source.ts\\0'),
    Buffer.from('R  src/'),
    Buffer.from([0xc2, 0x9b]),
    Buffer.from('spoof.ts\\0src/auth.ts\\0'),
    Buffer.from(' M src/'),
    Buffer.from([0xff]),
    Buffer.from('bad.ts\\0'),
    Buffer.from('R  src/clean-target.ts\\0src/'),
    Buffer.from([0xc2, 0x9b]),
    Buffer.from('source.ts\\0')
  ]));
  process.exit(0);
}
`);

    const launch = await runtime.launch({
      script: `export const meta = { name: "review-evidence-copy-status" };
return await workspaceContext({
  query: "copy status",
  includeDiff: true
});`,
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.match(snapshot.result, /file:src\/copied -> target\.ts/);
    assert.match(snapshot.result, /unavailable:git-status-path:2:unsafe-target/);
    assert.match(snapshot.result, /unavailable:git-status-path:3:unsafe-path/);
    assert.match(snapshot.result, /unavailable:git-status-path:4:unsafe-source/);
    assert.doesNotMatch(snapshot.result, /file:src\/clean-target\.ts/);
    assert.doesNotMatch(snapshot.result, /file:src\/auth\.ts/);
    assert.doesNotMatch(snapshot.result, /file:src\/source\.ts/);
    assert.doesNotMatch(snapshot.result, /file:src\/\u009Bspoof\.ts/);
    assert.doesNotMatch(snapshot.result, /file:src\/\uFFFDbad\.ts/);
  } finally {
    process.env.PATH = oldPath;
    await runtime.close();
  }
});

test('workspaceContext bounds a huge git-status list so it cannot balloon every agent prompt (coloso scale fix)', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend() });
  const oldPath = process.env.PATH;
  try {
    await initializeGitRepo(root);
    // Emit a 5000-entry `git status --short` (~140KiB) — the coloso shape: many untracked files.
    await withFakeGit(root, `
if (args[0] === 'status' && args.includes('--short')) {
  let out = '';
  for (let i = 0; i < 5000; i += 1) out += '?? untracked-file-' + i + '.txt\\n';
  process.stdout.write(out);
  process.exit(0);
}
`);
    const launch = await runtime.launch({
      script: 'export const meta = { name: "status-bound" };\nreturn await workspaceContext({ query: "scale" });',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed', snapshot.error);

    // The Git Status section is bounded, not the full 140KiB.
    const ctx = snapshot.result;
    const statusStart = ctx.indexOf('### Git Status');
    const statusEnd = ctx.indexOf('### Included Files');
    const statusSection = ctx.slice(statusStart, statusEnd);
    assert.match(statusSection, /more status entries omitted/);
    assert.ok(Buffer.byteLength(statusSection, 'utf8') <= 40 * 1024, `status section should be bounded, got ${Buffer.byteLength(statusSection, 'utf8')} bytes`);
    // The leading (material) entries are preserved; the tail is dropped.
    assert.match(statusSection, /untracked-file-0\.txt/);
    assert.doesNotMatch(statusSection, /untracked-file-4999\.txt/);
  } finally {
    process.env.PATH = oldPath;
    await runtime.close();
  }
});

test('workspaceContext fallback git status rejects leading control-character paths', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend() });
  const oldPath = process.env.PATH;
  try {
    await initializeGitRepo(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'fallback-safe.txt'), 'safe\n');
    await writeFile(join(root, 'src', 'target -> kept.ts'), 'quoted target\n');
    await writeFile(join(root, ' leading-target.txt'), 'target\n');
    await writeFile(join(root, ' leading.txt'), 'leading\n');
    await withFakeGit(root, `
if (args[0] === 'status' && args.includes('-z')) {
  process.stderr.write('forced raw status failure\\n');
  process.exit(1);
}
if (args[0] === 'status' && args.includes('--short')) {
  process.stdout.write(' M src/fallback-safe.txt\\n M  leading.txt\\n M "\\\\012file:fake.ts"\\nR  "\\\\033old.ts" -> src/fallback-safe.txt\\nR  "src/source -> old.ts" ->  leading-target.txt\\nR  src/source.ts -> src/renamed -> fallback.ts\\nR  src/old.ts -> "src/target -> kept.ts"\\n');
  process.exit(0);
}
`);

    const launch = await runtime.launch({
      script: `export const meta = { name: "review-evidence-fallback-status" };
return await workspaceContext({
  query: "fallback status",
  includeDiff: true
});`,
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.match(snapshot.result, /file:src\/fallback-safe\.txt/);
    assert.match(snapshot.result, /file:src\/target -> kept\.ts/);
    assert.match(snapshot.result, /^file: leading\.txt$/m);
    assert.match(snapshot.result, /^file: leading-target\.txt$/m);
    assert.match(snapshot.result, /unavailable:git-status-raw:failed/);
    assert.match(snapshot.result, /unavailable:git-status-path:3:unsafe-path/);
    assert.match(snapshot.result, /unavailable:git-status-path:4:unsafe-source/);
    assert.match(snapshot.result, /unavailable:git-status-path:6:unsafe-path/);
    assert.match(snapshot.result, /R  "src\/source -> old\.ts" -> " leading-target\.txt"/);
    assert.match(snapshot.result, /R  src\/old\.ts -> "src\/target -> kept\.ts"/);
    assert.doesNotMatch(snapshot.result, /^file:fake\.ts$/m);
    assert.doesNotMatch(snapshot.result, /^file:fallback\.ts$/m);
    assert.doesNotMatch(snapshot.result, /forced raw status failure/);
    assert.doesNotMatch(snapshot.result, /\\012file:fake\.ts/);
    assert.doesNotMatch(snapshot.result, /\\033old\.ts/);
    assert.doesNotMatch(snapshot.result, /src\/renamed -> fallback\.ts/);
  } finally {
    process.env.PATH = oldPath;
    await runtime.close();
  }
});

test('workflow runtime resumes logical-keyed agents after dynamic reorder', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const script = `export const meta = { name: "logical-key-resume" };
const order = Array.isArray(args.order) ? args.order : ["a", "b"];
return await parallel(order.map((id) => () => agent("logical:" + id, {
  label: "logical-" + id,
  key: "logical/" + id
})));`;
    const first = await runtime.launch({
      script,
      args: { order: ['a', 'b'] },
    });
    await collectEvents(runtime, first.taskId);
    assert.deepEqual(jsonValue(runtime.get(first.taskId).result), ['RAW:logical:a', 'RAW:logical:b']);
    assert.equal(backend.requests.length, 2);

    const resumed = await runtime.launch({
      resumeFromRunId: first.runId,
      args: { order: ['b', 'a'] },
    });
    const resumedEvents = await collectEvents(runtime, resumed.taskId);
    const completions = resumedEvents.filter((event) => event.type === 'workflow.agent.completed');
    assert.deepEqual(jsonValue(runtime.get(resumed.taskId).result), ['RAW:logical:b', 'RAW:logical:a']);
    assert.equal(completions.length, 2);
    assert.equal(completions.every((event) => event.cached === true), true);
    assert.equal(backend.requests.length, 2);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime resumes completed logical-keyed agents across registry instances', async () => {
  const backend1 = new FakeSubagentBackend();
  const { runtime: runtime1, root } = await createRuntime({ backend: backend1 });
  const stateDir = join(root, '.ultracode-for-codex');
  const script = `export const meta = { name: "durable-logical-key-resume" };
const order = Array.isArray(args.order) ? args.order : ["a", "b"];
return await parallel(order.map((id) => () => agent("durable:" + id, {
  label: "durable-" + id,
  key: "durable/" + id
})));`;
  let runId;
  let sourceScriptPath;
  let sourceScriptHash;
  try {
    const first = await runtime1.launch({
      script,
      args: { order: ['a', 'b'] },
    });
    await collectEvents(runtime1, first.taskId);
    const snapshot = runtime1.get(first.taskId);
    assert.equal(snapshot.status, 'completed');
    runId = first.runId;
    sourceScriptPath = snapshot.scriptPath;
    sourceScriptHash = snapshot.scriptHash;
    assert.equal(backend1.requests.length, 2);
    const resultRecord = JSON.parse(await readFile(join(stateDir, 'workflows', `${runId}.result.json`), 'utf8'));
    assert.equal(resultRecord.retryInput.scriptPath, snapshot.scriptPath);
    assert.deepEqual(resultRecord.retryInput.args, { order: ['a', 'b'] });
  } finally {
    await runtime1.close();
  }

  const backend2 = new FakeSubagentBackend();
  const runtime2 = new WorkflowTaskRegistry({
    backend: backend2,
    cwd: root,
    stateDir,
    requestTimeoutMs: 30_000,
  });
  try {
    // Edit-and-iterate (PG-ITER) now ALLOWS a single co-supplied source selector with resume
    // (see the dedicated tests below); more than one still fails loud — defense-in-depth for the
    // normalizeLaunchInput scriptPath>name>script precedence that would otherwise silently drop
    // an edit.
    await assertRejectCode(
      () => runtime2.launch({ resumeFromRunId: runId, script: 'export const meta = { name: "two" };', name: 'task' }),
      'workflow_input_invalid',
    );
    const resumed = await runtime2.launch({
      resumeFromRunId: runId,
      args: { order: ['b', 'a'] },
    });
    const resumedEvents = await collectEvents(runtime2, resumed.taskId);
    const completions = resumedEvents.filter((event) => event.type === 'workflow.agent.completed');
    assert.deepEqual(jsonValue(runtime2.get(resumed.taskId).result), ['RAW:durable:b', 'RAW:durable:a']);
    assert.equal(completions.length, 2);
    assert.equal(completions.every((event) => event.cached === true), true);
    assert.equal(backend2.requests.length, 0);

    const resultPath = join(stateDir, 'workflows', `${runId}.result.json`);
    const journalPath = workflowJournalPath(join(stateDir, 'subagents', 'workflows', runId));
    const resultRecord = JSON.parse(await readFile(resultPath, 'utf8'));
    const journalText = await readFile(journalPath, 'utf8');
    const alternateScriptPath = join(stateDir, 'workflows', 'scripts', 'alternate-durable-logical-key-resume.js');
    await writeFile(alternateScriptPath, await readFile(sourceScriptPath, 'utf8'));
    await writeFile(`${alternateScriptPath}.meta.json`, `${JSON.stringify({
      version: 1,
      workflowName: 'durable-logical-key-resume',
      workflowSource: 'project',
      scriptHash: sourceScriptHash,
    }, null, 2)}\n`);
    await writeFile(resultPath, `${JSON.stringify({
      ...resultRecord,
      retryInput: {
        ...resultRecord.retryInput,
        scriptPath: alternateScriptPath,
      },
    }, null, 2)}\n`);
    await assertRejectCode(
      () => runtime2.launch({ resumeFromRunId: runId }),
      'workflow_input_invalid',
    );
    await writeFile(resultPath, `${JSON.stringify(resultRecord, null, 2)}\n`);

    await writeFile(resultPath, `${JSON.stringify({
      ...resultRecord,
      retryInput: {
        scriptPath: resultRecord.retryInput.scriptPath,
      },
    }, null, 2)}\n`);
    const resumedWithJournalArgs = await runtime2.launch({ resumeFromRunId: runId });
    await collectEvents(runtime2, resumedWithJournalArgs.taskId);
    assert.deepEqual(jsonValue(runtime2.get(resumedWithJournalArgs.taskId).result), ['RAW:durable:a', 'RAW:durable:b']);
    assert.equal(backend2.requests.length, 0);
    await writeFile(resultPath, `${JSON.stringify(resultRecord, null, 2)}\n`);

    await writeFile(resultPath, `${JSON.stringify({
      ...resultRecord,
      retryInput: {
        ...resultRecord.retryInput,
        args: { order: ['tampered'] },
      },
    }, null, 2)}\n`);
    await assertRejectCode(
      () => runtime2.launch({ resumeFromRunId: runId }),
      'workflow_input_invalid',
    );
    await writeFile(resultPath, `${JSON.stringify(resultRecord, null, 2)}\n`);

    await writeFile(resultPath, `${JSON.stringify({ ...resultRecord, scriptHash: 'sha256:bad' }, null, 2)}\n`);
    await assertRejectCode(
      () => runtime2.launch({ resumeFromRunId: runId }),
      'workflow_input_invalid',
    );
    await writeFile(resultPath, `${JSON.stringify(resultRecord, null, 2)}\n`);

    // A result record beside a journal whose terminal append was interrupted
    // (kill window) falls through to journal-first discovery and resumes.
    const journalWithoutTerminal = `${journalText.trimEnd().split('\n').slice(0, -1).join('\n')}\n`;
    await writeFile(journalPath, journalWithoutTerminal);
    const resumedInterrupted = await runtime2.launch({ resumeFromRunId: runId });
    const interruptedEvents = await collectEvents(runtime2, resumedInterrupted.taskId);
    assert.deepEqual(jsonValue(runtime2.get(resumedInterrupted.taskId).result), ['RAW:durable:a', 'RAW:durable:b']);
    assert.equal(
      interruptedEvents.filter((event) => event.type === 'workflow.agent.completed' && event.cached === true).length,
      2,
    );
    assert.ok(interruptedEvents.some((event) => event.type === 'workflow.log' && event.message.includes('interrupted')));
    assert.equal(backend2.requests.length, 0);
  } finally {
    await runtime2.close();
  }
});

test('workflow resume with an edited inline script caches the unchanged chained prefix and runs the edit plus downstream live (PG-ITER)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const v1 = 'export const meta = { name: "iter" };\n'
      + 'const a = await agent("A");\n'
      + 'const b = await agent("B");\n'
      + 'return { a, b };';
    const first = await runtime.launch({ script: v1 });
    await collectEvents(runtime, first.taskId);
    assert.equal(runtime.get(first.taskId).status, 'completed');
    assert.equal(backend.requests.length, 2);

    // Edit: a unchanged (cached), b changed (live), c appended (live).
    const v2 = 'export const meta = { name: "iter" };\n'
      + 'const a = await agent("A");\n'
      + 'const b = await agent("B_EDITED");\n'
      + 'const c = await agent("C_NEW");\n'
      + 'return { a, b, c };';
    const resumed = await runtime.launch({ resumeFromRunId: first.runId, script: v2 });
    const events = await collectEvents(runtime, resumed.taskId);
    const completions = events.filter((event) => event.type === 'workflow.agent.completed');

    // The EDITED script executed with native prefix semantics for chained calls.
    assert.deepEqual(jsonValue(runtime.get(resumed.taskId).result), { a: 'RAW:A', b: 'RAW:B_EDITED', c: 'RAW:C_NEW' });
    assert.equal(completions.length, 3);
    assert.equal(completions.filter((event) => event.cached === true).length, 1); // a
    assert.equal(completions.filter((event) => event.cached !== true).length, 2); // b, c
    // MAJOR-3 edit-drop guard: only the two live calls (b, c) reach the backend on resume; the
    // source script was NOT silently resolved (that would be a 0-live 100%-cache-hit no-op that
    // returned the stale { a, b } and never ran c).
    assert.equal(backend.requests.length, 4);
  } finally {
    await runtime.close();
  }
});

test('workflow resume with an edited script reuses a logicalKey call out-of-prefix (documented superset of native) (PG-ITER)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const v1 = 'export const meta = { name: "iter-keyed" };\n'
      + 'const a = await agent("A");\n'
      + 'const b = await agent("B", { key: "kb" });\n'
      + 'return { a, b };';
    const first = await runtime.launch({ script: v1 });
    await collectEvents(runtime, first.taskId);
    assert.equal(backend.requests.length, 2);

    // Edit the chained call a: a runs live and closes the prefix, but the keyed call b keeps its
    // key+prompt+opts so its position-independent call key still exact-key-hits the source result.
    const v2 = 'export const meta = { name: "iter-keyed" };\n'
      + 'const a = await agent("A_EDITED");\n'
      + 'const b = await agent("B", { key: "kb" });\n'
      + 'return { a, b };';
    const resumed = await runtime.launch({ resumeFromRunId: first.runId, script: v2 });
    const events = await collectEvents(runtime, resumed.taskId);
    const completions = events.filter((event) => event.type === 'workflow.agent.completed');

    assert.deepEqual(jsonValue(runtime.get(resumed.taskId).result), { a: 'RAW:A_EDITED', b: 'RAW:B' });
    // b (keyed) is reused from the source even though the prefix closed at the edited a.
    assert.equal(completions.filter((event) => event.cached === true).length, 1);
    assert.equal(backend.requests.length, 3); // only a_edited runs live on resume
  } finally {
    await runtime.close();
  }
});

test('resume with an edited script_path selector is gated by the permission review and does not inherit the source grant (PG-ITER)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  const stateDir = join(root, '.ultracode-for-codex');
  try {
    // Source: a completed inline (ungated) run — its own persisted anchor stays intact.
    const first = await runtime.launch({ script: 'export const meta = { name: "sec-src" };\nreturn await agent("A");' });
    await collectEvents(runtime, first.taskId);
    assert.equal(runtime.get(first.taskId).status, 'completed');
    assert.equal(backend.requests.length, 1);

    // An unreviewed script_path file inside the runtime scripts dir (no sidecar → untrusted, no
    // allow record). script_path is a permission-required source.
    await mkdir(join(stateDir, 'workflows', 'scripts'), { recursive: true });
    const editedPath = join(stateDir, 'workflows', 'scripts', 'sec-edited.js');
    await writeFile(editedPath, 'export const meta = { name: "sec-edited" };\nreturn await agent("A");');

    // Resuming with this script_path routes through the permission gate rather than running
    // under the source run's implicit grant.
    const gated = await runtime.launch({ resumeFromRunId: first.runId, scriptPath: editedPath });
    assert.equal(gated.status, 'permission_required');
    assert.equal(gated.workflowSource, 'script_path');
    // No extra agent ran under a bypassed grant (still just the source's single agent).
    assert.equal(backend.requests.length, 1);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime resumes failed runs and reuses completed agent results beyond the stalled prefix', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const script = `export const meta = { name: "stall-recovery" };
const results = await parallel([
  () => agent("recover:FAIL_ONCE first"),
  () => agent("recover:second"),
  () => agent("recover:third")
]);
if (results[0] === null) throw new Error("first agent failed after siblings completed");
return results;`;
    const first = await runtime.launch({ script });
    await collectEvents(runtime, first.taskId);
    assert.equal(runtime.get(first.taskId).status, 'failed');
    assert.equal(backend.requests.length, 3);

    const resumed = await runtime.launch({ resumeFromRunId: first.runId });
    const events = await collectEvents(runtime, resumed.taskId);
    assert.equal(runtime.get(resumed.taskId).status, 'completed');
    assert.deepEqual(jsonValue(runtime.get(resumed.taskId).result), [
      'RAW:recover:FAIL_ONCE first',
      'RAW:recover:second',
      'RAW:recover:third',
    ]);
    const cached = events.filter((event) => event.type === 'workflow.agent.completed' && event.cached === true);
    assert.equal(cached.length, 2);
    assert.equal(backend.requests.length, 4);
    assert.ok(events.some((event) => (
      event.type === 'workflow.log'
      && event.message.includes('Resuming from')
      && event.message.includes('failed')
      && event.message.includes('2 completed agent result(s)')
    )));
  } finally {
    await runtime.close();
  }
});

test('workflow runtime resumes failed and interrupted runs across registry instances from journal state', async () => {
  const backend1 = new FakeSubagentBackend();
  const { runtime: runtime1, root } = await createRuntime({ backend: backend1 });
  const stateDir = join(root, '.ultracode-for-codex');
  const script = `export const meta = { name: "durable-failure-resume" };
const results = await parallel([
  () => agent("durable-fail:FAIL_ONCE first"),
  () => agent("durable-fail:second"),
  () => agent("durable-fail:third")
]);
if (results[0] === null) throw new Error("first agent failed after siblings completed");
return results;`;
  let runId;
  try {
    const first = await runtime1.launch({ script });
    await collectEvents(runtime1, first.taskId);
    assert.equal(runtime1.get(first.taskId).status, 'failed');
    runId = first.runId;
  } finally {
    await runtime1.close();
  }

  const backend2 = new FakeSubagentBackend();
  const runtime2 = new WorkflowTaskRegistry({
    backend: backend2,
    cwd: root,
    stateDir,
    requestTimeoutMs: 30_000,
  });
  try {
    // Journal-first durable discovery: a failed run has no result record.
    const resumedOnce = await runtime2.launch({ resumeFromRunId: runId });
    const onceEvents = await collectEvents(runtime2, resumedOnce.taskId);
    assert.equal(runtime2.get(resumedOnce.taskId).status, 'failed');
    assert.equal(onceEvents.filter((event) => event.type === 'workflow.agent.completed' && event.cached === true).length, 2);
    assert.equal(backend2.requests.length, 1);

    // Resuming the failed resume completes once the flaky agent recovers.
    const resumedTwice = await runtime2.launch({ resumeFromRunId: resumedOnce.runId });
    await collectEvents(runtime2, resumedTwice.taskId);
    assert.equal(runtime2.get(resumedTwice.taskId).status, 'completed');
    assert.deepEqual(jsonValue(runtime2.get(resumedTwice.taskId).result), [
      'RAW:durable-fail:FAIL_ONCE first',
      'RAW:durable-fail:second',
      'RAW:durable-fail:third',
    ]);

    const journalPath = workflowJournalPath(join(stateDir, 'subagents', 'workflows', runId));
    const journalText = await readFile(journalPath, 'utf8');
    const journalLines = journalText.trimEnd().split('\n');

    // A torn final line (partial JSON, no newline) is dropped as truncated.
    const tornTail = journalLines.at(-1).slice(0, Math.floor(journalLines.at(-1).length / 2));
    await writeFile(journalPath, `${journalLines.slice(0, -1).join('\n')}\n${tornTail}`);
    const resumedTorn = await runtime2.launch({ resumeFromRunId: runId });
    await collectEvents(runtime2, resumedTorn.taskId);
    assert.equal(runtime2.get(resumedTorn.taskId).status, 'completed');

    // A complete-JSON final line missing only its newline was never durably
    // committed and is dropped the same way.
    await writeFile(journalPath, journalText.trimEnd());
    const resumedUnterminated = await runtime2.launch({ resumeFromRunId: runId });
    const unterminatedEvents = await collectEvents(runtime2, resumedUnterminated.taskId);
    assert.equal(runtime2.get(resumedUnterminated.taskId).status, 'completed');
    assert.ok(unterminatedEvents.some((event) => event.type === 'workflow.log' && event.message.includes('interrupted')));

    // A broken hash chain rejects the source fail-loud.
    const tamperedLines = journalLines.map((line) => (
      line.includes('"RAW:durable-fail:second"') ? line.replace('RAW:durable-fail:second', 'RAW:durable-fail:tampered') : line
    ));
    assert.notDeepEqual(tamperedLines, journalLines);
    await writeFile(journalPath, `${tamperedLines.join('\n')}\n`);
    await assertRejectCode(
      () => runtime2.launch({ resumeFromRunId: runId }),
      'workflow_input_invalid',
    );
  } finally {
    await runtime2.close();
  }
});

test('workflow runtime refuses to resume a run whose process is still alive', async () => {
  const backend1 = new FakeSubagentBackend();
  const { runtime: runtime1, root } = await createRuntime({ backend: backend1 });
  const stateDir = join(root, '.ultracode-for-codex');
  const runtime2 = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(),
    cwd: root,
    stateDir,
    requestTimeoutMs: 30_000,
  });
  try {
    const launch = await runtime1.launch({
      script: 'export const meta = { name: "live-run" };\nreturn await agent("WAIT");',
    });
    await waitForEvent(runtime1, launch.taskId, 'workflow.agent.started');
    // runtime2 is a separate registry over the same durable state, standing in
    // for a fresh CLI process; the source run's process (this one) is alive.
    await assertRejectCode(
      () => runtime2.launch({ resumeFromRunId: launch.runId }),
      'workflow_resume_running',
    );
    await runtime1.cancel(launch.taskId);
    await collectEvents(runtime1, launch.taskId);
  } finally {
    await runtime2.close();
    await runtime1.close();
  }
});

test('workflow runtime fails loud on corrupt result records and post-terminal journal bytes', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  const stateDir = join(root, '.ultracode-for-codex');
  const runtime2 = new WorkflowTaskRegistry({
    backend: new FakeSubagentBackend(),
    cwd: root,
    stateDir,
    requestTimeoutMs: 30_000,
  });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "fail-loud-demo" };\nreturn await agent("solo agent");',
    });
    await collectEvents(runtime, launch.taskId);
    assert.equal(runtime.get(launch.taskId).status, 'completed');
    const resultPath = join(stateDir, 'workflows', `${launch.runId}.result.json`);
    const journalPath = workflowJournalPath(join(stateDir, 'subagents', 'workflows', launch.runId));
    const resultText = await readFile(resultPath, 'utf8');
    const journalText = await readFile(journalPath, 'utf8');

    // A result record that exists but cannot be parsed must not be silently
    // ignored in favor of journal-first discovery.
    await writeFile(resultPath, 'not json');
    await assertRejectCode(
      () => runtime2.launch({ resumeFromRunId: launch.runId }),
      'workflow_input_invalid',
    );
    await writeFile(resultPath, resultText);

    // Bytes after the terminal entry are external interference; the completed
    // source must not be rescued through journal-first discovery.
    await writeFile(journalPath, `${journalText}{"partial`);
    await assertRejectCode(
      () => runtime2.launch({ resumeFromRunId: launch.runId }),
      'workflow_input_invalid',
    );
    await writeFile(journalPath, journalText);
  } finally {
    await runtime2.close();
    await runtime.close();
  }
});

test('workflow retry resumes the failed run and reuses completed agent results', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const script = `export const meta = { name: "retry-reuses-cache" };
const results = await parallel([
  () => agent("retry-cache:FAIL_ONCE first"),
  () => agent("retry-cache:second"),
  () => agent("retry-cache:third")
]);
if (results[0] === null) throw new Error("first agent failed after siblings completed");
return results;`;
    const first = await runtime.launch({ script });
    await collectEvents(runtime, first.taskId);
    assert.equal(runtime.get(first.taskId).status, 'failed');
    assert.equal(backend.requests.length, 3);

    const retried = await runtime.retry(first.taskId);
    const events = await collectEvents(runtime, retried.taskId);
    assert.equal(runtime.get(retried.taskId).status, 'completed');
    assert.equal(events.filter((event) => event.type === 'workflow.agent.completed' && event.cached === true).length, 2);
    assert.equal(backend.requests.length, 4);
  } finally {
    await runtime.close();
  }
});

test('workflow agents reject duplicate logical keys at reservation time', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "dup-key" };\nawait agent("first keyed", { key: "dup" });\nreturn await agent("second keyed", { key: "dup" });',
    });
    const events = await collectEvents(runtime, launch.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');
    assert.match(runtime.get(launch.taskId).error, /already used/);
    assert.equal(backend.requests.length, 1);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime warns when a resume runs under a different backend model', async () => {
  const backend1 = new FakeSubagentBackend();
  const { runtime: runtime1, root } = await createRuntime({ backend: backend1 });
  const stateDir = join(root, '.ultracode-for-codex');
  let runId;
  try {
    const launch = await runtime1.launch({
      script: 'export const meta = { name: "model-mismatch" };\nawait agent("model:kept");\nreturn await agent("model:FAIL_AGENT tail");',
    });
    await collectEvents(runtime1, launch.taskId);
    assert.equal(runtime1.get(launch.taskId).status, 'failed');
    runId = launch.runId;
  } finally {
    await runtime1.close();
  }

  const backend2 = new FakeSubagentBackend();
  backend2.model = 'fake-model-b';
  const runtime2 = new WorkflowTaskRegistry({
    backend: backend2,
    cwd: root,
    stateDir,
    requestTimeoutMs: 30_000,
  });
  try {
    const resumed = await runtime2.launch({ resumeFromRunId: runId });
    const events = await collectEvents(runtime2, resumed.taskId);
    assert.ok(events.some((event) => event.type === 'workflow.log' && event.message.includes('Resume model mismatch')));
    assert.equal(events.filter((event) => event.type === 'workflow.agent.completed' && event.cached === true).length, 0);
  } finally {
    await runtime2.close();
  }
});

test('workflow runtime discloses workspace drift on resume without blocking cache reuse', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    // README.md is tracked and already dirty before the source run, so only
    // its CONTENT changes between the runs — the status listing is identical.
    await writeFile(join(root, 'README.md'), '# worktree fixture\ndirty before the run\n');
    const launch = await runtime.launch({
      script: 'export const meta = { name: "drift-demo" };\nawait agent("drift:kept");\nreturn await agent("drift:FAIL_ONCE tail");',
    });
    await collectEvents(runtime, launch.taskId);
    assert.equal(runtime.get(launch.taskId).status, 'failed');

    await writeFile(join(root, 'README.md'), '# worktree fixture\ndirty with different content\n');

    const resumed = await runtime.launch({ resumeFromRunId: launch.runId });
    const events = await collectEvents(runtime, resumed.taskId);
    assert.equal(runtime.get(resumed.taskId).status, 'completed');
    assert.ok(events.some((event) => event.type === 'workflow.log' && event.message.includes('Workspace changed')));
    assert.equal(events.filter((event) => event.type === 'workflow.agent.completed' && event.cached === true).length, 1);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime accepts cancelled runs as resume sources and surfaces the abort reason', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "cancel-resume" };\nawait agent("done early");\nreturn await agent(String(args && args.tail ? args.tail : "WAIT"));',
    });
    await waitForEvent(runtime, launch.taskId, 'workflow.agent.completed');
    await runtime.cancel(launch.taskId);
    await collectEvents(runtime, launch.taskId);
    assert.equal(runtime.get(launch.taskId).status, 'failed');

    const resumed = await runtime.launch({ resumeFromRunId: launch.runId, args: { tail: 'tail done' } });
    const events = await collectEvents(runtime, resumed.taskId);
    assert.equal(runtime.get(resumed.taskId).status, 'completed');
    assert.equal(jsonValue(runtime.get(resumed.taskId).result), 'RAW:tail done');
    assert.ok(events.some((event) => event.type === 'workflow.log' && event.message.includes('workflow_aborted')));
    assert.equal(events.filter((event) => event.type === 'workflow.agent.completed' && event.cached === true).length, 1);
  } finally {
    await runtime.close();
  }
});

test('built-in task uses planner-selected single execution only when parallel work is wasteful', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: { defaultReasoningEffort: 'high' },
  });
  try {
    const launch = await runtime.launch({
      name: 'task',
      args: { prompt: 'SINGLE_EXECUTION inspect one already isolated line.' },
    });
    const events = await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.equal(backend.requests.length, 2);
    assert.equal(backend.maxActiveRequests, 1);
    const planEvent = events.find((event) => event.type === 'workflow.plan.ready');
    assert.equal(planEvent.mode, 'single');
    assert.equal(planEvent.phases.length, 1);
    assert.deepEqual(planEvent.phases[0].agents.map((agent) => agent.label), ['task-single']);
    const labels = events
      .filter((event) => event.type === 'workflow.agent.started')
      .map((event) => event.label);
    assert.deepEqual(labels, ['task-planner', 'task-single']);
    assert.deepEqual(backend.requests.map((request) => request.reasoningEffort), ['medium', 'high']);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime handles project workflow permission allow and deny locally', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    await mkdir(join(root, '.codex', 'workflows'), { recursive: true });
    await writeFile(join(root, '.codex', 'workflows', 'allow-demo.js'), [
      'export const meta = { name: "allow-demo" };',
      'return { allowed: args.value };',
    ].join('\n'));
    await writeFile(join(root, '.codex', 'workflows', 'deny-demo.js'), [
      'export const meta = { name: "deny-demo" };',
      'return "denied should not run";',
    ].join('\n'));

    const needsPermission = await runtime.launch({ name: 'allow-demo', args: { value: 7 } });
    assert.equal(needsPermission.status, 'permission_required');
    assert.equal(needsPermission.workflowSource, 'project');
    assert.equal(Object.hasOwn(needsPermission, 'allowUrl'), false);
    assert.equal(Object.hasOwn(needsPermission, 'denyUrl'), false);

    const allowed = await runtime.approvePermissionRequest(needsPermission.permissionRequestId);
    assert.equal(allowed.status, 'async_launched');
    await collectEvents(runtime, allowed.taskId);
    assert.deepEqual(runtime.get(allowed.taskId).result, { allowed: 7 });

    const denyPermission = await runtime.launch({ name: 'deny-demo' });
    assert.equal(denyPermission.status, 'permission_required');
    const denied = await runtime.denyPermissionRequest(denyPermission.permissionRequestId);
    assert.equal(denied.status, 'permission_denied');
    assert.equal(denied.reason, 'workflow_permission_denied');
  } finally {
    await runtime.close();
  }
});

test('workflow runtime supports retry, cancellation, and stalled-agent retry caps', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: { agentStallTimeoutMs: 25, agentStallRetryLimit: 1, requestTimeoutMs: 1_000 },
  });
  try {
    const failOnce = await runtime.launch({
      script: 'export const meta = { name: "retry-demo" };\nreturn await agent("FAIL_ONCE");',
    });
    await collectEvents(runtime, failOnce.taskId);
    assert.equal(runtime.get(failOnce.taskId).status, 'failed');

    const retried = await runtime.retry(failOnce.taskId);
    await collectEvents(runtime, retried.taskId);
    assert.equal(runtime.get(retried.taskId).status, 'completed');
    assert.equal(runtime.get(retried.taskId).result, 'RAW:FAIL_ONCE');

    const stallRecover = await runtime.launch({
      script: 'export const meta = { name: "stall-recover" };\nreturn await agent("STALL_ONCE");',
    });
    await collectEvents(runtime, stallRecover.taskId);
    const stallSnapshot = runtime.get(stallRecover.taskId);
    assert.equal(stallSnapshot.status, 'completed');
    assert.ok(stallSnapshot.events.some((event) => event.type === 'workflow.log' && /stalled; retrying/.test(event.message)));

    const cancelLaunch = await runtime.launch({
      script: 'export const meta = { name: "cancel-demo" };\nawait agent("WAIT");\nreturn "never";',
    });
    await waitForEvent(runtime, cancelLaunch.taskId, 'workflow.agent.started');
    const cancelled = await runtime.cancel(cancelLaunch.taskId);
    assert.equal(cancelled.status, 'failed');
    assert.equal(cancelled.failureReason, 'workflow_aborted');
  } finally {
    await runtime.close();
  }
});

test('workflow runtime does not divide default agent stall timeout by retry budget', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: { requestTimeoutMs: 300 },
  });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "silent-agent-budget" };
const timeout = budget.agentStallTimeoutMs;
const result = await agent("SILENT_75MS");
return { timeout, result };`,
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.deepEqual(snapshot.result, {
      timeout: 300,
      result: 'RAW:SILENT_75MS',
    });
    assert.equal(snapshot.events.some((event) => event.type === 'workflow.log' && /stalled; retrying/.test(event.message)), false);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime can wait for agent completion without a timeout deadline', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: { requestTimeoutMs: 0 },
  });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "no-timeout-agent" };
const timeout = budget.agentStallTimeoutMs;
const result = await agent("SILENT_75MS");
return { timeout, result };`,
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.deepEqual(snapshot.result, {
      timeout: 0,
      result: 'RAW:SILENT_75MS',
    });
    assert.equal(snapshot.events.some((event) => event.type === 'workflow.log' && /stalled; retrying/.test(event.message)), false);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime resumes completed runs with cached agent prefix hits', async () => {
  const { runtime } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const first = await runtime.launch({
      script: `export const meta = { name: "resume-demo" };
const one = await agent("one");
const two = await agent("two");
return { one, two };`,
    });
    await collectEvents(runtime, first.taskId);
    const firstSnapshot = runtime.get(first.taskId);
    assert.equal(firstSnapshot.status, 'completed');

    const resumed = await runtime.launch({ resumeFromRunId: first.runId });
    const events = await collectEvents(runtime, resumed.taskId);
    const completions = events.filter((event) => event.type === 'workflow.agent.completed');
    assert.equal(completions.length, 2);
    assert.equal(completions.every((event) => event.cached === true), true);
    assert.deepEqual(runtime.get(resumed.taskId).result, firstSnapshot.result);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime preserves changed worktree-isolated agents for review', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend() });
  let preservedPath;
  try {
    await initializeGitRepo(root);
    const launch = await runtime.launch({
      script: 'export const meta = { name: "worktree-preserve" };\nreturn await agent("WRITE_WORKTREE", { isolation: "worktree" });',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    const completed = snapshot.events.find((event) => event.type === 'workflow.agent.completed');
    assert.equal(completed.worktreePreserved, true);
    preservedPath = completed.worktreePath;
    assert.equal(typeof preservedPath, 'string');
    assert.equal(await fileExists(join(preservedPath, 'agent-change.txt')), true);
  } finally {
    if (preservedPath) {
      await gitLines(root, ['worktree', 'remove', '--force', preservedPath]).catch(async () => {
        await rm(preservedPath, { recursive: true, force: true });
      });
    }
    await runtime.close();
  }
});

test('workflow runtime preserve-all opts out and retains a clean worktree for review', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { worktreeRetention: 'preserve-all' } });
  let preservedPath;
  try {
    await initializeGitRepo(root);
    const launch = await runtime.launch({
      script: 'export const meta = { name: "worktree-preserve-clean" };\nreturn await agent("READ_ONLY_WORKTREE", { isolation: "worktree" });',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    const completed = snapshot.events.find((event) => event.type === 'workflow.agent.completed');
    assert.equal(completed.worktreePreserved, true);
    preservedPath = completed.worktreePath;
    assert.equal(typeof preservedPath, 'string');
    assert.equal(await fileExists(preservedPath), true);
    assert.equal(completed.preservedWorktrees[0].reason, 'clean');
  } finally {
    if (preservedPath) {
      await gitLines(root, ['worktree', 'remove', '--force', preservedPath]).catch(async () => {
        await rm(preservedPath, { recursive: true, force: true });
      });
    }
    await runtime.close();
  }
});

test('workflow runtime reclaims a clean completed worktree by default', async () => {
  const backend = new FakeSubagentBackend();
  // No retention option: this pins the shipped default, which is remove-clean.
  const { runtime, root } = await createRuntime({ backend });
  try {
    await initializeGitRepo(root);
    const launch = await runtime.launch({
      script: 'export const meta = { name: "worktree-remove-clean" };\nreturn await agent("READ_ONLY_WORKTREE", { isolation: "worktree" });',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    // Isolation actually ran (subject cardinality > 0), so the removal assertion is non-vacuous.
    const worktreePath = backend.requests[0].worktreePath;
    assert.equal(typeof worktreePath, 'string');
    assert.equal(await fileExists(worktreePath), false);
    const completed = snapshot.events.find((event) => event.type === 'workflow.agent.completed');
    assert.notEqual(completed.worktreePreserved, true);
  } finally {
    await runtime.close();
  }
});

test('workflow runtime remove-clean preserves a changed worktree', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend, runtimeOptions: { worktreeRetention: 'remove-clean' } });
  let preservedPath;
  try {
    await initializeGitRepo(root);
    const launch = await runtime.launch({
      script: 'export const meta = { name: "worktree-remove-clean-changed" };\nreturn await agent("WRITE_WORKTREE", { isolation: "worktree" });',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    const completed = snapshot.events.find((event) => event.type === 'workflow.agent.completed');
    assert.equal(completed.worktreePreserved, true);
    preservedPath = completed.worktreePath;
    assert.equal(await fileExists(join(preservedPath, 'agent-change.txt')), true);
    assert.equal(completed.preservedWorktrees[0].reason, 'changed');
  } finally {
    if (preservedPath) {
      await gitLines(root, ['worktree', 'remove', '--force', preservedPath]).catch(async () => {
        await rm(preservedPath, { recursive: true, force: true });
      });
    }
    await runtime.close();
  }
});

test('workflow runtime remove-clean reclaims an ignored-only worktree (native unchanged parity)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend, runtimeOptions: { worktreeRetention: 'remove-clean' } });
  try {
    await initializeGitRepo(root);
    // Commit a .gitignore so the isolated worktree (checked out from HEAD) treats build/ as ignored.
    await writeFile(join(root, '.gitignore'), 'build/\n');
    await gitLines(root, ['add', '.gitignore']);
    await gitLines(root, ['commit', '-m', 'ignore build']);
    const launch = await runtime.launch({
      script: 'export const meta = { name: "worktree-remove-ignored" };\nreturn await agent("WRITE_IGNORED_WORKTREE", { isolation: "worktree" });',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    const worktreePath = backend.requests[0].worktreePath;
    assert.equal(typeof worktreePath, 'string');
    // Ignored-only content is "unchanged" to `git worktree remove`, so it is reclaimed.
    assert.equal(await fileExists(worktreePath), false);
    const completed = snapshot.events.find((event) => event.type === 'workflow.agent.completed');
    assert.notEqual(completed.worktreePreserved, true);
  } finally {
    await runtime.close();
  }
});

test('agentConcurrency bounds concurrent dispatch across a parallel() burst (DW-A1)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend, runtimeOptions: { agentConcurrency: 1 } });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "pool-bound" };\n'
        + 'return await parallel([() => agent("SILENT_75MS a"), () => agent("SILENT_75MS b"), () => agent("SILENT_75MS c")]);',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    // Cardinality guard: a pool that dispatched nothing would pass a bound check vacuously.
    assert.equal(backend.requests.length, 3);
    assert.equal(backend.maxActiveRequests, 1, 'pool size 1 must serialize agent dispatch');
  } finally {
    await runtime.close();
  }
});

test('agentConcurrency unbounded (landing default) leaves parallel() dispatch concurrent (DW-A2 contrast)', async () => {
  const backend = new FakeSubagentBackend();
  // No agentConcurrency option => no pool => current behavior.
  const { runtime } = await createRuntime({ backend });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "pool-off" };\n'
        + 'return await parallel([() => agent("SILENT_75MS a"), () => agent("SILENT_75MS b"), () => agent("SILENT_75MS c")]);',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.equal(backend.requests.length, 3);
    // Negative control for DW-A1: without a pool the same burst runs concurrently.
    assert.equal(backend.maxActiveRequests, 3, 'no pool must not serialize dispatch');
  } finally {
    await runtime.close();
  }
});

test('agentConcurrency holds the permit until the real dispatch settles, not the abort race (DW-A6)', async () => {
  // A backend whose first dispatch ignores its abort signal and stays live past the
  // stall timeout. The pool must keep that permit held until generate() actually
  // settles; releasing on the abort race would let the stall-retry's dispatch start
  // while the first is still in flight -- pushing live dispatches to 2 on a size-1 pool.
  class LingerBackend {
    name = 'linger-backend';
    model = 'fake-model';
    live = 0;
    maxLive = 0;
    calls = 0;
    async generate() {
      this.calls += 1;
      const call = this.calls;
      this.live += 1;
      this.maxLive = Math.max(this.maxLive, this.live);
      try {
        if (call === 1) await sleep(140); // ignore abort; linger well past the 40ms stall timeout
        return subagentResult({ text: `ok-${call}` });
      } finally {
        this.live -= 1;
      }
    }
    async close() {}
  }
  const backend = new LingerBackend();
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: { agentConcurrency: 1, agentStallTimeoutMs: 40, agentStallRetryLimit: 1 },
  });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "pool-honest-abort" };\nreturn await agent("linger please");',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.result, 'ok-2', 'the stall retry should have produced the second dispatch');
    assert.equal(backend.calls, 2, 'attempt 1 stalled and attempt 2 retried');
    assert.equal(backend.maxLive, 1, 'permit must be held until the real dispatch settles; releasing on the abort race would allow 2');
  } finally {
    await runtime.close();
  }
});

test('permit waiting does not count toward the agent stall timeout (DW-A3)', async () => {
  const backend = new FakeSubagentBackend();
  // Pool size 1 serializes 3 agents that each work ~75ms. Total serialized time (~225ms)
  // exceeds the 150ms stall timeout, but no single agent's WORK does. If permit waiting
  // counted toward the stall clock the later agents would stall; acquiring before the
  // timer starts means each agent's clock covers only its own dispatch.
  const { runtime } = await createRuntime({
    backend,
    runtimeOptions: { agentConcurrency: 1, agentStallTimeoutMs: 150 },
  });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "pool-stall-isolation" };\n'
        + 'return await parallel([() => agent("SILENT_75MS a"), () => agent("SILENT_75MS b"), () => agent("SILENT_75MS c")]);',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed', 'serialized agents must not stall while waiting for a permit');
    assert.equal(backend.requests.length, 3);
    assert.equal(backend.maxActiveRequests, 1);
    assert.equal(snapshot.events.some((event) => event.type === 'workflow.log' && /stalled/.test(event.message)), false);
  } finally {
    await runtime.close();
  }
});

test('cancelling a workflow settles queued permit waiters without hanging (DW-A4)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend, runtimeOptions: { agentConcurrency: 1 } });
  try {
    // Pool size 1: the first WAIT agent holds the permit (it never resolves until abort);
    // the other two queue on it. Cancelling must settle the queued waiters and terminate --
    // a leaked/unsettled waiter would hang this await forever.
    const launch = await runtime.launch({
      script: 'export const meta = { name: "pool-cancel" };\n'
        + 'return await parallel([() => agent("WAIT a"), () => agent("WAIT b"), () => agent("WAIT c")]);',
    });
    await waitForEvent(runtime, launch.taskId, 'workflow.agent.started');
    const cancelled = await runtime.cancel(launch.taskId);
    assert.equal(cancelled.status, 'failed');
    assert.equal(cancelled.failureReason, 'workflow_aborted');
  } finally {
    await runtime.close();
  }
});

class ClassifiedFailureBackend {
  name = 'classified-failure';
  model = 'fake-model';
  constructor(failure) { this.failure = failure; }
  async generate() { throw this.failure; }
  async close() {}
}

test('a terminal backend failure fails the workflow non-retryably (DW-C2)', async () => {
  const backend = new ClassifiedFailureBackend(new SubagentFailure('you are not authorized', 'terminal', 'unauthorized', true));
  const { runtime } = await createRuntime({ backend });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "terminal-failure" };\nreturn await agent("go");',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.failureReason, 'workflow_agent_terminal');
    assert.equal(isRetryableFailureReason(snapshot.failureReason), false, 'a terminal backend failure must not be retryable');
    // The provider message survives classification (no JSON.stringify flattening).
    assert.match(snapshot.error, /you are not authorized/);
  } finally {
    await runtime.close();
  }
});

test('a transient backend failure stays retryable, preserving current behavior (DW-C2 contrast)', async () => {
  const backend = new ClassifiedFailureBackend(new SubagentFailure('server overloaded', 'transient', 'serverOverloaded', true));
  const { runtime } = await createRuntime({ backend });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "transient-failure" };\nreturn await agent("go");',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.failureReason, 'workflow_agent_failed');
    assert.equal(isRetryableFailureReason(snapshot.failureReason), true, 'a transient backend failure stays retryable');
  } finally {
    await runtime.close();
  }
});

test('an unclassified backend failure emits an observability log and stays retryable (DW-C6)', async () => {
  const backend = new ClassifiedFailureBackend(new SubagentFailure('mystery', 'transient', 'someFutureVariant', false));
  const { runtime } = await createRuntime({ backend });
  try {
    const launch = await runtime.launch({
      script: 'export const meta = { name: "unclassified-failure" };\nreturn await agent("go");',
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.failureReason, 'workflow_agent_failed');
    const logged = snapshot.events.some((event) =>
      event.type === 'workflow.log' && /unclassified backend failure \(variant: someFutureVariant\)/.test(event.message));
    assert.ok(logged, 'an unrecognized failure variant must surface a distinguishable log');
  } finally {
    await runtime.close();
  }
});

test('budget is inert and enumeration-identical whether or not a ceiling is set (DW-B1)', async () => {
  // The sandbox exposes no Object, so a script can only observe budget's keys via for-in
  // (or spread) — both of which see own-enumerable properties, so this is the real test of
  // whether total/spent/remaining stay hidden.
  const script = `export const meta = { name: "budget-shape" };
const keys = [];
for (const key in budget) keys.push(key);
return { keys, total: budget.total, remainingIsInfinity: budget.remaining() === Infinity, spent: budget.spent() };`;
  const expectedKeys = ['maxAgentCalls', 'maxParallelism', 'agentConcurrency', 'agentStallTimeoutMs', 'agentStallRetryLimit'];

  const off = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    const launch = await off.runtime.launch({ script });
    await collectEvents(off.runtime, launch.taskId);
    const result = jsonValue(off.runtime.get(launch.taskId).result);
    assert.deepEqual(result.keys, expectedKeys);
    assert.equal(result.total, null);
    assert.equal(result.remainingIsInfinity, true);
    assert.equal(result.spent, 0);
  } finally {
    await off.runtime.close();
  }

  const on = await createRuntime({ backend: new FakeSubagentBackend(), runtimeOptions: { budgetTotal: 500 } });
  try {
    const launch = await on.runtime.launch({ script });
    await collectEvents(on.runtime, launch.taskId);
    const result = jsonValue(on.runtime.get(launch.taskId).result);
    // total/spent/remaining are non-enumerable, so the key set is byte-identical when on.
    assert.deepEqual(result.keys, expectedKeys);
    assert.equal(result.total, 500);
    assert.equal(result.remainingIsInfinity, false);
    assert.equal(result.spent, 0);
  } finally {
    await on.runtime.close();
  }
});

test('an output-token budget refuses further agent dispatch once exhausted (DW-B2)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend, runtimeOptions: { budgetTotal: 3 } });
  try {
    // Each fake agent spends outputTokens=2. total=3: agent0 (spent 0->2), agent1 (2->4),
    // agent2 is refused pre-dispatch because spent 4 >= 3.
    const launch = await runtime.launch({
      script: `export const meta = { name: "budget-ceiling" };
const out = [];
for (let i = 0; i < 5; i += 1) out.push(await agent("agent " + i));
return out.length;`,
    });
    const events = await collectEvents(runtime, launch.taskId);
    assert.equal(events.at(-1).type, 'workflow.failed');
    assert.equal(events.at(-1).recovery.reason, 'workflow_input_invalid');
    assert.equal(events.at(-1).recovery.retryable, false);
    assert.equal(isRetryableFailureReason('workflow_input_invalid'), false);
    assert.equal(backend.requests.length, 2, 'the exhausting agent is refused before it reaches the backend');
    assert.match(runtime.get(launch.taskId).error, /budget exhausted/);
  } finally {
    await runtime.close();
  }
});

test('a budget larger than the run never throws (DW-B2 negative control)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend, runtimeOptions: { budgetTotal: 1000 } });
  try {
    const launch = await runtime.launch({
      script: `export const meta = { name: "budget-headroom" };
const out = [];
for (let i = 0; i < 5; i += 1) out.push(await agent("agent " + i));
return out.length;`,
    });
    await collectEvents(runtime, launch.taskId);
    const snapshot = runtime.get(launch.taskId);
    assert.equal(snapshot.status, 'completed');
    assert.equal(jsonValue(snapshot.result), 5);
    assert.equal(backend.requests.length, 5);
  } finally {
    await runtime.close();
  }
});

test('spent() counts this run only; cached agents contribute 0 on resume (DW-B3)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
  try {
    const script = `export const meta = { name: "budget-per-run" };
await agent("solo");
return budget.spent();`;
    const first = await runtime.launch({ script });
    await collectEvents(runtime, first.taskId);
    assert.equal(jsonValue(runtime.get(first.taskId).result), 2, 'fresh run: one agent spent 2 output tokens');
    assert.equal(backend.requests.length, 1);

    const resumed = await runtime.launch({ resumeFromRunId: first.runId });
    const events = await collectEvents(runtime, resumed.taskId);
    const completions = events.filter((event) => event.type === 'workflow.agent.completed');
    assert.equal(completions.length, 1);
    assert.equal(completions.every((event) => event.cached === true), true, 'the resumed agent must be a cache hit (cardinality > 0)');
    assert.equal(jsonValue(runtime.get(resumed.taskId).result), 0, 'per-run semantics: a cached agent contributes 0 to spent()');
    assert.equal(backend.requests.length, 1, 'no re-dispatch on resume');
  } finally {
    await runtime.close();
  }
});

test('an exhausted budget inside parallel() becomes a per-item null, not a run failure (G-B2)', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend, runtimeOptions: { budgetTotal: 3 } });
  try {
    // Two sequential agents spend to 4 >= 3; the parallel batch is then all refused, and
    // parallel() converts each per-item throw to null instead of failing the run.
    const launch = await runtime.launch({
      script: `export const meta = { name: "budget-parallel-null" };
await agent("warm 0");
await agent("warm 1");
return await parallel([() => agent("p0"), () => agent("p1")]);`,
    });
    const events = await collectEvents(runtime, launch.taskId);
    assert.equal(events.at(-1).type, 'workflow.completed');
    assert.deepEqual(jsonValue(runtime.get(launch.taskId).result), [null, null]);
    assert.equal(backend.requests.length, 2, 'only the two warm-up agents reach the backend');
  } finally {
    await runtime.close();
  }
});

test('the registry rejects an invalid budgetTotal at its boundary, like agentConcurrency', () => {
  const backend = new FakeSubagentBackend();
  for (const bad of [-1, 0, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new WorkflowTaskRegistry({ backend, requestTimeoutMs: 30_000, budgetTotal: bad }),
      /budgetTotal must be/,
      `registry should reject budgetTotal ${String(bad)}`,
    );
  }
  for (const ok of [null, undefined, 1, 500000]) {
    assert.doesNotThrow(() => new WorkflowTaskRegistry({ backend, requestTimeoutMs: 30_000, budgetTotal: ok }));
  }
});








async function createRuntime({ backend, runtimeOptions = {} }) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-runtime-'));
  tempDirs.push(root);
  return {
    root,
    runtime: new WorkflowTaskRegistry({
      backend,
      cwd: root,
      stateDir: join(root, '.ultracode-for-codex'),
      requestTimeoutMs: runtimeOptions.requestTimeoutMs ?? 30_000,
      defaultReasoningEffort: runtimeOptions.defaultReasoningEffort,
      agentStallTimeoutMs: runtimeOptions.agentStallTimeoutMs,
      agentStallRetryLimit: runtimeOptions.agentStallRetryLimit,
      heartbeatMs: runtimeOptions.heartbeatMs,
      worktreeRetention: runtimeOptions.worktreeRetention,
      agentConcurrency: runtimeOptions.agentConcurrency,
      budgetTotal: runtimeOptions.budgetTotal,
      nestedWorkflows: runtimeOptions.nestedWorkflows,
      agentTypes: runtimeOptions.agentTypes,
      builtinWorkflows: runtimeOptions.builtinWorkflows,
      evidenceScope: runtimeOptions.evidenceScope,
      refPolicy: runtimeOptions.refPolicy,
      journalDurability: runtimeOptions.journalDurability,
    }),
  };
}

class FakeSubagentBackend {
  name = 'fake-subagent';
  model = 'fake-model';
  requests = [];
  activeRequests = 0;
  maxActiveRequests = 0;
  #stallCounts = new Map();
  #failOnceCounts = new Map();

  async generate(request, signal) {
    this.activeRequests += 1;
    this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
    try {
      return await this.#generateInner(request, signal);
    } finally {
      this.activeRequests -= 1;
    }
  }

  async #generateInner(request, signal) {
    this.requests.push(request);
    const prompt = request.messages.map((message) => message.content).join('\n\n');
    const workflowPrompt = stripWorktreeContext(prompt);
    if (workflowPrompt.includes('FAIL_ONCE')) {
      const count = this.#failOnceCounts.get(workflowPrompt) ?? 0;
      this.#failOnceCounts.set(workflowPrompt, count + 1);
      if (count === 0) throw new Error('backend failure once');
    }
    if (workflowPrompt.includes('FAIL_AGENT')) throw new Error('backend failure');
    if (workflowPrompt.includes('WAIT')) return await neverUntilAbort(signal);
    if (workflowPrompt.includes('SILENT_75MS')) await sleep(75);
    if (workflowPrompt.includes('STALL_ONCE')) {
      const count = this.#stallCounts.get(workflowPrompt) ?? 0;
      this.#stallCounts.set(workflowPrompt, count + 1);
      if (count === 0) return await neverUntilAbort(signal);
    }
    if (workflowPrompt.includes('WRITE_IGNORED_WORKTREE')) {
      assert.equal(typeof request.worktreePath, 'string');
      await mkdir(join(request.worktreePath, 'build'), { recursive: true });
      await writeFile(join(request.worktreePath, 'build', 'artifact.txt'), 'ignored build output\n');
    } else if (workflowPrompt.includes('WRITE_WORKTREE')) {
      assert.equal(typeof request.worktreePath, 'string');
      await writeFile(join(request.worktreePath, 'agent-change.txt'), 'changed\n');
    }
    if (request.toolChoice.type === 'required') {
      const schema = request.tools[0].inputSchema;
      if (isPhasePlanSchema(schema)) {
        return subagentResult({
          text: '',
          toolCalls: [{
            id: 'call_phase_plan',
            name: request.tools[0].name,
            arguments: JSON.stringify(fakePhasePlan(workflowPrompt)),
          }],
        });
      }
      if (isReviewScopeSchema(schema)) {
        return structuredToolResult(fakeReviewScope(workflowPrompt));
      }
      if (isReviewFinderSchema(schema)) {
        if (/Code-review Finder[\s\S]*Lens key: security-boundary/.test(workflowPrompt)) await sleep(80);
        return structuredToolResult(fakeReviewFinder(workflowPrompt));
      }
      if (isReviewVerifierSchema(schema)) {
        return structuredToolResult(fakeReviewVerifier(workflowPrompt));
      }
      if (isReviewSynthesisSchema(schema)) {
        return structuredToolResult(fakeReviewSynthesis());
      }
      return subagentResult({
        text: '',
        toolCalls: [{
          id: 'call_structured',
          name: request.tools[0].name,
          arguments: JSON.stringify({ detail: 'structured', count: 2 }),
        }],
      });
    }
    if (workflowPrompt.includes('Parallel phase agent:')) await sleep(25);
    return subagentResult({ text: `RAW:${workflowPrompt}` });
  }

  async close() {}
}

function isPhasePlanSchema(schema) {
  return Boolean(schema?.properties?.phases);
}

function isReviewScopeSchema(schema) {
  return Boolean(schema?.properties?.lensDecisions && schema?.properties?.lenses && schema?.properties?.files);
}

function isReviewFinderSchema(schema) {
  return Boolean(schema?.properties?.candidates);
}

function isReviewVerifierSchema(schema) {
  return Boolean(schema?.properties?.verdict && schema?.properties?.evidenceRefs);
}

function isReviewSynthesisSchema(schema) {
  return Boolean(schema?.properties?.decisions && schema?.properties?.summary);
}

function fakePhasePlan(prompt) {
  if (prompt.includes('SINGLE_EXECUTION')) {
    return {
      mode: 'single',
      rationale: 'The requested work is tiny and indivisible.',
      phases: [{
        id: 'single',
        title: 'Single',
        goal: 'Inspect the isolated request.',
        agents: [{
          id: 'focused',
          title: 'Focused Worker',
          focus: 'Handle the isolated task without parallel overhead.',
        }],
      }],
    };
  }
  return {
    mode: 'phase_parallel',
    rationale: 'Default to phase-wise parallel execution for faster and more accurate work.',
    phases: [
      {
        id: 'discovery',
        title: 'Discovery',
        goal: 'Find material risks and implementation evidence.',
        agents: [
          { id: 'runtime', title: 'Runtime', focus: 'Check workflow runtime behavior and failure semantics.' },
          { id: 'security', title: 'Security', focus: 'Check capability boundaries and sensitive data exposure.' },
        ],
      },
      {
        id: 'validation',
        title: 'Validation',
        goal: 'Validate findings against contracts and tests.',
        agents: [
          { id: 'contracts', title: 'Contracts', focus: 'Check README, install guide, and runtime contract alignment.' },
          { id: 'tests', title: 'Tests', focus: 'Check coverage gaps and missing E2E paths.' },
        ],
      },
    ],
  };
}

function fakeReviewScope(prompt = '') {
  const files = /SCOPE_FILE_ALL_INVALID/.test(prompt)
    ? ['outside.md']
    : /SCOPE_FILE_PARTIAL/.test(prompt)
      ? ['docs/client-package-plan.md', 'outside.md']
      : ['docs/client-package-plan.md'];
  const decisionRef = /SCOPE_DECISION_INVALID/.test(prompt) ? 'file:outside.md' : 'file:docs/client-package-plan.md';
  // The sweep finder's prompt carries the scope block but not the user prompt, so a sweep marker has
  // to travel through scope.instructions.
  const sweepMarker = /SWEEP_ONLY_DROP/.test(prompt)
    ? 'SWEEP_ONLY_DROP'
    : /SWEEP_RESCUE/.test(prompt) ? 'SWEEP_RESCUE' : '';
  // A scope that selects no lens at all reaches the early return, which must obey the same
  // vacuous-pass rule as candidate verification.
  if (/SCOPE_NO_LENSES/.test(prompt)) {
    return {
      files: /SCOPE_NO_LENSES_CLEAN/.test(prompt) ? ['docs/client-package-plan.md'] : ['docs/client-package-plan.md', 'outside.md'],
      summary: 'No lens applies to this change.',
      instructions: '',
      lensDecisions: [],
      lenses: [],
    };
  }
  return {
    files,
    summary: 'Review the client package plan and authority binding claims.',
    instructions: `Prioritize material runtime contract and boundary risks. ${sweepMarker}`.trim(),
    lensDecisions: [
      {
        seedId: 'cross-file-contract',
        action: 'select',
        selectedLensId: 'runtime-contract',
        reasonCategory: 'matched_change',
        decisionRefs: [decisionRef],
        reason: 'The plan changes runtime and package contract behavior.',
      },
      {
        seedId: 'security-boundary',
        action: 'select',
        selectedLensId: 'security-boundary',
        reasonCategory: 'prompt_risk',
        decisionRefs: [decisionRef],
        reason: 'Authority binding requires boundary review.',
      },
    ],
    lenses: [
      {
        id: 'runtime-contract',
        title: 'Runtime Contract',
        focus: 'Check whether the client package runtime contract can fail materially.',
        kind: 'contract',
      },
      {
        id: 'security-boundary',
        title: 'Security Boundary',
        focus: 'Check whether platform token authority can leak or be misbound.',
        kind: 'security',
      },
    ],
  };
}

function fakeReviewFinder(prompt) {
  const sweep = /Code-review Sweep Finder/.test(prompt);
  // Lens finders stay empty and only the sweep emits, so a drop can appear after the point where the
  // vacuous-pass guard used to run.
  if (/SWEEP_ONLY_DROP/.test(prompt)) {
    return sweep
      ? {
        candidates: [{
          file: 'docs/client-package-plan.md',
          line: 1,
          summary: 'Sweep candidate citing evidence that does not exist.',
          failureScenario: 'A sweep-only drop must not produce a completed review.',
          evidenceRefs: ['file:outside.md'],
          kind: 'coverage',
        }],
      }
      : { candidates: [] };
  }
  // A lens candidate drops and the sweep then supplies a usable one: the guard must not have failed
  // the run before the sweep had its chance.
  if (/SWEEP_RESCUE/.test(prompt)) {
    // Only the first lens emits, so exactly one drop is expected.
    if (!sweep && /Lens key: security-boundary/.test(prompt)) return { candidates: [] };
    return sweep
      ? {
        candidates: [{
          file: 'docs/client-package-plan.md',
          line: 3,
          summary: 'Sweep candidate citing evidence that exists.',
          failureScenario: 'It must survive and be reported.',
          evidenceRefs: ['file:docs/client-package-plan.md'],
          kind: 'coverage',
        }],
      }
      : {
        candidates: [{
          file: 'docs/client-package-plan.md',
          line: 1,
          summary: 'Lens candidate citing evidence that does not exist.',
          failureScenario: 'It is dropped under lenient policy.',
          evidenceRefs: ['file:outside.md'],
          kind: 'contract',
        }],
      };
  }
  if (sweep || /Lens key: security-boundary/.test(prompt)) {
    return { candidates: [] };
  }
  if (/INVALID_EVIDENCE_REF/.test(prompt)) {
    return {
      candidates: [{
        file: 'docs/client-package-plan.md',
        line: 1,
        summary: 'This candidate intentionally references unsupported evidence.',
        failureScenario: 'The workflow should fail before verification.',
        evidenceRefs: ['file:outside.md'],
        kind: 'contract',
      }],
    };
  }
  // The two ref shapes observed in real rejected runs: a file: ref with a line number appended, and
  // a diff:unstaged: guess for a path that exists only as file: (an untracked file).
  if (/VERIFIER_BAD_REF/.test(prompt)) {
    return {
      candidates: [
        {
          file: 'docs/client-package-plan.md',
          line: 1,
          summary: 'This candidate is verified normally.',
          failureScenario: 'It must survive its sibling verifier being dropped.',
          evidenceRefs: ['file:docs/client-package-plan.md'],
          kind: 'contract',
        },
        {
          file: 'docs/client-package-plan.md',
          line: 3,
          summary: 'VERIFIER_BAD_REF_MARK this candidate gets a verifier that cites unsupported evidence.',
          failureScenario: 'The verifier result is dropped while the run continues.',
          evidenceRefs: ['file:docs/client-package-plan.md'],
          kind: 'coverage',
        },
      ],
    };
  }
  if (/DRIVE_RELATIVE_REF/.test(prompt)) {
    return {
      candidates: [{
        file: 'docs/client-package-plan.md',
        line: 1,
        summary: 'This candidate cites a drive-RELATIVE name, which is a legal POSIX filename.',
        failureScenario: 'It must be an ordinary unsupported-evidence drop, not a structural violation.',
        evidenceRefs: ['file:C:foo.md'],
        kind: 'contract',
      }],
    };
  }
  if (/DRIVE_ABSOLUTE_REF/.test(prompt)) {
    return {
      candidates: [{
        file: 'docs/client-package-plan.md',
        line: 1,
        summary: 'This candidate cites a drive-letter absolute path.',
        failureScenario: 'A drive-absolute path escapes the workspace exactly like a POSIX absolute path.',
        evidenceRefs: ['file:C:/Users/someone/outside.md'],
        kind: 'contract',
      }],
    };
  }
  if (/TRAVERSAL_REF/.test(prompt)) {
    return {
      candidates: [{
        file: 'docs/client-package-plan.md',
        line: 1,
        summary: 'This candidate cites a path that escapes the workspace.',
        failureScenario: 'A structural violation must not be degraded into a drop.',
        evidenceRefs: ['file:../outside.md'],
        kind: 'contract',
      }],
    };
  }
  if (/COLON_INDEX_REF_PLAIN/.test(prompt)) {
    return {
      candidates: [{
        file: 'issue.md',
        line: 1,
        summary: 'Same kind mismatch, ordinary filename.',
        failureScenario: 'This one always normalized; it is the control for the colon-suffix case.',
        evidenceRefs: ['diff:unstaged:issue.md'],
        kind: 'contract',
      }],
    };
  }
  if (/COLON_INDEX_REF/.test(prompt)) {
    return {
      candidates: [{
        file: 'issue:123',
        line: 1,
        summary: 'This candidate cites a real file whose name ends in a colon and digits.',
        failureScenario: 'The kind is wrong, but the path is exact: normalization must not read ":123" as an index.',
        evidenceRefs: ['diff:unstaged:issue:123'],
        kind: 'contract',
      }],
    };
  }
  if (/PARTIAL_INVALID_REF/.test(prompt)) {
    return {
      candidates: [
        {
          file: 'docs/client-package-plan.md',
          line: 1,
          summary: 'This candidate cites a path that is not in evidence at all.',
          failureScenario: 'Under lenient it is dropped; under strict it fails the run.',
          evidenceRefs: ['file:outside.md'],
          kind: 'contract',
        },
        {
          file: 'docs/client-package-plan.md',
          line: 3,
          summary: 'This candidate cites evidence that exists.',
          failureScenario: 'It must survive a sibling candidate being dropped.',
          evidenceRefs: ['file:docs/client-package-plan.md'],
          kind: 'contract',
        },
      ],
    };
  }
  if (/LINE_SUFFIX_REF/.test(prompt)) {
    return {
      candidates: [{
        file: 'docs/client-package-plan.md:1',
        line: 1,
        summary: 'This candidate cites a file ref with a line number appended.',
        failureScenario: 'A caller reading the report needs the cited path to resolve.',
        evidenceRefs: ['file:docs/client-package-plan.md:1'],
        kind: 'contract',
      }],
    };
  }
  if (/KIND_MISMATCH_REF/.test(prompt)) {
    return {
      candidates: [{
        file: 'docs/client-package-plan.md',
        line: 1,
        summary: 'This candidate guesses a diff ref kind that this snapshot never produced.',
        failureScenario: 'A caller reading the report needs the cited path to resolve.',
        evidenceRefs: ['diff:unstaged:docs/client-package-plan.md'],
        kind: 'contract',
      }],
    };
  }
  return {
    candidates: [
      {
        file: 'docs/client-package-plan.md',
        line: 3,
        summary: 'Package plan may under-specify authority binding.',
        failureScenario: 'A client could treat a token-like artifact as authority without verifying the platform binding.',
        evidenceRefs: ['file:docs/client-package-plan.md'],
        kind: 'contract',
      },
      {
        file: 'docs/client-package-plan.md',
        line: 3,
        summary: 'The runtime contract may omit a deterministic validation gate.',
        failureScenario: 'A release could pass docs review while missing a local schema gate.',
        evidenceRefs: ['file:docs/client-package-plan.md'],
        kind: 'coverage',
      },
    ],
  };
}

function fakeReviewVerifier(prompt) {
  const second = /candidate_runtime-contract_2|candidate_sweep_2/.test(prompt);
  // Only the second candidate's verifier cites unsupported evidence, so one verifier result is
  // dropped while the run still completes — the case where attempt accounting used to under-report.
  if (/VERIFIER_BAD_REF_MARK/.test(prompt)) {
    return {
      verdict: 'CONFIRMED',
      evidence: 'This verifier cites a path that is not in evidence.',
      evidenceRefs: ['file:outside.md'],
      severity: 'P2',
    };
  }
  return {
    verdict: 'CONFIRMED',
    evidence: second
      ? 'The candidate is real but lower materiality than the authority binding issue.'
      : 'The plan text discusses platform token authority but does not show a validation gate.',
    evidenceRefs: ['file:docs/client-package-plan.md'],
    severity: second ? 'P2' : 'P1',
  };
}

function fakeReviewSynthesis() {
  return {
    summary: 'One material runtime contract issue should be reported; the lower-risk coverage point is dropped.',
    decisions: [
      {
        index: 0,
        action: 'report',
        merge: null,
        severity: 'P1',
        reasonCategory: 'material',
        reason: 'Authority binding is a material runtime contract risk.',
      },
      {
        index: 1,
        action: 'drop',
        merge: null,
        severity: 'P2',
        reasonCategory: 'not_material',
        reason: 'The validation gate point is useful follow-up but not material enough for the final report.',
      },
    ],
  };
}

function structuredToolResult(value) {
  return subagentResult({
    text: '',
    toolCalls: [{
      id: 'call_structured',
      name: 'StructuredOutput',
      arguments: JSON.stringify(value),
    }],
  });
}

function subagentResult({ text, toolCalls = [], usage }) {
  return {
    id: 'fake-result',
    model: 'fake-model',
    text,
    toolCalls,
    usage: usage ?? {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      source: 'estimated',
    },
    latencyMs: 1,
  };
}

async function collectEvents(runtime, taskId) {
  const events = [];
  for await (const event of runtime.streamEvents(taskId)) events.push(event);
  return events;
}

async function waitForEvent(runtime, taskId, eventType) {
  for (let index = 0; index < 100; index += 1) {
    const snapshot = runtime.get(taskId);
    if (snapshot?.events.some((event) => event.type === eventType)) return;
    await sleep(20);
  }
  throw new Error(`workflow did not emit ${eventType}: ${taskId}`);
}

async function assertRejectCode(fn, code) {
  try {
    await fn();
  } catch (err) {
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`Expected rejection with ${code}`);
}

function neverUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('request aborted'));
      return;
    }
    signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
  });
}

function stripWorktreeContext(prompt) {
  return prompt.split('\n\nWorktree isolation is enabled.')[0];
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFiles(root, fileName) {
  const found = [];
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const filePath = join(dir, name);
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) await walk(filePath);
      else if (fileStat.isFile() && name === fileName) found.push(filePath);
    }
  }
  await walk(root);
  return found;
}

async function initializeGitRepo(root) {
  const externalWorktreeStore = join(dirname(root), '.ultracode-for-codex-worktrees');
  if (!tempDirs.includes(externalWorktreeStore)) tempDirs.push(externalWorktreeStore);
  await gitLines(root, ['init']);
  await gitLines(root, ['config', 'user.email', 'ultracode@example.invalid']);
  await gitLines(root, ['config', 'user.name', 'Ultracode Test']);
  await writeFile(join(root, 'README.md'), '# worktree fixture\n');
  await gitLines(root, ['add', 'README.md']);
  await gitLines(root, ['commit', '-m', 'init']);
}

async function withFakeGit(root, customSource) {
  const { stdout } = await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  const realGit = stdout.trim();
  const binDir = join(root, 'fake-bin');
  await mkdir(binDir, { recursive: true });
  const fakeGitPath = join(binDir, 'git');
  await writeFile(fakeGitPath, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
${customSource}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
`);
  await chmod(fakeGitPath, 0o755);
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;
}

async function gitLines(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim().split(/\r?\n/).filter(Boolean);
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}


function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}
