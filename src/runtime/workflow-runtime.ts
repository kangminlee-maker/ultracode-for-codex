import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createContext, runInContext } from 'node:vm';
import type { AgentConcurrency, ReasoningEffort, SubagentBackend, SubagentRequest, SubagentResult, SubagentUsage, WorktreeRetention } from './types.js';
import { SUBAGENT_MODEL_PLACEHOLDER, UltracodeRequestError, estimateTokens, isReasoningEffort, isSubagentFailure } from './types.js';
import { AgentConcurrencyPool } from './agent-concurrency-pool.js';
import {
  WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
  WORKFLOW_JOURNAL_WRITE_FAILED_REASON,
  WorkflowJournalError,
  WorkflowJournalValidationError,
  WorkflowJournalWriter,
  computeWorkflowAgentCallKey,
  isWorkflowJournalError,
  normalizeJournalJsonValue,
  readWorkflowJournal,
  stableJson,
  workflowJournalPath,
} from './workflow-journal.js';
import type {
  JsonValue,
  WorkflowAgentSemanticOpts,
  WorkflowJournalEntry,
  WorkflowJournalDurability,
  WorkflowJournalUsage,
} from './workflow-journal.js';
import { defaultUltracodeStateRoot, defaultWorkflowStateDir } from './state-root.js';

export type WorkflowTaskStatus = 'running' | 'completed' | 'failed';
export type WorkflowTaskType = 'local_workflow';
export type WorkflowSource = 'inline' | 'script_path' | 'project' | 'user' | 'plugin' | 'built_in';
export type WorkflowPermissionDecision = 'allow' | 'deny';
type AgentIsolation = 'worktree';

export interface WorkflowPlanAgent {
  readonly id?: string;
  readonly title: string;
  readonly focus?: string;
  readonly label?: string;
}

export interface WorkflowPlanPhase {
  readonly id?: string;
  readonly title: string;
  readonly goal?: string;
  readonly agents: readonly WorkflowPlanAgent[];
}

interface WorkflowExecutionPlan {
  readonly mode: string;
  readonly rationale?: string;
  readonly phases: readonly WorkflowPlanPhase[];
}

export type WorkflowEvent =
  | {
      readonly type: 'workflow.started';
      readonly taskId: string;
      readonly runId: string;
      readonly workflowName: string;
      readonly scriptPath: string;
      readonly workflowSource: WorkflowSource;
      readonly workflowSourcePath?: string;
      readonly scriptHash: string;
    }
  | {
      readonly type: 'workflow.phase.started';
      readonly taskId: string;
      readonly runId: string;
      readonly phaseIndex: number;
      readonly title: string;
      readonly detail?: string;
      readonly goal?: string;
      readonly plannedAgentCount?: number;
      readonly plannedAgents?: readonly WorkflowPlanAgent[];
    }
  | {
      readonly type: 'workflow.plan.ready';
      readonly taskId: string;
      readonly runId: string;
      readonly mode: string;
      readonly rationale?: string;
      readonly phases: readonly WorkflowPlanPhase[];
    }
  | {
      readonly type: 'workflow.phase.planned';
      readonly taskId: string;
      readonly runId: string;
      readonly phaseIndex: number;
      readonly title: string;
      readonly goal?: string;
      readonly plannedAgentCount: number;
      readonly plannedAgents: readonly WorkflowPlanAgent[];
    }
  | {
      readonly type: 'workflow.log';
      readonly taskId: string;
      readonly runId: string;
      readonly message: string;
    }
  | {
      // Non-destructive liveness signal: emitted every heartbeatMs while a run
      // is in flight so a long or stuck run stays visible under an unbounded
      // (timeout 0) deadline. It never aborts or retries anything.
      readonly type: 'workflow.heartbeat';
      readonly taskId: string;
      readonly runId: string;
      readonly elapsedMs: number;
      readonly phase?: string;
      readonly completedAgentCount: number;
      readonly knownAgentCount: number;
      readonly seq: number;
    }
  | {
      readonly type: 'workflow.agent.started';
      readonly taskId: string;
      readonly runId: string;
      readonly agentIndex: number;
      readonly agentId: string;
      readonly label: string;
      readonly phase?: string;
      readonly promptPreview: string;
    }
  | {
      readonly type: 'workflow.agent.completed';
      readonly taskId: string;
      readonly runId: string;
      readonly agentIndex: number;
      readonly agentId: string;
      readonly label: string;
      readonly phase?: string;
      readonly tokens: number;
      readonly toolCalls: number;
      readonly resultPreview?: string;
      readonly cached?: boolean;
      readonly elapsedMs: number;
      readonly completedAgentCount: number;
      readonly knownAgentCount: number;
      readonly phaseCompletedAgentCount?: number;
      readonly phaseKnownAgentCount?: number;
      readonly worktreePath?: string;
      readonly worktreePreserved?: boolean;
      readonly preservedWorktrees?: readonly WorkflowAgentPreservedWorktree[];
    }
  | {
      readonly type: 'workflow.agent.failed';
      readonly taskId: string;
      readonly runId: string;
      readonly agentIndex: number;
      readonly agentId: string;
      readonly label: string;
      readonly phase?: string;
      readonly error: string;
      readonly skipped?: boolean;
      readonly worktreePath?: string;
      readonly worktreePreserved?: boolean;
      readonly preservedWorktrees?: readonly WorkflowAgentPreservedWorktree[];
    }
  | {
      readonly type: 'workflow.completed';
      readonly taskId: string;
      readonly runId: string;
      readonly resultPath: string;
      readonly agentCount: number;
      readonly tokens: number;
      readonly toolCalls: number;
      readonly durationMs: number;
    }
  | {
      readonly type: 'workflow.failed';
      readonly taskId: string;
      readonly runId: string;
      readonly error: string;
      readonly recovery?: { readonly retryable: boolean; readonly reason: string };
    };

export interface WorkflowLaunchInput {
  readonly script?: string;
  readonly name?: string;
  readonly scriptPath?: string;
  readonly args?: unknown;
  readonly resumeFromRunId?: string;
  readonly toolName?: string;
}

export type WorkflowLaunchResult = WorkflowAsyncLaunchResult | WorkflowPermissionRequiredResult;

export interface WorkflowAsyncLaunchResult {
  readonly status: 'async_launched';
  readonly taskId: string;
  readonly taskType: 'local_workflow';
  readonly workflowName: string;
  readonly runId: string;
  readonly summary?: string;
  readonly transcriptDir: string;
  readonly scriptPath: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourcePath?: string;
  readonly scriptHash: string;
}

export interface WorkflowPermissionRequiredResult {
  readonly status: 'permission_required';
  readonly taskType: WorkflowTaskType;
  readonly workflowName: string;
  readonly summary?: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourcePath?: string;
  readonly scriptHash: string;
  readonly permissionRequestId: string;
  readonly review: WorkflowPermissionReview;
}

export interface WorkflowPermissionDeniedResult {
  readonly status: 'permission_denied';
  readonly taskType: WorkflowTaskType;
  readonly workflowName: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourcePath?: string;
  readonly scriptHash: string;
  readonly permissionRequestId: string;
  readonly reason: 'workflow_permission_denied';
}

export interface WorkflowPermissionReview {
  readonly permissionRequestId: string;
  readonly reviewVersion: number;
  readonly workflowName: string;
  readonly summary?: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourcePath?: string;
  readonly scriptHash: string;
  readonly phases: readonly string[];
  readonly requestedIsolationModes: readonly string[];
  readonly dynamicIsolation: boolean;
  readonly riskSummary: string;
  readonly scriptPreview: string;
}

export interface WorkflowTaskSnapshot {
  readonly taskId: string;
  readonly runId: string;
  readonly workflowName: string;
  readonly status: WorkflowTaskStatus;
  readonly taskType: WorkflowTaskType;
  readonly transcriptDir: string;
  readonly scriptPath: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourcePath?: string;
  readonly scriptHash: string;
  readonly resultPath?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly failureReason?: string;
  readonly events: readonly WorkflowEvent[];
}

export interface WorkflowRuntime {
  launch(input: WorkflowLaunchInput): Promise<WorkflowLaunchResult>;
  get(taskId: string): WorkflowTaskSnapshot | null;
  cancel(taskId: string): Promise<WorkflowTaskSnapshot>;
  retry(taskId: string): Promise<WorkflowLaunchResult>;
  getPermissionRequest(permissionRequestId: string): WorkflowPermissionReview | null;
  approvePermissionRequest(permissionRequestId: string): Promise<WorkflowLaunchResult>;
  denyPermissionRequest(permissionRequestId: string): Promise<WorkflowPermissionDeniedResult>;
  streamEvents(taskId: string, signal?: AbortSignal): AsyncIterable<WorkflowEvent>;
  close?(): Promise<void>;
}

interface WorkflowTaskMutable {
  taskId: string;
  runId: string;
  workflowName: string;
  status: WorkflowTaskStatus;
  taskType: WorkflowTaskType;
  transcriptDir: string;
  scriptPath: string;
  workflowSource: WorkflowSource;
  workflowSourcePath?: string;
  scriptHash: string;
  isolationReview: WorkflowIsolationReview;
  startedAt: number;
  journal: WorkflowJournalWriter;
  resultPath?: string;
  result?: unknown;
  error?: string;
  failureReason?: string;
  events: WorkflowEvent[];
  waiters: Array<() => void>;
  terminalEmitted: boolean;
  terminalFinalization?: Promise<WorkflowTaskSnapshot>;
  runPromise?: Promise<void>;
  abortRequested?: boolean;
  abortFailure?: { readonly message: string; readonly reason: string };
  retryInput: ResolvedWorkflowLaunchInput;
  controller?: AbortController;
}

type ResolvedWorkflowLaunchInput = Required<Pick<WorkflowLaunchInput, 'script'>> & WorkflowLaunchInput & {
  readonly workflowSource: WorkflowSource;
  readonly workflowSourcePath?: string;
  readonly scriptMetadata?: WorkflowScriptMetadata;
};

interface ParsedWorkflowScript {
  readonly meta: WorkflowMeta;
  readonly body: string;
  readonly metaLiteral: string;
}

interface WorkflowMeta {
  readonly name: string;
  readonly description?: string;
  readonly phases?: readonly {
    readonly title: string;
    readonly detail?: string;
  }[];
}

interface WorkflowRunContext {
  readonly task: WorkflowTaskMutable;
  readonly parsed: ParsedWorkflowScript;
  readonly input: WorkflowLaunchInput;
  readonly isolationReview: WorkflowIsolationReview;
  readonly resumeCache?: WorkflowResumeCache;
  readonly startedAt: number;
  readonly model: string;
  inputTokens: number;
  outputTokens: number;
  agentCount: number;
  tokens: number;
  toolCalls: number;
  readonly controller: AbortController;
  readonly timers: Map<number, ReturnType<typeof setTimeout>>;
  readonly asyncFinalizers: Set<Promise<void>>;
  nextTimerId: number;
  previousAgentCallKey: string;
  readonly usedLogicalKeys: Set<string>;
  // One permit pool per run bounds concurrent agent dispatches. Undefined = unbounded.
  readonly agentPool?: AgentConcurrencyPool;
  // Per-run output-token ceiling, or null when unset (inert). budget.spent()/remaining()
  // and the pre-dispatch ceiling read it; counts this run's fresh spend only (cached = 0).
  readonly budgetTotal: number | null;
  currentPhase?: string;
  announcedPlan?: WorkflowExecutionPlan;
  pendingPhasePlan?: WorkflowPlanPhase;
  toVmValue?: (value: unknown) => unknown;
}

interface WorkflowVmGlobals {
  readonly argsLiteral: string;
  readonly budgetLiteral: string;
  // The run's output-token ceiling as a JSON literal ('null' when unset). Defined as a
  // non-enumerable budget.total so the budget key set is byte-identical whether set or not.
  readonly budgetTotalLiteral: string;
  readonly host: Record<string, unknown>;
  readonly setVmValueProjector: (projector: (value: unknown) => unknown) => void;
}

type HandledWorkflowPromise<T> = PromiseLike<T> & {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): HandledWorkflowPromise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): HandledWorkflowPromise<T | TResult>;
  finally(onfinally?: (() => void) | null): HandledWorkflowPromise<T>;
};

interface WorkflowPromiseTracking {
  handled: boolean;
  projectValue(value: unknown): unknown;
  trackPromise<T>(promise: Promise<T>): HandledWorkflowPromise<T>;
}

interface WorkflowTaskRegistryOptions {
  readonly backend: SubagentBackend;
  readonly cwd?: string;
  readonly stateDir?: string;
  readonly requestTimeoutMs: number;
  readonly defaultReasoningEffort?: ReasoningEffort;
  readonly agentStallTimeoutMs?: number;
  readonly agentStallRetryLimit?: number;
  // Emit a non-destructive workflow.heartbeat every heartbeatMs while running.
  // 0 (or omitted) disables it, preserving the pre-heartbeat event stream.
  readonly heartbeatMs?: number;
  // Retention policy for isolated agent worktrees. Omitted defaults to 'preserve-all'
  // (current behavior); 'remove-clean' reclaims unchanged completed worktrees.
  readonly worktreeRetention?: WorktreeRetention;
  // Bound on concurrent agent dispatches per run. Omitted or 'unbounded' applies no
  // pool (current behavior). 'auto' derives a size from CPUs; a positive integer pins it.
  readonly agentConcurrency?: AgentConcurrency;
  // Per-run output-token ceiling. Omitted or null = inert (no ceiling, remaining() Infinity).
  readonly budgetTotal?: number | null;
  readonly userWorkflowDirs?: readonly string[];
  readonly pluginWorkflows?: readonly WorkflowPluginRegistry[];
  readonly builtinWorkflows?: readonly BuiltinWorkflow[];
  readonly journalDurability?: WorkflowJournalDurability;
}

interface WorkflowPluginRegistry {
  readonly pluginName: string;
  readonly workflowsDir?: string;
  readonly workflowsDirs?: readonly string[];
  readonly workflowsPath?: string;
  readonly workflowsPaths?: readonly string[];
}

interface BuiltinWorkflow {
  readonly name: string;
  readonly script: string;
}

interface WorkflowScriptMetadata {
  readonly version: 1;
  readonly workflowName: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourcePath?: string;
  readonly scriptHash: string;
  readonly permissionKey?: string;
}

interface WorkspaceContextOptions {
  readonly query?: string;
  readonly files: readonly string[];
  readonly includeDiff: boolean;
  readonly diffBaseRef?: string;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxBytes: number;
  readonly maxDiffBytes: number;
}

interface WorkflowPermissionRequestMutable {
  readonly permissionRequestId: string;
  readonly permissionKey: string;
  readonly input: WorkflowLaunchInput;
  readonly review: WorkflowPermissionReview;
}

interface WorkflowPermissionRecord {
  readonly permissionKey: string;
  readonly decision: WorkflowPermissionDecision;
  readonly reviewVersion?: number;
  readonly workflowName: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourcePath?: string;
  readonly scriptHash: string;
  readonly requestedIsolationModes?: readonly string[];
  readonly dynamicIsolation?: boolean;
  readonly isolationReviewFingerprint?: string;
  readonly decidedAt: string;
}

interface WorkflowPermissionStore {
  readonly version: 1;
  readonly decisions: readonly WorkflowPermissionRecord[];
}

interface WorkflowResumePlan {
  readonly launchInput: WorkflowLaunchInput;
  readonly sourceTask?: WorkflowResumeSource;
}

interface WorkflowResumeSource {
  readonly runId: string;
  readonly status: WorkflowTaskStatus;
  readonly transcriptDir: string;
  readonly retryInput: WorkflowLaunchInput;
  readonly workflowName?: string;
  readonly scriptHash?: string;
}

interface WorkflowResumeSourceJournal {
  readonly entries: readonly WorkflowJournalEntry[];
  readonly started: Extract<WorkflowJournalEntry, { readonly kind: 'workflow.run.started' }>;
  readonly terminal?: Extract<WorkflowJournalEntry, { readonly kind: 'workflow.run.completed' | 'workflow.run.failed' }>;
  readonly truncatedTail: boolean;
}

type WorkflowResumeSourceTerminal = 'completed' | 'failed' | 'interrupted';

interface WorkflowResumeSourceInfo {
  readonly runId: string;
  readonly terminal: WorkflowResumeSourceTerminal;
  readonly terminalReason?: string;
  readonly model?: string;
  readonly workspaceFingerprint?: string;
  readonly completedAgentCount: number;
}

interface DurableWorkflowResultRecord {
  readonly runId: string;
  readonly workflowName: string;
  readonly scriptHash: string;
  readonly retryInput?: WorkflowLaunchInput;
}

interface WorkflowResumeCache {
  readonly entries: readonly WorkflowResumeAgentCacheEntry[];
  readonly byCallKey: Map<string, WorkflowResumeAgentCacheEntry>;
  readonly usedCallKeys: Set<string>;
  nextIndex: number;
  prefixOpen: boolean;
  readonly source: WorkflowResumeSourceInfo;
}

interface WorkflowResumeAgentCacheEntry {
  readonly agentCallKey: string;
  readonly result: JsonValue;
}

interface WorkflowAgentWorktree {
  readonly gitRoot: string;
  readonly path: string;
  readonly attemptIndex: number;
}

export interface WorkflowAgentPreservedWorktree {
  readonly path: string;
  readonly attemptIndex: number;
  readonly reason: 'clean' | 'changed' | 'stalled' | 'aborted' | 'status_unavailable';
}

interface WorkflowAgentWorktreeFinalization {
  readonly preserved: boolean;
  readonly preservedWorktree?: WorkflowAgentPreservedWorktree;
}

interface WorkflowAgentAttemptOutcome {
  readonly result: SubagentResult;
  readonly worktreeFinalization?: WorkflowAgentWorktreeFinalization;
}

interface AgentOptions {
  readonly label?: string;
  readonly key?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly phase?: string;
  readonly schema?: unknown;
  readonly isolation?: unknown;
}

const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_AGENT_CALLS = 1000;
const MAX_PARALLELISM = 16;
// Native parity: a single parallel()/pipeline() call accepts at most this many items;
// beyond it the call is an explicit error, not a silent truncation.
const MAX_PARALLEL_ITEMS = 4096;
const DEFAULT_AGENT_STALL_RETRY_LIMIT = 5;
const DEFAULT_WORKSPACE_CONTEXT_MAX_FILES = 24;
const DEFAULT_WORKSPACE_CONTEXT_MAX_FILE_BYTES = 12_000;
const DEFAULT_WORKSPACE_CONTEXT_MAX_BYTES = 80_000;
const DEFAULT_WORKSPACE_CONTEXT_MAX_DIFF_BYTES = 60_000;
const execFileAsync = promisify(execFile);
const PROJECT_WORKFLOW_DIRS = ['.codex/workflows'];
const WORKFLOW_PERMISSION_REQUIRED_SOURCES = new Set<WorkflowSource>(['script_path', 'project', 'user', 'plugin']);
const WORKFLOW_PERMISSION_STORE_VERSION = 1;
const WORKFLOW_PERMISSION_REVIEW_VERSION = 2;
const WORKFLOW_STATE_DIR_MODE = 0o700;
const WORKFLOW_STATE_FILE_MODE = 0o600;
const WORKFLOW_TOOL_NAMES = new Set(['Workflow', 'RunWorkflow']);
const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';
const WORKFLOW_INPUT_PARAM = 'workflow';
const WORKFLOW_JOURNAL_PUBLIC_FAILURE_MESSAGE = 'Workflow journal write failed.';
const WORKFLOW_STABLE_FAILURE_CODES = new Set([
  WORKFLOW_JOURNAL_WRITE_FAILED_REASON,
  'runtime_closed',
  'workflow_aborted',
  'workflow_agent_failed',
  'workflow_agent_terminal',
  'workflow_agent_stalled',
  'workflow_input_invalid',
  'workflow_meta_invalid',
  'workflow_permission_denied',
  'workflow_resume_running',
  'workflow_script_nondeterministic',
  'workflow_structured_output_failed',
]);
// Failure reasons worth re-running: transient/backend/stochastic classes. Every other
// reason — deterministic config/validation/control failures and any unrecognized code —
// is non-retryable so a stable failure is not retried to exhaustion. Invariant: this set
// stays a subset of WORKFLOW_STABLE_FAILURE_CODES ∪ {'workflow_failed'} (the backend
// catch-all), and a newly introduced failure code defaults to non-retryable until listed.
const WORKFLOW_RETRYABLE_FAILURE_CODES = new Set([
  'workflow_failed',
  'workflow_agent_failed',
  'workflow_agent_stalled',
  WORKFLOW_JOURNAL_WRITE_FAILED_REASON,
  'workflow_structured_output_failed',
]);
const FORBIDDEN_HOST_PROPERTY_NAMES = new Set(['constructor', 'prototype', '__proto__', 'process', 'require', 'globalThis', 'global', 'module', 'exports']);
const JSON_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const JSON_SCHEMA_KEYS = new Set([
  '$schema',
  'additionalProperties',
  'description',
  'enum',
  'items',
  'maximum',
  'maxItems',
  'maxLength',
  'minimum',
  'minItems',
  'minLength',
  'properties',
  'required',
  'title',
  'type',
]);
const WORKSPACE_CONTEXT_EXCLUDED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.ultracode-for-codex',
  'artifacts',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);
const EMPTY_WORKSPACE_PATH_EXCLUSIONS: ReadonlySet<string> = new Set();
const WORKSPACE_CONTEXT_ALLOWED_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.go',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const WORKSPACE_CONTEXT_PRIORITY_FILES = new Set([
  'AGENTS.md',
  'CONTRACT.md',
  'IMPLEMENTATION_MAP.html',
  'README.md',
  'SKILL.md',
  'ULTRACODE_INSTALL.md',
  'package.json',
  'tsconfig.json',
]);
const DYNAMIC_WORKFLOW_PATTERN_GUIDANCE = [
  'Use dynamic workflow patterns intentionally:',
  '- classify-and-act: classify the request, risk, or repository area before choosing phase shape.',
  '- fan-out-and-synthesize: split independent lenses across parallel agents, then merge evidence.',
  '- adversarial verification: assign at least one agent to challenge correctness, security, or assumptions on high-risk work.',
  '- generate-and-filter: create candidate approaches or fixes, then select by evidence and constraints.',
  '- tournament: compare competing alternatives when the best path is unclear.',
  '- loop-until-done: iterate repair and verification only when there is a clear stop condition.',
  'Prefer pipelines when later phases need earlier summaries; prefer parallel agents when independent evidence can be gathered at the same time.',
].join('\n');
const DEFAULT_BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = [
  {
    name: 'task',
    script: phaseWiseBuiltinWorkflowScript({
      name: 'task',
      description: 'Run a read-only, evidence-bound planning and analysis workflow for a repository task',
      defaultPrompt: 'Analyze the requested repository task and return evidence-bound implementation guidance.',
      plannerKind: 'read-only repository analysis task',
      plannerGuidance: 'Choose the smallest non-overlapping plan that covers the request. Default to phase_parallel only when agents can inspect distinct evidence or challenge distinct risks. Choose single for tiny, sequential, or indivisible work.',
      agentGuidance: 'Produce the assigned analysis outcome, not a broad essay. Ground material claims in files actually read or the supplied workspace evidence, label inferences, re-check conclusions, and state missing evidence instead of guessing. The main orchestrator owns any edits.',
      finalGuidance: 'Return implementation-ready guidance: observed evidence, reasoned conclusions, decisions, verification needed, and residual risk. Do not claim files were changed or checks were run unless an agent output proves it.',
    }),
  },
  {
    name: 'code-review',
    script: codeReviewBuiltinWorkflowScript(),
  },
  {
    name: 'batch',
    script: `export const meta = {
  name: "batch",
  description: "Run explicitly supplied prompts in one parallel phase"
};
const input = args && typeof args === "object" ? args : {};
const prompts = Array.isArray(input.prompts) ? input.prompts : [];
if (prompts.length > 0) {
  announcePhasePlan({
    title: "Batch",
    agents: prompts.map((_, index) => ({
      title: "Batch " + (index + 1),
      label: "batch-" + (index + 1)
    }))
  });
}
phase("Batch");
return await parallel(prompts.map((prompt, index) => () => agent(
  prompt == null ? "" : "" + prompt,
  { label: "batch-" + (index + 1) }
)));`,
  },
];

