import { readFileSync } from 'node:fs';
import type { AgentConcurrency, NestedWorkflows, ReasoningEffort, Verbosity, WorktreeRetention } from './runtime/types.js';
import { NESTED_WORKFLOWS_VALUES, REASONING_EFFORTS, WORKTREE_RETENTIONS, isAgentConcurrencyKeyword, isNestedWorkflows, isReasoningEffort, isWorktreeRetention } from './runtime/types.js';

export { isReasoningEffort };

export type WorkflowExecutionMode = 'background' | 'attached';
export type WorkflowProgressMode = 'jsonl' | 'plain';
export type WorkflowPermissionPolicy = 'ask' | 'allow' | 'deny';

export interface UltracodeSettings {
  readonly workflow: {
    readonly executionMode: WorkflowExecutionMode;
    readonly progress: WorkflowProgressMode;
    readonly permission: WorkflowPermissionPolicy;
    readonly retryLimit: number;
    readonly timeoutMs: number;
    readonly heartbeatMs: number;
    readonly worktreeRetention: WorktreeRetention;
    readonly agentConcurrency: AgentConcurrency;
    readonly nestedWorkflows: NestedWorkflows;
    readonly background: {
      readonly runDir: string;
      readonly resultFile: string;
      readonly progressFile: string;
      readonly metadataFile: string;
      readonly pidFile: string;
    };
  };
  readonly codex: {
    readonly reasoningEffort: ReasoningEffort;
    readonly verbosity: Verbosity;
  };
}

const SETTINGS_URL = new URL('../settings.json', import.meta.url);
const WORKFLOW_EXECUTION_MODES = ['background', 'attached'] as const;
const WORKFLOW_PROGRESS_MODES = ['jsonl', 'plain'] as const;
const WORKFLOW_PERMISSION_POLICIES = ['ask', 'allow', 'deny'] as const;
const VERBOSITIES = ['low', 'medium', 'high'] as const;

let cachedSettings: UltracodeSettings | null = null;

export function loadSettings(): UltracodeSettings {
  if (cachedSettings) return cachedSettings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SETTINGS_URL, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`Unable to read settings.json: ${errorMessage(err)}`);
  }

  const root = asRecord(parsed);
  if (!root) throw new Error('settings.json must contain a JSON object.');
  const workflow = asRecord(root?.workflow);
  if (!workflow) throw new Error('settings.json must define workflow.');
  const background = asRecord(workflow?.background);
  if (!background) throw new Error('settings.json must define workflow.background.');
  const codex = asRecord(root?.codex);
  if (!codex) throw new Error('settings.json must define codex.');
  cachedSettings = {
    workflow: {
      executionMode: readWorkflowExecutionModeSetting(
        workflow?.executionMode,
        'workflow.executionMode',
      ),
      progress: readWorkflowProgressModeSetting(
        workflow?.progress,
        'workflow.progress',
      ),
      permission: readWorkflowPermissionPolicySetting(
        workflow?.permission,
        'workflow.permission',
      ),
      retryLimit: readNonNegativeIntegerSetting(
        workflow?.retryLimit,
        'workflow.retryLimit',
      ),
      timeoutMs: readNonNegativeIntegerSetting(
        workflow?.timeoutMs,
        'workflow.timeoutMs',
      ),
      heartbeatMs: readNonNegativeIntegerSetting(
        workflow?.heartbeatMs,
        'workflow.heartbeatMs',
      ),
      worktreeRetention: readWorktreeRetentionSetting(
        workflow?.worktreeRetention,
        'workflow.worktreeRetention',
      ),
      agentConcurrency: readAgentConcurrencySetting(
        workflow?.agentConcurrency,
        'workflow.agentConcurrency',
      ),
      nestedWorkflows: readNestedWorkflowsSetting(
        workflow?.nestedWorkflows,
        'workflow.nestedWorkflows',
      ),
      background: {
        runDir: readTemplateSetting(
          background?.runDir,
          'workflow.background.runDir',
          true,
        ),
        resultFile: readRelativePathSetting(
          background?.resultFile,
          'workflow.background.resultFile',
        ),
        progressFile: readRelativePathSetting(
          background?.progressFile,
          'workflow.background.progressFile',
        ),
        metadataFile: readRelativePathSetting(
          background?.metadataFile,
          'workflow.background.metadataFile',
        ),
        pidFile: readRelativePathSetting(
          background?.pidFile,
          'workflow.background.pidFile',
        ),
      },
    },
    codex: {
      reasoningEffort: readReasoningEffortSetting(
        codex?.reasoningEffort,
        'codex.reasoningEffort',
      ),
      verbosity: readVerbositySetting(
        codex?.verbosity,
        'codex.verbosity',
      ),
    },
  };
  return cachedSettings;
}

export function workflowDefaultExecutionMode(): WorkflowExecutionMode {
  return loadSettings().workflow.executionMode;
}

export function workflowDefaultProgressMode(): WorkflowProgressMode {
  return loadSettings().workflow.progress;
}

export function workflowDefaultPermissionPolicy(): WorkflowPermissionPolicy {
  return loadSettings().workflow.permission;
}

