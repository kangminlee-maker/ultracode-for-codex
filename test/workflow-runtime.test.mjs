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
    assert.match(snapshot.error, /allowed file refs is empty \(0 entries\) derived from /);
    assert.match(snapshot.error, /; populated by /);
    assert.equal(backend.requests.length, 0);
    assert.equal(snapshot.events.some((event) => event.type === 'workflow.agent.started'), false);
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
        return structuredToolResult(fakeReviewScope());
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

function fakeReviewScope() {
  return {
    files: ['docs/client-package-plan.md'],
    summary: 'Review the client package plan and authority binding claims.',
    instructions: 'Prioritize material runtime contract and boundary risks.',
    lensDecisions: [
      {
        seedId: 'cross-file-contract',
        action: 'select',
        selectedLensId: 'runtime-contract',
        reasonCategory: 'matched_change',
        decisionRefs: ['file:docs/client-package-plan.md'],
        reason: 'The plan changes runtime and package contract behavior.',
      },
      {
        seedId: 'security-boundary',
        action: 'select',
        selectedLensId: 'security-boundary',
        reasonCategory: 'prompt_risk',
        decisionRefs: ['file:docs/client-package-plan.md'],
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
  if (/Code-review Sweep Finder/.test(prompt) || /Lens key: security-boundary/.test(prompt)) {
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