function codeReviewBuiltinWorkflowScript(): string {
  return `export const meta = {
  name: "code-review",
  description: "Run a dynamic evidence-bound code review workflow"
};
const workflowInput = args && typeof args === "object" ? args : {};
const prompt = typeof workflowInput.prompt === "string" && workflowInput.prompt.trim()
  ? workflowInput.prompt
  : "Review the current repository for correctness risks.";
const level = workflowInput.level === "high" ? "high" : "xhigh";
const scopeEffort = level === "high" ? "medium" : "xhigh";
const verdictEffort = level === "high" ? "high" : "xhigh";
const caps = level === "high"
  ? { maxFinders: 8, maxCandidatesPerLens: 6, sweep: false, reportCap: 10 }
  : { maxFinders: 10, maxCandidatesPerLens: 8, sweep: true, reportCap: 15 };
const seedLenses = [
  { id: "diff-correctness", title: "Diff correctness", kind: "correctness", focus: "Inspect touched hunks and enclosing behavior for runtime bugs." },
  { id: "removed-behavior", title: "Removed behavior", kind: "correctness", focus: "Check deleted or replaced guards, validation, errors, and tests." },
  { id: "cross-file-contract", title: "Cross-file contract", kind: "contract", focus: "Trace callers, callees, preconditions, and return shapes." },
  { id: "language-platform", title: "Language/platform pitfalls", kind: "correctness", focus: "Look for language, framework, and environment-sensitive footguns." },
  { id: "wrapper-delegation", title: "Wrapper/delegation correctness", kind: "contract", focus: "Check adapters, proxies, caches, decorators, and delegation paths." },
  { id: "security-boundary", title: "Security/capability boundary", kind: "security", focus: "Check authority, permissions, credential handling, and local state exposure." },
  { id: "persistence-retry-cancel", title: "Persistence/retry/cancel", kind: "persistence", focus: "Check journals, resume/cache, retries, cancellation, and terminal states." },
  { id: "cli-user-contract", title: "CLI/user contract", kind: "contract", focus: "Check commands, settings, progress, package contents, and documented behavior." },
  { id: "tests-package-coverage", title: "Tests/package coverage", kind: "coverage", focus: "Check whether tests and packaged artifacts cover changed behavior." },
  { id: "maintainability", title: "Maintainability/conventions", kind: "maintainability", focus: "Check duplication, altitude, and repository instruction alignment." }
];
const scopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["files", "summary", "instructions", "lensDecisions", "lenses"],
  properties: {
    files: { type: "array", items: { type: "string", minLength: 1, maxLength: 240 } },
    summary: { type: "string", minLength: 1 },
    instructions: { type: ["string", "null"] },
    lensDecisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seedId", "action", "selectedLensId", "reasonCategory", "decisionRefs", "reason"],
        properties: {
          seedId: { type: "string", minLength: 1 },
          action: { type: "string", enum: ["select", "skip"] },
          selectedLensId: { type: ["string", "null"] },
          reasonCategory: { type: "string", enum: ["matched_change", "prompt_risk", "no_evidence", "cap_limit", "redundant", "out_of_scope", "tiny_change"] },
          decisionRefs: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          reason: { type: "string", minLength: 1 }
        }
      }
    },
    lenses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "focus", "kind"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          title: { type: "string", minLength: 1, maxLength: 120 },
          focus: { type: "string", minLength: 1, maxLength: 1000 },
          kind: { type: "string", enum: ["correctness", "security", "contract", "persistence", "coverage", "maintainability"] }
        }
      }
    }
  }
};
const finderSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "summary", "failureScenario", "evidenceRefs", "kind"],
        properties: {
          file: { type: "string", minLength: 1, maxLength: 240 },
          line: { type: ["integer", "null"], minimum: 1 },
          summary: { type: "string", minLength: 1 },
          failureScenario: { type: "string", minLength: 1 },
          evidenceRefs: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          kind: { type: ["string", "null"] }
        }
      }
    }
  }
};
const verifierSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "evidence", "evidenceRefs", "severity"],
  properties: {
    verdict: { type: "string", enum: ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    evidence: { type: "string", minLength: 1 },
    evidenceRefs: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    severity: { type: ["string", "null"], enum: ["P0", "P1", "P2", "P3", null] }
  }
};
const synthesisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "decisions"],
  properties: {
    summary: { type: "string", minLength: 1 },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "action", "merge", "severity", "reasonCategory", "reason"],
        properties: {
          index: { type: "integer", minimum: 0 },
          action: { type: "string", enum: ["report", "merge", "drop"] },
          merge: { type: ["array", "null"], minItems: 1, items: { type: "integer", minimum: 0 } },
          severity: { type: ["string", "null"], enum: ["P0", "P1", "P2", "P3", null] },
          reasonCategory: { type: "string", enum: ["material", "duplicate", "not_material", "report_cap", "unsupported_evidence", "superseded"] },
          reason: { type: "string", minLength: 1 }
        }
      }
    }
  }
};
function fail(message) {
  throw "code-review invalid: " + message;
}
function text(value) {
  return value == null ? "" : "" + value;
}
function errorText(err) {
  if (err && typeof err.message === "string") return err.message;
  try {
    const json = JSON.stringify(err);
    if (json) return json;
  } catch (_err) {}
  return text(err);
}
function lines(value) {
  return text(value).split(/\\r?\\n/);
}
function firstLineValue(context, prefix) {
  const all = lines(context);
  for (let index = 0; index < all.length; index += 1) {
    if (all[index].indexOf(prefix) === 0) return all[index].slice(prefix.length).trim();
  }
  return "";
}
function sectionLines(context, title, endTitles) {
  const all = lines(context);
  let start = -1;
  for (let index = 0; index < all.length; index += 1) {
    if (all[index] === title) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return [];
  const out = [];
  for (let index = start; index < all.length; index += 1) {
    if (endTitles.indexOf(all[index]) >= 0) break;
    const line = all[index].trim();
    if (line && line !== "(none)") out.push(line);
  }
  return out;
}
function objectMap(values) {
  const map = {};
  for (let index = 0; index < values.length; index += 1) map[values[index]] = true;
  return map;
}
function normalizeKey(value, fallback) {
  const raw = text(value || fallback).trim().toLowerCase();
  const replaced = raw.replace(/[^a-z0-9_.:/@+-]+/g, "-").replace(/^-+|-+$/g, "");
  return replaced ? replaced.slice(0, 80) : fallback;
}
function uniquePush(list, item) {
  if (list.indexOf(item) < 0) list.push(item);
}
function failUnsupportedRef(prefix, value, refSet) {
  fail(prefix + " " + value + ": not in " + refSet.name + " (" + refSet.size + " entries) derived from " + refSet.source + "; populated by " + refSet.populatedBy);
}
function assertDecisionRefs(refs, label) {
  if (!Array.isArray(refs) || refs.length < 1) fail(label + " must include evidence or decision refs.");
  for (let index = 0; index < refs.length; index += 1) {
    const ref = text(refs[index]);
    if (!allowedEvidenceRefMap[ref] && !unavailableEvidenceRefMap[ref] && ref !== "prompt:request") {
      failUnsupportedRef(label + " includes unsupported decision ref", ref, decisionRefSet);
    }
  }
}
function assertEvidenceRefs(refs, label) {
  if (!Array.isArray(refs) || refs.length < 1) fail(label + " must include at least one evidence ref.");
  for (let index = 0; index < refs.length; index += 1) {
    const ref = text(refs[index]);
    if (!allowedEvidenceRefMap[ref]) failUnsupportedRef(label + " includes unsupported evidence ref", ref, evidenceRefSet);
  }
}
function validateFile(file, label) {
  const ref = "file:" + text(file);
  if (!allowedFileRefMap[ref]) failUnsupportedRef(label + " references unsupported file", text(file), fileRefSet);
}
function selectedDecisionMatches(decision, lens) {
  if (decision.action !== "select") return false;
  const selected = normalizeKey(decision.selectedLensId || decision.seedId, decision.seedId);
  return selected === lens.lensKey || selected === normalizeKey(lens.id, lens.lensKey);
}
function validateScope(scope) {
  for (let index = 0; index < scope.files.length; index += 1) validateFile(scope.files[index], "scope.files[" + index + "]");
  for (let index = 0; index < scope.lensDecisions.length; index += 1) {
    assertDecisionRefs(scope.lensDecisions[index].decisionRefs, "scope.lensDecisions[" + index + "]");
  }
  const selected = [];
  const seen = {};
  for (let index = 0; index < scope.lenses.length; index += 1) {
    const rawLens = scope.lenses[index];
    const lensKey = normalizeKey(rawLens.id, "lens-" + (index + 1));
    if (seen[lensKey]) fail("duplicate selected lens " + lensKey);
    const lens = {
      id: text(rawLens.id),
      lensKey: lensKey,
      title: text(rawLens.title),
      focus: text(rawLens.focus),
      kind: text(rawLens.kind),
      position: index
    };
    let matched = false;
    for (let decisionIndex = 0; decisionIndex < scope.lensDecisions.length; decisionIndex += 1) {
      if (selectedDecisionMatches(scope.lensDecisions[decisionIndex], lens)) matched = true;
    }
    if (!matched) fail("selected lens lacks matching select decision " + lensKey);
    seen[lensKey] = true;
    if (selected.length < caps.maxFinders) selected.push(lens);
  }
  return selected;
}
function validateCandidate(candidate, label) {
  validateFile(candidate.file, label + ".file");
  assertEvidenceRefs(candidate.evidenceRefs, label + ".evidenceRefs");
  return {
    file: text(candidate.file),
    line: Number.isInteger(candidate.line) ? candidate.line : null,
    summary: text(candidate.summary),
    failureScenario: text(candidate.failureScenario),
    evidenceRefs: candidate.evidenceRefs.map((item) => text(item)),
    kind: text(candidate.kind || "unspecified")
  };
}
function validateVerifier(verifier, label) {
  assertEvidenceRefs(verifier.evidenceRefs, label + ".evidenceRefs");
  return {
    verdict: verifier.verdict,
    evidence: text(verifier.evidence),
    evidenceRefs: verifier.evidenceRefs.map((item) => text(item)),
    severity: verifier.severity || "P2"
  };
}
function finderLabel(lens) {
  return "code-review-find-" + lens.lensKey;
}
function verifierLabel(envelope) {
  return "code-review-verify-" + envelope.lensKey + "-c" + (envelope.candidateIndex + 1);
}
function verifierKey(envelope) {
  return [
    "code-review/verify",
    envelope.lensKey,
    "" + envelope.candidateIndex,
    envelope.candidateDigest.slice(7, 23),
    contextHash.slice(7, 23),
    allowedEvidenceIndexDigest.slice(7, 23)
  ].join("/");
}
function reviewLensStage(lens) {
  return agent([
    "Code-review Finder",
    "Lens: " + lens.title,
    "Lens key: " + lens.lensKey,
    "Focus: " + lens.focus,
    "",
    "Return only concrete defect candidates with a failure scenario and evidence refs from the allowed index.",
    "User request:",
    prompt,
    "",
    "Scope:",
    JSON.stringify(scopeBlock, null, 2),
    "",
    context
  ].join("\\n"), {
    label: finderLabel(lens),
    phase: "Find",
    schema: finderSchema,
    effort: "high",
    key: "code-review/find/" + lens.lensKey + "/" + sourceSnapshotHashKey
  }).then((finderOutput) => {
    const rawCandidates = Array.isArray(finderOutput.candidates) ? finderOutput.candidates : [];
    const capped = rawCandidates.slice(0, caps.maxCandidatesPerLens);
    const envelopes = [];
    for (let index = 0; index < capped.length; index += 1) {
      const candidate = validateCandidate(capped[index], "candidate " + lens.lensKey + "/" + index);
      const candidateDigest = hash({
        sourceSnapshotId: sourceSnapshotId,
        contextHash: contextHash,
        allowedEvidenceIndexDigest: allowedEvidenceIndexDigest,
        truncation: truncation,
        scopeDigest: scopeDigest,
        lensKey: lens.lensKey,
        candidateIndex: index,
        candidate: candidate
      });
      envelopes.push({
        candidateId: "candidate_" + lens.lensKey + "_" + (index + 1),
        candidateIndex: index,
        candidateDigest: candidateDigest,
        lensKey: lens.lensKey,
        lensTitle: lens.title,
        candidate: candidate
      });
    }
    if (envelopes.length === 0) return [];
    return parallel(envelopes.map((envelope) => () => agent([
      "Code-review Verifier",
      "Verify exactly one candidate. Confirm, refute, or mark plausible using only allowed evidence refs.",
      "Candidate envelope:",
      JSON.stringify(envelope, null, 2),
      "",
      "Review evidence:",
      context
    ].join("\\n"), {
      label: verifierLabel(envelope),
      phase: "Verify",
      schema: verifierSchema,
      effort: verdictEffort,
      key: verifierKey(envelope)
    }))).then((verifierResults) => {
      if (verifierResults.length !== envelopes.length) fail("verifier count mismatch for " + lens.lensKey);
      const verified = [];
      for (let index = 0; index < envelopes.length; index += 1) {
        if (verifierResults[index] == null) fail("missing verifier result for " + envelopes[index].candidateId);
        verified.push({
          candidateId: envelopes[index].candidateId,
          candidateIndex: envelopes[index].candidateIndex,
          candidateDigest: envelopes[index].candidateDigest,
          lensKey: envelopes[index].lensKey,
          lensTitle: envelopes[index].lensTitle,
          candidate: envelopes[index].candidate,
          verifier: validateVerifier(verifierResults[index], "verifier " + envelopes[index].candidateId)
        });
      }
      return verified;
    });
  }).catch((err) => ({
    failed: true,
    error: errorText(err)
  }));
}
function runSweep(kept, refutedCount) {
  return agent([
    "Code-review Sweep Finder",
    "Find only new material candidates missed by the lens pass.",
    "Kept candidate count: " + kept.length,
    "Refuted candidate count: " + refutedCount,
    "Scope:",
    JSON.stringify(scopeBlock, null, 2),
    "",
    context
  ].join("\\n"), {
    label: "code-review-sweep-finder",
    phase: "Sweep",
    schema: finderSchema,
    effort: "high",
    key: "code-review/sweep/" + sourceSnapshotHashKey + "/" + scopeDigest.slice(7, 23)
  }).then((sweepOutput) => {
    const sweepLens = { id: "sweep", lensKey: "sweep", title: "Sweep", focus: "Final gap search", kind: "correctness", position: activeLenses.length };
    const raw = Array.isArray(sweepOutput.candidates) ? sweepOutput.candidates : [];
    if (raw.length === 0) return [];
    return reviewSweepCandidates(sweepLens, raw.slice(0, 8));
  });
}
function reviewSweepCandidates(lens, rawCandidates) {
  const envelopes = [];
  for (let index = 0; index < rawCandidates.length; index += 1) {
    const candidate = validateCandidate(rawCandidates[index], "sweep candidate " + index);
    const candidateDigest = hash({
      sourceSnapshotId: sourceSnapshotId,
      contextHash: contextHash,
      allowedEvidenceIndexDigest: allowedEvidenceIndexDigest,
      truncation: truncation,
      scopeDigest: scopeDigest,
      lensKey: "sweep",
      candidateIndex: index,
      candidate: candidate
    });
    envelopes.push({
      candidateId: "candidate_sweep_" + (index + 1),
      candidateIndex: index,
      candidateDigest: candidateDigest,
      lensKey: "sweep",
      lensTitle: "Sweep",
      candidate: candidate
    });
  }
  return parallel(envelopes.map((envelope) => () => agent([
    "Code-review Verifier",
    "Verify exactly one sweep candidate.",
    JSON.stringify(envelope, null, 2),
    "",
    context
  ].join("\\n"), {
    label: verifierLabel(envelope),
    phase: "Verify",
    schema: verifierSchema,
    effort: verdictEffort,
    key: verifierKey(envelope)
  }))).then((verifierResults) => {
    if (verifierResults.length !== envelopes.length) fail("sweep verifier count mismatch");
    const verified = [];
    for (let index = 0; index < envelopes.length; index += 1) {
      if (verifierResults[index] == null) fail("missing sweep verifier result");
      verified.push({
        candidateId: envelopes[index].candidateId,
        candidateIndex: envelopes[index].candidateIndex,
        candidateDigest: envelopes[index].candidateDigest,
        lensKey: envelopes[index].lensKey,
        lensTitle: envelopes[index].lensTitle,
        candidate: envelopes[index].candidate,
        verifier: validateVerifier(verifierResults[index], "sweep verifier " + index)
      });
    }
    return verified;
  });
}
function fallbackDecisions(items, reason) {
  const decisions = [];
  for (let index = 0; index < items.length; index += 1) {
    decisions.push({
      index: index,
      action: index < caps.reportCap ? "report" : "drop",
      severity: items[index].verifier.severity || "P2",
      reasonCategory: index < caps.reportCap ? "material" : "report_cap",
      reason: reason,
      merge: []
    });
  }
  return { mode: "script_fallback", summary: "Script fallback synthesis.", fallbackReason: reason, decisions: decisions };
}
function normalizeSynthesis(raw, items) {
  try {
    const decisions = Array.isArray(raw.decisions) ? raw.decisions : [];
    const covered = {};
    const normalized = [];
    for (let index = 0; index < decisions.length; index += 1) {
      const decision = decisions[index];
      if (!Number.isInteger(decision.index) || decision.index < 0 || decision.index >= items.length) fail("synthesis index out of range");
      if (covered[decision.index]) fail("duplicate synthesis coverage");
      covered[decision.index] = true;
      const merge = Array.isArray(decision.merge) ? decision.merge : [];
      if (decision.action === "merge" && merge.length < 1) fail("merge decision requires merge indexes");
      for (let mergeIndex = 0; mergeIndex < merge.length; mergeIndex += 1) {
        if (!Number.isInteger(merge[mergeIndex]) || merge[mergeIndex] < 0 || merge[mergeIndex] >= items.length) {
          fail("merge index out of range");
        }
        if (covered[merge[mergeIndex]]) fail("duplicate merge coverage");
        covered[merge[mergeIndex]] = true;
      }
      normalized.push({
        index: decision.index,
        action: decision.action,
        severity: decision.severity || items[decision.index].verifier.severity || "P2",
        reasonCategory: decision.reasonCategory,
        reason: text(decision.reason),
        merge: merge
      });
    }
    for (let index = 0; index < items.length; index += 1) {
      if (!covered[index]) fail("missing synthesis coverage for index " + index);
    }
    return { mode: "agent", summary: text(raw.summary), fallbackReason: null, decisions: normalized };
  } catch (err) {
    return fallbackDecisions(items, text(err && err.message ? err.message : err));
  }
}
function finalDecisionRows(synthesis, items) {
  const rows = [];
  for (let index = 0; index < synthesis.decisions.length; index += 1) {
    const decision = synthesis.decisions[index];
    const item = items[decision.index];
    const mergeCandidates = [];
    for (let mergeIndex = 0; mergeIndex < decision.merge.length; mergeIndex += 1) {
      const merged = items[decision.merge[mergeIndex]];
      mergeCandidates.push({ candidateId: merged.candidateId, candidateDigest: merged.candidateDigest });
    }
    rows.push({
      candidateId: item.candidateId,
      candidateDigest: item.candidateDigest,
      action: decision.action,
      reasonCategory: decision.reasonCategory,
      reason: decision.reason,
      mergeCandidates: mergeCandidates,
      severity: decision.severity
    });
  }
  return rows;
}
function droppedStats(decisions) {
  const stats = { duplicate: 0, notMaterial: 0, reportCap: 0, unsupportedEvidence: 0, superseded: 0 };
  for (let index = 0; index < decisions.length; index += 1) {
    const row = decisions[index];
    if (row.action !== "drop" && row.action !== "merge") continue;
    if (row.reasonCategory === "duplicate") stats.duplicate += 1;
    else if (row.reasonCategory === "not_material") stats.notMaterial += 1;
    else if (row.reasonCategory === "report_cap") stats.reportCap += 1;
    else if (row.reasonCategory === "unsupported_evidence") stats.unsupportedEvidence += 1;
    else if (row.reasonCategory === "superseded") stats.superseded += 1;
  }
  return stats;
}
announcePlan({
  mode: "phase_parallel",
  rationale: "Collect bounded repository evidence, choose review lenses, verify every candidate, then synthesize by index.",
  phases: [{
    id: "scope",
    title: "Scope",
    goal: "Choose active review lenses from runtime-owned evidence.",
    agents: [{ id: "scope", title: "Scope", label: "code-review-scope", focus: "Select lenses and evidence-bound review scope." }]
  }]
});
phase("Evidence");
const context = await workspaceContext({
  query: prompt,
  includeDiff: true,
  diffBaseRef: workflowInput.diffBaseRef
});
const allowedEvidenceRefs = sectionLines(context, "### Allowed Evidence Refs", ["### Unavailable Evidence", "### Git Status"]);
const unavailableEvidenceRefs = sectionLines(context, "### Unavailable Evidence", ["### Git Status"]);
const allowedEvidenceRefMap = objectMap(allowedEvidenceRefs);
const unavailableEvidenceRefMap = objectMap(unavailableEvidenceRefs);
const allowedFileRefs = [];
for (let index = 0; index < allowedEvidenceRefs.length; index += 1) {
  if (allowedEvidenceRefs[index].indexOf("file:") === 0) uniquePush(allowedFileRefs, allowedEvidenceRefs[index]);
}
const allowedFileRefMap = objectMap(allowedFileRefs);
const evidenceRefSet = {
  name: "allowed evidence refs",
  size: allowedEvidenceRefs.length,
  source: "the runtime evidence context (git status file: refs and staged/unstaged/committed diff refs)",
  populatedBy: "uncommitted or untracked paths in the working tree, plus the diffBaseRef commit range when provided"
};
const decisionRefSet = {
  name: "allowed decision refs",
  size: allowedEvidenceRefs.length + unavailableEvidenceRefs.length + 1,
  source: "allowed evidence refs, unavailable evidence tokens, and prompt:request",
  populatedBy: evidenceRefSet.populatedBy
};
const fileRefSet = {
  name: "allowed file refs",
  size: allowedFileRefs.length,
  source: "file: entries in the evidence context (git status changed/untracked paths)",
  populatedBy: "uncommitted or untracked paths in the working tree"
};
if (allowedFileRefs.length === 0) {
  fail("no reviewable change evidence in the working tree: " + fileRefSet.name + " is empty (0 entries) derived from " + fileRefSet.source + "; populated by " + fileRefSet.populatedBy);
}
const sourceSnapshotId = firstLineValue(context, "Source Snapshot: ") || firstLineValue(context, "sourceSnapshotId: ") || hash(context);
const contextHash = firstLineValue(context, "Context Hash: ") || firstLineValue(context, "contextHash: ") || hash({ context: context });
const allowedEvidenceIndexDigest = firstLineValue(context, "allowedEvidenceIndexDigest: ") || hash(allowedEvidenceRefs);
const diffBaseRef = firstLineValue(context, "diffBaseRef: ");
const truncation = firstLineValue(context, "truncation: ") || "{}";
const sourceSnapshotHashKey = hash({ sourceSnapshotId: sourceSnapshotId, contextHash: contextHash, allowedEvidenceIndexDigest: allowedEvidenceIndexDigest }).slice(7, 39);
announcePhasePlan({
  id: "scope",
  title: "Scope",
  goal: "Select active review lenses from the bounded evidence context.",
  agents: [{ id: "scope", title: "Scope", label: "code-review-scope", focus: "Return files, lens decisions, and active lenses." }]
});
phase("Scope");
const scope = await agent([
  "Code-review Scope",
  "Select active lenses from the seed list and the runtime-owned evidence context.",
  "Use decisionRefs only from allowed evidence refs, unavailable evidence refs, or prompt:request.",
  "Level: " + level,
  "Max active lenses: " + caps.maxFinders,
  "",
  "Seed lenses:",
  JSON.stringify(seedLenses, null, 2),
  "",
  "User request:",
  prompt,
  "",
  context
].join("\\n"), {
  label: "code-review-scope",
  phase: "Scope",
  schema: scopeSchema,
  effort: scopeEffort,
  key: "code-review/scope/" + sourceSnapshotHashKey
});
const activeLenses = validateScope(scope);
const scopeBlock = {
  files: scope.files,
  summary: scope.summary,
  instructions: scope.instructions || "",
  lenses: activeLenses,
  lensDecisions: scope.lensDecisions
};
const scopeDigest = hash({ sourceSnapshotId: sourceSnapshotId, contextHash: contextHash, scope: scopeBlock });
if (activeLenses.length === 0) {
  return {
    level: level,
    provenance: {
      sourceSnapshotId: sourceSnapshotId,
      contextHash: contextHash,
      allowedEvidenceIndexDigest: allowedEvidenceIndexDigest,
      diffBaseRef: diffBaseRef || null,
      truncation: { raw: truncation }
    },
    summary: scope.summary,
    findings: [],
    synthesis: { mode: "script_fallback", fallbackReason: "no active lenses", decisions: [] },
    stats: { finders: 0, candidates: 0, verifierAttempts: 0, verified: 0, refuted: 0, invalid: 0, reported: 0, dropped: droppedStats([]) }
  };
}
announcePhasePlan({
  id: "find",
  title: "Find",
  goal: "Run one finder per active review lens.",
  agents: activeLenses.map((lens) => ({
    id: lens.lensKey,
    title: lens.title,
    label: finderLabel(lens),
    focus: lens.focus
  }))
});
announcePhasePlan({
  id: "verify",
  title: "Verify",
  goal: "Verify candidates as soon as each finder emits them.",
  agents: [{ id: "dynamic-candidates", title: "Dynamic candidate verifiers", label: "code-review-verify-dynamic", focus: "One verifier runs for each emitted candidate." }]
});
phase("Find");
phase("Verify");
const lensResults = await pipeline(activeLenses, reviewLensStage);
const verifiedCandidates = [];
for (let lensIndex = 0; lensIndex < lensResults.length; lensIndex += 1) {
  if (lensResults[lensIndex] && lensResults[lensIndex].failed) fail(lensResults[lensIndex].error);
  if (lensResults[lensIndex] == null) fail("lens review failed for " + activeLenses[lensIndex].lensKey);
  for (let candidateIndex = 0; candidateIndex < lensResults[lensIndex].length; candidateIndex += 1) {
    verifiedCandidates.push(lensResults[lensIndex][candidateIndex]);
  }
}
const nonRefuted = [];
let refuted = 0;
for (let index = 0; index < verifiedCandidates.length; index += 1) {
  if (verifiedCandidates[index].verifier.verdict === "REFUTED") refuted += 1;
  else nonRefuted.push(verifiedCandidates[index]);
}
let sweepResults = [];
if (caps.sweep) {
  announcePhasePlan({
    id: "sweep",
    title: "Sweep",
    goal: "Search for missed candidates after initial verification.",
    agents: [{ id: "sweep", title: "Sweep Finder", label: "code-review-sweep-finder", focus: "Find only new material missed candidates." }]
  });
  phase("Sweep");
  sweepResults = await runSweep(nonRefuted, refuted);
  for (let index = 0; index < sweepResults.length; index += 1) {
    verifiedCandidates.push(sweepResults[index]);
    if (sweepResults[index].verifier.verdict === "REFUTED") refuted += 1;
    else nonRefuted.push(sweepResults[index]);
  }
}
let synthesis = { mode: "script_fallback", summary: "No confirmed or plausible candidates.", fallbackReason: "no reportable candidates", decisions: [] };
if (nonRefuted.length > 0) {
  announcePhasePlan({
    id: "synthesize",
    title: "Synthesize",
    goal: "Select final findings by verified candidate index.",
    agents: [{ id: "synthesis", title: "Synthesis", label: "code-review-synthesis", focus: "Report, merge, or drop every verified non-refuted candidate." }]
  });
  phase("Synthesize");
  const rawSynthesis = await agent([
    "Code-review Synthesis",
    "Select final findings by index only. Do not invent files, refs, or candidate ids.",
    "Every candidate index must be reported, merged, dropped, or covered as a merge target.",
    "Report cap: " + caps.reportCap,
    "",
    "Verified candidates:",
    JSON.stringify(nonRefuted.map((item, index) => ({
      index: index,
      candidateId: item.candidateId,
      candidateDigest: item.candidateDigest,
      lensKey: item.lensKey,
      file: item.candidate.file,
      line: item.candidate.line,
      summary: item.candidate.summary,
      failureScenario: item.candidate.failureScenario,
      verdict: item.verifier.verdict,
      severity: item.verifier.severity,
      evidenceRefs: item.verifier.evidenceRefs
    })), null, 2)
  ].join("\\n"), {
    label: "code-review-synthesis",
    phase: "Synthesize",
    schema: synthesisSchema,
    effort: verdictEffort,
    key: "code-review/synthesis/" + sourceSnapshotHashKey + "/" + scopeDigest.slice(7, 23) + "/" + hash(nonRefuted).slice(7, 23)
  });
  synthesis = normalizeSynthesis(rawSynthesis, nonRefuted);
}
const decisionRows = finalDecisionRows(synthesis, nonRefuted);
const findings = [];
for (let index = 0; index < synthesis.decisions.length; index += 1) {
  const decision = synthesis.decisions[index];
  if (decision.action !== "report") continue;
  const item = nonRefuted[decision.index];
  const row = decisionRows[index];
  findings.push({
    candidateId: item.candidateId,
    candidateDigest: item.candidateDigest,
    severity: decision.severity || item.verifier.severity || "P2",
    file: item.candidate.file,
    line: item.candidate.line,
    summary: item.candidate.summary,
    failureScenario: item.candidate.failureScenario,
    verdict: item.verifier.verdict,
    evidence: item.verifier.evidence,
    evidenceRefs: item.verifier.evidenceRefs,
    lens: { key: item.lensKey, title: item.lensTitle },
    synthesisDecision: {
      action: decision.action,
      reasonCategory: decision.reasonCategory,
      reason: decision.reason,
      mergeCandidates: row.mergeCandidates
    }
  });
}
return {
  level: level,
  provenance: {
    sourceSnapshotId: sourceSnapshotId,
    contextHash: contextHash,
    allowedEvidenceIndexDigest: allowedEvidenceIndexDigest,
    diffBaseRef: diffBaseRef || null,
    truncation: { raw: truncation }
  },
  summary: synthesis.summary,
  findings: findings,
  synthesis: {
    mode: synthesis.mode,
    fallbackReason: synthesis.fallbackReason,
    decisions: decisionRows
  },
  stats: {
    finders: activeLenses.length + (caps.sweep ? 1 : 0),
    candidates: verifiedCandidates.length,
    verifierAttempts: verifiedCandidates.length,
    verified: verifiedCandidates.length,
    refuted: refuted,
    invalid: 0,
    reported: findings.length,
    dropped: droppedStats(decisionRows)
  }
};`;
}

function phaseWiseBuiltinWorkflowScript(input: {
  readonly name: string;
  readonly description: string;
  readonly defaultPrompt: string;
  readonly plannerKind: string;
  readonly plannerGuidance: string;
  readonly agentGuidance: string;
  readonly finalGuidance: string;
}): string {
  return `export const meta = {
  name: ${JSON.stringify(input.name)},
  description: ${JSON.stringify(input.description)}
};
const workflowInput = args && typeof args === "object" ? args : {};
const prompt = typeof workflowInput.prompt === "string" && workflowInput.prompt.trim()
  ? workflowInput.prompt
  : ${JSON.stringify(input.defaultPrompt)};
const context = await workspaceContext({ query: prompt });
const plan = await agent([
  ${JSON.stringify(`Plan the phase-wise execution strategy for ${input.plannerKind}.`)},
  "",
  ${JSON.stringify(input.plannerGuidance)},
  "Each agent needs one bounded outcome, a distinct evidence focus, and a stop condition. Do not duplicate the same repository scan across agents.",
  "",
  ${JSON.stringify(DYNAMIC_WORKFLOW_PATTERN_GUIDANCE)},
  "A phase runs after previous phase summaries are available. Within each phase, use parallel agents by default.",
  "Return 1 to 4 phases. Prefer the fewest phases and agents that cover the request; use concise stable ids.",
  "",
  "User request:",
  prompt,
  "",
  context
].join("\\n"), {
  label: ${JSON.stringify(`${input.name}-planner`)},
  effort: "medium",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["phase_parallel", "single"] },
      rationale: { type: "string", minLength: 1 },
      phases: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 32 },
            title: { type: "string", minLength: 1, maxLength: 80 },
            goal: { type: "string", minLength: 1, maxLength: 800 },
            agents: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 32 },
                  title: { type: "string", minLength: 1, maxLength: 80 },
                  focus: { type: "string", minLength: 1, maxLength: 800 }
                },
                required: ["id", "title", "focus"]
              }
            }
          },
          required: ["id", "title", "goal", "agents"]
        }
      }
    },
    required: ["mode", "rationale", "phases"]
  }
});
const selectedPhases = plan.mode === "single" ? [plan.phases[0]] : plan.phases;
function plannedPhaseFor(phasePlan) {
  return {
    id: phasePlan.id,
    title: phasePlan.title,
    goal: phasePlan.goal,
    agents: (plan.mode === "single" ? [phasePlan.agents[0]] : phasePlan.agents).map((phaseAgent) => ({
      id: phaseAgent.id,
      title: phaseAgent.title,
      focus: phaseAgent.focus,
      label: plan.mode === "single"
        ? ${JSON.stringify(`${input.name}-single`)}
        : ${JSON.stringify(`${input.name}-`)} + phasePlan.id + "-" + phaseAgent.id
    }))
  };
}
const firstPhasePlan = plannedPhaseFor(selectedPhases[0]);
announcePlan({
  mode: plan.mode,
  rationale: plan.rationale,
  phases: [firstPhasePlan]
});
if (plan.mode === "single") {
  const singlePhase = firstPhasePlan;
  const singleAgent = singlePhase.agents[0];
  announcePhasePlan(singlePhase);
  phase(singlePhase.title);
  return await agent([
    "Single-agent execution selected by the LLM planner.",
    "Planner rationale: " + plan.rationale,
    "Phase goal: " + singlePhase.goal,
    "Agent focus: " + singleAgent.title + " - " + singleAgent.focus,
    "",
    "Original request:",
    prompt,
    "",
    ${JSON.stringify(input.agentGuidance)},
    "",
    "Use the deterministic workspace context below as primary evidence. Label inferences, mention missing evidence, and re-check each material conclusion before finalizing.",
    "",
    context
  ].join("\\n"), { label: ${JSON.stringify(`${input.name}-single`)}, phase: singlePhase.title });
}
const phaseOutputs = [];
const priorSummaries = [];
for (const rawPhasePlan of selectedPhases) {
  const phasePlan = plannedPhaseFor(rawPhasePlan);
  announcePhasePlan(phasePlan);
  phase(phasePlan.title);
  const agents = phasePlan.agents;
  const agentOutputs = agents.length < 2
    ? [await agent([
        "Parallel phase agent: " + agents[0].title,
        "Phase: " + phasePlan.title,
        "Phase goal: " + phasePlan.goal,
        "Agent focus: " + agents[0].focus,
        "",
        "Previous phase summaries:",
        JSON.stringify(priorSummaries, null, 2),
        "",
        "Original request:",
        prompt,
        "",
        ${JSON.stringify(input.agentGuidance)},
        "",
        "Use the deterministic workspace context below as primary evidence. Label inferences, mention missing evidence, and re-check each material conclusion before finalizing.",
        "",
        context
      ].join("\\n"), { label: ${JSON.stringify(`${input.name}-`)} + phasePlan.id + "-" + agents[0].id, phase: phasePlan.title })]
    : await parallel(agents.map((phaseAgent) => () => agent([
        "Parallel phase agent: " + phaseAgent.title,
        "Phase: " + phasePlan.title,
        "Phase goal: " + phasePlan.goal,
        "Agent focus: " + phaseAgent.focus,
        "",
        "Previous phase summaries:",
        JSON.stringify(priorSummaries, null, 2),
        "",
        "Original request:",
        prompt,
        "",
        ${JSON.stringify(input.agentGuidance)},
        "",
        "Use the deterministic workspace context below as primary evidence. Label inferences, mention missing evidence, and re-check each material conclusion before finalizing.",
        "",
        context
      ].join("\\n"), { label: ${JSON.stringify(`${input.name}-`)} + phasePlan.id + "-" + phaseAgent.id, phase: phasePlan.title })));
  const phaseSummary = await agent([
    "Synthesize this phase.",
    "Phase: " + phasePlan.title,
    "Phase goal: " + phasePlan.goal,
    "",
    "Original request:",
    prompt,
    "",
    "Agent outputs:",
    JSON.stringify(agentOutputs, null, 2),
    "",
    "Synthesize only what the agent outputs support. Separate observations, inferences, and unknowns; preserve disagreement. Return material findings, open questions, and what the next phase should know."
  ].join("\\n"), { label: ${JSON.stringify(`${input.name}-phase-`)} + phasePlan.id + "-synthesis", phase: phasePlan.title });
  const phaseRecord = {
    id: phasePlan.id,
    title: phasePlan.title,
    goal: phasePlan.goal,
    results: agentOutputs,
    summary: phaseSummary
  };
  phaseOutputs.push(phaseRecord);
  priorSummaries.push({ id: phaseRecord.id, title: phaseRecord.title, summary: phaseRecord.summary });
}
return await agent([
  ${JSON.stringify(`Synthesize the phase-wise ${input.plannerKind} workflow into the final result.`)},
  "",
  "Original request:",
  prompt,
  "",
  "Planner rationale:",
  plan.rationale,
  "",
  "Phase outputs:",
  JSON.stringify(phaseOutputs, null, 2),
  "",
  ${JSON.stringify(input.finalGuidance)},
  "Before finalizing, verify that every completion or verification claim is supported by a phase output; downgrade unsupported claims to recommendations or unknowns."
].join("\\n"), { label: ${JSON.stringify(`${input.name}-final-synthesis`)} });`;
}

