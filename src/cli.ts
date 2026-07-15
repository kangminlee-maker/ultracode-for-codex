#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, cp, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CodexSubagentBackend } from './codex/subagent-backend.js';
import { probeCodexSetup } from './codex/setup-probe.js';
import { WorkflowTaskRegistry, isRetryableFailureReason, cleanWorkflowWorktrees } from './runtime/workflow-runtime.js';
import { SUBAGENT_MODEL_PLACEHOLDER, UltracodeRequestError, isWorktreeRetention } from './runtime/types.js';
import { ultracodePackageVersion } from './runtime/package-info.js';
import { defaultUltracodeStateRoot, resolveUltracodeStatePath } from './runtime/state-root.js';
import { renderUltracodeInstallGuideNotice } from './ultracode-install-guide.js';
import {
  codexDefaultReasoningEffort,
  codexDefaultVerbosity,
  isReasoningEffort,
  isVerbosity,
  isWorkflowExecutionMode,
  isWorkflowPermissionPolicy,
  isWorkflowProgressMode,
  workflowBackgroundDefaults,
  workflowDefaultExecutionMode,
  workflowDefaultPermissionPolicy,
  workflowDefaultProgressMode,
  workflowDefaultRetryLimit,
  workflowDefaultRetryBackoffMs,
  workflowDefaultTimeoutMs,
  workflowDefaultHeartbeatMs,
  workflowDefaultWorktreeRetention,
} from './settings.js';
import type { ReasoningEffort, Verbosity, WorktreeRetention } from './runtime/types.js';
import type { WorkflowExecutionMode, WorkflowPermissionPolicy, WorkflowProgressMode } from './settings.js';
import type {
  WorkflowEvent,
  WorkflowLaunchInput,
  WorkflowLaunchResult,
  WorkflowPermissionReview,
  WorkflowTaskSnapshot,
} from './runtime/workflow-runtime.js';

export type {
  WorkflowAgentPreservedWorktree,
  WorkflowEvent,
  WorkflowLaunchInput,
  WorkflowLaunchResult,
  WorkflowPermissionReview,
  WorkflowTaskSnapshot,
  WorkflowTaskStatus,
  WorkflowTaskType,
} from './runtime/workflow-runtime.js';

const ULTRACODE_INSTALL_GUIDE_ACCEPT_VERSION = 'v1';
const PROGRESS_KIND = 'ultracode.workflow.progress';
const WORKFLOW_RUN_ID_RE = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ExecutionMode = WorkflowExecutionMode;
type PermissionPolicy = WorkflowPermissionPolicy;
type ProgressMode = WorkflowProgressMode;

async function main(argv: readonly string[]): Promise<number> {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(helpText());
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`ultracode-for-codex ${ultracodePackageVersion()}\n`);
    return 0;
  }
  if (command === '--llm-guide' || command === 'llm-guide') {
    process.stdout.write(renderUltracodeInstallGuideNotice());
    return 0;
  }
  if (command === 'run') return runWorkflow(args);
  if (command === 'status') return showBackgroundStatus(args);
  if (command === 'wait') return waitForBackgroundJob(args);
  if (command === 'logs') return showBackgroundLogs(args);
  if (command === 'result') return showBackgroundResult(args);
  if (command === 'cancel') return cancelBackgroundJob(args);
  if (command === 'jobs' || command === 'list') return listBackgroundJobs(args);
  if (command === 'archive' || command === 'export') return archiveBackgroundJob(args);
  if (command === 'worktree') return manageWorktrees(args);
  if (command === 'skills') return manageCodexSkills(args);
  if (command === 'setup' || command === 'doctor') return runCodexSetup(args);
  process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
  return 1;
}

async function runWorkflow(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.acceptLlmGuide !== ULTRACODE_INSTALL_GUIDE_ACCEPT_VERSION) {
    process.stdout.write(renderUltracodeInstallGuideNotice());
    process.stderr.write(
      `Refusing to run Ultracode for Codex until the install guide is acknowledged. Re-run with --accept-llm-guide=${ULTRACODE_INSTALL_GUIDE_ACCEPT_VERSION}.\n`,
    );
    return 1;
  }

  const cwd = options.cwd ?? process.cwd();
  const executionMode = parseExecutionMode(options.execution);
  const inputPromise = workflowLaunchInputFromOptions(options);
  if (options.validate !== undefined) {
    return await validateWorkflowCommand(await inputPromise, cwd, options);
  }
  if (executionMode === 'background') {
    const input = await inputPromise;
    if (input.resumeFromRunId) await assertBackgroundResumeSource(cwd, input.resumeFromRunId);
    return launchBackgroundWorkflow(args, cwd);
  }
  const timeoutMs = parseIntOption(options.timeoutMs, workflowDefaultTimeoutMs());
  const heartbeatMs = parseNonNegativeIntOption(options.heartbeatMs, workflowDefaultHeartbeatMs(), 'heartbeat-ms');
  const retryLimit = parseRetryLimit(options.retryLimit);
  const retryBackoffMs = parseNonNegativeIntOption(options.retryBackoffMs, workflowDefaultRetryBackoffMs(), 'retry-backoff-ms');
  const worktreeRetention = parseWorktreeRetention(options.worktreeRetention);
  const permissionPolicy = parsePermissionPolicy(options.permission);
  const progressMode = parseProgressMode(options.progress);
  const input = await inputPromise;
  const resumeModel = input.resumeFromRunId && !options.model
    ? await resolveResumeBackendModel(cwd, input.resumeFromRunId)
    : undefined;
  const reasoningEffort = parseReasoningEffort(options.reasoningEffort);
  const backend = new CodexSubagentBackend({
    command: options.command,
    cwd,
    model: options.model ?? resumeModel,
    timeoutMs,
    reasoningEffort,
    verbosity: parseVerbosity(options.verbosity),
  });
  const runtime = new WorkflowTaskRegistry({
    backend,
    cwd,
    requestTimeoutMs: timeoutMs,
    defaultReasoningEffort: reasoningEffort,
    heartbeatMs,
    worktreeRetention,
  });

  try {
    let launch = await requireRunnableLaunch(runtime, await runtime.launch(input), permissionPolicy, progressMode);
    let retries = 0;
    while (true) {
      const snapshot = await streamCommandWorkflow(runtime, launch, progressMode);
      if (snapshot.status === 'completed') {
        process.stdout.write(`${JSON.stringify(snapshot.result ?? null, null, 2)}\n`);
        renderWorkflowCompletionGuidance(snapshot, progressMode);
        return 0;
      }
      renderFailedSnapshot(snapshot, progressMode);
      if (!isRetryableFailureReason(snapshot.failureReason) || retries >= retryLimit) {
        // The result channel must stay total: in background mode this stdout
        // is result.json, so a terminal failure writes a machine-readable
        // record where consumers otherwise find a 0-byte file.
        process.stdout.write(`${JSON.stringify(workflowFailureRecord(snapshot), null, 2)}\n`);
        return snapshot.failureReason === 'workflow_aborted' ? 130 : 1;
      }
      retries += 1;
      const backoffMs = computeRetryBackoffMs(retryBackoffMs, retries);
      const backoffSuffix = backoffMs > 0 ? ` after ${backoffMs}ms` : '';
      renderControlProgress('workflow.retrying', progressMode, {
        status: 'retrying',
        summary: `Retrying workflow ${retries}/${retryLimit}${backoffSuffix}`,
        taskId: snapshot.taskId,
        runId: snapshot.runId,
        workflowName: snapshot.workflowName,
        retryIndex: retries,
        retryLimit,
        backoffMs,
      }, `[workflow] retrying ${retries}/${retryLimit}${backoffSuffix}\n`);
      // A retry backoff must stay cancellable: without its own signal handler the wait
      // sits between streamCommandWorkflow's handler scope, so Ctrl-C would hard-kill.
      if (backoffMs > 0 && (await interruptibleBackoff(backoffMs)) === 'interrupted') {
        process.stdout.write(`${JSON.stringify(workflowFailureRecord(snapshot), null, 2)}\n`);
        return 130;
      }
      launch = await requireRunnableLaunch(runtime, await runtime.retry(snapshot.taskId), permissionPolicy, progressMode);
    }
  } finally {
    await runtime.close();
  }
}

