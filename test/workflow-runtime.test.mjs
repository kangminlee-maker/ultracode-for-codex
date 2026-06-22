import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import { WorkflowTaskRegistry } from '../dist/runtime/workflow-runtime.js';
import { readWorkflowJournal, workflowJournalPath } from '../dist/runtime/workflow-journal.js';

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

test('workflow runtime rejects invalid launch inputs before side effects', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend() });
  try {
    await assertRejectCode(
      () => runtime.launch({ resumeFromRunId: 'run_old' }),
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

test('built-in code-review plans phase-wise parallel agents and injects deterministic workspace context', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime, root } = await createRuntime({ backend });
  try {
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
    assert.equal(snapshot.status, 'completed');
    assert.equal(backend.requests.length, 8);
    assert.ok(backend.maxActiveRequests >= 2);
    const planEvent = events.find((event) => event.type === 'workflow.plan.ready');
    assert.equal(planEvent.mode, 'phase_parallel');
    assert.equal(planEvent.phases.length, 1);
    assert.deepEqual(planEvent.phases.map((phase) => phase.title), ['Discovery']);
    assert.deepEqual(planEvent.phases[0].agents.map((agent) => agent.label), [
      'code-review-discovery-runtime',
      'code-review-discovery-security',
    ]);
    assert.ok(
      events.findIndex((event) => event.type === 'workflow.plan.ready')
        < events.findIndex((event) => event.type === 'workflow.phase.planned'),
    );
    assert.ok(
      events.findIndex((event) => event.type === 'workflow.phase.planned')
        < events.findIndex((event) => event.type === 'workflow.phase.started'),
    );
    const labels = events
      .filter((event) => event.type === 'workflow.agent.started')
      .map((event) => event.label);
    assert.deepEqual(labels, [
      'code-review-planner',
      'code-review-discovery-runtime',
      'code-review-discovery-security',
      'code-review-phase-discovery-synthesis',
      'code-review-validation-contracts',
      'code-review-validation-tests',
      'code-review-phase-validation-synthesis',
      'code-review-final-synthesis',
    ]);
    const phaseTitles = events
      .filter((event) => event.type === 'workflow.phase.started')
      .map((event) => event.title);
    assert.deepEqual(phaseTitles, ['Discovery', 'Validation']);
    const phasePlans = events
      .filter((event) => event.type === 'workflow.phase.planned')
      .map((event) => event.title);
    assert.deepEqual(phasePlans, ['Discovery', 'Validation']);
    const discoveryPhase = events.find((event) => event.type === 'workflow.phase.started' && event.title === 'Discovery');
    assert.equal(discoveryPhase.plannedAgentCount, 2);
    assert.deepEqual(discoveryPhase.plannedAgents.map((agent) => agent.label), [
      'code-review-discovery-runtime',
      'code-review-discovery-security',
    ]);
    const validationPlan = events.find((event) => event.type === 'workflow.phase.planned' && event.title === 'Validation');
    assert.deepEqual(validationPlan.plannedAgents.map((agent) => agent.label), [
      'code-review-validation-contracts',
      'code-review-validation-tests',
    ]);
    const reviewerPrompt = backend.requests
      .map((request) => request.messages[0].content)
      .find((content) => /Parallel phase agent: Runtime/.test(content));
    assert.match(reviewerPrompt, /## Workspace Context/);
    assert.match(reviewerPrompt, /--- docs\/client-package-plan\.md/);
    assert.match(reviewerPrompt, /platform token/);
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

test('built-in task uses planner-selected single execution only when parallel work is wasteful', async () => {
  const backend = new FakeSubagentBackend();
  const { runtime } = await createRuntime({ backend });
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

test('workflow runtime preserves clean worktree-isolated agents for review', async () => {
  const { runtime, root } = await createRuntime({ backend: new FakeSubagentBackend() });
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
      agentStallTimeoutMs: runtimeOptions.agentStallTimeoutMs,
      agentStallRetryLimit: runtimeOptions.agentStallRetryLimit,
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
    if (workflowPrompt.includes('WRITE_WORKTREE')) {
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