export class WorkflowTaskRegistry implements WorkflowRuntime {
  private readonly tasks = new Map<string, WorkflowTaskMutable>();
  private readonly permissionRequests = new Map<string, WorkflowPermissionRequestMutable>();
  private permissionRecords?: Map<string, WorkflowPermissionRecord>;
  private closed = false;
  private readonly stateDir: string;
  private readonly agentStallTimeoutMs: number;
  private readonly agentStallRetryLimit: number;
  private readonly heartbeatMs: number;
  private readonly worktreeRetention: WorktreeRetention;
  // Resolved agent-dispatch pool size, or null for unbounded (no pool). Computed once:
  // availableParallelism() is stable for the process lifetime.
  private readonly agentConcurrency: number | null;
  // Per-run output-token ceiling, or null when unset (inert). Parsed by the CLI/caller.
  private readonly budgetTotal: number | null;

  constructor(private readonly options: WorkflowTaskRegistryOptions) {
    this.stateDir = options.stateDir ?? defaultWorkflowStateDir(options.cwd ?? process.cwd());
    this.agentStallRetryLimit = normalizeAgentStallRetryLimit(options.agentStallRetryLimit);
    this.agentStallTimeoutMs = normalizeAgentStallTimeoutMs(
      options.agentStallTimeoutMs,
      options.requestTimeoutMs,
    );
    this.heartbeatMs = normalizeHeartbeatMs(options.heartbeatMs);
    this.worktreeRetention = options.worktreeRetention ?? 'remove-clean';
    this.agentConcurrency = resolveAgentConcurrency(options.agentConcurrency);
    this.budgetTotal = resolveBudgetTotal(options.budgetTotal);
  }