export function workflowDefaultRetryLimit(): number {
  return loadSettings().workflow.retryLimit;
}

export function workflowDefaultTimeoutMs(): number {
  return loadSettings().workflow.timeoutMs;
}

export function workflowDefaultHeartbeatMs(): number {
  return loadSettings().workflow.heartbeatMs;
}

export function workflowDefaultWorktreeRetention(): WorktreeRetention {
  return loadSettings().workflow.worktreeRetention;
}

export function workflowDefaultAgentConcurrency(): AgentConcurrency {
  return loadSettings().workflow.agentConcurrency;
}

export function workflowDefaultNestedWorkflows(): NestedWorkflows {
  return loadSettings().workflow.nestedWorkflows;
}

export function workflowBackgroundDefaults(): UltracodeSettings['workflow']['background'] {
  return loadSettings().workflow.background;
}

export function codexDefaultReasoningEffort(): ReasoningEffort {
  return loadSettings().codex.reasoningEffort;
}

export function codexDefaultVerbosity(): Verbosity {
  return loadSettings().codex.verbosity;
}

export function isVerbosity(value: unknown): value is Verbosity {
  return typeof value === 'string' && VERBOSITIES.includes(value as Verbosity);
}

export function isWorkflowExecutionMode(value: unknown): value is WorkflowExecutionMode {
  return typeof value === 'string' && WORKFLOW_EXECUTION_MODES.includes(value as WorkflowExecutionMode);
}

export function isWorkflowProgressMode(value: unknown): value is WorkflowProgressMode {
  return typeof value === 'string' && WORKFLOW_PROGRESS_MODES.includes(value as WorkflowProgressMode);
}

export function isWorkflowPermissionPolicy(value: unknown): value is WorkflowPermissionPolicy {
  return typeof value === 'string' && WORKFLOW_PERMISSION_POLICIES.includes(value as WorkflowPermissionPolicy);
}

function readWorkflowExecutionModeSetting(
  value: unknown,
  key: string,
): WorkflowExecutionMode {
  if (isWorkflowExecutionMode(value)) return value;
  throw new Error(`${key} must be one of ${WORKFLOW_EXECUTION_MODES.join(', ')}.`);
}

function readWorkflowProgressModeSetting(
  value: unknown,
  key: string,
): WorkflowProgressMode {
  if (isWorkflowProgressMode(value)) return value;
  throw new Error(`${key} must be one of ${WORKFLOW_PROGRESS_MODES.join(', ')}.`);
}

function readWorkflowPermissionPolicySetting(
  value: unknown,
  key: string,
): WorkflowPermissionPolicy {
  if (isWorkflowPermissionPolicy(value)) return value;
  throw new Error(`${key} must be one of ${WORKFLOW_PERMISSION_POLICIES.join(', ')}.`);
}

function readWorktreeRetentionSetting(
  value: unknown,
  key: string,
): WorktreeRetention {
  if (isWorktreeRetention(value)) return value;
  throw new Error(`${key} must be one of ${WORKTREE_RETENTIONS.join(', ')}.`);
}

// Omitted defaults to 'disabled' so an existing settings.json without this key keeps nested
// workflow() off (byte-identical to before the feature) rather than failing to load.
function readNestedWorkflowsSetting(
  value: unknown,
  key: string,
): NestedWorkflows {
  if (value === undefined) return 'disabled';
  if (isNestedWorkflows(value)) return value;
  throw new Error(`${key} must be one of ${NESTED_WORKFLOWS_VALUES.join(', ')}.`);
}

function readAgentConcurrencySetting(
  value: unknown,
  key: string,
): AgentConcurrency {
  if (isAgentConcurrencyKeyword(value)) return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  throw new Error(`${key} must be 'unbounded', 'auto', or a positive integer.`);
}

function readReasoningEffortSetting(
  value: unknown,
  key: string,
): ReasoningEffort {
  if (isReasoningEffort(value)) return value;
  throw new Error(`${key} must be one of ${REASONING_EFFORTS.join(', ')}.`);
}

function readVerbositySetting(
  value: unknown,
  key: string,
): Verbosity {
  if (isVerbosity(value)) return value;
  throw new Error(`${key} must be one of ${VERBOSITIES.join(', ')}.`);
}

function readNonNegativeIntegerSetting(value: unknown, key: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw new Error(`${key} must be a non-negative integer.`);
}

function readTemplateSetting(value: unknown, key: string, requireJobId: boolean): string {
  const text = readNonEmptyStringSetting(value, key);
  if (requireJobId && !text.includes('{jobId}')) {
    throw new Error(`${key} must include {jobId}.`);
  }
  return text;
}

function readRelativePathSetting(value: unknown, key: string): string {
  const text = readNonEmptyStringSetting(value, key);
  if (text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text) || text.split(/[\\/]+/).includes('..')) {
    throw new Error(`${key} must be a relative path without parent traversal.`);
  }
  return text;
}

function readNonEmptyStringSetting(value: unknown, key: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`${key} must be a non-empty string.`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