async function withPreflightRegistry<T>(
  cwd: string,
  fn: (runtime: WorkflowTaskRegistry) => Promise<T>,
): Promise<T> {
  const runtime = new WorkflowTaskRegistry({
    backend: PREFLIGHT_BACKEND,
    cwd,
    requestTimeoutMs: 0,
  });
  try {
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

async function validateWorkflowCommand(
  input: Awaited<ReturnType<typeof workflowLaunchInputFromOptions>>,
  cwd: string,
  options: ParsedOptions,
): Promise<number> {
  const report = await withPreflightRegistry(cwd, (runtime) => runtime.validateWorkflowInput(input));
  if (wantsPlain(options)) {
    process.stdout.write(`[validate] ${report.workflowName} (${report.workflowSource}) agents=${report.agentCallSites} schema=${report.schemaCallSites} keyed=${report.keyedCallSites}\n`);
    for (const warning of report.warnings) {
      process.stdout.write(`[validate] warning: ${warning}\n`);
    }
  } else {
    process.stdout.write(`${JSON.stringify({
      kind: 'ultracode.workflow.validate',
      version: 1,
      status: 'valid',
      ...report,
    }, null, 2)}\n`);
  }
  return 0;
}

async function assertBackgroundResumeSource(cwd: string, runId: string): Promise<void> {
  await withPreflightRegistry(cwd, (runtime) => runtime.validateResumeSource(runId));
}

async function resolveResumeBackendModel(cwd: string, runId: string): Promise<string | undefined> {
  const info = await withPreflightRegistry(cwd, (runtime) => runtime.resumeSourceInfo(runId));
  // An absent model means the source run had no run-level model configured,
  // so there is nothing to adopt.
  return info.model && info.model !== SUBAGENT_MODEL_PLACEHOLDER ? info.model : undefined;
}

const PREFLIGHT_BACKEND = {
  name: 'preflight',
  model: 'preflight',
  async generate(): Promise<never> {
    throw new Error('Preflight must not run subagents.');
  },
  async close(): Promise<void> {},
};

interface ParsedOptions {
  readonly _: string[];
  readonly args?: string;
  readonly argsFile?: string;
  readonly command?: string;
  readonly model?: string;
  readonly timeoutMs?: string;
  readonly heartbeatMs?: string;
  readonly cwd?: string;
  readonly execution?: string;
  readonly reasoningEffort?: string;
  readonly verbosity?: string;
  readonly progress?: string;
  readonly acceptLlmGuide?: string;
  readonly script?: string;
  readonly scriptFile?: string;
  readonly scriptPath?: string;
  readonly name?: string;
  readonly resumeFromRunId?: string;
  readonly validate?: string;
  readonly install?: string;
  readonly all?: string;
  readonly force?: string;
  readonly dryRun?: string;
  readonly cleanOnly?: string;
  readonly permission?: string;
  readonly retryLimit?: string;
  readonly retryBackoffMs?: string;
  readonly worktreeRetention?: string;
  readonly jobId?: string;
  readonly metadataPath?: string;
  readonly resultPath?: string;
  readonly progressPath?: string;
  readonly pidPath?: string;
  readonly intervalMs?: string;
  readonly tail?: string;
  readonly signal?: string;
  readonly plain?: string;
  readonly format?: string;
  readonly event?: string;
  readonly result?: string;
  readonly wait?: string;
  readonly outDir?: string;
  readonly outputPath?: string;
}

const VALUELESS_FLAGS = new Set(['install', 'plain', 'result', 'wait', 'validate', 'dryRun', 'all', 'force', 'cleanOnly']);

export function parseOptions(args: readonly string[]): ParsedOptions {
  const out: Record<string, string | string[]> = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) {
      (out._ as string[]).push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const rawKey = arg.slice(2, eq === -1 ? undefined : eq);
    const key = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
    if (eq === -1 && (VALUELESS_FLAGS.has(key) || value === undefined || value.startsWith('--'))) {
      out[key] = 'true';
      continue;
    }
    if (eq === -1) i += 1;
    out[key] = value ?? '';
  }
  if (typeof out.cwd === 'string' && out.cwd) {
    // Workflow state is partitioned by the exact working directory, and
    // background metadata replays this value as the recovery anchor, so a
    // relative --cwd must be pinned to an absolute path immediately.
    out.cwd = resolve(out.cwd);
  }
  return out as unknown as ParsedOptions;
}

async function launchBackgroundWorkflow(args: readonly string[], cwd: string): Promise<number> {
  const settings = workflowBackgroundDefaults();
  const jobId = `job_${randomUUID()}`;
  const runDir = resolveBackgroundRunDir(cwd, settings.runDir, jobId);
  const resultPath = join(runDir, settings.resultFile);
  const progressPath = join(runDir, settings.progressFile);
  const metadataPath = join(runDir, settings.metadataFile);
  const pidPath = join(runDir, settings.pidFile);
  assertDistinctBackgroundPaths([resultPath, progressPath, metadataPath, pidPath]);
  await mkdir(runDir, { recursive: true, mode: 0o700 });

  const stdout = await open(resultPath, 'w', 0o600);
  const stderr = await open(progressPath, 'w', 0o600);
  const entryPath = cliEntryPath();
  let childPid = 0;
  try {
    const child = spawn(process.execPath, [
      entryPath,
      'run',
      ...args,
      '--execution',
      'attached',
      // The background progress file is machine state for status/jobs/resume
      // anchors; force JSONL regardless of the caller's display preference
      // (logs --plain still renders human-readable lines from it).
      '--progress',
      'jsonl',
    ], {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', stdout.fd, stderr.fd],
    });
    childPid = child.pid ?? 0;
    child.unref();
  } finally {
    await stdout.close();
    await stderr.close();
  }

  const launchedAt = new Date().toISOString();
  await writeFile(pidPath, `${childPid}\n`, { mode: 0o600 });
  await writeFile(metadataPath, `${JSON.stringify({
    kind: 'ultracode.workflow.background',
    version: 1,
    status: 'launched',
    jobId,
    pid: childPid,
    launchedAt,
    cwd,
    resultPath,
    progressPath,
    metadataPath,
    pidPath,
    nodePath: process.execPath,
    cliEntryPath: entryPath,
    commandLineHint: `${process.execPath} ${entryPath} run`,
  }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    kind: 'ultracode.workflow.background',
    version: 1,
    status: 'launched',
    jobId,
    pid: childPid,
    resultPath,
    progressPath,
    metadataPath,
    pidPath,
  }, null, 2)}\n`);
  return 0;
}

interface BackgroundJobRef {
  readonly jobId?: string;
  readonly cwd: string;
  readonly metadataPath: string;
  readonly resultPath: string;
  readonly progressPath: string;
  readonly pidPath: string;
}

interface BackgroundJobMetadata {
  readonly kind: 'ultracode.workflow.background';
  readonly version: 1;
  readonly status: 'launched';
  readonly jobId: string;
  readonly pid: number;
  readonly launchedAt: string;
  readonly cwd: string;
  readonly resultPath: string;
  readonly progressPath: string;
  readonly metadataPath: string;
  readonly pidPath: string;
  readonly nodePath?: string;
  readonly cliEntryPath?: string;
  readonly commandLineHint?: string;
}

interface BackgroundProgressRead {
  readonly exists: boolean;
  readonly events: readonly ProgressPayload[];
  readonly malformedLineCount: number;
}

interface BackgroundJobStatus {
  readonly kind: 'ultracode.workflow.background.status';
  readonly version: 1;
  readonly status: 'running' | 'completed' | 'failed' | 'exited_unknown';
  readonly jobId?: string;
  readonly runId?: string;
  readonly pid?: number;
  readonly alive: boolean;
  readonly launchedAt?: string;
  readonly cwd: string;
  readonly resultPath: string;
  readonly progressPath: string;
  readonly metadataPath: string;
  readonly pidPath: string;
  readonly resultReady: boolean;
  readonly progressEventCount: number;
  readonly malformedProgressLineCount: number;
  readonly lastEvent?: string;
  readonly lastStatus?: string;
  readonly lastSummary?: string;
  readonly reason?: string;
  readonly error?: string;
  readonly completedAgentCount?: number;
  readonly knownAgentCount?: number;
  readonly phase?: string;
  readonly phaseCompletedAgentCount?: number;
  readonly phaseKnownAgentCount?: number;
  readonly elapsedMs?: number;
}

interface BackgroundJobsList {
  readonly kind: 'ultracode.workflow.background.jobs';
  readonly version: 1;
  readonly cwd: string;
  readonly backgroundRoot: string;
  readonly count: number;
  readonly jobs: readonly BackgroundJobStatus[];
  readonly invalidJobs: readonly {
    readonly path: string;
    readonly error: string;
  }[];
}

interface BackgroundCancelResult {
  readonly kind: 'ultracode.workflow.background.cancel';
  readonly version: 1;
  readonly status: 'signalled' | 'not_running' | 'identity_mismatch';
  readonly jobId: string;
  readonly pid: number;
  readonly signal: NodeJS.Signals;
  readonly identityVerified: boolean;
  readonly processCommandLine?: string;
  readonly metadataPath: string;
  readonly resultPath: string;
  readonly progressPath: string;
  readonly pidPath: string;
}

interface BackgroundArchiveRecord {
  readonly kind: 'ultracode.workflow.background.archive';
  readonly version: 1;
  readonly archivedAt: string;
  readonly archivePath: string;
  readonly status: BackgroundJobStatus;
  readonly metadata: BackgroundJobMetadata;
  readonly progressEvents: readonly ProgressPayload[];
  readonly malformedProgressLineCount: number;
  readonly resultText: string | null;
}

const WORKFLOW_FAILURE_RECORD_KIND = 'ultracode.workflow.failure';

interface WorkflowFailureRecord {
  readonly kind: typeof WORKFLOW_FAILURE_RECORD_KIND;
  readonly version: 1;
  readonly status: 'failed';
  readonly failure: {
    readonly reason: string;
    readonly error: string;
    readonly workflowName: string;
    readonly taskId: string;
    readonly runId: string;
    readonly phase?: string;
    readonly agentsCompleted?: number;
  };
}

function workflowFailureRecord(snapshot: WorkflowTaskSnapshot): WorkflowFailureRecord {
  let phase: string | undefined;
  let agentsCompleted: number | undefined;
  for (const event of snapshot.events) {
    if (event.type === 'workflow.phase.started') phase = event.title;
    if (event.type === 'workflow.agent.completed') agentsCompleted = event.completedAgentCount;
  }
  return {
    kind: WORKFLOW_FAILURE_RECORD_KIND,
    version: 1,
    status: 'failed',
    failure: {
      reason: snapshot.failureReason ?? 'unknown',
      error: snapshot.error ?? 'unknown',
      workflowName: snapshot.workflowName,
      taskId: snapshot.taskId,
      runId: snapshot.runId,
      ...(phase !== undefined ? { phase } : {}),
      ...(agentsCompleted !== undefined ? { agentsCompleted } : {}),
    },
  };
}

function parseWorkflowFailureRecord(text: string | null): WorkflowFailureRecord | null {
  if (!text?.trim()) return null;
  // Cheap containment check first: status/jobs polling reads every result
  // file, and success results can be large JSON that never needs parsing.
  if (!text.includes(WORKFLOW_FAILURE_RECORD_KIND)) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as { kind?: unknown }).kind === WORKFLOW_FAILURE_RECORD_KIND
      && (parsed as { version?: unknown }).version === 1
      && (parsed as { status?: unknown }).status === 'failed'
    ) {
      return parsed as WorkflowFailureRecord;
    }
  } catch {
    return null;
  }
  return null;
}

async function showBackgroundStatus(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const status = await inspectBackgroundJob(options);
  if (wantsPlain(options)) {
    process.stdout.write(renderBackgroundStatusPlain(status));
    return 0;
  }
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return 0;
}

async function waitForBackgroundJob(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const timeoutMs = parseNonNegativeIntOption(options.timeoutMs, 0, 'timeout-ms');
  const intervalMs = parsePositiveIntOption(options.intervalMs, 1_000, 'interval-ms');
  const waited = await waitForTerminalBackgroundJob(options, timeoutMs, intervalMs);
  if (waited.timedOut) {
    const payload: BackgroundJobStatus & { readonly waitTimedOut: true; readonly waitTimeoutMs: number } = {
      ...waited.status,
      waitTimedOut: true,
      waitTimeoutMs: timeoutMs,
    };
    if (wantsPlain(options)) process.stdout.write(renderBackgroundStatusPlain(payload));
    else process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 124;
  }
  if (wantsResult(options) && (waited.status.status === 'completed' || waited.status.status === 'failed')) {
    return await printBackgroundResult(await resolveBackgroundJobRef(options), waited.status);
  }
  if (wantsPlain(options)) process.stdout.write(renderBackgroundStatusPlain(waited.status));
  else process.stdout.write(`${JSON.stringify(waited.status, null, 2)}\n`);
  return waited.status.status === 'completed' ? 0 : 1;
}