  async launch(input: WorkflowLaunchInput): Promise<WorkflowLaunchResult> {
    if (this.closed) throw workflowInputError('Workflow runtime is closed.');
    const resumePlan = await this.prepareResumePlan(input);
    let resolved = await this.resolveLaunchInput(resumePlan.launchInput);
    const parsed = parseInlineWorkflowScript(resolved.script);
    const scriptHash = workflowScriptHash(resolved.script);
    const isolationReview = workflowRequestedIsolationModes(resolved.script);
    resolved = await this.resolveTrustedScriptPathMetadata(resolved, parsed, scriptHash, isolationReview);
    const permissionRequired = await this.workflowPermissionRequired(
      resumePlan.launchInput,
      resolved,
      parsed,
      scriptHash,
      isolationReview,
    );
    if (permissionRequired) return permissionRequired;
    if (workflowReferencesAgentCapability(resolved.script)) {
      // Prepare model capability truth only for workflows that can spend agent
      // tokens. This keeps deterministic/no-agent workflows independent of
      // Codex auth while ensuring the effective model is known before journal
      // creation and cache identity assignment.
      await this.options.backend.prepare?.();
    }
    const resumeCache = resumePlan.sourceTask
      ? await this.createResumeCache(resumePlan.sourceTask)
      : undefined;
    const taskId = `task_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    let scriptPath = resolved.scriptPath ?? this.workflowScriptPath(parsed.meta.name, runId);
    if (!resolved.scriptPath) {
      scriptPath = await this.persistInlineWorkflowScript(scriptPath, resolved.script);
      await this.writeWorkflowScriptMetadata(scriptPath, resolved, parsed, scriptHash);
    }
    const transcriptDir = join(this.stateDir, 'subagents', 'workflows', runId);
    const retryInput = { ...resolved, scriptPath };
    const startedAt = Date.now();
    const journalArgs = journalJsonValueOrInputError(resumePlan.launchInput.args ?? null, 'workflow args');
    const workspaceFingerprint = await this.workspaceFingerprint();
    let journal: WorkflowJournalWriter;
    try {
      journal = await WorkflowJournalWriter.create({
        transcriptDir,
        taskId,
        runId,
        durability: this.options.journalDurability,
      });
      await journal.append({
        kind: 'workflow.run.started',
        workflowName: parsed.meta.name,
        workflowSource: resolved.workflowSource,
        ...(resolved.workflowSourcePath ? { workflowSourcePath: resolved.workflowSourcePath } : {}),
        scriptPath,
        scriptHash,
        args: journalArgs,
        runtime: {
          schemaVersion: 1,
          cwd: this.options.cwd ?? process.cwd(),
          ...(this.options.backend.model !== SUBAGENT_MODEL_PLACEHOLDER
            ? { model: this.options.backend.model }
            : {}),
          ...(workspaceFingerprint ? { workspaceFingerprint } : {}),
        },
      });
      await writeWorkflowStateFile(workflowRunPidPath(transcriptDir), `${process.pid}\n`);
      if (!resolved.scriptPath) {
        await this.recordWorkflowSourceAllow(resolved, parsed, scriptHash, isolationReview);
      }
    } catch (err) {
      throw workflowJournalRequestError(err);
    }
    const task: WorkflowTaskMutable = {
      taskId,
      runId,
      workflowName: parsed.meta.name,
      status: 'running',
      taskType: 'local_workflow',
      transcriptDir,
      scriptPath,
      workflowSource: resolved.workflowSource,
      ...(resolved.workflowSourcePath ? { workflowSourcePath: resolved.workflowSourcePath } : {}),
      scriptHash,
      isolationReview,
      startedAt,
      journal,
      retryInput,
      events: [],
      waiters: [],
      terminalEmitted: false,
    };
    this.tasks.set(taskId, task);
    this.emit(task, {
      type: 'workflow.started',
      taskId,
      runId,
      workflowName: task.workflowName,
      scriptPath,
      workflowSource: task.workflowSource,
      ...(task.workflowSourcePath ? { workflowSourcePath: task.workflowSourcePath } : {}),
      scriptHash,
    });
    if (resumeCache) this.emitResumeDisclosure(task, resumeCache.source, workspaceFingerprint);
    task.runPromise = this.runTask(task, parsed, retryInput, resumeCache);
    task.runPromise.catch(() => undefined);
    return {
      status: 'async_launched',
      taskId,
      taskType: 'local_workflow',
      workflowName: task.workflowName,
      runId,
      summary: parsed.meta.description,
      transcriptDir,
      scriptPath,
      workflowSource: task.workflowSource,
      ...(task.workflowSourcePath ? { workflowSourcePath: task.workflowSourcePath } : {}),
      scriptHash,
    };
  }

  private emitResumeDisclosure(
    task: WorkflowTaskMutable,
    source: WorkflowResumeSourceInfo,
    currentWorkspaceFingerprint: string | undefined,
  ): void {
    const log = (message: string): void => {
      this.emit(task, {
        type: 'workflow.log',
        taskId: task.taskId,
        runId: task.runId,
        message,
      });
    };
    const terminalDetail = source.terminalReason ? `: ${source.terminalReason}` : '';
    log(`Resuming from ${source.runId} (${source.terminal}${terminalDetail}); up to ${source.completedAgentCount} completed agent result(s) are reusable.`);
    if ((source.model ?? SUBAGENT_MODEL_PLACEHOLDER) !== this.options.backend.model) {
      log(`Resume model mismatch: source run used ${source.model ?? 'the default model'}, this run uses ${this.options.backend.model}. Agent results whose call keys embed a different model re-run; per-agent model overrides keep their cached results.`);
    }
    if (
      source.workspaceFingerprint
      && currentWorkspaceFingerprint
      && source.workspaceFingerprint !== currentWorkspaceFingerprint
    ) {
      log('Workspace changed since the source run; cached agent results may reference stale file state.');
    }
  }

  private async workspaceFingerprint(): Promise<string | undefined> {
    const cwd = this.options.cwd ?? process.cwd();
    try {
      const gitRoot = await gitOutput(cwd, ['rev-parse', '--show-toplevel']);
      const excludes = await this.gitRuntimeStateExcludePathspecs(gitRoot);
      const head = await gitOutput(gitRoot, ['rev-parse', 'HEAD']).catch(() => 'no-head');
      const status = await gitOutput(gitRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ...excludes]);
      // `git diff HEAD` sees content edits to tracked files that the status
      // listing alone cannot (a file that was already dirty in both runs).
      // Untracked-file content changes remain invisible beyond presence.
      const diff = head === 'no-head'
        ? ''
        : await gitOutput(gitRoot, ['diff', 'HEAD', '--', '.', ...excludes]).catch(() => '');
      return `git:${createHash('sha256').update(`${head}\0${status}\0${diff}`).digest('hex')}`;
    } catch {
      return undefined;
    }
  }

  async validateWorkflowInput(input: WorkflowLaunchInput): Promise<{
    readonly workflowName: string;
    readonly description?: string;
    readonly workflowSource: WorkflowSource;
    readonly scriptHash: string;
    readonly agentCallSites: number;
    readonly schemaCallSites: number;
    readonly keyedCallSites: number;
    readonly warnings: readonly string[];
  }> {
    if (this.closed) throw workflowInputError('Workflow runtime is closed.');
    if (Object.prototype.hasOwnProperty.call(input, 'resumeFromRunId')) {
      throw workflowInputError('Workflow validation does not accept resumeFromRunId.');
    }
    const resolved = await this.resolveLaunchInput(input);
    const parsed = parseInlineWorkflowScript(resolved.script);
    return {
      workflowName: parsed.meta.name,
      ...(parsed.meta.description ? { description: parsed.meta.description } : {}),
      workflowSource: resolved.workflowSource,
      scriptHash: workflowScriptHash(resolved.script),
      ...workflowAuthoringScan(resolved.script),
    };
  }

  async validateResumeSource(resumeFromRunId: string): Promise<void> {
    await this.resumeSourceInfo(resumeFromRunId);
  }

  async resumeSourceInfo(resumeFromRunId: string): Promise<Omit<WorkflowResumeSourceInfo, 'workspaceFingerprint'>> {
    const runId = normalizeResumeFromRunId(resumeFromRunId);
    const sourceTask = await this.workflowTaskByRunId(runId);
    if (!sourceTask) throw workflowResumeUnknownError(runId);
    if (sourceTask.status === 'running') throw workflowResumeRunningError(runId);
    const sourceJournal = await this.readResumeSourceJournal(sourceTask);
    const completedAgentCount = sourceJournal.entries
      .filter((entry) => entry.kind === 'workflow.agent.completed')
      .length;
    const { workspaceFingerprint: _internal, ...info } = workflowResumeSourceInfoFromJournal(runId, sourceJournal, completedAgentCount);
    return info;
  }

  private async prepareResumePlan(input: WorkflowLaunchInput): Promise<WorkflowResumePlan> {
    if (!Object.prototype.hasOwnProperty.call(input, 'resumeFromRunId')) {
      return { launchInput: input };
    }
    const resumeFromRunId = normalizeResumeFromRunId(input.resumeFromRunId);
    const sourceTask = await this.workflowTaskByRunId(resumeFromRunId);
    if (!sourceTask) throw workflowResumeUnknownError(resumeFromRunId);
    if (sourceTask.status === 'running') throw workflowResumeRunningError(resumeFromRunId);
    if (workflowLaunchHasSourceSelector(input)) {
      throw workflowInputError('resumeFromRunId cannot be combined with script, scriptPath, or name. Resume uses the original persisted workflow source.');
    }
    const inheritedArgs = !Object.prototype.hasOwnProperty.call(input, 'args') && sourceTask.retryInput.args !== undefined
      ? { args: sourceTask.retryInput.args }
      : {};
    return {
      sourceTask,
      launchInput: {
        ...sourceTask.retryInput,
        ...inheritedArgs,
        ...(Object.prototype.hasOwnProperty.call(input, 'args') ? { args: input.args } : {}),
        ...(input.toolName ? { toolName: input.toolName } : {}),
        resumeFromRunId,
      },
    };
  }

  private async workflowTaskByRunId(runId: string): Promise<WorkflowResumeSource | undefined> {
    for (const task of this.tasks.values()) {
      if (task.runId === runId) return task;
    }
    return await this.durableWorkflowResumeSource(runId);
  }

  private async durableWorkflowResumeSource(runId: string): Promise<WorkflowResumeSource | undefined> {
    const resultPath = join(this.stateDir, 'workflows', `${runId}.result.json`);
    const transcriptDir = join(this.stateDir, 'subagents', 'workflows', runId);
    let recordText: string | null = null;
    try {
      recordText = await readFile(resultPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw workflowResumeSourceInvalidError(runId);
      recordText = null;
    }
    if (recordText !== null) {
      // A result record that exists but cannot be parsed or bound stays
      // fail-loud; only a valid record beside a non-completed journal (the
      // terminal append was interrupted) falls through to journal-first
      // discovery.
      let record: DurableWorkflowResultRecord | null = null;
      try {
        record = durableWorkflowResultRecordFromUnknown(JSON.parse(recordText));
      } catch {
        record = null;
      }
      if (!record || record.runId !== runId || !record.retryInput) {
        throw workflowResumeSourceInvalidError(runId);
      }
      const outcome = await this.durableCompletedResumeSource(runId, transcriptDir, {
        ...record,
        retryInput: record.retryInput,
      });
      if (outcome.kind === 'source') return outcome.source;
      if (outcome.kind === 'invalid') throw workflowResumeSourceInvalidError(runId);
    }
    return await this.durableJournalResumeSource(runId, transcriptDir);
  }

  private async durableCompletedResumeSource(
    runId: string,
    transcriptDir: string,
    record: DurableWorkflowResultRecord & { readonly retryInput: WorkflowLaunchInput },
  ): Promise<
    | { readonly kind: 'source'; readonly source: WorkflowResumeSource }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'journal_not_completed' }
  > {
    let scriptRecord: { readonly script: string; readonly scriptPath: string; readonly metadata?: WorkflowScriptMetadata };
    try {
      scriptRecord = await this.readRuntimeWorkflowScript(record.retryInput.scriptPath ?? '');
    } catch {
      return { kind: 'invalid' };
    }
    const actualScriptHash = workflowScriptHash(scriptRecord.script);
    if (actualScriptHash !== record.scriptHash) return { kind: 'invalid' };
    if (scriptRecord.metadata?.scriptHash !== record.scriptHash) return { kind: 'invalid' };
    if (scriptRecord.metadata?.workflowName !== record.workflowName) return { kind: 'invalid' };
    let sourceJournal: WorkflowResumeSourceJournal;
    try {
      sourceJournal = await this.readResumeSourceJournal({
        runId,
        transcriptDir,
        workflowName: record.workflowName,
        scriptHash: record.scriptHash,
      });
    } catch {
      return { kind: 'invalid' };
    }
    if (sourceJournal.truncatedTail || sourceJournal.terminal?.kind !== 'workflow.run.completed') {
      return { kind: 'journal_not_completed' };
    }
    if (!durableScriptRecordMatchesJournal(scriptRecord, sourceJournal.started)) return { kind: 'invalid' };
    if (!durableRetryInputArgsMatchJournal(record.retryInput, sourceJournal.started.args)) return { kind: 'invalid' };
    return {
      kind: 'source',
      source: {
        runId,
        status: 'completed',
        transcriptDir,
        retryInput: durableRetryInputWithJournalArgs(record.retryInput, sourceJournal.started.args),
        workflowName: record.workflowName,
        scriptHash: record.scriptHash,
      },
    };
  }

  private async durableJournalResumeSource(
    runId: string,
    transcriptDir: string,
  ): Promise<WorkflowResumeSource | undefined> {
    try {
      await stat(workflowJournalPath(transcriptDir));
    } catch {
      return undefined;
    }
    const sourceJournal = await this.readResumeSourceJournal({ runId, transcriptDir });
    if (sourceJournal.terminal?.kind === 'workflow.run.completed') {
      // Completed sources must bind through their result record. A completed
      // journal reaches journal-first discovery only when the record is
      // missing or the journal carries bytes after the terminal entry — both
      // are external interference, not recoverable states.
      throw workflowResumeSourceInvalidError(runId);
    }
    if (!sourceJournal.terminal) {
      await this.assertResumeSourceNotLive(runId, transcriptDir);
    }
    const started = sourceJournal.started;
    let scriptRecord: { readonly script: string; readonly scriptPath: string; readonly metadata?: WorkflowScriptMetadata };
    try {
      scriptRecord = await this.readRuntimeWorkflowScript(started.scriptPath);
    } catch {
      throw workflowResumeSourceInvalidError(runId);
    }
    if (workflowScriptHash(scriptRecord.script) !== started.scriptHash) throw workflowResumeSourceInvalidError(runId);
    if (scriptRecord.metadata?.workflowName !== started.workflowName) throw workflowResumeSourceInvalidError(runId);
    if (!durableScriptRecordMatchesJournal(scriptRecord, started)) throw workflowResumeSourceInvalidError(runId);
    return {
      runId,
      status: 'failed',
      transcriptDir,
      retryInput: {
        scriptPath: scriptRecord.scriptPath,
        // The launch path journals absent args as null; normalize back so a
        // resumed script sees the same `args` value the original run saw.
        ...(started.args === null ? {} : { args: started.args }),
      },
      workflowName: started.workflowName,
      scriptHash: started.scriptHash,
    };
  }

  private async assertResumeSourceNotLive(runId: string, transcriptDir: string): Promise<void> {
    let pidText: string;
    try {
      pidText = await readFile(workflowRunPidPath(transcriptDir), 'utf8');
    } catch {
      return;
    }
    const pid = Number.parseInt(pidText.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isWorkflowProcessAlive(pid)) {
      throw workflowResumeRunningError(runId);
    }
  }

  private async createResumeCache(sourceTask: WorkflowResumeSource): Promise<WorkflowResumeCache> {
    const sourceJournal = await this.readResumeSourceJournal(sourceTask);
    // Exact-key hits may reuse any durably completed agent result, not only
    // the contiguous prefix, so one early stall cannot discard the results of
    // agents that completed after it.
    const byCallKey = new Map<string, WorkflowResumeAgentCacheEntry>();
    for (const entry of sourceJournal.entries) {
      if (entry.kind === 'workflow.agent.completed') {
        byCallKey.set(entry.agentCallKey, { agentCallKey: entry.agentCallKey, result: entry.result });
      }
    }
    const cacheEntries: WorkflowResumeAgentCacheEntry[] = [];
    for (const entry of sourceJournal.entries) {
      if (entry.kind !== 'workflow.agent.started') continue;
      const completed = byCallKey.get(entry.agentCallKey);
      if (!completed) break;
      cacheEntries.push(completed);
    }
    return {
      entries: cacheEntries,
      byCallKey,
      usedCallKeys: new Set(),
      nextIndex: 0,
      prefixOpen: true,
      source: workflowResumeSourceInfoFromJournal(sourceTask.runId, sourceJournal, byCallKey.size),
    };
  }

  private async readResumeSourceJournal(sourceTask: {
    readonly runId: string;
    readonly transcriptDir: string;
    readonly workflowName?: string;
    readonly scriptHash?: string;
  }): Promise<WorkflowResumeSourceJournal> {
    let journal: Awaited<ReturnType<typeof readWorkflowJournal>>;
    try {
      // An unterminated final line was never durably committed, so it is
      // dropped rather than rejecting the whole journal; completed-source
      // acceptance separately requires a clean, terminal-completed journal.
      journal = await readWorkflowJournal(workflowJournalPath(sourceTask.transcriptDir), { dropUnterminatedTail: true });
    } catch (err) {
      throw workflowResumeSourceInvalidError(sourceTask.runId, err);
    }
    const entries = journal.entries;
    const started = entries[0];
    if (
      !started
      || started.kind !== 'workflow.run.started'
      || started.runId !== sourceTask.runId
      || (sourceTask.scriptHash && started.scriptHash !== sourceTask.scriptHash)
      || (sourceTask.workflowName && started.workflowName !== sourceTask.workflowName)
    ) {
      throw workflowResumeSourceInvalidError(sourceTask.runId);
    }
    const last = entries.at(-1);
    const terminal = last && (last.kind === 'workflow.run.completed' || last.kind === 'workflow.run.failed')
      ? last
      : undefined;
    return { entries, started, terminal, truncatedTail: journal.truncatedTail };
  }

  private async resolveLaunchInput(input: WorkflowLaunchInput): Promise<ResolvedWorkflowLaunchInput> {
    const normalized = normalizeLaunchInput(input);
    if (normalized.scriptPath) {
      const resolved = await this.readRuntimeWorkflowScript(normalized.scriptPath);
      return {
        ...normalized,
        script: resolved.script,
        scriptPath: resolved.scriptPath,
        workflowSource: 'script_path',
        workflowSourcePath: resolved.scriptPath,
        ...(resolved.metadata ? { scriptMetadata: resolved.metadata } : {}),
      };
    }
    if (normalized.name) {
      return {
        ...normalized,
        ...await this.resolveNamedWorkflow(normalized.name),
      };
    }
    return {
      ...normalized,
      script: normalized.script as string,
      workflowSource: 'inline',
    };
  }

  private async workflowPermissionRequired(
    input: WorkflowLaunchInput,
    resolved: ResolvedWorkflowLaunchInput,
    parsed: ParsedWorkflowScript,
    scriptHash: string,
    requestedIsolation: WorkflowIsolationReview,
  ): Promise<WorkflowPermissionRequiredResult | null> {
    const permissionSource = resolved.workflowSource;
    if (!WORKFLOW_PERMISSION_REQUIRED_SOURCES.has(permissionSource)) return null;
    const permissionKey = workflowPermissionKey(permissionSource, resolved.workflowSourcePath, parsed.meta.name, scriptHash);
    const existing = await this.workflowPermissionRecord(permissionKey);
    if (
      existing?.decision === 'allow'
      && workflowPermissionRecordMatchesCurrentReview(existing, requestedIsolation)
    ) {
      return null;
    }
    if (existing?.decision === 'deny') {
      throw workflowPermissionDeniedError(parsed.meta.name, permissionSource, scriptHash);
    }
    const permissionRequestId = workflowPermissionRequestId(permissionKey);
    const review: WorkflowPermissionReview = {
      permissionRequestId,
      reviewVersion: WORKFLOW_PERMISSION_REVIEW_VERSION,
      workflowName: parsed.meta.name,
      ...(parsed.meta.description ? { summary: parsed.meta.description } : {}),
      workflowSource: permissionSource,
      ...(resolved.workflowSourcePath ? { workflowSourcePath: resolved.workflowSourcePath } : {}),
      scriptHash,
      phases: parsed.meta.phases?.map((phase) => phase.title) ?? [],
      requestedIsolationModes: requestedIsolation.modes,
      dynamicIsolation: requestedIsolation.dynamic,
      riskSummary: workflowPermissionRiskSummary(permissionSource, requestedIsolation),
      scriptPreview: preview(resolved.script, 1600),
    };
    this.permissionRequests.set(permissionRequestId, {
      permissionRequestId,
      permissionKey,
      input,
      review,
    });
    return {
      status: 'permission_required',
      taskType: 'local_workflow',
      workflowName: parsed.meta.name,
      ...(parsed.meta.description ? { summary: parsed.meta.description } : {}),
      workflowSource: permissionSource,
      ...(resolved.workflowSourcePath ? { workflowSourcePath: resolved.workflowSourcePath } : {}),
      scriptHash,
      permissionRequestId,
      review,
    };
  }

  private async resolveTrustedScriptPathMetadata(
    resolved: ResolvedWorkflowLaunchInput,
    parsed: ParsedWorkflowScript,
    scriptHash: string,
    isolationReview: WorkflowIsolationReview,
  ): Promise<ResolvedWorkflowLaunchInput> {
    if (!resolved.scriptPath || !resolved.scriptMetadata) return resolved;
    const metadata = resolved.scriptMetadata;
    if (metadata.scriptHash !== scriptHash || metadata.workflowName !== parsed.meta.name) return resolved;
    const permissionKey = workflowPermissionKey(
      metadata.workflowSource,
      metadata.workflowSourcePath,
      parsed.meta.name,
      scriptHash,
    );
    if (metadata.permissionKey !== permissionKey) return resolved;
    const record = await this.workflowPermissionRecord(permissionKey);
    if (!workflowPermissionRecordMatchesMetadata(record, metadata, parsed.meta.name, scriptHash, isolationReview)) return resolved;
    const trusted: ResolvedWorkflowLaunchInput = {
      ...resolved,
      workflowSource: metadata.workflowSource,
      scriptMetadata: metadata,
    };
    if (metadata.workflowSourcePath) {
      return { ...trusted, workflowSourcePath: metadata.workflowSourcePath };
    }
    const { workflowSourcePath: _ignored, ...withoutSourcePath } = trusted;
    return withoutSourcePath;
  }

  getPermissionRequest(permissionRequestId: string): WorkflowPermissionReview | null {
    return this.permissionRequests.get(permissionRequestId)?.review ?? null;
  }

  async approvePermissionRequest(permissionRequestId: string): Promise<WorkflowLaunchResult> {
    const request = this.consumePendingWorkflowPermission(permissionRequestId);
    await this.recordWorkflowPermission(request, 'allow');
    return this.launch(request.input);
  }

  async denyPermissionRequest(permissionRequestId: string): Promise<WorkflowPermissionDeniedResult> {
    const request = this.consumePendingWorkflowPermission(permissionRequestId);
    await this.recordWorkflowPermission(request, 'deny');
    return {
      status: 'permission_denied',
      taskType: 'local_workflow',
      workflowName: request.review.workflowName,
      workflowSource: request.review.workflowSource,
      ...(request.review.workflowSourcePath ? { workflowSourcePath: request.review.workflowSourcePath } : {}),
      scriptHash: request.review.scriptHash,
      permissionRequestId,
      reason: 'workflow_permission_denied',
    };
  }

  private consumePendingWorkflowPermission(permissionRequestId: string): WorkflowPermissionRequestMutable {
    const request = this.permissionRequests.get(permissionRequestId);
    if (!request) throw workflowInputError(`Unknown workflow permission request: ${permissionRequestId}`);
    this.deletePendingWorkflowPermissions(request.permissionKey);
    return request;
  }

  private deletePendingWorkflowPermissions(permissionKey: string): void {
    for (const [requestId, request] of this.permissionRequests.entries()) {
      if (request.permissionKey === permissionKey) this.permissionRequests.delete(requestId);
    }
  }

  private async workflowPermissionRecord(permissionKey: string): Promise<WorkflowPermissionRecord | undefined> {
    return (await this.workflowPermissionRecords()).get(permissionKey);
  }

  private async recordWorkflowPermission(
    request: WorkflowPermissionRequestMutable,
    decision: WorkflowPermissionDecision,
  ): Promise<void> {
    await this.recordWorkflowPermissionRecord({
      permissionKey: request.permissionKey,
      decision,
      ...workflowPermissionReviewRecordFields(request.review),
      workflowName: request.review.workflowName,
      workflowSource: request.review.workflowSource,
      ...(request.review.workflowSourcePath ? { workflowSourcePath: request.review.workflowSourcePath } : {}),
      scriptHash: request.review.scriptHash,
      decidedAt: new Date().toISOString(),
    });
  }

  private async recordWorkflowSourceAllow(
    resolved: ResolvedWorkflowLaunchInput,
    parsed: ParsedWorkflowScript,
    scriptHash: string,
    isolationReview: WorkflowIsolationReview,
  ): Promise<void> {
    const permissionKey = workflowPermissionKey(
      resolved.workflowSource,
      resolved.workflowSourcePath,
      parsed.meta.name,
      scriptHash,
    );
    const existing = await this.workflowPermissionRecord(permissionKey);
    if (
      existing?.decision === 'allow'
      && workflowPermissionRecordMatchesCurrentReview(existing, isolationReview)
    ) {
      return;
    }
    await this.recordWorkflowPermissionRecord({
      permissionKey,
      decision: 'allow',
      ...workflowIsolationReviewRecordFields(isolationReview),
      workflowName: parsed.meta.name,
      workflowSource: resolved.workflowSource,
      ...(resolved.workflowSourcePath ? { workflowSourcePath: resolved.workflowSourcePath } : {}),
      scriptHash,
      decidedAt: new Date().toISOString(),
    });
  }

  private async recordWorkflowPermissionRecord(record: WorkflowPermissionRecord): Promise<void> {
    const records = await this.workflowPermissionRecords();
    records.set(record.permissionKey, record);
    await this.writeWorkflowPermissionRecords(records);
  }

  private async workflowPermissionRecords(): Promise<Map<string, WorkflowPermissionRecord>> {
    if (this.permissionRecords) return this.permissionRecords;
    const records = new Map<string, WorkflowPermissionRecord>();
    try {
      const raw = JSON.parse(await readFile(this.workflowPermissionStorePath(), 'utf8')) as unknown;
      const store = asRecord(raw);
      const decisions = store?.decisions;
      if (Array.isArray(decisions)) {
        for (const item of decisions) {
          const record = workflowPermissionRecordFromUnknown(item);
          if (record) records.set(record.permissionKey, record);
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw workflowInputError('Workflow permission store cannot be read.');
    }
    this.permissionRecords = records;
    return records;
  }

  private async writeWorkflowPermissionRecords(records: Map<string, WorkflowPermissionRecord>): Promise<void> {
    await ensureWorkflowStateDirectory(join(this.stateDir, 'workflows'));
    const store: WorkflowPermissionStore = {
      version: WORKFLOW_PERMISSION_STORE_VERSION,
      decisions: [...records.values()].sort((left, right) => left.permissionKey.localeCompare(right.permissionKey)),
    };
    await writeWorkflowStateFile(this.workflowPermissionStorePath(), `${JSON.stringify(store, null, 2)}\n`);
  }

  private workflowPermissionStorePath(): string {
    return join(this.stateDir, 'workflows', 'permissions.json');
  }

  private async resolveNamedWorkflow(name: string): Promise<ResolvedWorkflowLaunchInput> {
    const available = new Set<string>();
    const project = await this.findNamedWorkflowInDirs(
      name,
      'project',
      PROJECT_WORKFLOW_DIRS.map((dir) => join(this.options.cwd ?? process.cwd(), dir)),
      available,
    );
    if (project) return project;
    const user = await this.findNamedWorkflowInDirs(
      name,
      'user',
      this.userWorkflowDirs(),
      available,
    );
    if (user) return user;
    for (const plugin of this.options.pluginWorkflows ?? []) {
      const pluginName = plugin.pluginName.trim();
      if (!pluginName) continue;
      const pluginWorkflow = await this.findNamedWorkflowInDirs(
        name,
        'plugin',
        pluginWorkflowDirs(plugin),
        available,
        pluginName,
      );
      if (pluginWorkflow) return pluginWorkflow;
    }
    const builtIn = this.findBuiltinWorkflow(name, available);
    if (builtIn) return builtIn;
    throw namedWorkflowNotFoundError(name, available);
  }

  private userWorkflowDirs(): readonly string[] {
    if (this.options.userWorkflowDirs) return this.options.userWorkflowDirs;
    const codexHome = process.env.CODEX_HOME?.trim()
      ? resolve(process.env.CODEX_HOME)
      : join(homedir(), '.codex');
    return [
      join(codexHome, 'workflows'),
    ];
  }

  private async findNamedWorkflowInDirs(
    requestedName: string,
    workflowSource: Extract<WorkflowSource, 'project' | 'user' | 'plugin'>,
    dirs: readonly string[],
    available: Set<string>,
    prefix?: string,
  ): Promise<ResolvedWorkflowLaunchInput | null> {
    for (const dir of dirs) {
      const files = await workflowScriptFiles(dir);
      const ordered = [
        ...files.filter((file) => prefixedWorkflowName(workflowFileName(file), prefix) === requestedName),
        ...files.filter((file) => prefixedWorkflowName(workflowFileName(file), prefix) !== requestedName),
      ];
      for (const file of ordered) {
        const scriptPath = join(dir, file);
        const fileName = prefixedWorkflowName(workflowFileName(file), prefix);
        let script: string;
        let canonicalPath: string;
        let parsed: ParsedWorkflowScript;
        try {
          canonicalPath = await realpath(scriptPath);
          script = await readFile(canonicalPath, 'utf8');
          parsed = parseInlineWorkflowScript(script);
        } catch (err) {
          if (fileName === requestedName) throw err;
          continue;
        }
        const metaName = prefixedWorkflowName(parsed.meta.name, prefix);
        available.add(metaName);
        if (fileName !== metaName) available.add(fileName);
        if (fileName === requestedName || metaName === requestedName) {
          return {
            name: requestedName,
            script,
            workflowSource,
            workflowSourcePath: canonicalPath,
          };
        }
      }
    }
    return null;
  }

  private findBuiltinWorkflow(
    requestedName: string,
    available: Set<string>,
  ): ResolvedWorkflowLaunchInput | null {
    for (const workflow of this.options.builtinWorkflows ?? DEFAULT_BUILTIN_WORKFLOWS) {
      const name = workflow.name.trim();
      if (!name) continue;
      available.add(name);
      if (name !== requestedName) continue;
      return {
        name,
        script: workflow.script,
        workflowSource: 'built_in',
      };
    }
    return null;
  }

  private workflowScriptsDir(): string {
    return join(this.stateDir, 'workflows', 'scripts');
  }

  private workflowScriptPath(workflowName: string, runId: string): string {
    return join(this.workflowScriptsDir(), `${workflowScriptSlug(workflowName)}-${runId}.js`);
  }

  private async persistInlineWorkflowScript(scriptPath: string, script: string): Promise<string> {
    await ensureWorkflowStateDirectory(this.workflowScriptsDir());
    await writeWorkflowStateFile(scriptPath, script, { flag: 'wx' });
    return await realpath(scriptPath);
  }

  private async writeWorkflowScriptMetadata(
    scriptPath: string,
    resolved: ResolvedWorkflowLaunchInput,
    parsed: ParsedWorkflowScript,
    scriptHash: string,
  ): Promise<void> {
    const metadata: WorkflowScriptMetadata = {
      version: 1,
      workflowName: parsed.meta.name,
      workflowSource: resolved.workflowSource,
      ...(resolved.workflowSourcePath ? { workflowSourcePath: resolved.workflowSourcePath } : {}),
      scriptHash,
      permissionKey: workflowPermissionKey(resolved.workflowSource, resolved.workflowSourcePath, parsed.meta.name, scriptHash),
    };
    await writeWorkflowStateFile(workflowScriptMetadataPath(scriptPath), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  }

  private async readRuntimeWorkflowScript(
    scriptPath: string,
  ): Promise<{ readonly script: string; readonly scriptPath: string; readonly metadata?: WorkflowScriptMetadata }> {
    const scriptsDir = this.workflowScriptsDir();
    await ensureWorkflowStateDirectory(scriptsDir);
    const root = await realpath(scriptsDir);
    const requested = isAbsolute(scriptPath)
      ? resolve(scriptPath)
      : resolve(this.options.cwd ?? process.cwd(), scriptPath);
    let canonicalScriptPath: string;
    try {
      canonicalScriptPath = await realpath(requested);
    } catch {
      throw workflowInputError(`Workflow scriptPath not found: ${scriptPath}`);
    }
    if (!pathInsideOrEqual(root, canonicalScriptPath)) {
      throw workflowInputError('scriptPath must point to a runtime-owned workflow script.');
    }
    try {
      const script = await readFile(canonicalScriptPath, 'utf8');
      const metadata = await this.readWorkflowScriptMetadata(canonicalScriptPath);
      const currentScriptHash = workflowScriptHash(script);
      return {
        script,
        scriptPath: canonicalScriptPath,
        ...(metadata.metadata?.scriptHash === currentScriptHash ? metadata : {}),
      };
    } catch {
      throw workflowInputError(`Workflow scriptPath cannot be read: ${scriptPath}`);
    }
  }

  private async readWorkflowScriptMetadata(
    scriptPath: string,
  ): Promise<{ readonly metadata?: WorkflowScriptMetadata }> {
    try {
      const metadata = workflowScriptMetadataFromUnknown(JSON.parse(await readFile(workflowScriptMetadataPath(scriptPath), 'utf8')));
      return metadata ? { metadata } : {};
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return {};
      return {};
    }
  }

  get(taskId: string): WorkflowTaskSnapshot | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return workflowTaskSnapshot(task);
  }

  async cancel(taskId: string): Promise<WorkflowTaskSnapshot> {
    const task = this.tasks.get(taskId);
    if (!task) throw workflowInputError(`Unknown workflow task: ${taskId}`);
    if (task.status === 'running') {
      task.abortRequested = true;
      task.abortFailure = { message: 'Workflow cancelled.', reason: 'workflow_aborted' };
      task.controller?.abort();
      if (task.runPromise) {
        await task.runPromise;
        return workflowTaskSnapshot(task);
      }
      return await this.failTask(task, 'Workflow cancelled.', 'workflow_aborted');
    }
    return workflowTaskSnapshot(task);
  }

  async retry(taskId: string): Promise<WorkflowLaunchResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw workflowInputError(`Unknown workflow task: ${taskId}`);
    if (task.status === 'running') {
      throw new UltracodeRequestError(
        'Running workflows cannot be retried; cancel or wait for a terminal state first.',
        409,
        'invalid_request_error',
        WORKFLOW_INPUT_PARAM,
        'workflow_input_invalid',
      );
    }
    // Retry resumes the failed run so durably completed agent results are
    // reused; a source whose journal cannot serve as a resume source (for
    // example after a journal write failure) falls back to a fresh re-run.
    try {
      return await this.launch({
        resumeFromRunId: task.runId,
        ...(typeof task.retryInput.toolName === 'string' && task.retryInput.toolName
          ? { toolName: task.retryInput.toolName }
          : {}),
      });
    } catch (err) {
      if (err instanceof UltracodeRequestError && err.code === 'workflow_input_invalid') {
        return await this.launch(task.retryInput);
      }
      throw err;
    }
  }

  async *streamEvents(taskId: string, signal?: AbortSignal): AsyncIterable<WorkflowEvent> {
    const task = this.tasks.get(taskId);
    if (!task) throw workflowInputError(`Unknown workflow task: ${taskId}`);
    let index = 0;
    while (true) {
      while (index < task.events.length) {
        if (signal?.aborted) return;
        yield task.events[index] as WorkflowEvent;
        index += 1;
      }
      if (task.status !== 'running') return;
      if (!await waitForWorkflowTaskEvent(task, signal)) return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        task.abortRequested = true;
        task.abortFailure = { message: 'Workflow runtime closed.', reason: 'runtime_closed' };
        task.controller?.abort();
        if (task.runPromise) {
          await task.runPromise;
        } else {
          await this.failTask(task, 'Workflow runtime closed.', 'runtime_closed');
        }
      }
    }
    await this.options.backend.close();
  }

  private async runTask(
    task: WorkflowTaskMutable,
    parsed: ParsedWorkflowScript,
    input: WorkflowLaunchInput,
    resumeCache?: WorkflowResumeCache,
  ): Promise<void> {
    const controller = new AbortController();
    const ctx: WorkflowRunContext = {
      task,
      parsed,
      input,
      isolationReview: task.isolationReview,
      ...(resumeCache ? { resumeCache } : {}),
      startedAt: task.startedAt,
      model: this.options.backend.model,
      inputTokens: 0,
      outputTokens: 0,
      agentCount: 0,
      tokens: 0,
      toolCalls: 0,
      controller,
      timers: new Map(),
      asyncFinalizers: new Set(),
      nextTimerId: 1,
      previousAgentCallKey: WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY,
      usedLogicalKeys: new Set(),
      budgetTotal: this.budgetTotal,
      ...(this.agentConcurrency != null ? { agentPool: new AgentConcurrencyPool(this.agentConcurrency) } : {}),
    };
    task.controller = controller;
    if (task.abortRequested) controller.abort();
    if (task.status !== 'running') {
      controller.abort();
      return;
    }
    const workflowTimer = this.options.requestTimeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, this.options.requestTimeoutMs)
      : null;
    // Non-destructive liveness heartbeat: surfaces phase/elapsed/agent progress
    // on an interval so a long or stuck run stays visible under an unbounded
    // deadline. It only emits an event; it never aborts the run.
    let heartbeatSeq = 0;
    const heartbeatTimer = this.heartbeatMs > 0
      ? setInterval(() => {
          this.emit(task, {
            type: 'workflow.heartbeat',
            taskId: task.taskId,
            runId: task.runId,
            elapsedMs: Date.now() - ctx.startedAt,
            phase: ctx.currentPhase,
            completedAgentCount: task.events.filter((event) => event.type === 'workflow.agent.completed').length,
            knownAgentCount: ctx.agentCount,
            seq: (heartbeatSeq += 1),
          });
        }, this.heartbeatMs)
      : null;
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    try {
      if (controller.signal.aborted) throw workflowInputError('Workflow is aborted.');
      const result = await executeInlineWorkflow(parsed, this.createVmGlobals(ctx), controller.signal);
      await this.drainWorkflowFinalizers(ctx);
      if (controller.signal.aborted || task.status !== 'running') return;
      const journalResult = journalJsonValueOrInputError(result, 'workflow result');
      const resultPath = join(this.stateDir, 'workflows', `${task.runId}.result.json`);
      await ensureWorkflowStateDirectory(join(this.stateDir, 'workflows'));
      await writeWorkflowStateFile(resultPath, `${JSON.stringify({
        taskId: task.taskId,
        runId: task.runId,
        workflowName: task.workflowName,
        workflowSource: task.workflowSource,
        ...(task.workflowSourcePath ? { workflowSourcePath: task.workflowSourcePath } : {}),
        scriptHash: task.scriptHash,
        retryInput: durableWorkflowRetryInput(task.retryInput),
        result: journalResult,
      }, null, 2)}\n`);
      const completedSnapshot = await this.completeTask(ctx, journalResult, {
        type: 'workflow.completed',
        taskId: task.taskId,
        runId: task.runId,
        resultPath,
        agentCount: ctx.agentCount,
        tokens: ctx.tokens,
        toolCalls: ctx.toolCalls,
        durationMs: Date.now() - ctx.startedAt,
      });
      void completedSnapshot;
    } catch (err) {
      const abortFailure = controller.signal.aborted
        ? task.abortFailure ?? { message: 'Workflow timed out or was aborted.', reason: 'workflow_aborted' }
        : null;
      await this.drainWorkflowFinalizers(ctx);
      await this.failTask(
        task,
        abortFailure ? abortFailure.message : workflowErrorMessage(err),
        abortFailure ? abortFailure.reason : workflowFailureReason(err),
      );
    } finally {
      if (workflowTimer) clearTimeout(workflowTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const timer of ctx.timers.values()) clearTimeout(timer);
      ctx.timers.clear();
    }
  }

  private createVmGlobals(ctx: WorkflowRunContext): WorkflowVmGlobals {
    const log = (message: unknown): void => {
      if (ctx.controller.signal.aborted || ctx.task.status !== 'running') return;
      this.emit(ctx.task, {
        type: 'workflow.log',
        taskId: ctx.task.taskId,
        runId: ctx.task.runId,
        message: String(message),
      });
    };
    const workflowSetTimeout = hardenCallable((callback: unknown, delay?: unknown, ...args: unknown[]): number => {
      if (ctx.controller.signal.aborted || ctx.task.status !== 'running') return 0;
      if (typeof callback !== 'function') throw workflowInputError('setTimeout callback must be a function.');
      const ms = typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? delay : 0;
      const timerId = ctx.nextTimerId;
      ctx.nextTimerId += 1;
      const handle = setTimeout(() => {
        ctx.timers.delete(timerId);
        if (!ctx.controller.signal.aborted && ctx.task.status === 'running') {
          try {
            const returned = (callback as (...values: unknown[]) => unknown)(...args);
            Promise.resolve(returned).catch((err) => {
              void this.failTaskFromCallback(ctx, err, 'workflow_timer_callback_failed');
            });
          } catch (err) {
            void this.failTaskFromCallback(ctx, err, 'workflow_timer_callback_failed');
          }
        }
      }, ms);
      ctx.timers.set(timerId, handle);
      return timerId;
    });
    const workflowClearTimeout = hardenCallable((handle: unknown): void => {
      if (typeof handle !== 'number') return;
      const timer = ctx.timers.get(handle);
      if (!timer) return;
      clearTimeout(timer);
      ctx.timers.delete(handle);
    });
    const host = Object.create(null) as Record<string, unknown>;
    host.trackPromise = hardenCallable((value: unknown): HandledWorkflowPromise<unknown> => this.trackWorkflowPromise(ctx, value));
    host.agent = hardenCallable((prompt: unknown, options?: AgentOptions): HandledWorkflowPromise<unknown> => this.runAgent(ctx, prompt, options));
    host.parallel = hardenCallable((items: unknown): HandledWorkflowPromise<unknown[]> => {
      return this.trackWorkflowPromise(ctx, this.parallel(ctx, items));
    });
    host.pipeline = hardenCallable((items: unknown, ...stages: unknown[]): HandledWorkflowPromise<unknown[]> => {
      return this.trackWorkflowPromise(ctx, this.pipeline(ctx, items, stages));
    });
    host.hash = hardenCallable((value: unknown): string => workflowValueHash(value));
    host.workspaceContext = hardenCallable((options?: unknown): HandledWorkflowPromise<string> => {
      return this.trackWorkflowPromise(ctx, this.workspaceContext(ctx, options));
    });
    host.announcePlan = hardenCallable((plan: unknown): void => this.announcePlan(ctx, plan));
    host.announcePhasePlan = hardenCallable((phasePlan: unknown): void => this.announcePhasePlan(ctx, phasePlan));
    host.phase = hardenCallable((title: unknown): void => this.phase(ctx, title));
    host.log = hardenCallable(log);
    host.consoleLog = hardenCallable((...values: unknown[]): void => {
      log(values.map((value) => String(value)).join(' '));
    });
    host.workflow = hardenCallable((): never => {
      throw workflowInputError('Nested workflow calls are not supported by this runtime yet.');
    });
    // Per-run output spend gauge. spent() = this run's fresh successful-agent output tokens
    // (cached agents contribute 0, matching the journaled per-run cost); remaining() is
    // Infinity when no ceiling is set, so an unset budget is inert.
    host.spent = hardenCallable((): number => ctx.outputTokens);
    host.remaining = hardenCallable((): number =>
      ctx.budgetTotal == null ? Infinity : Math.max(0, ctx.budgetTotal - ctx.outputTokens));
    host.setTimeout = workflowSetTimeout;
    host.clearTimeout = workflowClearTimeout;
    return {
      argsLiteral: vmDataLiteral(ctx.input.args, 'args'),
      budgetLiteral: vmDataLiteral({
        maxAgentCalls: MAX_AGENT_CALLS,
        maxParallelism: MAX_PARALLELISM,
        // Effective agent-dispatch pool size, or null when unbounded. Distinct from
        // maxParallelism, which stays the parallel()/pipeline() item fan-out bound.
        agentConcurrency: ctx.agentPool?.size ?? null,
        agentStallTimeoutMs: this.agentStallTimeoutMs,
        agentStallRetryLimit: this.agentStallRetryLimit,
      }, 'budget'),
      budgetTotalLiteral: ctx.budgetTotal === null ? 'null' : String(ctx.budgetTotal),
      host: Object.freeze(host),
      setVmValueProjector: (projector) => {
        ctx.toVmValue = projector;
      },
    };
  }

  private runAgent(
    ctx: WorkflowRunContext,
    prompt: unknown,
    options?: AgentOptions,
  ): HandledWorkflowPromise<unknown> {
    let resolveFinalizer: () => void;
    const finalizer = new Promise<void>((resolve) => {
      resolveFinalizer = resolve;
    });
    ctx.asyncFinalizers.add(finalizer);
    const inner = this.runAgentInner(ctx, prompt, options);
    inner.catch(() => undefined);
    const operation = inner.finally(() => {
      ctx.asyncFinalizers.delete(finalizer);
      resolveFinalizer!();
    });
    operation.catch(() => undefined);
    return this.trackWorkflowPromise(ctx, operation);
  }

  private async workspaceContext(ctx: WorkflowRunContext, options?: unknown): Promise<string> {
    if (ctx.controller.signal.aborted || ctx.task.status !== 'running') {
      throw workflowInputError('Workflow is aborted.');
    }
    return await buildWorkspaceContext(
      this.options.cwd ?? process.cwd(),
      normalizeWorkspaceContextOptions(options),
    );
  }

  private async runAgentInner(
    ctx: WorkflowRunContext,
    prompt: unknown,
    options?: AgentOptions,
  ): Promise<unknown> {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw workflowInputError('agent(prompt) requires a non-empty string prompt.');
    }
    if (ctx.controller.signal.aborted || ctx.task.status !== 'running') {
      throw workflowInputError('Workflow is aborted.');
    }
    if (ctx.agentCount >= MAX_AGENT_CALLS) {
      throw workflowInputError(`Workflow agent call cap exceeded (${MAX_AGENT_CALLS}).`);
    }
    // Pre-dispatch output-token ceiling, beside the agent-call cap: refuse a new dispatch
    // once this run's fresh spend reaches the budget. Non-retryable workflow_input_invalid,
    // like the cap; inside parallel()/pipeline() it becomes a per-item null (native parity).
    if (ctx.budgetTotal != null && ctx.outputTokens >= ctx.budgetTotal) {
      throw workflowInputError(`Workflow output-token budget exhausted (spent ${ctx.outputTokens} of ${ctx.budgetTotal}).`);
    }
    const schema = normalizeStructuredOutputSchema(options?.schema);
    const isolation = normalizeAgentIsolation(options?.isolation);
    const logicalKey = normalizeAgentLogicalKey(options?.key);
    const effort = normalizeAgentEffort(options?.effort)
      ?? this.options.defaultReasoningEffort
      ?? 'xhigh';
    const model = normalizeAgentModel(options?.model) ?? ctx.model;
    if (logicalKey) {
      // A repeated logical key would produce duplicate agent call keys, which
      // poisons the whole journal as a resume source; fail before any spend.
      if (ctx.usedLogicalKeys.has(logicalKey)) {
        throw workflowInputError(`agent key "${logicalKey}" was already used in this workflow run; use a distinct key per attempt when re-calling an agent.`);
      }
      ctx.usedLogicalKeys.add(logicalKey);
    }
    if (isolation && !workflowIsolationReviewAllowsMode(ctx.isolationReview, isolation)) {
      throw workflowInputError(`agent ${isolation} isolation was not covered by the current workflow permission review.`);
    }
    const agentIndex = ctx.agentCount;
    ctx.agentCount += 1;
    const agentId = `agent_${agentIndex + 1}`;
    const semanticOpts = workflowAgentSemanticOpts({
      model,
      effort,
      schema,
      isolation,
      logicalKey,
    });
    const previousAgentCallKey = ctx.previousAgentCallKey;
    const agentCallKey = computeWorkflowAgentCallKey({
      previousAgentCallKey,
      prompt,
      semanticOpts,
    });
    ctx.previousAgentCallKey = agentCallKey;
    const label = options?.label ?? preview(prompt, 48);
    const phase = options?.phase ?? ctx.currentPhase;
    try {
      await ctx.task.journal.append({
        kind: 'workflow.agent.started',
        agentIndex,
        agentId,
        previousAgentCallKey,
        agentCallKey,
        prompt,
        semanticOpts,
      });
    } catch (err) {
      ctx.controller.abort();
      await this.failTask(ctx.task, 'Workflow journal write failed before agent start.', WORKFLOW_JOURNAL_WRITE_FAILED_REASON);
      throw workflowJournalRuntimeError(err);
    }
    this.emit(ctx.task, {
      type: 'workflow.agent.started',
      taskId: ctx.task.taskId,
      runId: ctx.task.runId,
      agentIndex,
      agentId,
      label,
      phase,
      promptPreview: preview(prompt, 160),
    });
    const cached = takeResumeCacheHit(ctx.resumeCache, agentCallKey);
    if (cached) {
      try {
        await ctx.task.journal.append({
          kind: 'workflow.agent.completed',
          agentIndex,
          agentId,
          agentCallKey,
          result: cached.result,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          toolCalls: 0,
        });
      } catch (err) {
        ctx.controller.abort();
        await this.failTask(ctx.task, 'Workflow journal write failed after cached agent completion.', WORKFLOW_JOURNAL_WRITE_FAILED_REASON);
        throw workflowJournalRuntimeError(err);
      }
      this.emit(ctx.task, {
        type: 'workflow.agent.completed',
        taskId: ctx.task.taskId,
        runId: ctx.task.runId,
        agentIndex,
        agentId,
        label,
        phase,
        tokens: 0,
        toolCalls: 0,
        resultPreview: previewValue(cached.result, 160),
        cached: true,
        ...agentCompletionProgress(ctx, phase),
      });
      return cached.result;
    }
    const preservedWorktrees: WorkflowAgentPreservedWorktree[] = [];
    const recordWorktreeFinalization = (finalization: WorkflowAgentWorktreeFinalization): void => {
      if (!finalization.preserved || !finalization.preservedWorktree) return;
      if (preservedWorktrees.some((item) => item.path === finalization.preservedWorktree?.path)) return;
      preservedWorktrees.push(finalization.preservedWorktree);
    };
    try {
      const attempt = await this.runAgentWithStallRetries(ctx, {
        agentId,
        prompt,
        schema,
        isolation,
        model,
        effort,
        onWorktreeFinalized: recordWorktreeFinalization,
      });
      const result = attempt.result;
      if (attempt.worktreeFinalization) recordWorktreeFinalization(attempt.worktreeFinalization);
      if (ctx.controller.signal.aborted || ctx.task.status !== 'running') {
        throw workflowInputError('Workflow is aborted.');
      }
      const agentResult = schema
        ? structuredAgentResult(result, schema)
        : agentResultText(result);
      const journalResult = journalJsonValueOrInputError(agentResult, 'agent result');
      const usage = workflowUsage(result.usage);
      const toolCalls = result.toolCalls.length;
      try {
        await ctx.task.journal.append({
          kind: 'workflow.agent.completed',
          agentIndex,
          agentId,
          agentCallKey,
          result: journalResult,
          usage,
          toolCalls,
        });
      } catch (err) {
        ctx.controller.abort();
        await this.failTask(ctx.task, 'Workflow journal write failed after agent completion.', WORKFLOW_JOURNAL_WRITE_FAILED_REASON);
        throw workflowJournalRuntimeError(err);
      }
      ctx.inputTokens += usage.inputTokens;
      ctx.outputTokens += usage.outputTokens;
      ctx.tokens += usage.totalTokens;
      ctx.toolCalls += toolCalls;
      this.emit(ctx.task, {
        type: 'workflow.agent.completed',
        taskId: ctx.task.taskId,
        runId: ctx.task.runId,
        agentIndex,
        agentId,
        label,
        phase,
        tokens: usage.totalTokens,
        toolCalls,
        resultPreview: previewValue(journalResult, 160),
        ...agentCompletionProgress(ctx, phase),
        ...preservedWorktreeEventProjection(preservedWorktrees),
      });
      return journalResult;
    } catch (err) {
      if (isWorkflowJournalError(err)) throw err;
      if (ctx.task.status !== 'running') throw err;
      const error = workflowErrorMessage(err);
      try {
        await ctx.task.journal.append({
          kind: 'workflow.agent.failed',
          agentIndex,
          agentId,
          agentCallKey,
          reason: ctx.controller.signal.aborted
            ? ctx.task.abortFailure?.reason ?? 'workflow_aborted'
            : workflowFailureReason(err),
          message: error,
        });
      } catch (journalErr) {
        ctx.controller.abort();
        await this.failTask(ctx.task, 'Workflow journal write failed after agent failure.', WORKFLOW_JOURNAL_WRITE_FAILED_REASON);
        throw workflowJournalRuntimeError(journalErr);
      }
      this.emit(ctx.task, {
        type: 'workflow.agent.failed',
        taskId: ctx.task.taskId,
        runId: ctx.task.runId,
        agentIndex,
        agentId,
        label,
        phase,
        error,
        ...preservedWorktreeEventProjection(preservedWorktrees),
      });
      if (ctx.controller.signal.aborted) return null;
      throw err;
    }
  }

  private async createAgentWorktree(
    ctx: WorkflowRunContext,
    agentId: string,
    attemptIndex = 0,
  ): Promise<WorkflowAgentWorktree> {
    const cwd = this.options.cwd ?? process.cwd();
    let gitRoot: string;
    try {
      gitRoot = await gitOutput(cwd, ['rev-parse', '--show-toplevel']);
      await gitOutput(gitRoot, ['rev-parse', '--verify', 'HEAD']);
    } catch (err) {
      throw workflowInputError(`worktree isolation requires a git repository with at least one commit: ${workflowErrorMessage(err)}`);
    }
    const worktreeRoot = join(workflowWorktreeStoreRoot(gitRoot), ctx.task.runId);
    await ensureWorkflowStateDirectory(worktreeRoot);
    const worktreePath = join(worktreeRoot, attemptIndex === 0 ? agentId : `${agentId}-attempt-${attemptIndex + 1}`);
    try {
      await gitOutput(gitRoot, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
      return {
        gitRoot,
        path: await realpath(worktreePath),
        attemptIndex,
      };
    } catch (err) {
      throw workflowInputError(`worktree isolation could not create an isolated worktree: ${workflowErrorMessage(err)}`);
    }
  }

  private async finalizeAgentWorktree(
    worktree: WorkflowAgentWorktree,
    completed: boolean,
  ): Promise<WorkflowAgentWorktreeFinalization> {
    if (completed && this.worktreeRetention === 'remove-clean') {
      try {
        // Reclaim an unchanged completed worktree by delegating the cleanliness decision to
        // git: `worktree remove` (no --force) deletes a clean or ignored-only tree (matching
        // native "unchanged") and refuses one with real changes, so it is both the removal
        // gate and TOCTOU-safe. A cleanup failure must never fail a completed agent, so on
        // any error we fall through and preserve the worktree for review.
        await gitOutput(worktree.gitRoot, ['worktree', 'remove', worktree.path]);
        return { preserved: false };
      } catch {
        // Real changes (git refused) or a transient failure: preserve below.
      }
    }
    return {
      preserved: true,
      preservedWorktree: preservedWorktree(worktree, await this.worktreePreservationReason(worktree)),
    };
  }

  // Provenance status for preservation telemetry only (never the removal gate): includes
  // ignored artifacts via --ignored=matching, which git's own removal treats as removable.
  private async worktreePreservationReason(
    worktree: WorkflowAgentWorktree,
  ): Promise<'clean' | 'changed' | 'status_unavailable'> {
    try {
      const status = await gitOutput(worktree.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']);
      return status.trim() ? 'changed' : 'clean';
    } catch {
      return 'status_unavailable';
    }
  }

  private async runAgentWithStallRetries(
    ctx: WorkflowRunContext,
    input: {
      readonly agentId: string;
      readonly prompt: string;
      readonly schema?: Record<string, unknown>;
      readonly isolation?: 'worktree';
      readonly model: string;
      readonly effort: ReasoningEffort;
      readonly onWorktreeFinalized: (finalization: WorkflowAgentWorktreeFinalization) => void;
    },
  ): Promise<WorkflowAgentAttemptOutcome> {
    for (let retryIndex = 0; retryIndex <= this.agentStallRetryLimit; retryIndex += 1) {
      if (ctx.controller.signal.aborted || ctx.task.status !== 'running') {
        throw workflowInputError('Workflow is aborted.');
      }
      const worktree = input.isolation === 'worktree'
        ? await this.createAgentWorktree(ctx, input.agentId, retryIndex)
        : undefined;
      try {
        const result = await this.runAgentAttempt(ctx, agentRequest({
          model: input.model,
          effort: input.effort,
          prompt: input.prompt,
          schema: input.schema,
          worktreePath: worktree?.path,
        }));
        const worktreeFinalization = worktree
          ? await this.finalizeAgentWorktree(worktree, true)
          : undefined;
        if (worktreeFinalization) input.onWorktreeFinalized(worktreeFinalization);
        return {
          result,
          ...(worktreeFinalization ? { worktreeFinalization } : {}),
        };
      } catch (err) {
        if (worktree) {
          const worktreeFinalization = isWorkflowAgentStalledError(err) || ctx.controller.signal.aborted
            ? {
                preserved: true,
                preservedWorktree: preservedWorktree(
                  worktree,
                  ctx.controller.signal.aborted ? 'aborted' : 'stalled',
                ),
              } satisfies WorkflowAgentWorktreeFinalization
            : await this.finalizeAgentWorktree(worktree, false);
          input.onWorktreeFinalized(worktreeFinalization);
        }
        if (
          isWorkflowAgentStalledError(err)
          && retryIndex < this.agentStallRetryLimit
          && !ctx.controller.signal.aborted
          && ctx.task.status === 'running'
        ) {
          this.emit(ctx.task, {
            type: 'workflow.log',
            taskId: ctx.task.taskId,
            runId: ctx.task.runId,
            message: `${input.agentId} stalled; retrying (${retryIndex + 1}/${this.agentStallRetryLimit}).`,
          });
          continue;
        }
        throw err;
      }
    }
    throw workflowAgentStalledError(`Workflow agent stalled after ${this.agentStallRetryLimit + 1} attempts.`);
  }

  private async gitStatusArgsExcludingRuntimeState(gitRoot: string): Promise<readonly string[]> {
    return [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      '.',
      ...await this.gitRuntimeStateExcludePathspecs(gitRoot),
    ];
  }

  private async gitRuntimeStateExcludePathspecs(gitRoot: string): Promise<readonly string[]> {
    const canonicalGitRoot = await realpath(gitRoot).catch(() => resolve(gitRoot));
    const canonicalStateDir = await realpath(this.stateDir).catch(() => resolve(this.stateDir));
    const relativeStateDir = relative(canonicalGitRoot, canonicalStateDir);
    if (relativeStateDir && !relativeStateDir.startsWith('..') && !isAbsolute(relativeStateDir)) {
      return [`:(exclude)${relativeStateDir}`, `:(exclude)${relativeStateDir}/**`];
    }
    return [];
  }

  private async runAgentAttempt(ctx: WorkflowRunContext, request: SubagentRequest): Promise<SubagentResult> {
    const attemptController = new AbortController();
    let timedOut = false;
    const abortFromWorkflow = (): void => {
      attemptController.abort();
    };
    if (ctx.controller.signal.aborted || ctx.task.status !== 'running') {
      throw workflowInputError('Workflow is aborted.');
    }
    // Acquire a dispatch permit BEFORE the stall timer starts: waiting for a permit
    // must not count toward agentStallTimeoutMs, and an already-aborted run must not
    // take a slot (acquire rejects if the signal is aborted). Ownership of the release
    // transfers to `generated` below, so the permit is held for the real dispatch's
    // true lifetime -- releasing on the abort race would free the slot while the
    // dispatch is still in flight and let the next attempt over-subscribe the pool.
    let releaseAgentPermit: (() => void) | undefined;
    if (ctx.agentPool) {
      try {
        releaseAgentPermit = await ctx.agentPool.acquire(ctx.controller.signal);
      } catch (err) {
        if (ctx.controller.signal.aborted || ctx.task.status !== 'running') {
          throw workflowInputError('Workflow is aborted.');
        }
        throw err;
      }
    }
    ctx.controller.signal.addEventListener('abort', abortFromWorkflow, { once: true });
    const timer = this.agentStallTimeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          attemptController.abort();
        }, this.agentStallTimeoutMs)
      : null;
    try {
      type AgentAttemptOutcome =
        | { readonly type: 'result'; readonly result: SubagentResult }
        | { readonly type: 'error'; readonly error: unknown }
        | { readonly type: 'aborted' };
      let dispatched: Promise<AgentAttemptOutcome>;
      try {
        dispatched = this.options.backend.generate(request, attemptController.signal).then(
          (result) => ({ type: 'result', result }),
          (err) => ({ type: 'error', error: err }),
        );
      } catch (syncErr) {
        // A backend is contracted to return a promise; if one throws synchronously the
        // permit would otherwise leak (its release transfers to `dispatched` below and
        // that promise never exists), deadlocking the pool. Release before rethrowing.
        if (releaseAgentPermit) releaseAgentPermit();
        throw syncErr;
      }
      // Release when the real dispatch settles, not when the abort race resolves.
      const generated = releaseAgentPermit
        ? dispatched.finally(releaseAgentPermit)
        : dispatched;
      const aborted = new Promise<AgentAttemptOutcome>((resolve) => {
        attemptController.signal.addEventListener('abort', () => {
          resolve({ type: 'aborted' });
        }, { once: true });
      });
      const outcome = await Promise.race([generated, aborted]);
      if (timedOut) {
        throw workflowAgentStalledError(`Workflow agent stalled after ${this.agentStallTimeoutMs} ms.`);
      }
      if (outcome.type === 'result') return outcome.result;
      if (outcome.type === 'aborted') {
        throw workflowInputError('Workflow is aborted.');
      }
      if (ctx.controller.signal.aborted || ctx.task.status !== 'running') {
        throw workflowInputError('Workflow is aborted.');
      }
      // The backend surfaces its failures as plain, uncoded Errors. Left uncoded they
      // collapse into the `workflow_failed` catch-all, which is indistinguishable from an
      // uncoded throw in workflow script code -- so any downstream classifier has to guess
      // transient-vs-deterministic from the shape of the error, and guesses wrong. Code the
      // failure here, at the boundary it crosses, so classification never has to infer it.
      if (isSubagentFailure(outcome.error) && !outcome.error.recognized) {
        // A failure the taxonomy did not recognize defaults to retryable; surface it so a
        // codex variant renamed upstream cannot degrade into "retry forever" unseen.
        this.emit(ctx.task, {
          type: 'workflow.log',
          taskId: ctx.task.taskId,
          runId: ctx.task.runId,
          message: `unclassified backend failure (variant: ${outcome.error.variant ?? 'none'}); treated as ${outcome.error.kind} and retryable.`,
        });
      }
      throw codedAgentFailure(outcome.error);
    } finally {
      if (timer) clearTimeout(timer);
      ctx.controller.signal.removeEventListener('abort', abortFromWorkflow);
    }
  }

  private async parallel(ctx: WorkflowRunContext, items: unknown): Promise<unknown[]> {
    if (!Array.isArray(items)) throw workflowInputError('parallel() requires an array.');
    if (items.length > MAX_PARALLEL_ITEMS) {
      throw workflowInputError(`parallel() accepts at most ${MAX_PARALLEL_ITEMS} items; got ${items.length}.`);
    }
    return mapWithConcurrency(items, MAX_PARALLELISM, async (item) => {
      try {
        return typeof item === 'function' ? await (item as () => unknown)() : await item;
      } catch (err) {
        this.emit(ctx.task, {
          type: 'workflow.log',
          taskId: ctx.task.taskId,
          runId: ctx.task.runId,
          message: `parallel item failed: ${workflowErrorMessage(err)}`,
        });
        return null;
      }
    });
  }

  private async pipeline(ctx: WorkflowRunContext, items: unknown, stages: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(items)) throw workflowInputError('pipeline() requires an item array.');
    if (items.length > MAX_PARALLEL_ITEMS) {
      throw workflowInputError(`pipeline() accepts at most ${MAX_PARALLEL_ITEMS} items; got ${items.length}.`);
    }
    for (const stage of stages) {
      if (typeof stage !== 'function') throw workflowInputError('pipeline() stages must be functions.');
    }
    return mapWithConcurrency(items, MAX_PARALLELISM, async (item, index) => {
      // Native parity: each stage receives (prevResult, originalItem, index). Only a
      // stage that THROWS drops the item to null and skips the rest; a stage that
      // returns null/undefined passes that value onward to the next stage.
      let current: unknown = item;
      for (const stage of stages as Array<(prev: unknown, original: unknown, index: number) => unknown>) {
        try {
          current = await stage(current, item, index);
        } catch (err) {
          this.emit(ctx.task, {
            type: 'workflow.log',
            taskId: ctx.task.taskId,
            runId: ctx.task.runId,
            message: `pipeline stage failed: ${workflowErrorMessage(err)}`,
          });
          return null;
        }
      }
      return current;
    });
  }

  private announcePlan(ctx: WorkflowRunContext, plan: unknown): void {
    if (ctx.controller.signal.aborted || ctx.task.status !== 'running') {
      throw workflowInputError('Workflow is aborted.');
    }
    const normalized = normalizeWorkflowExecutionPlan(plan);
    ctx.announcedPlan = normalized;
    this.emit(ctx.task, {
      type: 'workflow.plan.ready',
      taskId: ctx.task.taskId,
      runId: ctx.task.runId,
      ...normalized,
    });
  }

  private announcePhasePlan(ctx: WorkflowRunContext, phasePlan: unknown): void {
    if (ctx.controller.signal.aborted || ctx.task.status !== 'running') {
      throw workflowInputError('Workflow is aborted.');
    }
    const normalized = normalizeWorkflowPhasePlan(phasePlan, 'announcePhasePlan(phasePlan)');
    ctx.pendingPhasePlan = normalized;
    const phaseIndex = ctx.task.events
      .filter((event) => event.type === 'workflow.phase.started')
      .length;
    this.emit(ctx.task, {
      type: 'workflow.phase.planned',
      taskId: ctx.task.taskId,
      runId: ctx.task.runId,
      phaseIndex,
      title: normalized.title,
      ...(normalized.goal ? { goal: normalized.goal } : {}),
      plannedAgentCount: normalized.agents.length,
      plannedAgents: normalized.agents,
    });
  }

  private phase(ctx: WorkflowRunContext, title: unknown): void {
    if (typeof title !== 'string' || title.trim() === '') {
      throw workflowInputError('phase() requires a non-empty string title.');
    }
    const normalizedTitle = title.trim();
    ctx.currentPhase = normalizedTitle;
    const phaseIndex = ctx.task.events
      .filter((event) => event.type === 'workflow.phase.started')
      .length;
    const detail = ctx.parsed.meta.phases?.find((item) => item.title === normalizedTitle)?.detail;
    const pendingPhase = ctx.pendingPhasePlan?.title === normalizedTitle
      ? ctx.pendingPhasePlan
      : undefined;
    if (pendingPhase) ctx.pendingPhasePlan = undefined;
    const plannedPhase = pendingPhase ?? workflowPlannedPhase(ctx.announcedPlan, phaseIndex, normalizedTitle);
    this.emit(ctx.task, {
      type: 'workflow.phase.started',
      taskId: ctx.task.taskId,
      runId: ctx.task.runId,
      phaseIndex,
      title: normalizedTitle,
      ...(detail ? { detail } : {}),
      ...(plannedPhase?.goal ? { goal: plannedPhase.goal } : {}),
      ...(plannedPhase ? {
        plannedAgentCount: plannedPhase.agents.length,
        plannedAgents: plannedPhase.agents,
      } : {}),
    });
  }

  private async completeTask(
    ctx: WorkflowRunContext,
    result: JsonValue,
    event: Extract<WorkflowEvent, { type: 'workflow.completed' }>,
  ): Promise<WorkflowTaskSnapshot> {
    return await this.finalizeTask(ctx.task, async () => {
      await ctx.task.journal.append({
        kind: 'workflow.run.completed',
        result,
        resultPath: event.resultPath,
        agentCount: ctx.agentCount,
        usage: {
          inputTokens: ctx.inputTokens,
          outputTokens: ctx.outputTokens,
          totalTokens: ctx.tokens,
        },
        toolCalls: ctx.toolCalls,
        durationMs: event.durationMs,
      });
      ctx.task.result = result;
      ctx.task.resultPath = event.resultPath;
      this.emit(ctx.task, event);
      ctx.task.status = 'completed';
    });
  }

  private async failTask(task: WorkflowTaskMutable, error: string, reason: string): Promise<WorkflowTaskSnapshot> {
    return await this.finalizeTask(task, async () => {
      await task.journal.append({
        kind: 'workflow.run.failed',
        reason,
        message: error,
        durationMs: Date.now() - task.startedAt,
      });
      task.error = error;
      task.failureReason = reason;
      this.emit(task, {
        type: 'workflow.failed',
        taskId: task.taskId,
        runId: task.runId,
        error,
        recovery: { retryable: isRetryableFailureReason(reason), reason },
      });
      task.status = 'failed';
    });
  }

  private async finalizeTask(task: WorkflowTaskMutable, action: () => Promise<void>): Promise<WorkflowTaskSnapshot> {
    if (task.terminalFinalization) return await task.terminalFinalization;
    task.terminalFinalization = (async () => {
      if (task.status !== 'running' || task.terminalEmitted) return workflowTaskSnapshot(task);
      try {
        await action();
      } catch (err) {
        task.error = WORKFLOW_JOURNAL_PUBLIC_FAILURE_MESSAGE;
        task.failureReason = WORKFLOW_JOURNAL_WRITE_FAILED_REASON;
        task.status = 'failed';
        task.terminalEmitted = true;
        this.notifyTaskWaiters(task);
      }
      await rm(workflowRunPidPath(task.transcriptDir), { force: true }).catch(() => undefined);
      return workflowTaskSnapshot(task);
    })();
    return await task.terminalFinalization;
  }

  private async failTaskFromCallback(
    ctx: WorkflowRunContext,
    err: unknown,
    fallbackReason: string,
    excludeFinalizer?: Promise<void>,
  ): Promise<void> {
    if (ctx.controller.signal.aborted || ctx.task.status !== 'running') return;
    // Prefer the underlying error's canonical code so a stall surfacing through a tracked
    // promise stays `workflow_agent_stalled` and remains retryable. Keep the callback's own
    // wrapper reason for an uncoded error: a plain throw from a timer or a rejected promise
    // in workflow script code is a deterministic defect, and the `workflow_failed` catch-all
    // would classify it as retryable and repeat it to the retry limit.
    const derived = workflowFailureReason(err);
    ctx.task.abortFailure = {
      message: workflowErrorMessage(err),
      reason: derived === 'workflow_failed' ? fallbackReason : derived,
    };
    ctx.controller.abort();
    await this.drainWorkflowFinalizers(ctx, excludeFinalizer);
    await this.failTask(
      ctx.task,
      ctx.task.abortFailure.message,
      ctx.task.abortFailure.reason,
    );
  }

  private async drainWorkflowFinalizers(ctx: WorkflowRunContext, exclude?: Promise<void>): Promise<void> {
    while (ctx.asyncFinalizers.size > (exclude ? 1 : 0)) {
      const pending = [...ctx.asyncFinalizers].filter((finalizer) => finalizer !== exclude);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private trackWorkflowPromise<T>(ctx: WorkflowRunContext, value: T | PromiseLike<T>): HandledWorkflowPromise<T> {
    const promise = Promise.resolve(value);
    const tracking: WorkflowPromiseTracking = {
      handled: false,
      projectValue: (nextValue) => ctx.toVmValue ? ctx.toVmValue(nextValue) : nextValue,
      trackPromise: <U>(nextPromise: Promise<U>) => this.trackWorkflowPromise(ctx, nextPromise),
    };
    let finalizer: Promise<void>;
    const settled = promise.then(
      () => undefined,
      async (reason) => {
        await sleep(0);
        if (!tracking.handled) {
          await this.failTaskFromCallback(ctx, reason, 'workflow_promise_rejected', finalizer);
        }
      },
    );
    const aborted = new Promise<void>((resolve) => {
      if (ctx.controller.signal.aborted) {
        resolve();
      } else {
        ctx.controller.signal.addEventListener('abort', () => resolve(), { once: true });
      }
    });
    finalizer = Promise.race([settled, aborted]).finally(() => {
      ctx.asyncFinalizers.delete(finalizer);
    });
    finalizer.catch(() => undefined);
    ctx.asyncFinalizers.add(finalizer);
    return handledWorkflowPromise(promise, tracking);
  }

  private emit(task: WorkflowTaskMutable, event: WorkflowEvent): void {
    if (task.terminalEmitted) return;
    if (isTerminalWorkflowEvent(event)) task.terminalEmitted = true;
    task.events.push(event);
    this.notifyTaskWaiters(task);
  }

  private notifyTaskWaiters(task: WorkflowTaskMutable): void {
    const waiters = task.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

function normalizeLaunchInput(input: WorkflowLaunchInput): WorkflowLaunchInput {
  if (input.toolName !== undefined && !WORKFLOW_TOOL_NAMES.has(input.toolName)) {
    throw workflowInputError('Workflow launch tool must be Workflow or RunWorkflow.');
  }
  const resume = Object.prototype.hasOwnProperty.call(input, 'resumeFromRunId')
    ? { resumeFromRunId: normalizeResumeFromRunId(input.resumeFromRunId) }
    : {};
  if (input.scriptPath !== undefined) {
    if (typeof input.scriptPath !== 'string') {
      throw workflowInputError('Workflow scriptPath must be a non-empty string.');
    }
    const scriptPath = input.scriptPath.trim();
    if (!scriptPath) throw workflowInputError('Workflow scriptPath must be a non-empty string.');
    return { ...input, ...resume, scriptPath };
  }
  if (input.name !== undefined) {
    if (typeof input.name !== 'string') {
      throw workflowInputError('Workflow name must be a non-empty string.');
    }
    const name = input.name.trim();
    if (!name) throw workflowInputError('Workflow name must be a non-empty string.');
    return { ...input, ...resume, name };
  }
  if (typeof input.script !== 'string' || input.script.trim() === '') {
    throw workflowInputError('Workflow launch requires an inline script string.');
  }
  return { ...input, ...resume, script: input.script };
}

function workflowLaunchHasSourceSelector(input: WorkflowLaunchInput): boolean {
  return input.script !== undefined || input.name !== undefined || input.scriptPath !== undefined;
}

function normalizeResumeFromRunId(value: unknown): string {
  if (typeof value !== 'string') {
    throw workflowInputError('resumeFromRunId must be a non-empty workflow runId string.');
  }
  const runId = value.trim();
  if (!runId) throw workflowInputError('resumeFromRunId must be a non-empty workflow runId string.');
  if (!/^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    throw workflowInputError('resumeFromRunId must be a workflow runId in run_<uuid> format.');
  }
  return runId;
}

function normalizeAgentIsolation(value: unknown): AgentIsolation | undefined {
  if (value === undefined) return undefined;
  if (value === 'worktree') return 'worktree';
  throw workflowInputError('agent isolation must be "worktree" when provided.');
}

function normalizeAgentLogicalKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw workflowInputError('agent key must be a non-empty string when provided.');
  const key = value.trim();
  if (!key) throw workflowInputError('agent key must be a non-empty string when provided.');
  if (key.length > 160) throw workflowInputError('agent key must be at most 160 characters.');
  if (!/^[A-Za-z0-9_.:/@+-]+$/.test(key)) {
    throw workflowInputError('agent key may only contain letters, numbers, "_", "-", ".", ":", "/", "@", and "+".');
  }
  return key;
}

function normalizeAgentEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (!isReasoningEffort(value)) {
    throw workflowInputError('agent effort must be one of none, minimal, low, medium, high, xhigh, max.');
  }
  return value;
}

function normalizeAgentModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw workflowInputError('agent model must be a non-empty string.');
  }
  if (value === SUBAGENT_MODEL_PLACEHOLDER) {
    throw workflowInputError(`agent model must not be the reserved backend placeholder "${SUBAGENT_MODEL_PLACEHOLDER}".`);
  }
  return value;
}

function takeResumeCacheHit(
  cache: WorkflowResumeCache | undefined,
  agentCallKey: string,
): WorkflowResumeAgentCacheEntry | null {
  if (!cache) return null;
  if (cache.prefixOpen) {
    const entry = cache.entries[cache.nextIndex];
    if (entry?.agentCallKey === agentCallKey && !cache.usedCallKeys.has(agentCallKey)) {
      cache.usedCallKeys.add(agentCallKey);
      cache.nextIndex += 1;
      return entry;
    }
    cache.prefixOpen = false;
  }
  const keyed = cache.byCallKey.get(agentCallKey);
  if (!keyed || cache.usedCallKeys.has(agentCallKey)) return null;
  cache.usedCallKeys.add(agentCallKey);
  return keyed;
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitOutputRaw(cwd, args)).trim();
}

async function gitOutputRaw(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch (err) {
    const record = err as { readonly stderr?: unknown; readonly message?: unknown };
    const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
    const message = stderr || (typeof record.message === 'string' ? record.message : String(err));
    throw new Error(message);
  }
}

async function buildWorkspaceContext(cwd: string, options: WorkspaceContextOptions): Promise<string> {
  const root = await workspaceContextRoot(cwd);
  const runtimeStateExcludedPaths = workspaceRuntimeStateExcludedPaths(root);
  const statusUnavailableEvidence: string[] = [];
  let gitStatusRaw = '';
  try {
    gitStatusRaw = await gitOutputRaw(root, ['status', '--short', '--untracked-files=all', '--', '.']);
  } catch (err) {
    statusUnavailableEvidence.push(`unavailable:git-status:${gitFailureToken(err)}`);
  }
  const gitStatus = statusUnavailableEvidence.length
    ? `(unavailable: ${statusUnavailableEvidence[0]})`
    : formatGitStatusDisplay(gitStatusRaw, runtimeStateExcludedPaths);
  const gitStatusPaths = await gitOutputRaw(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']).catch((err) => {
    statusUnavailableEvidence.push(`unavailable:git-status-raw:${gitFailureToken(err)}`);
    return gitStatusRaw;
  });
  const gitStatusPathParse = parseGitStatusPaths(gitStatusPaths, runtimeStateExcludedPaths);
  const excludedWorkspacePaths = new Set(gitStatusPathParse.excludedPaths.map(workspacePathKey));
  const changeEvidence = options.includeDiff
    ? await buildChangeEvidenceContext(root, gitStatusPaths, options, statusUnavailableEvidence, runtimeStateExcludedPaths)
    : undefined;
  const explicitPaths = [
    ...options.files,
    ...extractMentionedWorkspacePaths(options.query ?? ''),
  ];
  const changedPaths = gitStatusPathParse.paths.filter((path) => shouldIncludeWorkspaceContextPath(path, runtimeStateExcludedPaths));
  const listedPaths = await listWorkspaceContextCandidates(root);
  const candidates = uniqueStrings([
    ...explicitPaths,
    ...changedPaths,
    ...WORKSPACE_CONTEXT_PRIORITY_FILES,
    ...listedPaths,
  ]).filter((path) => shouldIncludeWorkspaceContextPath(path, runtimeStateExcludedPaths) && !excludedWorkspacePaths.has(workspacePathKey(path)));
  const fileBlocks: string[] = [];
  let usedBytes = 0;
  for (const candidate of candidates) {
    if (fileBlocks.length >= options.maxFiles) break;
    const block = await workspaceContextFileBlock(root, candidate, options.maxFileBytes).catch(() => null);
    if (!block) continue;
    const blockBytes = Buffer.byteLength(block, 'utf8');
    if (usedBytes + blockBytes > options.maxBytes) {
      if (fileBlocks.length > 0) break;
      fileBlocks.push(block.slice(0, options.maxBytes));
      break;
    }
    fileBlocks.push(block);
    usedBytes += blockBytes;
  }
  return [
    '## Workspace Context',
    `Root: ${root}`,
    ...(changeEvidence ? [
      `Source Snapshot: ${changeEvidence.sourceSnapshotId}`,
      `Context Hash: ${changeEvidence.contextHash}`,
      '',
      '### Change Evidence',
      changeEvidence.text,
      '',
      '### Allowed Evidence Refs',
      changeEvidence.allowedEvidenceRefs.length ? changeEvidence.allowedEvidenceRefs.join('\n') : '(none)',
      '',
      '### Unavailable Evidence',
      changeEvidence.unavailableEvidence.length ? changeEvidence.unavailableEvidence.join('\n') : '(none)',
    ] : []),
    '',
    '### Git Status',
    gitStatus,
    '',
    '### Included Files',
    fileBlocks.length ? fileBlocks.join('\n\n') : '(no readable text files selected)',
  ].join('\n');
}

interface ChangeEvidenceContext {
  readonly sourceSnapshotId: string;
  readonly contextHash: string;
  readonly allowedEvidenceRefs: readonly string[];
  readonly unavailableEvidence: readonly string[];
  readonly text: string;
}

interface GitStatusPathParse {
  readonly paths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly unavailableEvidence: readonly string[];
}

interface BoundedGitText {
  readonly text: string;
  readonly truncated: boolean;
}

async function buildChangeEvidenceContext(
  root: string,
  gitStatus: string,
  options: WorkspaceContextOptions,
  initialUnavailableEvidence: readonly string[] = [],
  runtimeStateExcludedPaths: ReadonlySet<string> = EMPTY_WORKSPACE_PATH_EXCLUSIONS,
): Promise<ChangeEvidenceContext> {
  const unavailableEvidence: string[] = [...initialUnavailableEvidence];
  const gitStatusPaths = parseGitStatusPaths(gitStatus, runtimeStateExcludedPaths);
  const changedPaths = gitStatusPaths.paths.filter((path) => shouldIncludeWorkspaceContextPath(path, runtimeStateExcludedPaths));
  const excludedDiffPaths = new Set([
    ...gitStatusPaths.excludedPaths.map(workspacePathKey),
    ...runtimeStateExcludedPaths,
  ]);
  unavailableEvidence.push(...gitStatusPaths.unavailableEvidence);
  const head = await gitOutput(root, ['rev-parse', '--verify', 'HEAD']).catch((err) => {
    unavailableEvidence.push(unavailableGitEvidence('git-head', err));
    return 'unavailable';
  });
  const unstaged = filterWorkspaceContextDiff(await boundedGitOutput(root, [
    'diff',
    '--no-ext-diff',
    '--patch',
    '--find-renames',
    '--',
  ], options.maxDiffBytes).catch((err) => {
    unavailableEvidence.push(unavailableGitEvidence('diff-unstaged', err));
    return { text: '', truncated: false };
  }), excludedDiffPaths, runtimeStateExcludedPaths);
  const staged = filterWorkspaceContextDiff(await boundedGitOutput(root, [
    'diff',
    '--cached',
    '--no-ext-diff',
    '--patch',
    '--find-renames',
    '--',
  ], options.maxDiffBytes).catch((err) => {
    unavailableEvidence.push(unavailableGitEvidence('diff-staged', err));
    return { text: '', truncated: false };
  }), excludedDiffPaths, runtimeStateExcludedPaths);
  let committed: BoundedGitText = { text: '', truncated: false };
  let acceptedDiffBaseRef = '';
  if (options.diffBaseRef) {
    const baseCommit = await gitOutput(root, ['rev-parse', '--verify', `${options.diffBaseRef}^{commit}`]).catch((err) => {
      unavailableEvidence.push(unavailableGitEvidence('diff-base', err, options.diffBaseRef));
      return '';
    });
    if (baseCommit) {
      acceptedDiffBaseRef = options.diffBaseRef;
      committed = filterWorkspaceContextDiff(await boundedGitOutput(root, [
        'diff',
        '--no-ext-diff',
        '--patch',
        '--find-renames',
        `${baseCommit}..HEAD`,
        '--',
      ], options.maxDiffBytes).catch((err) => {
        unavailableEvidence.push(unavailableGitEvidence('diff-committed', err, options.diffBaseRef));
        return { text: '', truncated: false };
      }), excludedDiffPaths, runtimeStateExcludedPaths);
    }
  }
  const diffEvidence = [
    { kind: 'unstaged', value: unstaged },
    { kind: 'staged', value: staged },
    { kind: 'committed', value: committed },
  ] as const;
  const allowedEvidenceRefs = uniqueStrings([
    ...changedPaths.map((path) => `file:${path}`),
    ...diffEvidence.flatMap((entry) => diffEvidenceRefs(entry.kind, entry.value.text, runtimeStateExcludedPaths)),
  ]);
  const allowedEvidenceIndexDigest = fullHash(allowedEvidenceRefs.join('\n'));
  const sourceSnapshotId = `git:${head}:${fullHash([
    gitStatus,
    unstaged.text,
    staged.text,
    committed.text,
  ].join('\n\0\n'))}`;
  const truncation = {
    unstaged: unstaged.truncated,
    staged: staged.truncated,
    committed: committed.truncated,
  };
  const contextHash = fullHash(JSON.stringify({
    root,
    sourceSnapshotId,
    gitStatus,
    acceptedDiffBaseRef,
    truncation,
    allowedEvidenceRefs,
    unavailableEvidence,
  }));
  const sections = [
    `sourceSnapshotId: ${sourceSnapshotId}`,
    `contextHash: ${contextHash}`,
    `allowedEvidenceIndexDigest: ${allowedEvidenceIndexDigest}`,
    `diffBaseRef: ${acceptedDiffBaseRef || '(none)'}`,
    `truncation: ${JSON.stringify(truncation)}`,
    '',
    '#### Changed Files',
    changedPaths.length ? changedPaths.join('\n') : '(none)',
    '',
    '#### Unstaged Diff',
    unstaged.text || '(none)',
    '',
    '#### Staged Diff',
    staged.text || '(none)',
    '',
    '#### Committed Diff',
    committed.text || (options.diffBaseRef ? '(none)' : '(not requested)'),
  ];
  return {
    sourceSnapshotId,
    contextHash,
    allowedEvidenceRefs,
    unavailableEvidence,
    text: sections.join('\n'),
  };
}

async function boundedGitOutput(root: string, args: readonly string[], maxBytes: number): Promise<BoundedGitText> {
  const text = await gitOutput(root, args);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  return {
    text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

function filterWorkspaceContextDiff(
  value: BoundedGitText,
  excludedPaths: ReadonlySet<string>,
  runtimeStateExcludedPaths: ReadonlySet<string>,
): BoundedGitText {
  if (!value.text) return value;
  return {
    ...value,
    text: filterWorkspaceContextDiffText(value.text, excludedPaths, runtimeStateExcludedPaths),
  };
}

function filterWorkspaceContextDiffText(
  text: string,
  excludedPaths: ReadonlySet<string>,
  runtimeStateExcludedPaths: ReadonlySet<string>,
): string {
  const kept: string[] = [];
  let block: string[] = [];
  let includeBlock = true;
  const flush = (): void => {
    if (includeBlock && block.length > 0) kept.push(block.join('\n'));
    block = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      const header = parseGitDiffHeader(line);
      includeBlock = header
        ? workspaceContextDiffPathAllowed(header.oldPath, excludedPaths, runtimeStateExcludedPaths)
          && workspaceContextDiffPathAllowed(header.newPath, excludedPaths, runtimeStateExcludedPaths)
        : false;
    }
    block.push(line);
  }
  flush();
  return kept.join('\n');
}

function workspaceContextDiffPathAllowed(
  path: string,
  excludedPaths: ReadonlySet<string>,
  runtimeStateExcludedPaths: ReadonlySet<string>,
): boolean {
  if (!path || path === '/dev/null') return true;
  const key = workspacePathKey(path);
  return shouldIncludeWorkspaceContextPath(key, runtimeStateExcludedPaths) && !workspacePathExcludedBySet(key, excludedPaths);
}

function diffEvidenceRefs(
  kind: string,
  diff: string,
  runtimeStateExcludedPaths: ReadonlySet<string>,
): readonly string[] {
  const refs: string[] = [];
  let currentPath = '';
  let hunkIndex = 0;
  for (const line of diff.split(/\r?\n/)) {
    const header = parseGitDiffHeader(line);
    if (header) {
      currentPath = header.newPath || header.oldPath;
      hunkIndex = 0;
      if (currentPath && currentPath !== '/dev/null' && shouldIncludeWorkspaceContextPath(currentPath, runtimeStateExcludedPaths)) refs.push(`diff:${kind}:${currentPath}`);
      continue;
    }
    if (currentPath && shouldIncludeWorkspaceContextPath(currentPath, runtimeStateExcludedPaths) && line.startsWith('@@')) {
      hunkIndex += 1;
      refs.push(`hunk:${kind}:${currentPath}:${hunkIndex}`);
    }
  }
  return refs;
}

interface GitDiffHeader {
  readonly oldPath: string;
  readonly newPath: string;
}

function parseGitDiffHeader(line: string): GitDiffHeader | undefined {
  if (!line.startsWith('diff --git ')) return undefined;
  const first = readGitDiffHeaderToken(line.slice('diff --git '.length));
  if (!first) return undefined;
  const second = readGitDiffHeaderToken(first.rest.trimStart());
  if (!second || second.rest.trim()) return undefined;
  const oldPath = gitDiffHeaderTokenPath(first.token, 'a/');
  const newPath = gitDiffHeaderTokenPath(second.token, 'b/');
  if (oldPath === undefined || newPath === undefined) return undefined;
  return { oldPath, newPath };
}

function readGitDiffHeaderToken(value: string): { readonly token: string; readonly rest: string } | undefined {
  if (!value) return undefined;
  if (value.startsWith('"')) {
    const end = gitQuotedPathEnd(value);
    if (end === -1) return undefined;
    return { token: value.slice(0, end), rest: value.slice(end) };
  }
  const separator = value.indexOf(' ');
  if (separator === -1) return { token: value, rest: '' };
  return { token: value.slice(0, separator), rest: value.slice(separator + 1) };
}

function gitDiffHeaderTokenPath(token: string, prefix: 'a/' | 'b/'): string | undefined {
  const path = normalizeGitStatusPath(token);
  if (!path.startsWith(prefix)) return undefined;
  return path.slice(prefix.length);
}

function normalizeWorkspaceContextOptions(value: unknown): WorkspaceContextOptions {
  const options = asRecord(value) ?? {};
  const query = typeof options.query === 'string' ? options.query : undefined;
  const files = Array.isArray(options.files)
    ? options.files.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  const diffBaseRef = typeof options.diffBaseRef === 'string' && options.diffBaseRef.trim()
    ? options.diffBaseRef.trim()
    : undefined;
  return {
    ...(query ? { query } : {}),
    files,
    includeDiff: options.includeDiff === true,
    ...(diffBaseRef ? { diffBaseRef } : {}),
    maxFiles: boundedPositiveInteger(options.maxFiles, DEFAULT_WORKSPACE_CONTEXT_MAX_FILES, 1, 100),
    maxFileBytes: boundedPositiveInteger(options.maxFileBytes, DEFAULT_WORKSPACE_CONTEXT_MAX_FILE_BYTES, 1_000, 50_000),
    maxBytes: boundedPositiveInteger(options.maxBytes, DEFAULT_WORKSPACE_CONTEXT_MAX_BYTES, 10_000, 200_000),
    maxDiffBytes: boundedPositiveInteger(options.maxDiffBytes, DEFAULT_WORKSPACE_CONTEXT_MAX_DIFF_BYTES, 1_000, 200_000),
  };
}

function boundedPositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

async function workspaceContextRoot(cwd: string): Promise<string> {
  try {
    return await gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return await realpath(cwd).catch(() => resolve(cwd));
  }
}

function workspaceRuntimeStateExcludedPaths(root: string): ReadonlySet<string> {
  const stateRoot = resolve(defaultUltracodeStateRoot());
  const workspaceRoot = resolve(root);
  if (!pathInsideOrEqual(workspaceRoot, stateRoot)) return EMPTY_WORKSPACE_PATH_EXCLUSIONS;
  const relativeStateRoot = workspacePathKey(relative(workspaceRoot, stateRoot));
  return new Set([relativeStateRoot || '.']);
}

async function listWorkspaceContextCandidates(root: string): Promise<readonly string[]> {
  try {
    return splitLines(await gitOutput(root, ['ls-files', '--cached', '--others', '--exclude-standard']));
  } catch {
    return await walkWorkspaceContextFiles(root);
  }
}

async function walkWorkspaceContextFiles(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (found.length >= 500) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (found.length >= 500) return;
      if (WORKSPACE_CONTEXT_EXCLUDED_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile()) found.push(relative(root, fullPath));
    }
  }
  await walk(root);
  return found;
}

function extractMentionedWorkspacePaths(query: string): readonly string[] {
  const out = new Set<string>();
  for (const file of WORKSPACE_CONTEXT_PRIORITY_FILES) {
    if (query.includes(file)) out.add(file);
  }
  const matches = query.match(/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+(?:\.[A-Za-z0-9]+)?(?::\d+)?/g) ?? [];
  for (const match of matches) {
    if (match.includes('://')) continue;
    out.add(match.replace(/:\d+$/, ''));
  }
  return [...out];
}

function pathsFromGitStatus(status: string): readonly string[] {
  return parseGitStatusPaths(status).paths;
}

function parseGitStatusPaths(
  status: string,
  runtimeStateExcludedPaths: ReadonlySet<string> = EMPTY_WORKSPACE_PATH_EXCLUSIONS,
): GitStatusPathParse {
  if (status.includes('\0')) return parseGitStatusPathsZ(status, runtimeStateExcludedPaths);
  const paths: string[] = [];
  const excludedPaths: string[] = [];
  const unavailableEvidence: string[] = [];
  let entryIndex = 0;
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    entryIndex += 1;
    const match = /^([ MADRCUT?!]{2}) ([\s\S]+)$/.exec(line);
    if (!match) {
      unavailableEvidence.push(`unavailable:git-status-path:${entryIndex}:unparseable`);
      continue;
    }
    const statusCode = match[1];
    const rawPath = match[2];
    if (!rawPath) continue;
    const renameOrCopy = /[RC]/.test(statusCode);
    const renameParts = renameOrCopy ? splitGitStatusRename(rawPath) : undefined;
    if (renameOrCopy && !renameParts) {
      unavailableEvidence.push(`unavailable:git-status-path:${entryIndex}:unsafe-path`);
      continue;
    }
    if (renameParts) {
      const sourcePath = normalizeGitStatusPath(renameParts.source);
      if (!isWorkspaceEvidencePathSafe(sourcePath)) {
        const targetPath = normalizeGitStatusPath(renameParts.target);
        if (targetPath) excludedPaths.push(targetPath);
        unavailableEvidence.push(`unavailable:git-status-path:${entryIndex}:unsafe-source`);
        continue;
      } else if (!shouldExposeWorkspaceStatusPath(sourcePath, runtimeStateExcludedPaths)) {
        const targetPath = normalizeGitStatusPath(renameParts.target);
        if (targetPath) excludedPaths.push(targetPath);
        unavailableEvidence.push(`unavailable:git-status-path:${entryIndex}:excluded-source`);
        continue;
      }
    }
    const selectedPath = renameParts ? renameParts.target : rawPath;
    const path = normalizeGitStatusPath(selectedPath);
    if (isWorkspaceEvidencePathSafe(path) && shouldExposeWorkspaceStatusPath(path, runtimeStateExcludedPaths)) paths.push(path);
    else if (isWorkspaceEvidencePathSafe(path)) excludedPaths.push(path);
    else unavailableEvidence.push(`unavailable:git-status-path:${entryIndex}:${renameParts ? 'unsafe-target' : 'unsafe-path'}`);
  }
  return { paths, excludedPaths, unavailableEvidence };
}

function parseGitStatusPathsZ(
  status: string,
  runtimeStateExcludedPaths: ReadonlySet<string> = EMPTY_WORKSPACE_PATH_EXCLUSIONS,
): GitStatusPathParse {
  const paths: string[] = [];
  const excludedPaths: string[] = [];
  const unavailableEvidence: string[] = [];
  const entries = status.split('\0').filter((entry) => entry !== '');
  let entryIndex = 0;
  for (let index = 0; index < entries.length; index += 1) {
    entryIndex += 1;
    const entry = entries[index] ?? '';
    const match = /^([ MADRCUT?!]{2}) ([\s\S]+)$/.exec(entry);
    const statusCode = match?.[1] ?? '';
    const path = match?.[2] ?? '';
    const renameOrCopy = /[RC]/.test(statusCode);
    let excludedBySource = false;
    if (renameOrCopy) {
      const sourcePath = entries[index + 1];
      if (sourcePath === undefined) unavailableEvidence.push(`unavailable:git-status-path:${entryIndex}:missing-source`);
      else if (!isWorkspaceEvidencePathSafe(sourcePath)) {
        unavailableEvidence.push(`unavailable:git-status-path:${entryIndex}:unsafe-source`);
        excludedBySource = true;
      }
      else if (!shouldExposeWorkspaceStatusPath(sourcePath, runtimeStateExcludedPaths)) {
        unavailableEvidence.push(`unavailable:git-status-path:${entryIndex}:excluded-source`);
        excludedBySource = true;
      }
    }
    if (isWorkspaceEvidencePathSafe(path) && shouldExposeWorkspaceStatusPath(path, runtimeStateExcludedPaths) && !excludedBySource) paths.push(path);
    else if (isWorkspaceEvidencePathSafe(path)) excludedPaths.push(path);
    else unavailableEvidence.push(`unavailable:git-status-path:${entryIndex}:${renameOrCopy ? 'unsafe-target' : 'unsafe-path'}`);
    if (renameOrCopy) {
      index += 1;
    }
  }
  return { paths, excludedPaths, unavailableEvidence };
}

function formatGitStatusDisplay(
  status: string,
  runtimeStateExcludedPaths: ReadonlySet<string> = EMPTY_WORKSPACE_PATH_EXCLUSIONS,
): string {
  if (!status.trim()) return '(clean or unavailable)';
  if (status.includes('\0')) return formatGitStatusZDisplay(status, runtimeStateExcludedPaths);
  const lines: string[] = [];
  let entryIndex = 0;
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    entryIndex += 1;
    const match = /^([ MADRCUT?!]{2}) ([\s\S]+)$/.exec(line);
    if (!match) {
      lines.push(`${entryIndex}: <unparseable status omitted>`);
      continue;
    }
    const statusCode = match[1];
    const rawPath = match[2];
    const renameOrCopy = /[RC]/.test(statusCode);
    if (renameOrCopy) {
      const renameParts = splitGitStatusRename(rawPath);
      if (!renameParts) {
        lines.push(`${statusCode} <unsafe rename omitted>`);
        continue;
      }
      const sourcePath = normalizeGitStatusPath(renameParts.source);
      const targetPath = normalizeGitStatusPath(renameParts.target);
      if (
        (isWorkspaceEvidencePathSafe(sourcePath) && !shouldExposeWorkspaceStatusPath(sourcePath, runtimeStateExcludedPaths))
        || (isWorkspaceEvidencePathSafe(targetPath) && !shouldExposeWorkspaceStatusPath(targetPath, runtimeStateExcludedPaths))
      ) {
        lines.push(`${statusCode} <excluded rename omitted>`);
        continue;
      }
      lines.push(`${statusCode} ${formatGitStatusPathForDisplay(sourcePath, 'source', runtimeStateExcludedPaths)} -> ${formatGitStatusPathForDisplay(targetPath, 'target', runtimeStateExcludedPaths)}`);
      continue;
    }
    const path = normalizeGitStatusPath(rawPath);
    lines.push(`${statusCode} ${formatGitStatusPathForDisplay(path, 'path', runtimeStateExcludedPaths)}`);
  }
  return lines.length ? lines.join('\n') : '(clean or unavailable)';
}

function formatGitStatusZDisplay(
  status: string,
  runtimeStateExcludedPaths: ReadonlySet<string> = EMPTY_WORKSPACE_PATH_EXCLUSIONS,
): string {
  const lines: string[] = [];
  const entries = status.split('\0').filter((entry) => entry !== '');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? '';
    const match = /^([ MADRCUT?!]{2}) ([\s\S]+)$/.exec(entry);
    if (!match) {
      lines.push(`${index + 1}: <unparseable status omitted>`);
      continue;
    }
    const statusCode = match[1];
    const path = match[2];
    const renameOrCopy = /[RC]/.test(statusCode);
    if (renameOrCopy) {
      const sourcePath = entries[index + 1] ?? '';
      if (
        (isWorkspaceEvidencePathSafe(sourcePath) && !shouldExposeWorkspaceStatusPath(sourcePath, runtimeStateExcludedPaths))
        || (isWorkspaceEvidencePathSafe(path) && !shouldExposeWorkspaceStatusPath(path, runtimeStateExcludedPaths))
      ) {
        lines.push(`${statusCode} <excluded rename omitted>`);
        index += 1;
        continue;
      }
      lines.push(`${statusCode} ${formatGitStatusPathForDisplay(sourcePath, 'source', runtimeStateExcludedPaths)} -> ${formatGitStatusPathForDisplay(path, 'target', runtimeStateExcludedPaths)}`);
      index += 1;
      continue;
    }
    lines.push(`${statusCode} ${formatGitStatusPathForDisplay(path, 'path', runtimeStateExcludedPaths)}`);
  }
  return lines.length ? lines.join('\n') : '(clean or unavailable)';
}

function formatGitStatusPathForDisplay(
  path: string,
  label: 'path' | 'source' | 'target',
  runtimeStateExcludedPaths: ReadonlySet<string> = EMPTY_WORKSPACE_PATH_EXCLUSIONS,
): string {
  if (!isWorkspaceEvidencePathSafe(path)) return `<unsafe ${label} omitted>`;
  if (!shouldExposeWorkspaceStatusPath(path, runtimeStateExcludedPaths)) return `<excluded ${label} omitted>`;
  if (/^\s|\s$| -> /.test(path)) return JSON.stringify(path);
  return path;
}

function isWorkspaceEvidencePathSafe(path: string): boolean {
  return path !== '' && !/[\uFFFD\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path);
}

interface GitStatusRenameParts {
  readonly source: string;
  readonly target: string;
}

function splitGitStatusRename(rawPath: string): GitStatusRenameParts | undefined {
  const separator = gitStatusRenameSeparator(rawPath);
  if (separator === -1) return undefined;
  return {
    source: rawPath.slice(0, separator),
    target: rawPath.slice(separator + 4),
  };
}

function gitStatusRenameSeparator(value: string): number {
  let separator = -1;
  let inQuote = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inQuote = false;
      continue;
    }
    if (char === '"') {
      inQuote = true;
      continue;
    }
    if (value.startsWith(' -> ', index)) {
      if (separator !== -1) return -1;
      separator = index;
      index += 3;
    }
  }
  return inQuote ? -1 : separator;
}

function gitFailureToken(err: unknown): string {
  const record = err as { readonly code?: unknown; readonly signal?: unknown };
  if (typeof record.signal === 'string' && record.signal) return 'signal';
  if (typeof record.code === 'number') return `exit-${record.code}`;
  return 'failed';
}

function unavailableGitEvidence(kind: string, err: unknown, detail?: string): string {
  const safeDetail = detail && /^[A-Za-z0-9._/@+-]{1,160}$/.test(detail) ? `:${detail}` : '';
  return `unavailable:${kind}${safeDetail}:${gitFailureToken(err)}`;
}

function gitQuotedPathEnd(value: string): number {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') return index + 1;
  }
  return -1;
}

function normalizeGitStatusPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
  } catch {
    return decodeGitQuotedPath(trimmed);
  }
  return decodeGitQuotedPath(trimmed);
}

function decodeGitQuotedPath(value: string): string {
  const body = value.slice(1, -1);
  let out = '';
  let bytes: number[] = [];
  const flushBytes = (): void => {
    if (bytes.length === 0) return;
    out += Buffer.from(bytes).toString('utf8');
    bytes = [];
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? '';
    if (char !== '\\') {
      flushBytes();
      out += char;
      continue;
    }
    const next = body[index + 1] ?? '';
    if (/[0-7]/.test(next)) {
      let octal = next;
      index += 1;
      for (let count = 0; count < 2 && /[0-7]/.test(body[index + 1] ?? ''); count += 1) {
        index += 1;
        octal += body[index] ?? '';
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    flushBytes();
    index += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === 'v') out += '\v';
    else if (next === 'a') out += '\x07';
    else out += next;
  }
  flushBytes();
  return out;
}

async function workspaceContextFileBlock(root: string, requestedPath: string, maxFileBytes: number): Promise<string | null> {
  const resolved = await resolveWorkspaceContextPath(root, requestedPath);
  if (!resolved) return null;
  const fileStat = await stat(resolved.path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size > maxFileBytes) return null;
  const text = await readFile(resolved.path, 'utf8').catch(() => null);
  if (text === null || text.includes('\0')) return null;
  return [
    `--- ${resolved.relativePath} (${fileStat.size} bytes) ---`,
    numberWorkspaceContextLines(text),
  ].join('\n');
}

async function resolveWorkspaceContextPath(
  root: string,
  requestedPath: string,
): Promise<{ readonly path: string; readonly relativePath: string } | null> {
  const requested = requestedPath.trim();
  if (!requested) return null;
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!pathInsideOrEqual(root, candidate)) return null;
  const canonical = await realpath(candidate).catch(() => null);
  if (!canonical || !pathInsideOrEqual(root, canonical)) return null;
  return {
    path: canonical,
    relativePath: relative(root, canonical) || '.',
  };
}

function shouldIncludeWorkspaceContextPath(
  path: string,
  runtimeStateExcludedPaths: ReadonlySet<string> = EMPTY_WORKSPACE_PATH_EXCLUSIONS,
): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return false;
  if (workspacePathExcludedBySet(normalized, runtimeStateExcludedPaths)) return false;
  const parts = normalized.split('/');
  if (parts.some((part) => WORKSPACE_CONTEXT_EXCLUDED_DIRS.has(part))) return false;
  const name = parts.at(-1) ?? '';
  if (WORKSPACE_CONTEXT_PRIORITY_FILES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return WORKSPACE_CONTEXT_ALLOWED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function shouldExposeWorkspaceStatusPath(
  path: string,
  runtimeStateExcludedPaths: ReadonlySet<string> = EMPTY_WORKSPACE_PATH_EXCLUSIONS,
): boolean {
  const normalized = workspacePathKey(path);
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return false;
  if (workspacePathExcludedBySet(normalized, runtimeStateExcludedPaths)) return false;
  return !normalized.split('/').some((part) => WORKSPACE_CONTEXT_EXCLUDED_DIRS.has(part));
}

function workspacePathKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function workspacePathExcludedBySet(path: string, excludedPaths: ReadonlySet<string>): boolean {
  const key = workspacePathKey(path);
  if (excludedPaths.has('.')) return true;
  for (const excludedPath of excludedPaths) {
    if (!excludedPath || excludedPath === '.') continue;
    if (key === excludedPath || key.startsWith(`${excludedPath}/`)) return true;
  }
  return false;
}

function numberWorkspaceContextLines(text: string): string {
  return text.split(/\r?\n/).map((line, index) => {
    return `${String(index + 1).padStart(4, ' ')} | ${line}`;
  }).join('\n');
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function preservedWorktree(
  worktree: WorkflowAgentWorktree,
  reason: WorkflowAgentPreservedWorktree['reason'],
): WorkflowAgentPreservedWorktree {
  return {
    path: worktree.path,
    attemptIndex: worktree.attemptIndex,
    reason,
  };
}

function preservedWorktreeEventProjection(
  preservedWorktrees: readonly WorkflowAgentPreservedWorktree[],
): {
  readonly worktreePath?: string;
  readonly worktreePreserved?: true;
  readonly preservedWorktrees?: readonly WorkflowAgentPreservedWorktree[];
} {
  if (preservedWorktrees.length === 0) return {};
  const primary = preservedWorktrees.find((item) => item.reason === 'changed')
    ?? preservedWorktrees.find((item) => item.reason === 'status_unavailable')
    ?? preservedWorktrees[0];
  return {
    worktreePath: primary?.path,
    worktreePreserved: true,
    preservedWorktrees: [...preservedWorktrees],
  };
}

function workflowPlannedPhase(
  plan: WorkflowExecutionPlan | undefined,
  phaseIndex: number,
  title: string,
): WorkflowPlanPhase | undefined {
  const indexed = plan?.phases[phaseIndex];
  if (indexed?.title === title) return indexed;
  return plan?.phases.find((phase) => phase.title === title);
}

function agentCompletionProgress(
  ctx: WorkflowRunContext,
  phase: string | undefined,
): {
  readonly elapsedMs: number;
  readonly completedAgentCount: number;
  readonly knownAgentCount: number;
  readonly phaseCompletedAgentCount?: number;
  readonly phaseKnownAgentCount?: number;
} {
  const completedAgentCount = ctx.task.events
    .filter((event) => event.type === 'workflow.agent.completed')
    .length + 1;
  const base = {
    elapsedMs: Date.now() - ctx.startedAt,
    completedAgentCount,
    knownAgentCount: ctx.agentCount,
  };
  if (!phase) return base;
  const phaseCompletedAgentCount = ctx.task.events
    .filter((event) => event.type === 'workflow.agent.completed' && event.phase === phase)
    .length + 1;
  const phaseKnownAgentCount = Math.max(
    phaseCompletedAgentCount,
    ctx.task.events.filter((event) => event.type === 'workflow.agent.started' && event.phase === phase).length,
  );
  return {
    ...base,
    phaseCompletedAgentCount,
    phaseKnownAgentCount,
  };
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function fullHash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function workflowValueHash(value: unknown): string {
  try {
    return fullHash(stableJson(value));
  } catch (err) {
    throw workflowInputError(workflowErrorMessage(err, 'workflow hash value must be JSON-serializable.'));
  }
}

function workflowScriptHash(script: string): string {
  return `sha256:${createHash('sha256').update(script).digest('hex')}`;
}

function workflowPermissionKey(
  workflowSource: WorkflowSource,
  workflowSourcePath: string | undefined,
  workflowName: string,
  scriptHash: string,
): string {
  const sourceRef = workflowSourcePath ?? workflowName;
  return `${workflowSource}\0${sourceRef}\0${workflowName}\0${scriptHash}`;
}

function workflowPermissionRequestId(permissionKey: string): string {
  const permissionKeyHash = createHash('sha256').update(permissionKey).digest('hex').slice(0, 12);
  return `perm_${permissionKeyHash}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

interface WorkflowIsolationReview {
  readonly modes: readonly string[];
  readonly dynamic: boolean;
}

function workflowIsolationReviewRecordFields(
  isolationReview: WorkflowIsolationReview,
): Pick<WorkflowPermissionRecord, 'reviewVersion' | 'requestedIsolationModes' | 'dynamicIsolation' | 'isolationReviewFingerprint'> {
  return {
    reviewVersion: WORKFLOW_PERMISSION_REVIEW_VERSION,
    requestedIsolationModes: [...isolationReview.modes].sort((left, right) => left.localeCompare(right)),
    dynamicIsolation: isolationReview.dynamic,
    isolationReviewFingerprint: workflowIsolationReviewFingerprint(isolationReview),
  };
}

function workflowPermissionReviewRecordFields(
  review: WorkflowPermissionReview,
): Pick<WorkflowPermissionRecord, 'reviewVersion' | 'requestedIsolationModes' | 'dynamicIsolation' | 'isolationReviewFingerprint'> {
  return workflowIsolationReviewRecordFields({
    modes: review.requestedIsolationModes,
    dynamic: review.dynamicIsolation,
  });
}

function workflowIsolationReviewFingerprint(isolationReview: WorkflowIsolationReview): string {
  const canonical = JSON.stringify({
    dynamic: isolationReview.dynamic,
    modes: [...isolationReview.modes].sort((left, right) => left.localeCompare(right)),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function workflowPermissionRecordMatchesCurrentReview(
  record: WorkflowPermissionRecord,
  isolationReview: WorkflowIsolationReview,
): boolean {
  const expected = workflowIsolationReviewRecordFields(isolationReview);
  return record.reviewVersion === expected.reviewVersion
    && record.dynamicIsolation === expected.dynamicIsolation
    && record.isolationReviewFingerprint === expected.isolationReviewFingerprint
    && arraysEqual(record.requestedIsolationModes ?? [], expected.requestedIsolationModes ?? []);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workflowIsolationReviewAllowsMode(isolationReview: WorkflowIsolationReview, mode: AgentIsolation): boolean {
  return isolationReview.dynamic || isolationReview.modes.includes(mode);
}

function workflowPermissionRiskSummary(
  workflowSource: WorkflowSource,
  requestedIsolation: WorkflowIsolationReview,
): string {
  const sourceSummary = (() => {
    if (workflowSource === 'project') return 'Project workflow source requires approval before execution.';
    if (workflowSource === 'user') return 'User workflow source requires approval before execution.';
    if (workflowSource === 'plugin') return 'Plugin workflow source requires approval before execution.';
    if (workflowSource === 'script_path') return 'Edited runtime workflow scriptPath requires approval before execution.';
    return 'Workflow source is trusted by default.';
  })();
  const isolationSummaries: string[] = [];
  if (requestedIsolation.modes.includes('worktree')) {
    isolationSummaries.push('Requests worktree isolation, allowing subagents to write inside isolated git worktrees that may be preserved for review.');
  }
  if (requestedIsolation.dynamic) {
    isolationSummaries.push('Contains dynamic agent isolation options; review as a possible worktree write request.');
  }
  const unknownModes = requestedIsolation.modes.filter((mode) => mode !== 'worktree');
  if (unknownModes.length > 0) {
    isolationSummaries.push(`Requests unsupported agent isolation mode(s): ${unknownModes.join(', ')}.`);
  }
  return [sourceSummary, ...isolationSummaries].join(' ');
}

function workflowRequestedIsolationModes(script: string): WorkflowIsolationReview {
  const modes = new Set<string>();
  let dynamic = workflowAgentCallsHaveDynamicOptions(script);
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? '';
    const next = script[index + 1] ?? '';
    if (char === '/' && next === '/') {
      index = skipLineComment(script, index + 2);
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(script, index + 2);
      continue;
    }
    if (char === '.' && next === '.' && script[index + 2] === '.') {
      dynamic = true;
      index += 2;
      continue;
    }
    if (char === '`') {
      const template = readTemplateLiteralReview(script, index);
      if (template) {
        dynamic = template.dynamic || dynamic;
        for (const mode of template.modes) modes.add(mode);
        index = template.end;
      } else {
        dynamic = true;
      }
      continue;
    }
    if (char === '[') {
      const computed = readComputedPropertyKey(script, index);
      if (computed) {
        if (computed.key === 'isolation') {
          dynamic = readIsolationModeValue(script, computed.afterColon + 1, modes) || dynamic;
        } else if (computed.hasColon) {
          dynamic = true;
        }
        index = computed.end;
      } else {
        dynamic = true;
      }
      continue;
    }
    if (
      char === '.'
      && script.startsWith('isolation', index + 1)
      && !isIdentifierChar(script[index + 1 + 'isolation'.length] ?? '')
    ) {
      dynamic = true;
      index += 'isolation'.length;
      continue;
    }
    if (char === '"' || char === "'") {
      const key = readStringLiteral(script, index, char);
      if (!key) continue;
      const colon = firstNonCodeWhitespace(script, key.end + 1);
      if (key.value === 'isolation' && script[colon] === ':') {
        dynamic = readIsolationModeValue(script, colon + 1, modes) || dynamic;
      }
      index = key.end;
      continue;
    }
    if (
      script.startsWith('isolation', index)
      && !isIdentifierChar(script[index - 1] ?? '')
      && !isIdentifierChar(script[index + 'isolation'.length] ?? '')
    ) {
      const colon = firstNonCodeWhitespace(script, index + 'isolation'.length);
      if (script[colon] === ':') {
        dynamic = readIsolationModeValue(script, colon + 1, modes) || dynamic;
      } else {
        dynamic = true;
      }
      index += 'isolation'.length - 1;
    }
  }
  return {
    modes: [...modes].sort((left, right) => left.localeCompare(right)),
    dynamic,
  };
}

function workflowAgentCallsHaveDynamicOptions(script: string): boolean {
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? '';
    const next = script[index + 1] ?? '';
    if (char === '/' && next === '/') {
      index = skipLineComment(script, index + 2);
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(script, index + 2);
      continue;
    }
    if (char === '"' || char === "'") {
      const literal = readStringLiteral(script, index, char);
      if (!literal) continue;
      index = literal.end;
      continue;
    }
    if (char === '`') {
      const template = readTemplateLiteralReview(script, index);
      if (!template) return true;
      if (template.dynamic) return true;
      index = template.end;
      continue;
    }
    if (!script.startsWith('agent', index) || isIdentifierChar(script[index - 1] ?? '') || isIdentifierChar(script[index + 5] ?? '')) {
      continue;
    }
    const openParen = firstNonWhitespace(script, index + 5);
    if (script[openParen] !== '(') continue;
    const args = splitTopLevelCallArguments(script, openParen);
    if (!args) return true;
    if (args.args.length < 2) {
      index = args.end;
      continue;
    }
    const optionsArg = args.args[1]?.trim() ?? '';
    if (!optionsArg.startsWith('{') || !optionsArg.endsWith('}')) return true;
    if (optionsArg.includes('...')) return true;
    index = args.end;
  }
  return false;
}

function readIsolationModeValue(script: string, start: number, modes: Set<string>): boolean {
  const valueStart = firstNonCodeWhitespace(script, start);
  const quote = script[valueStart];
  if (quote === '"' || quote === "'") {
    const value = readStringLiteral(script, valueStart, quote);
    if (value?.value) modes.add(value.value);
    return false;
  }
  if (quote === '`') {
    const value = readSimpleTemplateLiteral(script, valueStart);
    if (value?.value) {
      modes.add(value.value);
      return false;
    }
  }
  return true;
}

function readComputedPropertyKey(
  script: string,
  start: number,
): { readonly key?: string; readonly end: number; readonly hasColon: boolean; readonly afterColon: number } | null {
  const closeBracket = findMatchingBracket(script, start);
  if (closeBracket === -1) return null;
  const keyStart = firstNonCodeWhitespace(script, start + 1);
  const quote = script[keyStart];
  let key: string | undefined;
  if (quote === '"' || quote === "'") {
    const literal = readStringLiteral(script, keyStart, quote);
    if (!literal) return null;
    if (firstNonCodeWhitespace(script, literal.end + 1) === closeBracket) key = literal.value;
  }
  const afterBracket = firstNonCodeWhitespace(script, closeBracket + 1);
  const hasColon = script[afterBracket] === ':';
  return {
    ...(key !== undefined ? { key } : {}),
    end: closeBracket,
    hasColon,
    afterColon: afterBracket,
  };
}

function findMatchingBracket(script: string, start: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < script.length; index += 1) {
    const char = script[index] ?? '';
    const next = script[index + 1] ?? '';
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '`') {
      index = skipTemplateLiteral(script, index + 1);
      continue;
    }
    if (char === '[') {
      depth += 1;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readSimpleTemplateLiteral(
  script: string,
  start: number,
): { readonly value: string; readonly end: number } | null {
  let value = '';
  let escaped = false;
  for (let index = start + 1; index < script.length; index += 1) {
    const char = script[index] ?? '';
    const next = script[index + 1] ?? '';
    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '$' && next === '{') {
      return null;
    } else if (char === '`') {
      return { value, end: index };
    } else {
      value += char;
    }
  }
  return null;
}

function readTemplateLiteralReview(
  script: string,
  start: number,
): { readonly end: number; readonly dynamic: boolean; readonly modes: readonly string[] } | null {
  const modes = new Set<string>();
  let dynamic = false;
  let escaped = false;
  for (let index = start + 1; index < script.length; index += 1) {
    const char = script[index] ?? '';
    const next = script[index + 1] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '`') {
      return {
        end: index,
        dynamic,
        modes: [...modes].sort((left, right) => left.localeCompare(right)),
      };
    }
    if (char === '$' && next === '{') {
      const expressionStart = index + 2;
      const expressionEnd = findMatchingExpressionBrace(script, expressionStart);
      if (expressionEnd === -1) return null;
      const nested = workflowRequestedIsolationModes(script.slice(expressionStart, expressionEnd));
      dynamic = dynamic || nested.dynamic;
      for (const mode of nested.modes) modes.add(mode);
      index = expressionEnd;
    }
  }
  return null;
}

function findMatchingExpressionBrace(script: string, start: number): number {
  let depth = 1;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < script.length; index += 1) {
    const char = script[index] ?? '';
    const next = script[index + 1] ?? '';
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelCallArguments(
  script: string,
  openParen: number,
): { readonly args: readonly string[]; readonly end: number } | null {
  let depth = 1;
  let nestedParen = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let argStart = openParen + 1;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const args: string[] = [];
  for (let index = openParen + 1; index < script.length; index += 1) {
    const char = script[index] ?? '';
    const next = script[index + 1] ?? '';
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      nestedParen += 1;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === ')' && nestedParen === 0 && bracketDepth === 0 && braceDepth === 0) {
      depth -= 1;
      if (depth === 0) {
        const lastArg = script.slice(argStart, index).trim();
        if (lastArg) args.push(lastArg);
        return { args, end: index };
      }
    }
    if (char === ')' && nestedParen > 0) {
      nestedParen -= 1;
      continue;
    }
    if (char === ',' && nestedParen === 0 && bracketDepth === 0 && braceDepth === 0) {
      args.push(script.slice(argStart, index));
      argStart = index + 1;
    }
  }
  return null;
}

function skipLineComment(script: string, start: number): number {
  const lineEnd = script.indexOf('\n', start);
  return lineEnd === -1 ? script.length : lineEnd;
}

function skipBlockComment(script: string, start: number): number {
  const blockEnd = script.indexOf('*/', start);
  return blockEnd === -1 ? script.length : blockEnd + 1;
}

function skipTemplateLiteral(script: string, start: number): number {
  let escaped = false;
  for (let index = start; index < script.length; index += 1) {
    const char = script[index] ?? '';
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '`') {
      return index;
    }
  }
  return script.length;
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function workflowScriptMetadataPath(scriptPath: string): string {
  return `${scriptPath}.meta.json`;
}

function workflowScriptMetadataFromUnknown(value: unknown): WorkflowScriptMetadata | null {
  const record = asRecord(value);
  if (!record || record.version !== 1) return null;
  if (typeof record.workflowName !== 'string' || !record.workflowName.trim()) return null;
  if (!isWorkflowSource(record.workflowSource)) return null;
  if (typeof record.scriptHash !== 'string' || !record.scriptHash.startsWith('sha256:')) return null;
  if (record.workflowSourcePath !== undefined && typeof record.workflowSourcePath !== 'string') return null;
  if (record.permissionKey !== undefined && typeof record.permissionKey !== 'string') return null;
  return {
    version: 1,
    workflowName: record.workflowName,
    workflowSource: record.workflowSource,
    ...(typeof record.workflowSourcePath === 'string' ? { workflowSourcePath: record.workflowSourcePath } : {}),
    scriptHash: record.scriptHash,
    ...(typeof record.permissionKey === 'string' ? { permissionKey: record.permissionKey } : {}),
  };
}

function durableWorkflowRetryInput(input: WorkflowLaunchInput): WorkflowLaunchInput {
  const scriptPath = typeof input.scriptPath === 'string' ? input.scriptPath : '';
  if (!scriptPath) throw workflowInputError('Workflow result resume input requires a persisted scriptPath.');
  return {
    scriptPath,
    ...(input.args !== undefined ? { args: journalJsonValueOrInputError(input.args, 'workflow args') } : {}),
    ...(typeof input.toolName === 'string' && input.toolName ? { toolName: input.toolName } : {}),
  };
}

function durableWorkflowResultRecordFromUnknown(value: unknown): DurableWorkflowResultRecord | null {
  const record = asRecord(value);
  if (!record || typeof record.runId !== 'string' || !record.runId.trim()) return null;
  if (typeof record.workflowName !== 'string' || !record.workflowName.trim()) return null;
  if (typeof record.scriptHash !== 'string' || !record.scriptHash.startsWith('sha256:')) return null;
  const retryInput = durableWorkflowRetryInputFromUnknown(record.retryInput);
  return {
    runId: record.runId,
    workflowName: record.workflowName,
    scriptHash: record.scriptHash,
    ...(retryInput ? { retryInput } : {}),
  };
}

function durableWorkflowRetryInputFromUnknown(value: unknown): WorkflowLaunchInput | null {
  const record = asRecord(value);
  if (!record || typeof record.scriptPath !== 'string' || !record.scriptPath.trim()) return null;
  return {
    scriptPath: record.scriptPath.trim(),
    ...(record.args !== undefined ? { args: normalizeJournalJsonValue(record.args, 'workflow args') } : {}),
    ...(typeof record.toolName === 'string' && record.toolName.trim() ? { toolName: record.toolName.trim() } : {}),
  };
}

function durableScriptRecordMatchesJournal(
  scriptRecord: { readonly scriptPath: string; readonly metadata?: WorkflowScriptMetadata },
  started: Extract<WorkflowJournalEntry, { readonly kind: 'workflow.run.started' }>,
): boolean {
  const metadata = scriptRecord.metadata;
  return scriptRecord.scriptPath === started.scriptPath
    && metadata !== undefined
    && metadata.workflowSource === started.workflowSource
    && metadata.workflowSourcePath === started.workflowSourcePath;
}

function durableRetryInputArgsMatchJournal(input: WorkflowLaunchInput, journalArgs: JsonValue): boolean {
  if (!Object.prototype.hasOwnProperty.call(input, 'args')) return true;
  return stableJson(input.args) === stableJson(journalArgs);
}

function durableRetryInputWithJournalArgs(input: WorkflowLaunchInput, journalArgs: JsonValue): WorkflowLaunchInput {
  return {
    ...input,
    args: journalArgs,
  };
}

function workflowPermissionRecordFromUnknown(value: unknown): WorkflowPermissionRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.permissionKey !== 'string' || !record.permissionKey) return null;
  if (record.decision !== 'allow' && record.decision !== 'deny') return null;
  if (record.reviewVersion !== undefined && (
    typeof record.reviewVersion !== 'number'
    || !Number.isInteger(record.reviewVersion)
    || record.reviewVersion < 1
  )) return null;
  if (typeof record.workflowName !== 'string' || !record.workflowName.trim()) return null;
  if (!isWorkflowSource(record.workflowSource)) return null;
  if (record.workflowSourcePath !== undefined && typeof record.workflowSourcePath !== 'string') return null;
  if (typeof record.scriptHash !== 'string' || !record.scriptHash.startsWith('sha256:')) return null;
  if (record.requestedIsolationModes !== undefined && (
    !Array.isArray(record.requestedIsolationModes)
    || record.requestedIsolationModes.some((item) => typeof item !== 'string')
  )) return null;
  if (record.dynamicIsolation !== undefined && typeof record.dynamicIsolation !== 'boolean') return null;
  if (record.isolationReviewFingerprint !== undefined && (
    typeof record.isolationReviewFingerprint !== 'string'
    || !record.isolationReviewFingerprint.startsWith('sha256:')
  )) return null;
  if (typeof record.decidedAt !== 'string' || !record.decidedAt) return null;
  return {
    permissionKey: record.permissionKey,
    decision: record.decision,
    ...(typeof record.reviewVersion === 'number' ? { reviewVersion: record.reviewVersion } : {}),
    workflowName: record.workflowName,
    workflowSource: record.workflowSource,
    ...(typeof record.workflowSourcePath === 'string' ? { workflowSourcePath: record.workflowSourcePath } : {}),
    scriptHash: record.scriptHash,
    ...(Array.isArray(record.requestedIsolationModes) ? { requestedIsolationModes: record.requestedIsolationModes } : {}),
    ...(typeof record.dynamicIsolation === 'boolean' ? { dynamicIsolation: record.dynamicIsolation } : {}),
    ...(typeof record.isolationReviewFingerprint === 'string' ? { isolationReviewFingerprint: record.isolationReviewFingerprint } : {}),
    decidedAt: record.decidedAt,
  };
}