async function showBackgroundLogs(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const ref = await resolveBackgroundJobRef(options);
  const progress = await readBackgroundProgress(ref.progressPath);
  if (!progress.exists) {
    process.stderr.write(`Background progress file not found: ${ref.progressPath}\n`);
    return 1;
  }
  const filtered = options.event
    ? progress.events.filter((event) => event.event === options.event)
    : progress.events;
  const tail = options.tail === undefined ? 0 : parseNonNegativeIntOption(options.tail, 0, 'tail');
  const selected = tail > 0 ? filtered.slice(-tail) : filtered;
  if (wantsPlain(options)) {
    process.stdout.write(selected.map(renderProgressEventPlain).join(''));
  } else {
    process.stdout.write(selected.map((event) => JSON.stringify(event)).join('\n'));
    if (selected.length > 0) process.stdout.write('\n');
  }
  return 0;
}

async function showBackgroundResult(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const ref = await resolveBackgroundJobRef(options);
  const status = await inspectBackgroundJob(options);
  return await printBackgroundResult(ref, status);
}

async function printBackgroundResult(ref: BackgroundJobRef, status: BackgroundJobStatus): Promise<number> {
  const text = await readTextFileIfPresent(ref.resultPath);
  if (text !== null && text.trim()) {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return parseWorkflowFailureRecord(text) ? 1 : 0;
  }
  process.stderr.write(`Background result is not ready: ${status.status}${status.reason ? ` (${status.reason})` : ''}\n`);
  return status.status === 'failed' ? 1 : 2;
}

async function cancelBackgroundJob(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const ref = await resolveBackgroundJobRef(options);
  const metadata = await readBackgroundMetadata(ref.metadataPath);
  const pid = metadata.pid || await readPid(ref.pidPath);
  if (!pid || pid <= 0) {
    process.stderr.write(`Background job pid not found: ${ref.pidPath}\n`);
    return 1;
  }
  const signal = parseSignalOption(options.signal);
  const alive = isProcessAlive(pid);
  const commandLine = alive ? backgroundProcessCommandLine(pid) : undefined;
  const identityVerified = !alive || backgroundProcessIdentityMatches(metadata, commandLine);
  const cancelResult: BackgroundCancelResult = {
    kind: 'ultracode.workflow.background.cancel',
    version: 1,
    status: alive
      ? identityVerified ? 'signalled' : 'identity_mismatch'
      : 'not_running',
    jobId: metadata.jobId,
    pid,
    signal,
    identityVerified,
    ...(commandLine ? { processCommandLine: commandLine } : {}),
    metadataPath: ref.metadataPath,
    resultPath: ref.resultPath,
    progressPath: ref.progressPath,
    pidPath: ref.pidPath,
  };
  if (alive && !identityVerified) {
    if (wantsPlain(options)) process.stdout.write(renderBackgroundCancelPlain(cancelResult));
    else process.stdout.write(`${JSON.stringify(cancelResult, null, 2)}\n`);
    return 1;
  }
  if (alive) {
    process.kill(pid, signal);
  }
  if (wantsWait(options)) {
    const timeoutMs = parseNonNegativeIntOption(options.timeoutMs, 0, 'timeout-ms');
    const intervalMs = parsePositiveIntOption(options.intervalMs, 1_000, 'interval-ms');
    const waited = await waitForTerminalBackgroundJob(options, timeoutMs, intervalMs);
    const payload = {
      kind: 'ultracode.workflow.background.cancel.wait',
      version: 1,
      cancel: cancelResult,
      terminalStatus: waited.status,
      waitTimedOut: waited.timedOut,
      ...(waited.timedOut ? { waitTimeoutMs: timeoutMs } : {}),
    };
    if (wantsPlain(options)) {
      process.stdout.write(`${renderBackgroundCancelPlain(cancelResult)}${renderBackgroundStatusPlain(waited.status)}`);
    } else {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    }
    return waited.timedOut ? 124 : 0;
  }
  if (wantsPlain(options)) process.stdout.write(renderBackgroundCancelPlain(cancelResult));
  else process.stdout.write(`${JSON.stringify(cancelResult, null, 2)}\n`);
  return 0;
}

async function listBackgroundJobs(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const list = await backgroundJobsList(options);
  if (wantsPlain(options)) {
    process.stdout.write(renderBackgroundJobsPlain(list));
    return 0;
  }
  process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  return 0;
}