function workflowPermissionRecordMatchesMetadata(
  record: WorkflowPermissionRecord | undefined,
  metadata: WorkflowScriptMetadata,
  workflowName: string,
  scriptHash: string,
  isolationReview: WorkflowIsolationReview,
): boolean {
  return record?.decision === 'allow'
    && record.workflowName === workflowName
    && record.workflowSource === metadata.workflowSource
    && record.workflowSourcePath === metadata.workflowSourcePath
    && record.scriptHash === scriptHash
    && workflowPermissionRecordMatchesCurrentReview(record, isolationReview);
}

function isWorkflowSource(value: unknown): value is WorkflowSource {
  return value === 'inline'
    || value === 'script_path'
    || value === 'project'
    || value === 'user'
    || value === 'plugin'
    || value === 'built_in';
}

function workflowPermissionDeniedError(
  workflowName: string,
  workflowSource: WorkflowSource,
  scriptHash: string,
): UltracodeRequestError {
  return new UltracodeRequestError(
    `Workflow permission denied for ${workflowName} (${workflowSource}, ${scriptHash}).`,
    403,
    'invalid_request_error',
    WORKFLOW_INPUT_PARAM,
    'workflow_permission_denied',
  );
}

async function workflowScriptFiles(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw workflowInputError(`Workflow directory cannot be read: ${dir}`);
  }
}

function workflowFileName(file: string): string {
  return basename(file, '.js');
}

function prefixedWorkflowName(name: string, prefix: string | undefined): string {
  return prefix ? `${prefix}:${name}` : name;
}

function pluginWorkflowDirs(plugin: WorkflowPluginRegistry): readonly string[] {
  return [
    ...(plugin.workflowsDir ? [plugin.workflowsDir] : []),
    ...(plugin.workflowsDirs ?? []),
    ...(plugin.workflowsPath ? [plugin.workflowsPath] : []),
    ...(plugin.workflowsPaths ?? []),
  ];
}

function namedWorkflowNotFoundError(name: string, available: Set<string>): UltracodeRequestError {
  const names = [...available].sort((left, right) => left.localeCompare(right));
  const detail = names.length
    ? ` Available workflows: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', ...' : ''}.`
    : ' No workflows are registered.';
  return workflowInputError(`Named workflow not found: ${name}.${detail}`);
}

function workflowScriptSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workflow';
}

async function ensureWorkflowStateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: WORKFLOW_STATE_DIR_MODE });
  await chmod(directoryPath, WORKFLOW_STATE_DIR_MODE).catch(() => undefined);
}

async function writeWorkflowStateFile(
  filePath: string,
  data: string,
  options: { readonly flag?: string } = {},
): Promise<void> {
  await writeFile(filePath, data, {
    ...options,
    mode: WORKFLOW_STATE_FILE_MODE,
  });
  await chmod(filePath, WORKFLOW_STATE_FILE_MODE).catch(() => undefined);
}