async function archiveBackgroundJob(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const ref = await resolveBackgroundJobRef(options);
  const metadata = await readBackgroundMetadata(ref.metadataPath);
  const status = await inspectBackgroundJob(options);
  const progress = await readBackgroundProgress(ref.progressPath);
  const resultText = await readTextFileIfPresent(ref.resultPath);
  const archivePath = await backgroundArchivePath(options, metadata.jobId);
  const record: BackgroundArchiveRecord = {
    kind: 'ultracode.workflow.background.archive',
    version: 1,
    archivedAt: new Date().toISOString(),
    archivePath,
    status,
    metadata,
    progressEvents: progress.events,
    malformedProgressLineCount: progress.malformedLineCount,
    resultText,
  };
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, `${JSON.stringify(record, null, 2)}\n`);
  await chmod(archivePath, 0o600).catch(() => undefined);
  const projection = {
    kind: 'ultracode.workflow.background.archive.created',
    version: 1,
    jobId: metadata.jobId,
    archivePath,
    status: status.status,
    progressEventCount: progress.events.length,
  };
  if (wantsPlain(options)) {
    process.stdout.write(`[archive] ${metadata.jobId} ${status.status} -> ${archivePath}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
  }
  return 0;
}

async function inspectBackgroundJob(options: ParsedOptions): Promise<BackgroundJobStatus> {
  const ref = await resolveBackgroundJobRef(options);
  const metadata = await readBackgroundMetadata(ref.metadataPath);
  const pid = metadata.pid || await readPid(ref.pidPath);
  const alive = pid ? isProcessAlive(pid) : false;
  const progress = await readBackgroundProgress(ref.progressPath);
  const resultText = await readTextFileIfPresent(ref.resultPath);
  const resultReady = Boolean(resultText?.trim());
  const resultFailure = parseWorkflowFailureRecord(resultText);
  const statusEvents = progress.events.filter((event) => !isPostCompletionGuidanceEvent(event));
  const lastEvent = statusEvents.at(-1);
  // A terminal event counts only while it is the newest status event: an
  // in-process retry appends new events after a failed attempt's terminal
  // record, and that job is running again, not terminally failed.
  const terminalEvent = lastEvent && (
    lastEvent.event === 'workflow.completed'
    || lastEvent.event === 'workflow.failed'
    || lastEvent.event === 'workflow.terminal_failure'
  ) ? lastEvent : undefined;
  const status = backgroundStatusFrom({ terminalEvent, resultReady, resultIsFailure: resultFailure !== null, alive });
  return {
    kind: 'ultracode.workflow.background.status',
    version: 1,
    status,
    jobId: metadata.jobId ?? ref.jobId,
    runId: lastStringField(progress.events, 'runId'),
    pid,
    alive,
    launchedAt: metadata.launchedAt,
    cwd: metadata.cwd ?? ref.cwd,
    resultPath: ref.resultPath,
    progressPath: ref.progressPath,
    metadataPath: ref.metadataPath,
    pidPath: ref.pidPath,
    resultReady,
    progressEventCount: progress.events.length,
    malformedProgressLineCount: progress.malformedLineCount,
    lastEvent: lastEvent?.event,
    lastStatus: lastEvent?.status,
    lastSummary: lastEvent?.summary,
    reason: terminalEvent?.reason ?? resultFailure?.failure.reason,
    error: terminalEvent?.error ?? resultFailure?.failure.error,
    completedAgentCount: lastNumericField(progress.events, 'completedAgentCount'),
    knownAgentCount: lastNumericField(progress.events, 'knownAgentCount'),
    phase: lastStringField(progress.events, 'phase'),
    phaseCompletedAgentCount: lastNumericField(progress.events, 'phaseCompletedAgentCount'),
    phaseKnownAgentCount: lastNumericField(progress.events, 'phaseKnownAgentCount'),
    elapsedMs: lastNumericField(progress.events, 'elapsedMs'),
  };
}

async function waitForTerminalBackgroundJob(
  options: ParsedOptions,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ readonly status: BackgroundJobStatus; readonly timedOut: boolean }> {
  const startedAt = Date.now();
  while (true) {
    const status = await inspectBackgroundJob(options);
    if (isTerminalBackgroundStatus(status.status)) return { status, timedOut: false };
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) return { status, timedOut: true };
    await delay(intervalMs);
  }
}

async function backgroundJobsList(options: ParsedOptions): Promise<BackgroundJobsList> {
  const cwd = options.cwd ?? process.cwd();
  const settings = workflowBackgroundDefaults();
  const backgroundRoot = resolveBackgroundJobsRoot(cwd, settings.runDir);
  const jobs: BackgroundJobStatus[] = [];
  const invalidJobs: { path: string; error: string }[] = [];
  let entries: readonly string[] = [];
  try {
    entries = await readdir(backgroundRoot);
  } catch (err) {
    if (!isNodeErrorCode(err, 'ENOENT')) throw err;
  }
  for (const entry of entries) {
    const candidateDir = join(backgroundRoot, entry);
    const candidateMetadataPath = join(candidateDir, settings.metadataFile);
    const candidateStat = await stat(candidateMetadataPath).catch((err) => {
      if (isNodeErrorCode(err, 'ENOENT') || isNodeErrorCode(err, 'ENOTDIR')) return null;
      throw err;
    });
    if (!candidateStat?.isFile()) continue;
    try {
      const metadata = await readBackgroundMetadata(candidateMetadataPath);
      jobs.push(await inspectBackgroundJob({
        ...options,
        _: [],
        metadataPath: metadata.metadataPath || candidateMetadataPath,
        cwd,
      }));
    } catch (err) {
      invalidJobs.push({ path: candidateMetadataPath, error: errorMessage(err) });
    }
  }
  jobs.sort((a, b) => String(b.launchedAt ?? '').localeCompare(String(a.launchedAt ?? '')));
  return {
    kind: 'ultracode.workflow.background.jobs',
    version: 1,
    cwd,
    backgroundRoot,
    count: jobs.length,
    jobs,
    invalidJobs,
  };
}

async function resolveBackgroundJobRef(options: ParsedOptions): Promise<BackgroundJobRef> {
  if (options._.length > 1) {
    throw new Error('Background commands accept at most one positional job id or metadata path.');
  }
  const cwd = options.cwd ?? process.cwd();
  const positional = options._[0];
  const positionalLooksLikePath = positional
    ? positional.includes('/') || positional.includes('\\') || positional.endsWith('.json')
    : false;
  const jobId = options.jobId ?? (positional && !positionalLooksLikePath ? positional : undefined);
  const metadataPathOption = options.metadataPath ?? (positional && positionalLooksLikePath ? positional : undefined);
  let ref: BackgroundJobRef;
  if (metadataPathOption) {
    const metadataPath = resolve(metadataPathOption);
    const metadata = await readBackgroundMetadata(metadataPath);
    ref = {
      jobId: metadata.jobId,
      cwd: metadata.cwd,
      metadataPath,
      resultPath: options.resultPath ? resolve(options.resultPath) : requireMetadataPath(metadata.resultPath, 'resultPath'),
      progressPath: options.progressPath ? resolve(options.progressPath) : requireMetadataPath(metadata.progressPath, 'progressPath'),
      pidPath: options.pidPath ? resolve(options.pidPath) : requireMetadataPath(metadata.pidPath, 'pidPath'),
    };
  } else if (jobId) {
    const settings = workflowBackgroundDefaults();
    const runDir = resolveBackgroundRunDir(cwd, settings.runDir, jobId);
    ref = {
      jobId,
      cwd,
      metadataPath: options.metadataPath ? resolve(options.metadataPath) : join(runDir, settings.metadataFile),
      resultPath: options.resultPath ? resolve(options.resultPath) : join(runDir, settings.resultFile),
      progressPath: options.progressPath ? resolve(options.progressPath) : join(runDir, settings.progressFile),
      pidPath: options.pidPath ? resolve(options.pidPath) : join(runDir, settings.pidFile),
    };
  } else {
    throw new Error('Background command requires a job id, metadata path, or --job-id.');
  }
  assertDistinctBackgroundPaths([ref.resultPath, ref.progressPath, ref.metadataPath, ref.pidPath]);
  return ref;
}

async function readBackgroundMetadata(metadataPath: string): Promise<BackgroundJobMetadata> {
  const text = await readTextFileIfPresent(metadataPath);
  if (text === null) throw new Error(`Background metadata file not found: ${metadataPath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`Background metadata file is not valid JSON: ${errorMessage(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Background metadata must contain a JSON object.');
  }
  return validateBackgroundMetadata(parsed as Record<string, unknown>, metadataPath);
}

async function readPid(pidPath: string): Promise<number | undefined> {
  const text = await readTextFileIfPresent(pidPath);
  if (text === null) return undefined;
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isFinite(pid) ? pid : undefined;
}

function validateBackgroundMetadata(value: Record<string, unknown>, metadataPath: string): BackgroundJobMetadata {
  const kind = requiredString(value.kind, 'kind');
  if (kind !== 'ultracode.workflow.background') {
    throw new Error(`Background metadata kind must be ultracode.workflow.background: ${metadataPath}`);
  }
  const version = requiredInteger(value.version, 'version');
  if (version !== 1) throw new Error(`Background metadata version must be 1: ${metadataPath}`);
  const status = requiredString(value.status, 'status');
  if (status !== 'launched') throw new Error(`Background metadata status must be launched: ${metadataPath}`);
  const pid = requiredInteger(value.pid, 'pid');
  if (pid < 0) throw new Error(`Background metadata pid must be non-negative: ${metadataPath}`);
  const metadata: BackgroundJobMetadata = {
    kind: 'ultracode.workflow.background',
    version: 1,
    status: 'launched',
    jobId: requiredString(value.jobId, 'jobId'),
    pid,
    launchedAt: requiredString(value.launchedAt, 'launchedAt'),
    cwd: requiredString(value.cwd, 'cwd'),
    resultPath: requiredString(value.resultPath, 'resultPath'),
    progressPath: requiredString(value.progressPath, 'progressPath'),
    metadataPath: requiredString(value.metadataPath, 'metadataPath'),
    pidPath: requiredString(value.pidPath, 'pidPath'),
    ...(typeof value.nodePath === 'string' && value.nodePath ? { nodePath: value.nodePath } : {}),
    ...(typeof value.cliEntryPath === 'string' && value.cliEntryPath ? { cliEntryPath: value.cliEntryPath } : {}),
    ...(typeof value.commandLineHint === 'string' && value.commandLineHint ? { commandLineHint: value.commandLineHint } : {}),
  };
  for (const [key, path] of Object.entries({
    cwd: metadata.cwd,
    resultPath: metadata.resultPath,
    progressPath: metadata.progressPath,
    metadataPath: metadata.metadataPath,
    pidPath: metadata.pidPath,
  })) {
    if (!isAbsolute(path)) throw new Error(`Background metadata ${key} must be an absolute path: ${metadataPath}`);
  }
  return metadata;
}

function requiredString(value: unknown, key: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`Background metadata ${key} must be a non-empty string.`);
}

function requiredInteger(value: unknown, key: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new Error(`Background metadata ${key} must be an integer.`);
}

function backgroundProcessCommandLine(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function backgroundProcessIdentityMatches(
  metadata: BackgroundJobMetadata,
  commandLine: string | undefined,
): boolean {
  if (!metadata.cliEntryPath || !commandLine) return true;
  return commandLine.includes(metadata.cliEntryPath)
    && (!metadata.nodePath || commandLine.includes(metadata.nodePath) || commandLine.includes('node'));
}

async function backgroundArchivePath(options: ParsedOptions, jobId: string): Promise<string> {
  if (options.outputPath) return resolve(options.outputPath);
  const archiveDir = options.outDir
    ? resolve(options.outDir)
    : join(defaultUltracodeStateRoot(), 'archive');
  return join(archiveDir, `${jobId}.json`);
}

async function readBackgroundProgress(progressPath: string): Promise<BackgroundProgressRead> {
  const text = await readTextFileIfPresent(progressPath);
  if (text === null) return { exists: false, events: [], malformedLineCount: 0 };
  if (!text.trim()) return { exists: true, events: [], malformedLineCount: 0 };
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const events: ProgressPayload[] = [];
  let malformedLineCount = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && (parsed as { kind?: unknown }).kind === PROGRESS_KIND
        && (parsed as { version?: unknown }).version === 1
        && typeof (parsed as { event?: unknown }).event === 'string'
      ) {
        events.push(parsed as ProgressPayload);
      } else {
        malformedLineCount += 1;
      }
    } catch {
      if (index !== lines.length - 1) malformedLineCount += 1;
    }
  }
  return { exists: true, events, malformedLineCount };
}

async function readTextFileIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isNodeErrorCode(err, 'ENOENT')) return null;
    throw err;
  }
}

function requireMetadataPath(value: string | undefined, key: string): string {
  if (!value) throw new Error(`Background metadata is missing ${key}.`);
  return value;
}

function backgroundStatusFrom(input: {
  readonly terminalEvent?: ProgressPayload;
  readonly resultReady: boolean;
  readonly resultIsFailure: boolean;
  readonly alive: boolean;
}): BackgroundJobStatus['status'] {
  if (input.terminalEvent?.event === 'workflow.completed') return 'completed';
  if (input.terminalEvent?.event === 'workflow.failed' || input.terminalEvent?.event === 'workflow.terminal_failure') return 'failed';
  if (input.resultIsFailure) return 'failed';
  if (input.resultReady) return 'completed';
  return input.alive ? 'running' : 'exited_unknown';
}

function isTerminalBackgroundStatus(status: BackgroundJobStatus['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'exited_unknown';
}

function resolveBackgroundJobsRoot(cwd: string, template: string): string {
  const marker = '__ultracode_job_marker__';
  return dirname(resolveBackgroundRunDir(cwd, template, marker));
}

function wantsPlain(options: ParsedOptions): boolean {
  return options.plain === 'true' || options.format === 'plain' || options.progress === 'plain';
}

function wantsResult(options: ParsedOptions): boolean {
  return options.result === 'true';
}

function wantsWait(options: ParsedOptions): boolean {
  return options.wait === 'true';
}

function renderBackgroundStatusPlain(status: BackgroundJobStatus & {
  readonly waitTimedOut?: boolean;
  readonly waitTimeoutMs?: number;
}): string {
  const parts = [
    `[job] ${status.jobId ?? 'unknown'} ${status.status}`,
    status.runId ? `run=${status.runId}` : '',
    status.pid !== undefined ? `pid=${status.pid}` : '',
    `alive=${status.alive}`,
    `cwd=${status.cwd}`,
    status.resultReady ? 'result=ready' : 'result=pending',
    status.waitTimedOut ? `wait=timeout(${status.waitTimeoutMs}ms)` : '',
  ].filter(Boolean);
  const lines = [parts.join(' ')];
  if (status.lastEvent || status.lastSummary) {
    lines.push(`[job] last=${status.lastEvent ?? 'unknown'} ${status.lastSummary ?? ''}`.trimEnd());
  }
  if (status.completedAgentCount !== undefined && status.knownAgentCount !== undefined) {
    lines.push(`[job] agents=${status.completedAgentCount}/${status.knownAgentCount}${status.phase ? ` phase=${status.phase}` : ''}`);
  }
  if (status.reason || status.error) {
    lines.push(`[job] failure=${status.reason ?? 'unknown'} ${status.error ?? ''}`.trimEnd());
  }
  lines.push(`[job] resultPath=${status.resultPath}`);
  lines.push(`[job] progressPath=${status.progressPath}`);
  return `${lines.join('\n')}\n`;
}

function renderBackgroundJobsPlain(list: BackgroundJobsList): string {
  const lines = [`[jobs] ${list.count} jobs in ${list.backgroundRoot}`];
  for (const job of list.jobs) {
    lines.push(`[jobs] ${job.jobId ?? 'unknown'} ${job.status} pid=${job.pid ?? 'unknown'} alive=${job.alive} result=${job.resultReady ? 'ready' : 'pending'}`);
  }
  for (const invalid of list.invalidJobs) {
    lines.push(`[jobs] invalid ${invalid.path}: ${invalid.error}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderBackgroundCancelPlain(cancel: BackgroundCancelResult): string {
  return `[cancel] ${cancel.jobId} ${cancel.status} pid=${cancel.pid} signal=${cancel.signal} identity=${cancel.identityVerified ? 'verified' : 'unverified'}\n`;
}

function renderProgressEventPlain(event: ProgressPayload): string {
  const label = [
    `[${event.event}]`,
    event.status ? `status=${event.status}` : '',
    event.phase ? `phase=${event.phase}` : '',
    event.label ? `agent=${event.label}` : '',
    event.summary,
  ].filter(Boolean).join(' ');
  return `${label}\n`;
}

function isPostCompletionGuidanceEvent(event: ProgressPayload): boolean {
  return event.event === 'workflow.summary.ready'
    || event.event === 'workflow.review.recommended';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isNodeErrorCode(err, 'ESRCH')) return false;
    if (isNodeErrorCode(err, 'EPERM')) return true;
    throw err;
  }
}

function parseSignalOption(value: string | undefined): NodeJS.Signals {
  if (value === undefined) return 'SIGINT';
  const normalized = value.startsWith('SIG') ? value : `SIG${value}`;
  const allowed = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGHUP']);
  if (allowed.has(normalized as NodeJS.Signals)) return normalized as NodeJS.Signals;
  throw new Error('signal must be one of SIGINT, SIGTERM, or SIGHUP.');
}

function parsePositiveIntOption(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function parseNonNegativeIntOption(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`);
  return parsed;
}

function lastNumericField(events: readonly ProgressPayload[], key: keyof ProgressPayload): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = events[index]?.[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function lastStringField(events: readonly ProgressPayload[], key: keyof ProgressPayload): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = events[index]?.[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function resolveBackgroundRunDir(cwd: string, template: string, jobId: string): string {
  const expanded = template.replaceAll('{jobId}', jobId);
  if (expanded.includes('{stateRoot}') || expanded === '~' || expanded.startsWith('~/')) {
    return resolveUltracodeStatePath(expanded);
  }
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function assertDistinctBackgroundPaths(paths: readonly string[]): void {
  const normalized = new Set(paths);
  if (normalized.size !== paths.length) {
    throw new Error('Background result, progress, metadata, and pid paths must be distinct.');
  }
}

function cliEntryPath(): string {
  const entry = process.argv[1];
  if (!entry) throw new Error('Unable to locate CLI entry path for background launch.');
  return realpathSync(entry);
}

const CODEX_SKILL_NAMES = ['ultracode-for-codex', 'ultracode-for-codex-cli'] as const;

export type CodexSkillState = 'current' | 'stale' | 'missing' | 'unmanaged';

async function manageWorktrees(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  const subcommand = options._[0];
  if (subcommand !== 'clean') {
    throw new Error('worktree supports one subcommand: clean.');
  }
  if (options._.length > 1) {
    throw new Error('worktree clean does not accept positional arguments.');
  }
  assertKnownWorktreeCleanFlags(options);
  // Destructive flags are read by value, never by presence: `--all=false` must disable the
  // destructive mode it names, and a contradictory --clean-only --all must be rejected
  // rather than silently letting the destructive side win.
  const cleanOnly = parseBooleanFlag(options.cleanOnly, 'clean-only');
  const includeChanged = parseBooleanFlag(options.all, 'all');
  const force = parseBooleanFlag(options.force, 'force');
  const dryRun = parseBooleanFlag(options.dryRun, 'dry-run');
  if (cleanOnly && includeChanged) {
    throw new Error('worktree clean --clean-only cannot be combined with --all.');
  }
  if (includeChanged && !force) {
    throw new Error('worktree clean --all requires --force to remove changed worktrees.');
  }
  const result = await cleanWorkflowWorktrees({
    cwd: options.cwd ?? process.cwd(),
    includeChanged,
    force,
    dryRun,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // An incomplete cleanup must not report process success to status-driven automation.
  return result.entries.some((entry) => entry.action === 'failed') ? 1 : 0;
}

const WORKTREE_CLEAN_OPTION_KEYS = new Set(['_', 'cwd', 'cleanOnly', 'all', 'force', 'dryRun']);

function assertKnownWorktreeCleanFlags(options: ParsedOptions): void {
  for (const key of Object.keys(options)) {
    if (WORKTREE_CLEAN_OPTION_KEYS.has(key)) continue;
    const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    throw new Error(`worktree clean does not accept --${flag}.`);
  }
}

function parseBooleanFlag(value: string | undefined, label: string): boolean {
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be true or false.`);
}

async function manageCodexSkills(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  if (options._.length > 0) throw new Error('skills does not accept positional arguments.');
  const install = options.install !== undefined;
  const sourceRoot = join(dirname(cliEntryPath()), '..', 'skills');
  const targetRoot = codexSkillsRoot();
  const skills: { readonly name: string; readonly state: CodexSkillState }[] = [];
  for (const name of CODEX_SKILL_NAMES) {
    const sourceDir = join(sourceRoot, name);
    const targetDir = join(targetRoot, name);
    let state = await codexSkillState(sourceDir, targetDir, name);
    if (install) {
      if (state === 'unmanaged') {
        throw new Error(`Skill folder ${targetDir} exists but does not declare name: ${name}; refusing to overwrite it.`);
      }
      if (state !== 'current') {
        await mkdir(targetRoot, { recursive: true });
        await rm(targetDir, { recursive: true, force: true });
        await cp(sourceDir, targetDir, { recursive: true });
        state = await codexSkillState(sourceDir, targetDir, name);
      }
    }
    skills.push({ name, state });
  }
  if (wantsPlain(options)) {
    for (const skill of skills) {
      process.stdout.write(`[skills] ${skill.name} ${skill.state}\n`);
    }
    process.stdout.write(`[skills] root=${targetRoot} package=${ultracodePackageVersion()}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      kind: 'ultracode.skills',
      version: 1,
      action: install ? 'install' : 'status',
      packageVersion: ultracodePackageVersion(),
      codexSkillsRoot: targetRoot,
      skills,
    }, null, 2)}\n`);
  }
  return 0;
}

async function runCodexSetup(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  if (options._.length > 0) throw new Error('setup does not accept positional arguments.');
  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : process.cwd();
  const probe = await probeCodexSetup({
    command: options.command,
    cwd,
    model: options.model,
    reasoningEffort: parseReasoningEffort(options.reasoningEffort),
  });
  const skills = await collectCodexSkillStates();
  const skillsReady = skills.every((skill) => skill.state === 'current');
  const ready = probe.ready && skillsReady;
  if (wantsPlain(options)) {
    process.stdout.write(`[setup] package ${probe.packageVersion}  node ${probe.nodeVersion}\n`);
    process.stdout.write(probe.codexInstalled
      ? `[setup] codex installed  ${probe.codexVersion}\n`
      : `[setup] codex missing  ${probe.detail}\n`);
    if (probe.codexInstalled) {
      process.stdout.write(`[setup] app-server ${probe.appServerReachable ? 'reachable' : 'unreachable'}\n`);
      process.stdout.write(`[setup] detail ${probe.detail}\n`);
      process.stdout.write(probe.selectedModel
        ? `[setup] model ${probe.selectedModel}  effort=${probe.reasoningEffort}  supported=${probe.supportedReasoningEfforts.join(',')}\n`
        : `[setup] model unavailable  effort=${probe.reasoningEffort}\n`);
    }
    for (const skill of skills) process.stdout.write(`[setup] skill ${skill.name} ${skill.state}\n`);
    if (!skillsReady) {
      process.stdout.write('[setup] run "ultracode-for-codex skills --install" to refresh skill commands\n');
    }
    process.stdout.write(`[setup] ready: ${ready ? 'yes' : 'no'}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      kind: 'ultracode.setup',
      version: 2,
      ready,
      packageVersion: probe.packageVersion,
      nodeVersion: probe.nodeVersion,
      codex: {
        command: probe.command,
        installed: probe.codexInstalled,
        version: probe.codexVersion,
        appServerReachable: probe.appServerReachable,
      },
      auth: {
        checked: probe.authChecked,
        loggedIn: probe.loggedIn,
        method: probe.authMethod,
        account: probe.account,
        requiresOpenaiAuth: probe.requiresOpenaiAuth,
      },
      model: {
        catalogChecked: probe.modelCatalogChecked,
        selected: probe.selectedModel,
        reasoningEffort: probe.reasoningEffort,
        reasoningEffortSupported: probe.reasoningEffortSupported,
        supportedReasoningEfforts: probe.supportedReasoningEfforts,
      },
      detail: probe.detail,
      codexSkillsRoot: codexSkillsRoot(),
      skills,
    }, null, 2)}\n`);
  }
  return ready ? 0 : 1;
}

async function collectCodexSkillStates(): Promise<{ readonly name: string; readonly state: CodexSkillState }[]> {
  const sourceRoot = join(dirname(cliEntryPath()), '..', 'skills');
  const targetRoot = codexSkillsRoot();
  const skills: { readonly name: string; readonly state: CodexSkillState }[] = [];
  for (const name of CODEX_SKILL_NAMES) {
    const state = await codexSkillState(join(sourceRoot, name), join(targetRoot, name), name);
    skills.push({ name, state });
  }
  return skills;
}

function codexSkillsRoot(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return join(configured ? configured : join(homedir(), '.codex'), 'skills');
}

export async function codexSkillState(sourceDir: string, targetDir: string, name: string): Promise<CodexSkillState> {
  const targetSkill = await readFile(join(targetDir, 'SKILL.md'), 'utf8').catch(() => null);
  if (targetSkill === null) return 'missing';
  if (!new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(targetSkill)) return 'unmanaged';
  const sourceFiles = await listSkillFiles(sourceDir, '');
  const targetFiles = await listSkillFiles(targetDir, '');
  if (sourceFiles.join('\n') !== targetFiles.join('\n')) return 'stale';
  for (const relativePath of sourceFiles) {
    const [sourceText, targetText] = await Promise.all([
      readFile(join(sourceDir, relativePath)),
      readFile(join(targetDir, relativePath)).catch(() => null),
    ]);
    if (targetText === null || !sourceText.equals(targetText)) return 'stale';
  }
  return 'current';
}

async function listSkillFiles(root: string, prefix: string): Promise<readonly string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listSkillFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function workflowLaunchInputFromOptions(options: ParsedOptions): Promise<WorkflowLaunchInput> {
  const positionalScriptFile = options._[0];
  if (options._.length > 1) throw new Error('run accepts at most one positional workflow script file.');
  const scriptFile = options.scriptFile ?? positionalScriptFile;
  const hasResumeFromRunId = options.resumeFromRunId !== undefined;
  const sourceSelectors = [
    options.script !== undefined ? '--script' : '',
    scriptFile ? '--script-file' : '',
    options.scriptPath ? '--script-path' : '',
    options.name ? '--name' : '',
  ].filter(Boolean);
  if (sourceSelectors.length > 1) {
    throw new Error(`Choose only one workflow source selector: ${sourceSelectors.join(', ')}.`);
  }
  if (hasResumeFromRunId) validateCliResumeFromRunId(options.resumeFromRunId);
  if (hasResumeFromRunId && sourceSelectors.length > 0) {
    throw new Error('--resume-from-run-id cannot be combined with --script, --script-file, --script-path, --name, or a positional script file.');
  }
  if (sourceSelectors.length === 0 && !hasResumeFromRunId) {
    throw new Error('run requires --script, --script-file, --script-path, --name, --resume-from-run-id, or a positional script file.');
  }
  const parsedArgs = await parseArgsPayload(options);
  const shouldIncludeArgs = options.args !== undefined || options.argsFile !== undefined || !hasResumeFromRunId;
  return {
    ...(options.script !== undefined ? { script: options.script } : {}),
    ...(scriptFile ? { script: await readFile(scriptFile, 'utf8') } : {}),
    ...(options.scriptPath ? { scriptPath: options.scriptPath } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(hasResumeFromRunId ? { resumeFromRunId: options.resumeFromRunId } : {}),
    ...(shouldIncludeArgs ? { args: parsedArgs } : {}),
  };
}

function validateCliResumeFromRunId(value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('resumeFromRunId must be a non-empty workflow runId string.');
  }
  if (!WORKFLOW_RUN_ID_RE.test(value.trim())) {
    throw new Error('resumeFromRunId must be a workflow runId in run_<uuid> format.');
  }
}

async function parseArgsPayload(options: ParsedOptions): Promise<unknown> {
  if (options.args !== undefined && options.argsFile) {
    throw new Error('Use either --args or --args-file, not both.');
  }
  const text = options.argsFile ? await readFile(options.argsFile, 'utf8') : options.args;
  if (text === undefined || text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Workflow args must be valid JSON.');
  }
}

async function requireRunnableLaunch(
  runtime: WorkflowTaskRegistry,
  launched: WorkflowLaunchResult,
  permissionPolicy: PermissionPolicy,
  progressMode: ProgressMode,
): Promise<Extract<WorkflowLaunchResult, { readonly status: 'async_launched' }>> {
  let current = launched;
  while (current.status === 'permission_required') {
    const allow = await resolvePermissionReview(current.review, permissionPolicy, progressMode);
    if (!allow) {
      const denied = await runtime.denyPermissionRequest(current.permissionRequestId);
      throw new Error(`Workflow permission denied: ${denied.workflowName}`);
    }
    current = await runtime.approvePermissionRequest(current.permissionRequestId);
  }
  if (current.status !== 'async_launched') {
    throw new Error('CLI supports only local workflow launches.');
  }
  return current;
}

async function resolvePermissionReview(
  review: WorkflowPermissionReview,
  permissionPolicy: PermissionPolicy,
  progressMode: ProgressMode,
): Promise<boolean> {
  renderPermissionReview(review, progressMode);
  if (permissionPolicy === 'allow') return true;
  if (permissionPolicy === 'deny') return false;
  if (!process.stdin.isTTY) {
    throw new Error('Workflow permission review requires --permission allow or --permission deny in non-interactive terminals.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question('Allow this workflow? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function renderPermissionReview(review: WorkflowPermissionReview, progressMode: ProgressMode): void {
  if (progressMode === 'jsonl') {
    writeJsonlProgress({
      event: 'workflow.permission.required',
      status: 'waiting_for_permission',
      summary: `Permission review required for ${review.workflowName}`,
      permissionRequestId: review.permissionRequestId,
      workflowName: review.workflowName,
      workflowSource: review.workflowSource,
      workflowSourcePath: review.workflowSourcePath,
      scriptHash: review.scriptHash,
      riskSummary: review.riskSummary,
      phases: review.phases,
      requestedIsolationModes: review.requestedIsolationModes,
    });
    return;
  }
  process.stderr.write([
    '[permission] workflow review required',
    `  name: ${review.workflowName}`,
    `  source: ${review.workflowSource}${review.workflowSourcePath ? ` (${review.workflowSourcePath})` : ''}`,
    `  scriptHash: ${review.scriptHash}`,
    `  risk: ${review.riskSummary}`,
    review.phases.length > 0 ? `  phases: ${review.phases.join(', ')}` : '',
    review.requestedIsolationModes.length > 0 ? `  isolation: ${review.requestedIsolationModes.join(', ')}` : '',
  ].filter(Boolean).join('\n'));
  process.stderr.write('\n');
}

async function streamCommandWorkflow(
  runtime: WorkflowTaskRegistry,
  launch: Extract<WorkflowLaunchResult, { readonly status: 'async_launched' }>,
  progressMode: ProgressMode,
): Promise<WorkflowTaskSnapshot> {
  let cancelling = false;
  const cancel = (signal: NodeJS.Signals): void => {
    if (cancelling) {
      renderControlProgress('workflow.cancel.already_requested', progressMode, {
        status: 'cancelling',
        summary: `${signal} received while cancellation is already in progress`,
        taskId: launch.taskId,
        runId: launch.runId,
        workflowName: launch.workflowName,
        signal,
      }, `[workflow] ${signal} received while cancellation is already in progress\n`);
      return;
    }
    cancelling = true;
    renderControlProgress('workflow.cancel.requested', progressMode, {
      status: 'cancelling',
      summary: `${signal} received; cancelling workflow`,
      taskId: launch.taskId,
      runId: launch.runId,
      workflowName: launch.workflowName,
      signal,
    }, `[workflow] ${signal} received; cancelling ${launch.taskId}\n`);
    void runtime.cancel(launch.taskId).catch((err) => {
      renderControlProgress('workflow.cancel.failed', progressMode, {
        status: 'failed',
        summary: 'Workflow cancellation failed',
        taskId: launch.taskId,
        runId: launch.runId,
        workflowName: launch.workflowName,
        error: errorMessage(err),
      }, `[workflow] cancellation failed: ${errorMessage(err)}\n`);
    });
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    for await (const event of runtime.streamEvents(launch.taskId)) {
      renderWorkflowEvent(event, progressMode);
    }
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
  const snapshot = runtime.get(launch.taskId);
  if (!snapshot) throw new Error(`Workflow task disappeared: ${launch.taskId}`);
  return snapshot;
}

function renderWorkflowEvent(event: WorkflowEvent, progressMode: ProgressMode): void {
  if (progressMode === 'jsonl') {
    writeJsonlProgress(progressPayloadForEvent(event));
    return;
  }
  switch (event.type) {
    case 'workflow.started':
      process.stderr.write(`[workflow] started ${event.workflowName} task=${event.taskId} run=${event.runId}\n`);
      return;
    case 'workflow.phase.planned':
      process.stderr.write(`[phase-plan] ${event.title} (${event.plannedAgentCount} agents)${event.goal ? ` - ${event.goal}` : ''}\n`);
      for (const agent of event.plannedAgents) {
        process.stderr.write(`[phase-plan]    - ${agent.title}${agent.label ? ` (${agent.label})` : ''}${agent.focus ? `: ${agent.focus}` : ''}\n`);
      }
      return;
    case 'workflow.phase.started':
      process.stderr.write(`[phase] ${event.title}${event.plannedAgentCount ? ` (${event.plannedAgentCount} agents)` : ''}${event.detail ? ` - ${event.detail}` : ''}\n`);
      if (event.plannedAgents) {
        for (const agent of event.plannedAgents) {
          process.stderr.write(`[phase]    - ${agent.title}${agent.label ? ` (${agent.label})` : ''}${agent.focus ? `: ${agent.focus}` : ''}\n`);
        }
      }
      return;
    case 'workflow.plan.ready':
      process.stderr.write(`[plan] mode=${event.mode} phases=${event.phases.length}${event.rationale ? ` - ${event.rationale}` : ''}\n`);
      for (const [phaseIndex, phase] of event.phases.entries()) {
        process.stderr.write(`[plan] ${phaseIndex + 1}. ${phase.title}${phase.goal ? ` - ${phase.goal}` : ''}\n`);
        for (const agent of phase.agents) {
          process.stderr.write(`[plan]    - ${agent.title}${agent.label ? ` (${agent.label})` : ''}${agent.focus ? `: ${agent.focus}` : ''}\n`);
        }
      }
      return;
    case 'workflow.log':
      process.stderr.write(`[log] ${event.message}\n`);
      return;
    case 'workflow.heartbeat':
      process.stderr.write(`[heartbeat] ${formatElapsedDuration(event.elapsedMs)} elapsed${event.phase ? ` phase=${event.phase}` : ''} agents=${event.completedAgentCount}/${event.knownAgentCount}\n`);
      return;
    case 'workflow.agent.started':
      process.stderr.write(`[agent:${event.agentIndex + 1}] started ${event.label}\n`);
      return;
    case 'workflow.agent.completed':
      process.stderr.write(`[agent:${event.agentIndex + 1}] completed ${event.label} | ${agentCompletionProgressSummary(event)} | tokens=${event.tokens} preview=${formatPreview(event.resultPreview)}${event.cached ? ' cached=true' : ''}\n`);
      return;
    case 'workflow.agent.failed':
      process.stderr.write(`[agent:${event.agentIndex + 1}] failed ${event.label} ${event.error}\n`);
      return;
    case 'workflow.completed':
      process.stderr.write(`[workflow] completed agents=${event.agentCount} tokens=${event.tokens} result=${event.resultPath}\n`);
      return;
    case 'workflow.failed':
      process.stderr.write(`[workflow] failed ${event.recovery?.reason ?? ''} ${event.error}\n`);
      return;
  }
}

function renderFailedSnapshot(snapshot: WorkflowTaskSnapshot, progressMode: ProgressMode): void {
  if (progressMode === 'jsonl') {
    writeJsonlProgress({
      event: 'workflow.terminal_failure',
      status: 'failed',
      summary: `Workflow terminal failure: ${snapshot.failureReason ?? 'unknown'}`,
      taskId: snapshot.taskId,
      runId: snapshot.runId,
      workflowName: snapshot.workflowName,
      reason: snapshot.failureReason ?? 'unknown',
      error: snapshot.error ?? 'unknown',
    });
    return;
  }
  process.stderr.write(
    `[workflow] terminal failure task=${snapshot.taskId} reason=${snapshot.failureReason ?? 'unknown'} error=${snapshot.error ?? 'unknown'}\n`,
  );
}

interface WorkflowAgentAngleSummary {
  readonly title: string;
  readonly label?: string;
  readonly angle?: string;
}

interface WorkflowPhaseExecutionSummary {
  readonly title: string;
  readonly goal?: string;
  readonly agentCount: number;
  readonly agents: readonly WorkflowAgentAngleSummary[];
}

function renderWorkflowCompletionGuidance(
  snapshot: WorkflowTaskSnapshot,
  progressMode: ProgressMode,
): void {
  const phasesSummary = workflowPhaseExecutionSummary(snapshot.events);
  const totalPlannedAgentCount = phasesSummary.reduce((sum, phase) => sum + phase.agentCount, 0);
  const reviewRecommendation = criticalReviewRecommendation();
  if (progressMode === 'jsonl') {
    writeJsonlProgress({
      event: 'workflow.summary.ready',
      status: 'completed',
      summary: `Workflow completed with ${phasesSummary.length} phase${phasesSummary.length === 1 ? '' : 's'} and ${totalPlannedAgentCount} planned phase agent${totalPlannedAgentCount === 1 ? '' : 's'}`,
      taskId: snapshot.taskId,
      runId: snapshot.runId,
      workflowName: snapshot.workflowName,
      phasesSummary,
      totalPhaseCount: phasesSummary.length,
      totalPlannedAgentCount,
    });
    writeJsonlProgress({
      event: 'workflow.review.recommended',
      status: 'review_recommended',
      summary: reviewRecommendation,
      taskId: snapshot.taskId,
      runId: snapshot.runId,
      workflowName: snapshot.workflowName,
      recommendation: reviewRecommendation,
    });
    return;
  }
  if (phasesSummary.length > 0) {
    process.stderr.write('[workflow-summary] phase/agent angles\n');
    for (const phase of phasesSummary) {
      process.stderr.write(`[workflow-summary] Phase ${phase.title}: ${phase.agentCount} agent${phase.agentCount === 1 ? '' : 's'}${phase.goal ? ` - ${phase.goal}` : ''}\n`);
      for (const agent of phase.agents) {
        process.stderr.write(`[workflow-summary]   - ${agent.title}${agent.label ? ` (${agent.label})` : ''}${agent.angle ? `: ${agent.angle}` : ''}\n`);
      }
    }
  } else {
    process.stderr.write('[workflow-summary] no phase-level agent plan was recorded\n');
  }
  process.stderr.write(`[review-recommendation] ${reviewRecommendation}\n`);
}

function workflowPhaseExecutionSummary(events: readonly WorkflowEvent[]): readonly WorkflowPhaseExecutionSummary[] {
  const phases = new Map<string, WorkflowPhaseExecutionSummary>();
  const phaseTitlesWithPlannedAgents = new Set<string>();
  for (const event of events) {
    if (event.type !== 'workflow.phase.planned' && event.type !== 'workflow.phase.started') continue;
    const plannedAgents = event.plannedAgents ?? [];
    if (plannedAgents.length > 0) phaseTitlesWithPlannedAgents.add(event.title);
    const existing = phases.get(event.title);
    const agents = plannedAgents.length > 0
      ? plannedAgents.map((agent) => ({
          title: agent.title,
          ...(agent.label ? { label: agent.label } : {}),
          ...(agent.focus ? { angle: agent.focus } : {}),
        }))
      : existing?.agents ?? [];
    phases.set(event.title, {
      title: event.title,
      ...(event.goal ?? existing?.goal ? { goal: event.goal ?? existing?.goal } : {}),
      agentCount: agents.length || existing?.agentCount || 0,
      agents,
    });
  }
  for (const event of events) {
    if (event.type !== 'workflow.agent.started' || !event.phase) continue;
    const startedAgent = {
      title: event.label,
      label: event.label,
      angle: event.promptPreview,
    };
    const existing = phases.get(event.phase);
    if (!existing) {
      phases.set(event.phase, {
        title: event.phase,
        agentCount: 1,
        agents: [startedAgent],
      });
      continue;
    }
    if (
      phaseTitlesWithPlannedAgents.has(event.phase)
      && existing.agents.length > 0
      && !phaseSummaryAllowsDynamicStartedAgents(existing)
    ) continue;
    if (existing.agents.some((agent) => agent.label === event.label || agent.title === event.label)) continue;
    const agents = [...existing.agents, startedAgent];
    phases.set(event.phase, {
      ...existing,
      agentCount: agents.length,
      agents,
    });
  }
  return [...phases.values()];
}

function phaseSummaryAllowsDynamicStartedAgents(phase: WorkflowPhaseExecutionSummary): boolean {
  return phase.agents.some((agent) => {
    const label = agent.label ?? '';
    const title = agent.title ?? '';
    const angle = agent.angle ?? '';
    return /\bdynamic\b/i.test(`${label} ${title} ${angle}`);
  });
}

function criticalReviewRecommendation(): string {
  return 'Session LLM should critically re-check the final result before acting: verify whether the conclusion is justified, internally consistent, supported by the observed workflow evidence, and missing material counterarguments.';
}

function renderControlProgress(
  event: string,
  progressMode: ProgressMode,
  payload: Omit<ProgressPayload, 'kind' | 'version' | 'event'>,
  plainText: string,
): void {
  if (progressMode === 'jsonl') {
    writeJsonlProgress({ event, ...payload });
    return;
  }
  process.stderr.write(plainText);
}

interface ProgressPayload {
  readonly kind?: typeof PROGRESS_KIND;
  readonly version?: 1;
  readonly event: string;
  readonly status?: string;
  readonly summary: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly workflowName?: string;
  readonly workflowSource?: string;
  readonly workflowSourcePath?: string;
  readonly scriptHash?: string;
  readonly permissionRequestId?: string;
  readonly riskSummary?: string;
  readonly phases?: readonly string[];
  readonly requestedIsolationModes?: readonly string[];
  readonly phaseIndex?: number;
  readonly title?: string;
  readonly detail?: string;
  readonly goal?: string;
  readonly plannedAgentCount?: number;
  readonly plannedAgents?: readonly unknown[];
  readonly mode?: string;
  readonly rationale?: string;
  readonly phaseCount?: number;
  readonly planPhases?: readonly unknown[];
  readonly message?: string;
  readonly agentIndex?: number;
  readonly agentId?: string;
  readonly label?: string;
  readonly phase?: string;
  readonly promptPreview?: string;
  readonly tokens?: number;
  readonly toolCalls?: number;
  readonly resultPreview?: string;
  readonly cached?: boolean;
  readonly elapsedMs?: number;
  readonly completedAgentCount?: number;
  readonly knownAgentCount?: number;
  readonly phaseCompletedAgentCount?: number;
  readonly phaseKnownAgentCount?: number;
  readonly seq?: number;
  readonly skipped?: boolean;
  readonly worktreePreserved?: boolean;
  readonly preservedWorktrees?: readonly unknown[];
  readonly resultPath?: string;
  readonly agentCount?: number;
  readonly durationMs?: number;
  readonly retryable?: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly signal?: string;
  readonly retryIndex?: number;
  readonly retryLimit?: number;
  readonly backoffMs?: number;
  readonly phasesSummary?: readonly WorkflowPhaseExecutionSummary[];
  readonly totalPhaseCount?: number;
  readonly totalPlannedAgentCount?: number;
  readonly recommendation?: string;
}

function writeJsonlProgress(payload: ProgressPayload): void {
  process.stderr.write(`${JSON.stringify({
    kind: PROGRESS_KIND,
    version: 1,
    ...payload,
  })}\n`);
}

function phaseStartedSummary(event: Extract<WorkflowEvent, { type: 'workflow.phase.started' }>): string {
  const agentText = event.plannedAgentCount
    ? `${event.plannedAgentCount} planned agent${event.plannedAgentCount === 1 ? '' : 's'}`
    : '';
  const suffix = [agentText, event.detail ?? event.goal].filter(Boolean).join(': ');
  return suffix ? `Phase ${event.title}: ${suffix}` : `Phase ${event.title}`;
}

function phasePlannedSummary(event: Extract<WorkflowEvent, { type: 'workflow.phase.planned' }>): string {
  return `Phase ${event.title} planned: ${event.plannedAgentCount} planned agent${event.plannedAgentCount === 1 ? '' : 's'}`;
}

function agentCompletionProgressSummary(event: Extract<WorkflowEvent, { type: 'workflow.agent.completed' }>): string {
  const parts: string[] = [];
  if (
    event.phase
    && event.phaseCompletedAgentCount !== undefined
    && event.phaseKnownAgentCount !== undefined
  ) {
    parts.push(`Phase ${event.phase} (${event.phaseCompletedAgentCount}/${event.phaseKnownAgentCount})`);
  }
  parts.push(`${event.completedAgentCount} out of ${event.knownAgentCount} agents have completed the task`);
  parts.push(`${formatElapsedDuration(event.elapsedMs)} elapsed`);
  return parts.join(', ');
}

function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function progressPayloadForEvent(event: WorkflowEvent): ProgressPayload {
  switch (event.type) {
    case 'workflow.started':
      return {
        event: event.type,
        status: 'running',
        summary: `Workflow ${event.workflowName} started`,
        taskId: event.taskId,
        runId: event.runId,
        workflowName: event.workflowName,
        workflowSource: event.workflowSource,
        workflowSourcePath: event.workflowSourcePath,
        scriptHash: event.scriptHash,
      };
    case 'workflow.phase.planned':
      return {
        event: event.type,
        status: 'planned',
        summary: phasePlannedSummary(event),
        taskId: event.taskId,
        runId: event.runId,
        phaseIndex: event.phaseIndex,
        title: event.title,
        goal: event.goal,
        plannedAgentCount: event.plannedAgentCount,
        plannedAgents: event.plannedAgents,
      };
    case 'workflow.phase.started':
      return {
        event: event.type,
        status: 'running',
        summary: phaseStartedSummary(event),
        taskId: event.taskId,
        runId: event.runId,
        phaseIndex: event.phaseIndex,
        title: event.title,
        detail: event.detail,
        goal: event.goal,
        plannedAgentCount: event.plannedAgentCount,
        plannedAgents: event.plannedAgents,
      };
    case 'workflow.plan.ready':
      return {
        event: event.type,
        status: 'planned',
        summary: `Workflow planning snapshot: ${event.phases.length} known phase${event.phases.length === 1 ? '' : 's'}, mode=${event.mode}`,
        taskId: event.taskId,
        runId: event.runId,
        mode: event.mode,
        rationale: event.rationale,
        phaseCount: event.phases.length,
        planPhases: event.phases,
      };
    case 'workflow.log':
      return {
        event: event.type,
        status: 'running',
        summary: event.message,
        taskId: event.taskId,
        runId: event.runId,
        message: event.message,
      };
    case 'workflow.heartbeat':
      return {
        event: event.type,
        status: 'running',
        summary: `Still running: ${formatElapsedDuration(event.elapsedMs)} elapsed${event.phase ? `, phase ${event.phase}` : ''}, ${event.completedAgentCount}/${event.knownAgentCount} agents completed`,
        taskId: event.taskId,
        runId: event.runId,
        elapsedMs: event.elapsedMs,
        phase: event.phase,
        completedAgentCount: event.completedAgentCount,
        knownAgentCount: event.knownAgentCount,
        seq: event.seq,
      };
    case 'workflow.agent.started':
      return {
        event: event.type,
        status: 'running',
        summary: `Agent ${event.agentIndex + 1} started: ${event.label}`,
        taskId: event.taskId,
        runId: event.runId,
        agentIndex: event.agentIndex,
        agentId: event.agentId,
        label: event.label,
        phase: event.phase,
        promptPreview: event.promptPreview,
      };
    case 'workflow.agent.completed':
      return {
        event: event.type,
        status: 'completed',
        summary: `Agent ${event.agentIndex + 1} completed: ${event.label}. ${agentCompletionProgressSummary(event)}`,
        taskId: event.taskId,
        runId: event.runId,
        agentIndex: event.agentIndex,
        agentId: event.agentId,
        label: event.label,
        phase: event.phase,
        tokens: event.tokens,
        toolCalls: event.toolCalls,
        resultPreview: event.resultPreview,
        cached: event.cached,
        elapsedMs: event.elapsedMs,
        completedAgentCount: event.completedAgentCount,
        knownAgentCount: event.knownAgentCount,
        phaseCompletedAgentCount: event.phaseCompletedAgentCount,
        phaseKnownAgentCount: event.phaseKnownAgentCount,
        worktreePreserved: event.worktreePreserved,
        preservedWorktrees: event.preservedWorktrees,
      };
    case 'workflow.agent.failed':
      return {
        event: event.type,
        status: event.skipped ? 'skipped' : 'failed',
        summary: `Agent ${event.agentIndex + 1} ${event.skipped ? 'skipped' : 'failed'}: ${event.error}`,
        taskId: event.taskId,
        runId: event.runId,
        agentIndex: event.agentIndex,
        agentId: event.agentId,
        label: event.label,
        phase: event.phase,
        error: event.error,
        skipped: event.skipped,
        worktreePreserved: event.worktreePreserved,
        preservedWorktrees: event.preservedWorktrees,
      };
    case 'workflow.completed':
      return {
        event: event.type,
        status: 'completed',
        summary: `Workflow completed with ${event.agentCount} agent${event.agentCount === 1 ? '' : 's'}`,
        taskId: event.taskId,
        runId: event.runId,
        resultPath: event.resultPath,
        agentCount: event.agentCount,
        tokens: event.tokens,
        toolCalls: event.toolCalls,
        durationMs: event.durationMs,
      };
    case 'workflow.failed':
      return {
        event: event.type,
        status: 'failed',
        summary: `Workflow failed: ${event.recovery?.reason ?? event.error}`,
        taskId: event.taskId,
        runId: event.runId,
        error: event.error,
        reason: event.recovery?.reason,
        retryable: event.recovery?.retryable,
      };
  }
}

function formatPreview(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').slice(0, 160);
}

function parseIntOption(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseRetryLimit(value: string | undefined): number {
  if (value === undefined) return workflowDefaultRetryLimit();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('retry-limit must be a non-negative integer.');
  return parsed;
}

const MAX_RETRY_BACKOFF_MS = 60_000;

// Exponential backoff between whole-workflow retries: base doubles each attempt, capped.
// base 0 (default) disables the wait entirely, preserving immediate-retry behavior.
function computeRetryBackoffMs(base: number, retryIndex: number): number {
  if (base <= 0) return 0;
  return Math.min(base * 2 ** (retryIndex - 1), MAX_RETRY_BACKOFF_MS);
}

// A backoff wait that resolves early on SIGINT/SIGTERM so the retry loop can cancel
// cleanly instead of the default hard-kill during the pause between attempts.
async function interruptibleBackoff(ms: number): Promise<'elapsed' | 'interrupted'> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: 'elapsed' | 'interrupted'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve(outcome);
    };
    const onSignal = (): void => finish('interrupted');
    const timer = setTimeout(() => finish('elapsed'), ms);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

function parseWorktreeRetention(value: string | undefined): WorktreeRetention {
  if (value === undefined) return workflowDefaultWorktreeRetention();
  if (isWorktreeRetention(value)) return value;
  throw new Error('worktree-retention must be one of preserve-all, remove-clean.');
}

function parsePermissionPolicy(value: string | undefined): PermissionPolicy {
  if (value === undefined) return workflowDefaultPermissionPolicy();
  if (isWorkflowPermissionPolicy(value)) return value;
  throw new Error('permission must be one of ask, allow, or deny.');
}

function parseProgressMode(value: string | undefined): ProgressMode {
  if (value === undefined) return workflowDefaultProgressMode();
  if (isWorkflowProgressMode(value)) return value;
  throw new Error('progress must be one of jsonl or plain.');
}

function parseExecutionMode(value: string | undefined): ExecutionMode {
  if (value === undefined) return workflowDefaultExecutionMode();
  if (isWorkflowExecutionMode(value)) return value;
  throw new Error('execution must be one of background or attached.');
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  if (value === undefined) return codexDefaultReasoningEffort();
  if (isReasoningEffort(value)) return value;
  throw new Error('reasoning effort must be one of none, minimal, low, medium, high, xhigh, or max. Ultra is reserved for native Codex delegation.');
}

function parseVerbosity(value: string | undefined): Verbosity {
  if (value === undefined) return codexDefaultVerbosity();
  if (isVerbosity(value)) return value;
  throw new Error('verbosity must be one of low, medium, or high.');
}

function errorMessage(err: unknown): string {
  if (err instanceof UltracodeRequestError && err.code) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function helpText(): string {
  return `ultracode-for-codex

Commands:
  run        Run a workflow as a local CLI command.
  status     Show a background workflow status record.
  wait       Wait for a background workflow to reach a terminal state.
  logs       Print a background workflow progress JSONL file.
  result     Print a completed background workflow result JSON.
  cancel     Send SIGINT to a background workflow command.
  jobs       List background workflow jobs.
  list       Alias for jobs.
  archive    Export one background workflow job state to an archive JSON file.
  export     Alias for archive.
  worktree   Manage isolated agent worktrees. Subcommand: clean [--clean-only|--all --force] [--dry-run].
  skills     Report whether the installed Codex skill commands match this package; --install updates them.
  setup      Check readiness: package, Codex CLI, app-server, authentication, selected model/effort, and installed skill commands (alias: doctor).

Options:
  --version, -v                     Print the package version.
  --llm-guide                       Print the Ultracode install and usage guide.
  --accept-llm-guide <version>       Required for run. Current version: ${ULTRACODE_INSTALL_GUIDE_ACCEPT_VERSION}.
  --script <js>                      Inline workflow script.
  --script-file <path>               Workflow script file. A positional file path is also accepted.
  --script-path <path>               Runtime-owned persisted workflow script path.
  --name <name>                      Named workflow from .codex/workflows or built-ins.
  --resume-from-run-id <runId>        Resume a completed, failed, cancelled, or interrupted local workflow run from preserved runtime state; run it from the source run's working directory.
  --validate                         Validate the workflow source without running agents: hard-fails structural problems, prints static schema/key warnings.
  --args <json>                      Workflow args JSON. Default: {}; resume runs inherit prior args when omitted.
  --args-file <path>                 Read workflow args JSON from a file.
  --permission <ask|allow|deny>      Permission review behavior. Default: settings.json (${workflowDefaultPermissionPolicy()}).
  --retry-limit <number>             Retry failed workflows in the same process. Default: settings.json (${workflowDefaultRetryLimit()}).
  --retry-backoff-ms <number>        Exponential backoff before each retry (doubles per attempt, capped, cancellable); 0 disables. Default: settings.json (${workflowDefaultRetryBackoffMs()}).
  --worktree-retention <preserve-all|remove-clean>  Reclaim unchanged completed isolated worktrees. Default: settings.json (${workflowDefaultWorktreeRetention()}).
  --progress <jsonl|plain>           Progress format on stderr. Default: settings.json (${workflowDefaultProgressMode()}).
  --execution <background|attached>  Execution mode. Default: settings.json (${workflowDefaultExecutionMode()}).
  --command <path>                   Override Codex CLI binary path.
  --model <model>                    Select a model verified against Codex model/list. Example: gpt-5.6-sol.
  --timeout-ms <number>              Runtime timeout; 0 waits for completion/cancel. Default: settings.json (${workflowDefaultTimeoutMs()}).
  --heartbeat-ms <number>            Emit a non-destructive workflow.heartbeat every N ms while running; 0 disables. Default: settings.json (${workflowDefaultHeartbeatMs()}).
  --cwd <dir>                        Working directory for workflow execution. Default: current cwd.
  --reasoning-effort <effort>        Codex effort: none|minimal|low|medium|high|xhigh|max. Default: settings.json (${codexDefaultReasoningEffort()}).
  --verbosity <verbosity>            Codex verbosity. Default: settings.json (${codexDefaultVerbosity()}).

Background command options:
  <jobId|metadataPath>               Background job id or metadata.json path.
  --job-id <id>                      Background job id.
  --metadata-path <path>             Path to metadata.json from a launch record.
  --result-path <path>               Override result.json path.
  --progress-path <path>             Override progress.jsonl path.
  --pid-path <path>                  Override pid path.
  --interval-ms <number>             wait polling interval. Default: 1000.
  --tail <number>                    logs line count. Default: all lines.
  --event <event>                    logs event filter, such as workflow.agent.completed.
  --signal <SIGINT|SIGTERM|SIGHUP>   cancel signal. Default: SIGINT.
  --plain                            Print a human-readable background summary.
  --result                           wait prints the workflow result on completion.
  --wait                             cancel waits for terminal workflow status.
  --out-dir <dir>                    archive output directory. Default: .ultracode-for-codex/archive.
  --output-path <path>               archive output file path.
  --install                          skills copies the packaged skill commands into \${CODEX_HOME:-~/.codex}/skills.
`;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