function pathInsideOrEqual(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
}

function normalizeAgentStallRetryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AGENT_STALL_RETRY_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_AGENT_STALL_RETRY_LIMIT;
  return Math.max(0, Math.floor(value));
}

function normalizeAgentStallTimeoutMs(
  configured: number | undefined,
  requestTimeoutMs: number,
): number {
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.floor(configured));
  }
  if (configured === 0 || requestTimeoutMs === 0) return 0;
  return Math.max(1, Math.floor(requestTimeoutMs));
}

function normalizeHeartbeatMs(configured: number | undefined): number {
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.floor(configured));
  }
  return 0;
}

function workflowTaskSnapshot(task: WorkflowTaskMutable): WorkflowTaskSnapshot {
  return {
    taskId: task.taskId,
    runId: task.runId,
    workflowName: task.workflowName,
    status: task.status,
    taskType: task.taskType,
    transcriptDir: task.transcriptDir,
    scriptPath: task.scriptPath,
    workflowSource: task.workflowSource,
    ...(task.workflowSourcePath ? { workflowSourcePath: task.workflowSourcePath } : {}),
    scriptHash: task.scriptHash,
    ...(task.resultPath ? { resultPath: task.resultPath } : {}),
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.failureReason ? { failureReason: task.failureReason } : {}),
    events: [...task.events],
  };
}

function parseInlineWorkflowScript(script: string): ParsedWorkflowScript {
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) {
    throw workflowMetaError('Workflow script exceeds the runtime size cap.');
  }
  const trimmedStart = script.trimStart();
  if (!trimmedStart.startsWith('export const meta')) {
    throw workflowMetaError('Workflow script must start with export const meta = {...};');
  }
  rejectForbiddenSyntax(script);
  const metaStart = script.indexOf('export const meta');
  const equals = script.indexOf('=', metaStart);
  if (equals === -1) throw workflowMetaError('Workflow meta declaration must assign a pure object literal.');
  const objectStart = firstNonWhitespace(script, equals + 1);
  if (script[objectStart] !== '{') {
    throw workflowMetaError('Workflow meta must be a pure object literal.');
  }
  const objectEnd = findMatchingBrace(script, objectStart);
  const semicolon = firstNonWhitespace(script, objectEnd + 1);
  if (script[semicolon] !== ';') {
    throw workflowMetaError('Workflow meta declaration must end with a semicolon.');
  }
  const metaLiteral = script.slice(objectStart, objectEnd + 1);
  rejectImpureMeta(metaLiteral);
  const meta = readMetaLiteral(metaLiteral);
  return {
    meta,
    metaLiteral,
    body: script.slice(semicolon + 1),
  };
}

function rejectForbiddenSyntax(script: string): void {
  const stripped = stripCommentsAndStrings(script);
  rejectForbiddenComputedLiteralAccess(script);
  const rawForbidden: Array<[RegExp, string]> = [
    [/\b(?:constructor|prototype|__proto__)\b/, 'prototype/constructor access is disabled in workflows.'],
    [/\b(?:process|require|globalThis|global|module|exports)\b/, 'host runtime access is disabled in workflows.'],
  ];
  for (const [pattern, message] of rawForbidden) {
    if (pattern.test(stripped)) throw workflowScriptError(message);
  }
  const checks: Array<[RegExp, string]> = [
    [/\bDate\s*(?:\.|\[|\()/, 'Date is disabled in workflows.'],
    [/\bnew\s+Date\s*\(\s*\)/, 'argless new Date() is nondeterministic.'],
    [/\bMath\.random\s*\(/, 'Math.random() is nondeterministic.'],
    [/\bMath\s*\[/, 'computed Math access is disabled in workflows.'],
    [/\bimport\s*\(/, 'dynamic import is disabled in workflows.'],
    [/\beval\s*\(/, 'eval is disabled in workflows.'],
    [/\bFunction\s*\(/, 'Function constructor is disabled in workflows.'],
    [/\bWebAssembly\b/, 'WebAssembly code generation is disabled in workflows.'],
    [/\brequire\s*\(/, 'require is disabled in workflows.'],
    [/\basync\b/, 'async function definitions are disabled in workflows.'],
    [/(^|[^?]):\s*(string|number|boolean|unknown|any|Record|Array|Promise)\b/, 'TypeScript syntax is not accepted in workflow scripts.'],
  ];
  for (const [pattern, message] of checks) {
    if (pattern.test(stripped)) throw workflowScriptError(message);
  }
}

function rejectForbiddenComputedLiteralAccess(script: string): void {
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? '';
    const next = script[index + 1] ?? '';
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char !== '[') continue;
    const literalStart = firstNonWhitespace(script, index + 1);
    const literalQuote = script[literalStart];
    if (literalQuote !== '"' && literalQuote !== "'") continue;
    const literal = readStringLiteral(script, literalStart, literalQuote);
    if (!literal) continue;
    const closeBracket = firstNonWhitespace(script, literal.end + 1);
    if (script[closeBracket] !== ']') continue;
    if (FORBIDDEN_HOST_PROPERTY_NAMES.has(literal.value)) {
      throw workflowScriptError(`computed ${literal.value} access is disabled in workflows.`);
    }
  }
}

function readStringLiteral(
  text: string,
  start: number,
  quote: '"' | "'",
): { readonly value: string; readonly end: number } | null {
  let value = '';
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (char === quote) return { value, end: index };
    if (char !== '\\') {
      value += char;
      continue;
    }
    const escaped = text[index + 1] ?? '';
    if (escaped === 'u') {
      const hex = text.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 5;
        continue;
      }
    }
    if (escaped === 'x') {
      const hex = text.slice(index + 2, index + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 3;
        continue;
      }
    }
    value += escaped;
    index += 1;
  }
  return null;
}

function rejectImpureMeta(metaLiteral: string): void {
  const stripped = stripCommentsAndStrings(metaLiteral);
  if (containsTemplateLiteral(metaLiteral)) {
    throw workflowMetaError('Workflow meta must not use template literals.');
  }
  const checks: Array<[RegExp, string]> = [
    [/\.\.\./, 'Workflow meta must not use spread syntax.'],
    [/\[[^\]]+\]\s*:/, 'Workflow meta must not use computed keys.'],
    [/\b(get|set)\s+[A-Za-z_$]/, 'Workflow meta must not use accessors.'],
    [/=>|\bfunction\b/, 'Workflow meta must not use functions.'],
    [/\bnew\b|\bimport\b|\beval\b/, 'Workflow meta must not call code.'],
    [/\b(__proto__|constructor|prototype)\b/, 'Workflow meta contains a forbidden key.'],
    [/[()]/, 'Workflow meta must be a pure literal without calls or grouping.'],
  ];
  for (const [pattern, message] of checks) {
    if (pattern.test(stripped)) throw workflowMetaError(message);
  }
}

function readMetaLiteral(metaLiteral: string): WorkflowMeta {
  let value: unknown;
  try {
    const context = createWorkflowVmContext();
    disableDangerousGlobals(context);
    value = runInContext(`(${metaLiteral})`, context, { timeout: 50 });
  } catch (err) {
    throw workflowMetaError(`Workflow meta object is invalid: ${workflowErrorMessage(err)}`);
  }
  const meta = asRecord(value);
  if (!meta || typeof meta.name !== 'string' || meta.name.trim() === '') {
    throw workflowMetaError('Workflow meta.name must be a non-empty string.');
  }
  if (meta.description !== undefined && typeof meta.description !== 'string') {
    throw workflowMetaError('Workflow meta.description must be a string when present.');
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw workflowMetaError('Workflow meta.phases must be an array.');
    for (const phase of meta.phases) {
      const phaseRecord = asRecord(phase);
      if (!phaseRecord || typeof phaseRecord.title !== 'string' || phaseRecord.title.trim() === '') {
        throw workflowMetaError('Every workflow phase must have a non-empty title.');
      }
      if (phaseRecord.detail !== undefined && typeof phaseRecord.detail !== 'string') {
        throw workflowMetaError('Workflow phase detail must be a string when present.');
      }
    }
  }
  return {
    name: meta.name,
    ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
    ...(Array.isArray(meta.phases) ? { phases: meta.phases as WorkflowMeta['phases'] } : {}),
  };
}

async function executeInlineWorkflow(
  parsed: ParsedWorkflowScript,
  globals: WorkflowVmGlobals,
  signal: AbortSignal,
): Promise<unknown> {
  const context = createWorkflowVmContext();
  installWorkflowVmGlobals(context, globals);
  const wrapped = [
    '"use strict";',
    `const meta = ${parsed.metaLiteral};`,
    'async function __workflow_main() {',
    parsed.body,
    '}',
    '__workflow_main.call(undefined);',
  ].join('\n');
  const result = runInContext(wrapped, context, { timeout: 250 });
  return await abortable(result, signal);
}

function createWorkflowVmContext(): ReturnType<typeof createContext> {
  return createContext({
    Math: safeMath(),
  }, {
    codeGeneration: { strings: false, wasm: false },
  });
}

function installWorkflowVmGlobals(
  context: ReturnType<typeof createContext>,
  globals: WorkflowVmGlobals,
): void {
  globals.setVmValueProjector(createWorkflowVmValueProjector(context));
  Object.defineProperty(context, '__workflowHost', {
    value: globals.host,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  runInContext([
    '"use strict";',
    '{',
    '  const define = Object.defineProperty;',
    '  const freeze = Object.freeze;',
    '  const __host = globalThis.__workflowHost;',
    '  const NativePromise = Promise;',
    '  delete globalThis.__workflowHost;',
    '  function WorkflowPromise(executor) {',
    '    if (typeof executor !== "function") throw new TypeError("Promise resolver must be a function");',
    '    return __host.trackPromise(new NativePromise(executor));',
    '  }',
    '  define(WorkflowPromise, "resolve", { value: (value) => __host.trackPromise(NativePromise.resolve(value)), writable: false, configurable: false });',
    '  define(WorkflowPromise, "reject", { value: (reason) => __host.trackPromise(NativePromise.reject(reason)), writable: false, configurable: false });',
    '  define(WorkflowPromise, "all", { value: (values) => __host.trackPromise(NativePromise.all(values)), writable: false, configurable: false });',
    '  define(WorkflowPromise, "allSettled", { value: (values) => __host.trackPromise(NativePromise.allSettled(values)), writable: false, configurable: false });',
    '  define(WorkflowPromise, "any", { value: (values) => __host.trackPromise(NativePromise.any(values)), writable: false, configurable: false });',
    '  define(WorkflowPromise, "race", { value: (values) => __host.trackPromise(NativePromise.race(values)), writable: false, configurable: false });',
    '  try { Object.setPrototypeOf(WorkflowPromise, null); } catch {}',
    '  try { Object.setPrototypeOf(WorkflowPromise.prototype, null); } catch {}',
    `  define(globalThis, "args", { value: ${globals.argsLiteral}, writable: false, configurable: false });`,
    `  const __budget = ${globals.budgetLiteral};`,
    // total/spent/remaining are NON-enumerable so Object.keys(budget)/for-in/spread are
    // byte-identical whether or not a ceiling is set. Direct access still works.
    `  define(__budget, "total", { value: ${globals.budgetTotalLiteral}, enumerable: false, writable: false, configurable: false });`,
    '  define(__budget, "spent", { value: () => __host.spent(), enumerable: false, writable: false, configurable: false });',
    '  define(__budget, "remaining", { value: () => __host.remaining(), enumerable: false, writable: false, configurable: false });',
    '  define(globalThis, "budget", { value: freeze(__budget), writable: false, configurable: false });',
    '  define(globalThis, "Promise", { value: freeze(WorkflowPromise), writable: false, configurable: false });',
    '  define(globalThis, "agent", { value: (...values) => __host.agent(...values), writable: false, configurable: false });',
    '  define(globalThis, "parallel", { value: (...values) => __host.parallel(...values), writable: false, configurable: false });',
    '  define(globalThis, "pipeline", { value: (...values) => __host.pipeline(...values), writable: false, configurable: false });',
    '  define(globalThis, "hash", { value: (...values) => __host.hash(...values), writable: false, configurable: false });',
    '  define(globalThis, "workspaceContext", { value: (...values) => __host.workspaceContext(...values), writable: false, configurable: false });',
    '  define(globalThis, "announcePlan", { value: (...values) => __host.announcePlan(...values), writable: false, configurable: false });',
    '  define(globalThis, "announcePhasePlan", { value: (...values) => __host.announcePhasePlan(...values), writable: false, configurable: false });',
    '  define(globalThis, "phase", { value: (...values) => __host.phase(...values), writable: false, configurable: false });',
    '  define(globalThis, "log", { value: (...values) => __host.log(...values), writable: false, configurable: false });',
    '  define(globalThis, "workflow", { value: (...values) => __host.workflow(...values), writable: false, configurable: false });',
    '  define(globalThis, "setTimeout", { value: (...values) => __host.setTimeout(...values), writable: false, configurable: false });',
    '  define(globalThis, "clearTimeout", { value: (...values) => __host.clearTimeout(...values), writable: false, configurable: false });',
    '  define(globalThis, "console", { value: freeze({',
    '    log: (...values) => __host.consoleLog(...values),',
    '    warn: (...values) => __host.consoleLog(...values),',
    '    error: (...values) => __host.consoleLog(...values),',
    '  }), writable: false, configurable: false });',
    '}',
  ].join('\n'), context, { timeout: 50 });
  hardenWorkflowVmIntrinsics(context);
  disableDangerousGlobals(context);
}

function createWorkflowVmValueProjector(context: ReturnType<typeof createContext>): (value: unknown) => unknown {
  return (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (value instanceof Error) return projectWorkflowErrorToVm(context, value);
    const json = JSON.stringify(workflowVmSerializableValue(value));
    if (json === undefined) return undefined;
    Object.defineProperty(context, '__workflowValueJson', {
      value: json,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      return runInContext('JSON.parse(__workflowValueJson)', context, { timeout: 50 });
    } finally {
      delete (context as Record<string, unknown>).__workflowValueJson;
    }
  };
}

function projectWorkflowErrorToVm(context: ReturnType<typeof createContext>, err: Error): unknown {
  const source = err as Error & { readonly code?: unknown };
  const payload = {
    name: err.name,
    message: err.message,
    ...(typeof source.code === 'string' ? { code: source.code } : {}),
  };
  Object.defineProperty(context, '__workflowErrorJson', {
    value: JSON.stringify(payload),
    configurable: true,
    enumerable: false,
    writable: true,
  });
  try {
    return runInContext([
      '(() => {',
      '  const payload = JSON.parse(__workflowErrorJson);',
      '  const err = new Error(payload.message);',
      '  try { err.name = payload.name || "Error"; } catch {}',
      '  if (typeof payload.code === "string") {',
      '    try { err.code = payload.code; } catch {}',
      '  }',
      '  return err;',
      '})()',
    ].join('\n'), context, { timeout: 50 });
  } finally {
    delete (context as Record<string, unknown>).__workflowErrorJson;
  }
}

function workflowVmSerializableValue(value: unknown): unknown {
  return value;
}

function hardenWorkflowVmIntrinsics(context: ReturnType<typeof createContext>): void {
  runInContext([
    '"use strict";',
    '{',
    '  const define = Object.defineProperty;',
    '  const constructors = [',
    '    Object, Function, Array, String, Number, Boolean, RegExp, Error, TypeError, Promise, Map, Set,',
    '    async function () {}.constructor,',
    '    function* () {}.constructor,',
    '    async function* () {}.constructor,',
    '  ];',
    '  for (const ctor of constructors) {',
    '    if (!ctor || !ctor.prototype) continue;',
    '    try { define(ctor.prototype, "constructor", { value: undefined, writable: false, configurable: false }); } catch {}',
    '  }',
    '  try { define(Object.prototype, "__proto__", { value: undefined, writable: false, configurable: false }); } catch {}',
    '}',
  ].join('\n'), context, { timeout: 50 });
}

function disableDangerousGlobals(context: ReturnType<typeof createContext>): void {
  runInContext([
    '"use strict";',
    '{',
    '  const define = Object.defineProperty;',
    '  for (const name of ["Date", "Function", "eval", "WebAssembly", "require", "process", "global", "module", "exports", "Object", "Reflect", "globalThis"]) {',
    '    define(globalThis, name, { value: undefined, writable: false, configurable: false });',
    '  }',
    '}',
  ].join('\n'), context, { timeout: 50 });
}

function safeMath(): Math {
  const math = Object.create(null) as Math;
  for (const key of Object.getOwnPropertyNames(Math) as Array<keyof Math>) {
    if (key === 'random') continue;
    const descriptor = Object.getOwnPropertyDescriptor(Math, key);
    if (!descriptor) continue;
    if ('value' in descriptor && typeof descriptor.value === 'function') {
      const fn = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(math, key, {
        value: hardenCallable((...args: unknown[]) => fn(...args)),
        enumerable: descriptor.enumerable,
        configurable: false,
        writable: false,
      });
    } else {
      Object.defineProperty(math, key, descriptor);
    }
  }
  return Object.freeze(math);
}

function hardenCallable<T extends (...args: never[]) => unknown>(fn: T): T {
  Object.setPrototypeOf(fn, null);
  Object.defineProperty(fn, 'constructor', { value: undefined, configurable: false, writable: false });
  Object.defineProperty(fn, 'prototype', { value: undefined, configurable: false, writable: false });
  return Object.freeze(fn);
}

function handledWorkflowPromise<T>(
  promise: Promise<T>,
  tracking?: WorkflowPromiseTracking,
): HandledWorkflowPromise<T> {
  promise.catch(() => undefined);
  const thenable = Object.create(null) as HandledWorkflowPromise<T>;
  Object.defineProperties(thenable, {
    then: {
      value: hardenCallable(<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): HandledWorkflowPromise<TResult1 | TResult2> => {
        if (typeof onrejected === 'function' && tracking) tracking.handled = true;
        const wrappedFulfilled = typeof onfulfilled === 'function'
          ? (value: T) => onfulfilled((tracking?.projectValue(value) ?? value) as T)
          : onfulfilled;
        const wrappedRejected = typeof onrejected === 'function'
          ? (reason: unknown) => onrejected(tracking?.projectValue(reason) ?? reason)
          : onrejected;
        const nextPromise = promise.then(wrappedFulfilled, wrappedRejected);
        return tracking ? tracking.trackPromise(nextPromise) : handledWorkflowPromise(nextPromise);
      }),
      enumerable: true,
      configurable: false,
      writable: false,
    },
    catch: {
      value: hardenCallable(<TResult = never>(
        onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
      ): HandledWorkflowPromise<T | TResult> => {
        if (tracking) tracking.handled = true;
        const wrappedRejected = typeof onrejected === 'function'
          ? (reason: unknown) => onrejected(tracking?.projectValue(reason) ?? reason)
          : onrejected;
        const nextPromise = promise.catch(wrappedRejected);
        return tracking ? tracking.trackPromise(nextPromise) : handledWorkflowPromise(nextPromise);
      }),
      enumerable: true,
      configurable: false,
      writable: false,
    },
    finally: {
      value: hardenCallable((onfinally?: (() => void) | null): HandledWorkflowPromise<T> => {
        if (tracking) tracking.handled = true;
        const nextPromise = promise.finally(onfinally);
        return tracking ? tracking.trackPromise(nextPromise) : handledWorkflowPromise(nextPromise);
      }),
      enumerable: true,
      configurable: false,
      writable: false,
    },
  });
  return Object.freeze(thenable);
}

function vmDataLiteral(value: unknown, label: string): string {
  if (value === undefined) return 'undefined';
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(`${label} must be JSON-serializable for workflow VM.`);
    }
    return serialized;
  } catch (err) {
    throw workflowInputError(workflowErrorMessage(err, `${label} must be JSON-serializable for workflow VM.`));
  }
}

async function abortable<T>(value: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw workflowInputError('Workflow is aborted.');
  return await Promise.race([
    Promise.resolve(value),
    new Promise<T>((_, reject) => {
      signal.addEventListener('abort', () => reject(workflowInputError('Workflow is aborted.')), { once: true });
    }),
  ]);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForWorkflowTaskEvent(task: WorkflowTaskMutable, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = (): void => {
      const index = task.waiters.indexOf(waiter);
      if (index !== -1) task.waiters.splice(index, 1);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const waiter = (): void => finish(true);
    const abort = (): void => finish(false);
    task.waiters.push(waiter);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

// Resolve the agent-concurrency setting to a pool size, or null for unbounded (no
// pool). 'auto' matches native's CPU-based bound: min(16, cores - 2), floored at 1.
function resolveAgentConcurrency(value: AgentConcurrency | undefined): number | null {
  if (value === undefined || value === 'unbounded') return null;
  if (value === 'auto') return Math.min(16, Math.max(1, availableParallelism() - 2));
  if (Number.isInteger(value) && value >= 1) return value;
  throw workflowInputError(`agentConcurrency must be 'unbounded', 'auto', or a positive integer; got ${String(value)}.`);
}

// The registry is the authority boundary for the ceiling, mirroring resolveAgentConcurrency:
// the CLI parses --budget, but a programmatic caller reaches the registry directly, and the
// ceiling check / remaining() rely on budgetTotal being null or a positive safe integer.
function resolveBudgetTotal(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (Number.isSafeInteger(value) && value >= 1) return value;
  throw workflowInputError(`budgetTotal must be null or a positive safe integer; got ${String(value)}.`);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index] as T, index);
    }
  }));
  return results;
}

function isTerminalWorkflowEvent(event: WorkflowEvent): boolean {
  return event.type === 'workflow.completed' || event.type === 'workflow.failed';
}

function agentRequest(input: {
  readonly model: string;
  readonly effort: ReasoningEffort;
  readonly prompt: string;
  readonly schema?: Record<string, unknown>;
  readonly worktreePath?: string;
}): SubagentRequest {
  const tools = input.schema ? [{
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: 'Submit the canonical structured return value for this workflow agent.',
    inputSchema: input.schema,
  }] : [];
  const prompt = input.worktreePath
    ? [
        input.prompt,
        '',
        'Worktree isolation is enabled. The runtime has set your current working directory to the isolated worktree.',
        'Make any file changes inside the current working directory only.',
      ].join('\n')
    : input.prompt;
  return {
    model: input.model,
    messages: [{
      role: 'user',
      content: prompt,
    }],
    reasoningEffort: input.effort,
    tools,
    toolChoice: input.schema ? { type: 'required' } : { type: 'auto' },
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    raw: {
      localWorkflowAgent: true,
      ...(input.schema ? { structuredOutput: true } : {}),
      ...(input.worktreePath ? { isolation: 'worktree' } : {}),
    },
  };
}

function agentResultText(result: SubagentResult): string {
  if (result.text) return result.text;
  if (result.toolCalls.length > 0) return JSON.stringify(result.toolCalls);
  return '';
}

function structuredAgentResult(
  result: SubagentResult,
  schema: Record<string, unknown>,
): unknown {
  const structuredCalls = result.toolCalls.filter((call) => call.name === STRUCTURED_OUTPUT_TOOL_NAME);
  if (structuredCalls.length !== 1 || result.toolCalls.length !== 1) {
    throw workflowStructuredOutputError('StructuredOutput tool call is required for schema-based workflow agents.');
  }
  let value: unknown;
  try {
    value = JSON.parse(structuredCalls[0]?.arguments ?? '');
  } catch (err) {
    throw workflowStructuredOutputError(`StructuredOutput arguments must be valid JSON: ${workflowErrorMessage(err)}`);
  }
  const error = validateJsonSchemaValue(value, schema);
  if (error) throw workflowStructuredOutputError(error);
  return value;
}

function normalizeStructuredOutputSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(vmDataLiteral(value, 'agent schema')) as unknown;
  } catch (err) {
    if (err instanceof UltracodeRequestError) throw err;
    throw workflowInputError(workflowErrorMessage(err, 'agent schema must be JSON-serializable.'));
  }
  const schema = asRecord(parsed);
  if (!schema) throw workflowInputError('agent schema must be a JSON Schema object.');
  assertSupportedJsonSchema(schema, 'agent schema');
  return schema;
}

function assertSupportedJsonSchema(schema: unknown, path: string): void {
  if (typeof schema === 'boolean') return;
  const record = asRecord(schema);
  if (!record) throw workflowInputError(`${path} must be a JSON Schema object.`);
  for (const key of Object.keys(record)) {
    if (!JSON_SCHEMA_KEYS.has(key)) {
      throw workflowInputError(`${path}.${key} is not supported by the workflow schema validator.`);
    }
  }
  const type = record.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (
      types.length === 0
      || !types.every((item) => typeof item === 'string' && JSON_SCHEMA_TYPES.has(item))
    ) {
      throw workflowInputError(`${path}.type must be a JSON Schema primitive type or type array.`);
    }
  }
  const properties = record.properties;
  if (properties !== undefined) {
    const propertySchemas = asRecord(properties);
    if (!propertySchemas) throw workflowInputError(`${path}.properties must be an object.`);
    for (const [key, child] of Object.entries(propertySchemas)) {
      assertSupportedJsonSchema(child, `${path}.properties.${key}`);
    }
  }
  const required = record.required;
  if (required !== undefined && (!Array.isArray(required) || !required.every((item) => typeof item === 'string'))) {
    throw workflowInputError(`${path}.required must be an array of strings.`);
  }
  const additionalProperties = record.additionalProperties;
  if (
    additionalProperties !== undefined
    && typeof additionalProperties !== 'boolean'
  ) {
    assertSupportedJsonSchema(additionalProperties, `${path}.additionalProperties`);
  }
  if (record.items !== undefined) {
    assertSupportedJsonSchema(record.items, `${path}.items`);
  }
  if (record.enum !== undefined && !Array.isArray(record.enum)) {
    throw workflowInputError(`${path}.enum must be an array.`);
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    const constraint = record[key];
    if (constraint !== undefined && (typeof constraint !== 'number' || !Number.isFinite(constraint))) {
      throw workflowInputError(`${path}.${key} must be a finite number.`);
    }
  }
}

function validateJsonSchemaValue(value: unknown, schema: unknown, path = '$'): string | null {
  if (schema === true) return null;
  if (schema === false) return `${path} is rejected by schema.`;
  const record = asRecord(schema);
  if (!record) return `${path} schema is invalid.`;
  if (Array.isArray(record.enum) && !record.enum.some((item) => jsonDeepEqual(item, value))) {
    return `${path} must equal one of the schema enum values.`;
  }
  const typeError = validateJsonSchemaType(value, record.type, path);
  if (typeError) return typeError;
  if (isJsonObject(value)) {
    const required = Array.isArray(record.required) ? record.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return `${path}.${key} is required by schema.`;
    }
    const properties = asRecord(record.properties) ?? {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const childError = validateJsonSchemaValue(value[key], childSchema, `${path}.${key}`);
        if (childError) return childError;
      }
    }
    const additionalProperties = record.additionalProperties;
    if (additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
        if (additionalProperties === false) return `${path}.${key} is not allowed by schema.`;
        if (additionalProperties !== true) {
          const childError = validateJsonSchemaValue(value[key], additionalProperties, `${path}.${key}`);
          if (childError) return childError;
        }
      }
    }
  }
  if (Array.isArray(value)) {
    const minItems = numberConstraint(record.minItems);
    if (minItems !== undefined && value.length < minItems) return `${path} must contain at least ${minItems} items.`;
    const maxItems = numberConstraint(record.maxItems);
    if (maxItems !== undefined && value.length > maxItems) return `${path} must contain at most ${maxItems} items.`;
    if (record.items !== undefined) {
      for (const [index, item] of value.entries()) {
        const itemError = validateJsonSchemaValue(item, record.items, `${path}[${index}]`);
        if (itemError) return itemError;
      }
    }
  }
  if (typeof value === 'string') {
    const minLength = numberConstraint(record.minLength);
    if (minLength !== undefined && value.length < minLength) return `${path} must contain at least ${minLength} characters.`;
    const maxLength = numberConstraint(record.maxLength);
    if (maxLength !== undefined && value.length > maxLength) return `${path} must contain at most ${maxLength} characters.`;
  }
  if (typeof value === 'number') {
    const minimum = numberConstraint(record.minimum);
    if (minimum !== undefined && value < minimum) return `${path} must be at least ${minimum}.`;
    const maximum = numberConstraint(record.maximum);
    if (maximum !== undefined && value > maximum) return `${path} must be at most ${maximum}.`;
  }
  return null;
}

function validateJsonSchemaType(value: unknown, type: unknown, path: string): string | null {
  if (type === undefined) return null;
  const types = Array.isArray(type) ? type : [type];
  if (types.some((item) => typeof item === 'string' && jsonTypeMatches(value, item))) return null;
  return `${path} must be ${types.join(' or ')}.`;
}

function jsonTypeMatches(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isJsonObject(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberConstraint(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findMatchingBrace(text: string, start: number): number {
  const index = findMatchingDelimiter(text, start, '{', '}');
  if (index === -1) throw workflowMetaError('Workflow meta object is not closed.');
  return index;
}

function findMatchingDelimiter(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function firstNonWhitespace(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (!/\s/.test(text[index] ?? '')) return index;
  }
  return text.length;
}

function firstNonCodeWhitespace(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (/\s/.test(char)) continue;
    if (char === '/' && next === '/') {
      index = skipLineComment(text, index + 2);
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(text, index + 2);
      continue;
    }
    return index;
  }
  return text.length;
}

function stripCommentsAndStrings(text: string): string {
  let out = '';
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (lineComment) {
      out += char === '\n' ? '\n' : ' ';
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        out += '  ';
        blockComment = false;
        index += 1;
      } else {
        out += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (quote) {
      out += char === '\n' ? '\n' : ' ';
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      out += '  ';
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      out += '  ';
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      out += ' ';
      quote = char;
      continue;
    }
    out += char;
  }
  return out;
}

function containsTemplateLiteral(text: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '`') return true;
  }
  return false;
}

function preview(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}...`;
}

function previewValue(value: unknown, limit: number): string {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value) ?? String(value);
  return preview(text, limit);
}

function normalizeWorkflowExecutionPlan(value: unknown): WorkflowExecutionPlan {
  const record = asRecord(value);
  if (!record) throw workflowInputError('announcePlan(plan) requires a plan object.');
  const mode = boundedPlanString(record.mode, 'phase_parallel', 48);
  const rationale = optionalBoundedPlanString(record.rationale, 400);
  const rawPhases = Array.isArray(record.phases) ? Array.from(record.phases) : [];
  if (rawPhases.length === 0) throw workflowInputError('announcePlan(plan) requires at least one phase.');
  const phases = rawPhases
    .slice(0, 16)
    .map((phaseValue, phaseIndex) => normalizeWorkflowPhasePlan(
      phaseValue,
      `announcePlan(plan).phases[${phaseIndex}]`,
      phaseIndex,
    ));
  return {
    mode,
    ...(rationale ? { rationale } : {}),
    phases,
  };
}

function normalizeWorkflowPhasePlan(
  value: unknown,
  label: string,
  phaseIndex = 0,
): WorkflowPlanPhase {
  const phase = asRecord(value);
  if (!phase) throw workflowInputError(`${label} must be an object.`);
  const rawAgents = Array.isArray(phase.agents) ? Array.from(phase.agents) : [];
  if (rawAgents.length === 0) {
    throw workflowInputError(`${label}.agents requires at least one agent.`);
  }
  return {
    ...(typeof phase.id === 'string' && phase.id.trim() ? { id: boundedPlanString(phase.id, '', 48) } : {}),
    title: boundedPlanString(phase.title, `Phase ${phaseIndex + 1}`, 96),
    ...(typeof phase.goal === 'string' && phase.goal.trim() ? { goal: boundedPlanString(phase.goal, '', 600) } : {}),
    agents: rawAgents.slice(0, 16).map((agentValue, agentIndex) => {
      const agent = asRecord(agentValue);
      if (!agent) {
        throw workflowInputError(`${label}.agents[${agentIndex}] must be an object.`);
      }
      return {
        ...(typeof agent.id === 'string' && agent.id.trim() ? { id: boundedPlanString(agent.id, '', 48) } : {}),
        title: boundedPlanString(agent.title, `Agent ${agentIndex + 1}`, 96),
        ...(typeof agent.focus === 'string' && agent.focus.trim() ? { focus: boundedPlanString(agent.focus, '', 600) } : {}),
        ...(typeof agent.label === 'string' && agent.label.trim() ? { label: boundedPlanString(agent.label, '', 96) } : {}),
      };
    }),
  };
}

function boundedPlanString(value: unknown, fallback: string, limit: number): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return preview(text, limit);
}

function optionalBoundedPlanString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return boundedPlanString(value, '', limit);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function workflowErrorMessage(err: unknown, fallback = 'Workflow failed.'): string {
  if (err instanceof Error) return err.message;
  const record = asRecord(err);
  if (typeof record?.message === 'string') return record.message;
  const text = String(err);
  return text || fallback;
}

function workflowAgentSemanticOpts(input: {
  readonly model: string;
  readonly effort: string;
  readonly schema?: Record<string, unknown>;
  readonly isolation?: AgentIsolation;
  readonly logicalKey?: string;
}): WorkflowAgentSemanticOpts {
  return {
    ...(input.schema ? { schema: journalJsonValueOrInputError(input.schema, 'agent schema') } : {}),
    model: input.model,
    effort: input.effort,
    ...(input.isolation ? { isolation: input.isolation } : {}),
    ...(input.logicalKey ? { logicalKey: input.logicalKey } : {}),
  };
}

function workflowUsage(usage: SubagentUsage): WorkflowJournalUsage {
  const inputTokens = finiteTokenCount(usage.inputTokens);
  const outputTokens = finiteTokenCount(usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: finiteTokenCount(usage.totalTokens ?? inputTokens + outputTokens),
  };
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function journalJsonValueOrInputError(value: unknown, label: string): JsonValue {
  try {
    return normalizeJournalJsonValue(value, label);
  } catch (err) {
    throw workflowInputError(workflowErrorMessage(err, `${label} must be JSON-serializable.`));
  }
}

function workflowJournalRuntimeError(err: unknown): WorkflowJournalError {
  if (isWorkflowJournalError(err)) return err;
  return new WorkflowJournalError('Workflow journal write failed.', err);
}

function workflowJournalRequestError(_err: unknown): UltracodeRequestError {
  return new UltracodeRequestError(WORKFLOW_JOURNAL_PUBLIC_FAILURE_MESSAGE, 500, 'server_error', WORKFLOW_INPUT_PARAM, WORKFLOW_JOURNAL_WRITE_FAILED_REASON);
}

// Deterministic static scan over the script text. It cannot judge whether a
// result is machine-consumed; it only counts call sites so validation can
// disclose likely contract gaps without blocking on them.
function workflowAuthoringScan(script: string): {
  readonly agentCallSites: number;
  readonly schemaCallSites: number;
  readonly keyedCallSites: number;
  readonly warnings: readonly string[];
} {
  let agentCallSites = 0;
  let schemaCallSites = 0;
  let keyedCallSites = 0;
  const agentCallRe = /\bagent\s*\(/g;
  for (let match = agentCallRe.exec(script); match; match = agentCallRe.exec(script)) {
    const openParen = script.indexOf('(', match.index);
    const closeParen = findMatchingDelimiter(script, openParen, '(', ')');
    const argsText = closeParen === -1 ? script.slice(openParen + 1) : script.slice(openParen + 1, closeParen);
    agentCallSites += 1;
    if (/\bschema\s*:/.test(argsText)) schemaCallSites += 1;
    if (/\bkey\s*:/.test(argsText)) keyedCallSites += 1;
  }
  const warnings: string[] = [];
  if (agentCallSites > schemaCallSites) {
    warnings.push(`${agentCallSites - schemaCallSites} of ${agentCallSites} agent() call site(s) do not declare a structured output schema; machine-consumed results should pass { schema }.`);
  }
  if (agentCallSites > 0 && keyedCallSites === 0 && /\b(parallel|pipeline)\s*\(/.test(script)) {
    warnings.push('No agent() call site passes a logical { key }; dynamic parallel agents without keys lose resume cache hits after reorder.');
  }
  return { agentCallSites, schemaCallSites, keyedCallSites, warnings };
}

// Unlike workflowAuthoringScan (a warning heuristic), this scanner controls a
// runtime gate. It therefore ignores comments and literal text and treats any
// real `agent` identifier reference as use of the delegated-agent capability,
// including aliases such as `const run = agent`.
function workflowReferencesAgentCapability(script: string): boolean {
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? '';
    const next = script[index + 1] ?? '';
    if (char === '/' && next === '/') {
      index = skipLineComment(script, index + 2);
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(script, index + 2);
      continue;
    }
    if (char === '"' || char === "'") {
      const literal = readStringLiteral(script, index, char);
      if (literal) index = literal.end;
      continue;
    }
    if (char === '`') {
      const end = templateLiteralEndAndAgentReference(script, index);
      if (end.referencesAgent) return true;
      index = end.end;
      continue;
    }
    if (
      script.startsWith('agent', index)
      && !isIdentifierChar(script[index - 1] ?? '')
      && !isIdentifierChar(script[index + 'agent'.length] ?? '')
    ) {
      return true;
    }
  }
  return false;
}

function templateLiteralEndAndAgentReference(
  script: string,
  start: number,
): { readonly end: number; readonly referencesAgent: boolean } {
  let escaped = false;
  for (let index = start + 1; index < script.length; index += 1) {
    const char = script[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '`') return { end: index, referencesAgent: false };
    if (char === '$' && script[index + 1] === '{') {
      const expressionStart = index + 2;
      const expressionEnd = findMatchingExpressionBrace(script, expressionStart);
      if (expressionEnd === -1) return { end: script.length - 1, referencesAgent: false };
      if (workflowReferencesAgentCapability(script.slice(expressionStart, expressionEnd))) {
        return { end: expressionEnd, referencesAgent: true };
      }
      index = expressionEnd;
    }
  }
  return { end: script.length - 1, referencesAgent: false };
}

function workflowResumeSourceInfoFromJournal(
  runId: string,
  sourceJournal: WorkflowResumeSourceJournal,
  completedAgentCount: number,
): WorkflowResumeSourceInfo {
  const terminal = sourceJournal.terminal;
  const runtime = sourceJournal.started.runtime;
  return {
    runId,
    terminal: terminal ? (terminal.kind === 'workflow.run.completed' ? 'completed' : 'failed') : 'interrupted',
    ...(terminal?.kind === 'workflow.run.failed' ? { terminalReason: terminal.reason } : {}),
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.workspaceFingerprint ? { workspaceFingerprint: runtime.workspaceFingerprint } : {}),
    completedAgentCount,
  };
}

function workflowRunPidPath(transcriptDir: string): string {
  return join(transcriptDir, 'run.pid');
}

function isWorkflowProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Sibling-of-repo store that holds every run's isolated worktrees, keyed by repo slug and
// hash, so isolated checkouts never land inside the source working tree.
function workflowWorktreeStoreRoot(gitRoot: string): string {
  return join(
    dirname(gitRoot),
    '.ultracode-for-codex-worktrees',
    `${workflowScriptSlug(basename(gitRoot))}-${shortHash(gitRoot)}`,
  );
}


function workflowResumeUnknownError(runId: string): UltracodeRequestError {
  // Workflow state is partitioned by the exact working directory, so the most
  // common cause of an unknown run id is resuming from a different cwd.
  return workflowInputError(`Unknown workflow run for resume: ${runId}. Run resume from the source run's working directory (--cwd).`);
}

function workflowResumeSourceInvalidError(runId: string, cause?: unknown): UltracodeRequestError {
  const detail = cause instanceof WorkflowJournalValidationError ? ` (${cause.message})` : '';
  return workflowInputError(`Workflow run cannot be used as a resume source: ${runId}${detail}`);
}

function workflowResumeRunningError(runId: string): UltracodeRequestError {
  return new UltracodeRequestError(
    `Workflow run is still running and cannot be resumed: ${runId}`,
    409,
    'invalid_request_error',
    WORKFLOW_INPUT_PARAM,
    'workflow_resume_running',
  );
}

function workflowFailureReason(err: unknown): string {
  if (isWorkflowJournalError(err)) return WORKFLOW_JOURNAL_WRITE_FAILED_REASON;
  if (err instanceof UltracodeRequestError && err.code) return err.code;
  const record = asRecord(err);
  if (typeof record?.code === 'string' && WORKFLOW_STABLE_FAILURE_CODES.has(record.code)) return record.code;
  return 'workflow_failed';
}

// Single source of retryability: it is a pure property of the failure reason, derived
// wherever needed (CLI retry gate, streamed failure event) and stored nowhere durable.
export function isRetryableFailureReason(reason: string | undefined): boolean {
  return reason !== undefined && WORKFLOW_RETRYABLE_FAILURE_CODES.has(reason);
}

function workflowInputError(message: string): UltracodeRequestError {
  return new UltracodeRequestError(message, 400, 'invalid_request_error', WORKFLOW_INPUT_PARAM, 'workflow_input_invalid');
}

function workflowMetaError(message: string): UltracodeRequestError {
  return new UltracodeRequestError(message, 400, 'invalid_request_error', WORKFLOW_INPUT_PARAM, 'workflow_meta_invalid');
}

function workflowScriptError(message: string): UltracodeRequestError {
  return new UltracodeRequestError(message, 400, 'invalid_request_error', WORKFLOW_INPUT_PARAM, 'workflow_script_nondeterministic');
}

function workflowAgentStalledError(message: string): UltracodeRequestError {
  return new UltracodeRequestError(message, 408, 'invalid_request_error', WORKFLOW_INPUT_PARAM, 'workflow_agent_stalled');
}

// Give a backend failure its canonical workflow code. A classified SubagentFailure maps
// by kind: `terminal` becomes the non-retryable `workflow_agent_terminal` so a failure
// retrying cannot fix (auth, bad request, config) is not retried to exhaustion; every
// other kind becomes the retryable `workflow_agent_failed`, preserving today's behavior.
// An uncoded backend Error also becomes `workflow_agent_failed`; an error already
// carrying a stable code (a stall, an aborted workflow) keeps it.
function codedAgentFailure(err: unknown): unknown {
  if (isSubagentFailure(err)) {
    const terminal = err.kind === 'terminal';
    return new UltracodeRequestError(
      err.message,
      terminal ? 403 : 502,
      'invalid_request_error',
      WORKFLOW_INPUT_PARAM,
      terminal ? 'workflow_agent_terminal' : 'workflow_agent_failed',
    );
  }
  if (workflowFailureReason(err) !== 'workflow_failed') return err;
  return new UltracodeRequestError(
    workflowErrorMessage(err),
    502,
    'invalid_request_error',
    WORKFLOW_INPUT_PARAM,
    'workflow_agent_failed',
  );
}

function isWorkflowAgentStalledError(err: unknown): boolean {
  return err instanceof UltracodeRequestError && err.code === 'workflow_agent_stalled';
}

function workflowStructuredOutputError(message: string): UltracodeRequestError {
  return new UltracodeRequestError(message, 400, 'invalid_request_error', WORKFLOW_INPUT_PARAM, 'workflow_structured_output_failed');
}

export function workflowResultUsage(events: readonly WorkflowEvent[]): { readonly inputTokens: number; readonly outputTokens: number } {
  const text = events.map((event) => JSON.stringify(event)).join('\n');
  return {
    inputTokens: 1,
    outputTokens: estimateTokens(text),
  };
}
