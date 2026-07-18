import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface WorkflowJournalUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface WorkflowAgentSemanticOpts {
  readonly schema?: JsonValue;
  readonly model: string;
  readonly effort?: string;
  readonly isolation?: string;
  readonly agentType?: string;
  readonly logicalKey?: string;
}

export type WorkflowJournalEntry =
  | WorkflowRunStartedEntry
  | WorkflowAgentStartedEntry
  | WorkflowAgentCompletedEntry
  | WorkflowAgentFailedEntry
  | WorkflowRunCompletedEntry
  | WorkflowRunFailedEntry;

interface WorkflowJournalEntryEnvelope {
  readonly version: 1;
  readonly seq: number;
  readonly previousEntryHash: string;
  readonly entryHash: string;
  readonly recordedAt: string;
  readonly taskId: string;
  readonly runId: string;
}

export interface WorkflowRunStartedEntry extends WorkflowJournalEntryEnvelope {
  readonly kind: 'workflow.run.started';
  readonly workflowName: string;
  readonly workflowSource: string;
  readonly workflowSourcePath?: string;
  readonly scriptPath: string;
  readonly scriptHash: string;
  readonly args: JsonValue;
  readonly runtime: {
    readonly schemaVersion: 1;
    readonly cwd: string;
    readonly model?: string;
    readonly workspaceFingerprint?: string;
  };
}

export interface WorkflowAgentStartedEntry extends WorkflowJournalEntryEnvelope {
  readonly kind: 'workflow.agent.started';
  readonly agentIndex: number;
  readonly agentId: string;
  readonly agentCallKey: string;
  readonly previousAgentCallKey: string;
  readonly prompt: string;
  // True when `prompt` is a bounded audit preview of an oversized prompt (see boundJournalAuditString),
  // not the verbatim prompt. The agentCallKey was still derived from the FULL prompt, so validation
  // skips the prompt-vs-key re-derivation cross-check for such entries (the key stays hash-chain
  // protected, and resume recomputes it from the live prompt).
  readonly promptBounded?: boolean;
  readonly semanticOpts: WorkflowAgentSemanticOpts;
}

export interface WorkflowAgentCompletedEntry extends WorkflowJournalEntryEnvelope {
  readonly kind: 'workflow.agent.completed';
  readonly agentIndex: number;
  readonly agentId: string;
  readonly agentCallKey: string;
  readonly result: JsonValue;
  readonly usage: WorkflowJournalUsage;
  readonly toolCalls: number;
}

export interface WorkflowAgentFailedEntry extends WorkflowJournalEntryEnvelope {
  readonly kind: 'workflow.agent.failed';
  readonly agentIndex: number;
  readonly agentId: string;
  readonly agentCallKey: string;
  readonly reason: string;
  readonly message: string;
}

export interface WorkflowRunCompletedEntry extends WorkflowJournalEntryEnvelope {
  readonly kind: 'workflow.run.completed';
  readonly result: JsonValue;
  readonly resultPath: string;
  readonly agentCount: number;
  readonly usage: WorkflowJournalUsage;
  readonly toolCalls: number;
  readonly durationMs: number;
}

export interface WorkflowRunFailedEntry extends WorkflowJournalEntryEnvelope {
  readonly kind: 'workflow.run.failed';
  readonly reason: string;
  readonly message: string;
  readonly recovery?: {
    readonly retryable: boolean;
    readonly reason: string;
  };
  readonly durationMs: number;
}

export type WorkflowJournalEntryPayload =
  | Omit<WorkflowRunStartedEntry, keyof WorkflowJournalEntryEnvelope>
  | Omit<WorkflowAgentStartedEntry, keyof WorkflowJournalEntryEnvelope>
  | Omit<WorkflowAgentCompletedEntry, keyof WorkflowJournalEntryEnvelope>
  | Omit<WorkflowAgentFailedEntry, keyof WorkflowJournalEntryEnvelope>
  | Omit<WorkflowRunCompletedEntry, keyof WorkflowJournalEntryEnvelope>
  | Omit<WorkflowRunFailedEntry, keyof WorkflowJournalEntryEnvelope>;

export interface WorkflowJournalReadResult {
  readonly entries: readonly WorkflowJournalEntry[];
  readonly truncatedTail: boolean;
}

export interface WorkflowJournalReadOptions {
  // An unterminated final line was never durably committed (the writer emits
  // entry+newline as one buffer), so non-completed resume sources may drop it
  // even when the bytes happen to parse as complete JSON.
  readonly dropUnterminatedTail?: boolean;
}

export interface WorkflowJournalDurability {
  readonly syncFile?: (journalPath: string, entry: WorkflowJournalEntry) => Promise<void>;
  readonly syncDirectory?: (directoryPath: string) => Promise<void>;
}

export interface WorkflowJournalWriterOptions {
  readonly transcriptDir: string;
  readonly taskId: string;
  readonly runId: string;
  readonly durability?: WorkflowJournalDurability;
}

export class WorkflowJournalError extends Error {
  readonly code = 'workflow_journal_write_failed';

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'WorkflowJournalError';
  }
}

export class WorkflowJournalValidationError extends Error {
  readonly code = 'workflow_journal_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowJournalValidationError';
  }
}

export class WorkflowJournalWriter {
  private readonly journalPath: string;
  private queue: Promise<void> = Promise.resolve();
  private poisoned?: WorkflowJournalError;
  private seq = 0;
  private previousEntryHash = ZERO_HASH;

  private constructor(
    private readonly options: Required<Pick<WorkflowJournalWriterOptions, 'transcriptDir' | 'taskId' | 'runId'>> & {
      readonly durability?: WorkflowJournalDurability;
    },
  ) {
    this.journalPath = join(options.transcriptDir, JOURNAL_FILE_NAME);
  }

  static async create(options: WorkflowJournalWriterOptions): Promise<WorkflowJournalWriter> {
    await ensureWorkflowTranscriptDir(options.transcriptDir);
    const journalPath = join(options.transcriptDir, JOURNAL_FILE_NAME);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(journalPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, JOURNAL_FILE_MODE);
      await handle.sync();
    } catch (err) {
      throw new WorkflowJournalError(`Workflow journal cannot be initialized at ${journalPath}.`, err);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    await chmod(journalPath, JOURNAL_FILE_MODE).catch(() => undefined);
    await durableDirectorySync(options.transcriptDir, options.durability);
    await durableDirectorySync(dirname(options.transcriptDir), options.durability);
    return new WorkflowJournalWriter(options);
  }

  async append(payload: WorkflowJournalEntryPayload): Promise<WorkflowJournalEntry> {
    const terminalPayload = TERMINAL_KINDS.has(payload.kind);
    if (this.poisoned && !terminalPayload) throw this.poisoned;
    let entry: WorkflowJournalEntry | undefined;
    const queue = terminalPayload ? this.queue.catch(() => undefined) : this.queue;
    const appendWork = queue.then(async () => {
      if (this.poisoned && !terminalPayload) throw this.poisoned;
      entry = this.nextEntry(payload);
      await appendJournalLine(this.journalPath, entry, this.options.durability);
      this.seq = entry.seq;
      this.previousEntryHash = entry.entryHash;
    });
    this.queue = appendWork.catch((err) => {
      const journalError = toWorkflowJournalError(err, `Workflow journal append failed at ${this.journalPath}.`);
      if (!terminalPayload && !this.poisoned) this.poisoned = journalError;
      throw journalError;
    });
    this.queue.catch(() => undefined);
    try {
      await appendWork;
    } catch (err) {
      const journalError = toWorkflowJournalError(err, `Workflow journal append failed at ${this.journalPath}.`);
      if (!terminalPayload && !this.poisoned) this.poisoned = journalError;
      throw terminalPayload ? journalError : this.poisoned ?? journalError;
    }
    return entry as WorkflowJournalEntry;
  }

  private nextEntry(payload: WorkflowJournalEntryPayload): WorkflowJournalEntry {
    const base = {
      version: 1 as const,
      seq: this.seq + 1,
      previousEntryHash: this.previousEntryHash,
      recordedAt: new Date().toISOString(),
      taskId: this.options.taskId,
      runId: this.options.runId,
      ...payload,
    };
    const entryHash = workflowJournalHash(base);
    const entry = { ...base, entryHash } as WorkflowJournalEntry;
    assertValidWorkflowJournalEntry(entry);
    return entry;
  }
}

const JOURNAL_FILE_NAME = 'journal.jsonl';
const JOURNAL_FILE_MODE = 0o600;
const TRANSCRIPT_DIR_MODE = 0o700;
const ZERO_HASH = '0'.repeat(64);
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STRING_BYTES = 512 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;
const TERMINAL_KINDS = new Set(['workflow.run.completed', 'workflow.run.failed']);

export const WORKFLOW_JOURNAL_GENESIS_HASH = ZERO_HASH;
export const WORKFLOW_JOURNAL_GENESIS_AGENT_CALL_KEY = ZERO_HASH;
export const WORKFLOW_JOURNAL_WRITE_FAILED_REASON = 'workflow_journal_write_failed';

const ENTRY_KEYS: Record<WorkflowJournalEntry['kind'], readonly string[]> = {
  'workflow.run.started': [
    'version',
    'seq',
    'previousEntryHash',
    'entryHash',
    'recordedAt',
    'taskId',
    'runId',
    'kind',
    'workflowName',
    'workflowSource',
    'workflowSourcePath',
    'scriptPath',
    'scriptHash',
    'args',
    'runtime',
  ],
  'workflow.agent.started': [
    'version',
    'seq',
    'previousEntryHash',
    'entryHash',
    'recordedAt',
    'taskId',
    'runId',
    'kind',
    'agentIndex',
    'agentId',
    'agentCallKey',
    'previousAgentCallKey',
    'prompt',
    'promptBounded',
    'semanticOpts',
  ],
  'workflow.agent.completed': [
    'version',
    'seq',
    'previousEntryHash',
    'entryHash',
    'recordedAt',
    'taskId',
    'runId',
    'kind',
    'agentIndex',
    'agentId',
    'agentCallKey',
    'result',
    'usage',
    'toolCalls',
  ],
  'workflow.agent.failed': [
    'version',
    'seq',
    'previousEntryHash',
    'entryHash',
    'recordedAt',
    'taskId',
    'runId',
    'kind',
    'agentIndex',
    'agentId',
    'agentCallKey',
    'reason',
    'message',
  ],
  'workflow.run.completed': [
    'version',
    'seq',
    'previousEntryHash',
    'entryHash',
    'recordedAt',
    'taskId',
    'runId',
    'kind',
    'result',
    'resultPath',
    'agentCount',
    'usage',
    'toolCalls',
    'durationMs',
  ],
  'workflow.run.failed': [
    'version',
    'seq',
    'previousEntryHash',
    'entryHash',
    'recordedAt',
    'taskId',
    'runId',
    'kind',
    'reason',
    'message',
    'recovery',
    'durationMs',
  ],
};

export function workflowJournalPath(transcriptDir: string): string {
  return join(transcriptDir, JOURNAL_FILE_NAME);
}

export function isWorkflowJournalError(err: unknown): err is WorkflowJournalError {
  return err instanceof WorkflowJournalError || (Boolean(err) && (err as { code?: unknown }).code === WORKFLOW_JOURNAL_WRITE_FAILED_REASON);
}

export function normalizeJournalJsonValue(value: unknown, label: string): JsonValue {
  return normalizeJsonValue(value, label, new WeakSet<object>());
}

export function stableJson(value: unknown): string {
  return stableSerialize(normalizeJournalJsonValue(value, 'value'));
}

export function computeWorkflowAgentCallKey(input: {
  readonly previousAgentCallKey: string;
  readonly prompt: string;
  readonly semanticOpts: WorkflowAgentSemanticOpts;
}): string {
  if (!HASH_RE.test(input.previousAgentCallKey)) {
    throw new WorkflowJournalValidationError('previousAgentCallKey must be a 64-character sha256 hex digest.');
  }
  if (input.semanticOpts.logicalKey) {
    return sha256(`logical\0${input.semanticOpts.logicalKey}\0${input.prompt}\0${stableJson(input.semanticOpts)}`);
  }
  return sha256(`${input.previousAgentCallKey}\0${input.prompt}\0${stableJson(input.semanticOpts)}`);
}

export function workflowJournalHash(entryWithoutEntryHash: unknown): string {
  return sha256(stableJson(entryWithoutEntryHash));
}

export async function readWorkflowJournal(
  journalPath: string,
  options?: WorkflowJournalReadOptions,
): Promise<WorkflowJournalReadResult> {
  const raw = await readFile(journalPath, 'utf8');
  const endsWithNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (endsWithNewline) lines.pop();
  let truncatedTail = false;
  if (!endsWithNewline && lines.length > 0) {
    if (options?.dropUnterminatedTail) {
      // The writer emits entry+newline in one buffer, so a missing newline
      // means the entry was never durably committed, whatever its bytes parse
      // as; drop it without depending on parser error message shapes.
      lines.pop();
      truncatedTail = true;
    } else {
      const tail = lines[lines.length - 1] ?? '';
      try {
        JSON.parse(tail);
        throw new WorkflowJournalValidationError('workflow journal has a non-newline-terminated JSON entry.');
      } catch (err) {
        if (err instanceof WorkflowJournalValidationError) throw err;
        if (!isTruncationParseError(err)) throw err;
        lines.pop();
        truncatedTail = true;
      }
    }
  }
  const entries = lines.map((line, index) => parseJournalLine(line, index + 1));
  validateWorkflowJournal(entries);
  return { entries, truncatedTail };
}

function parseJournalLine(line: string, lineNumber: number): WorkflowJournalEntry {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    throw new WorkflowJournalValidationError(`journal line ${lineNumber} exceeds ${MAX_LINE_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (err) {
    throw new WorkflowJournalValidationError(`journal line ${lineNumber} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entry = value as WorkflowJournalEntry;
  assertValidWorkflowJournalEntry(entry);
  return entry;
}

function validateWorkflowJournal(entries: readonly WorkflowJournalEntry[]): void {
  if (entries.length === 0) throw new WorkflowJournalValidationError('workflow journal is empty.');
  if (entries[0]?.kind !== 'workflow.run.started') {
    throw new WorkflowJournalValidationError('workflow journal must start with workflow.run.started.');
  }
  const started = entries[0] as WorkflowRunStartedEntry;
  let previousEntryHash = ZERO_HASH;
  let expectedAgentPreviousKey = ZERO_HASH;
  let terminalSeen = false;
  const startedAgents = new Map<string, WorkflowAgentStartedEntry>();
  const startedAgentIndexes = new Set<number>();
  const finalizedAgents = new Set<string>();
  const agentCallKeys = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index + 1) throw new WorkflowJournalValidationError(`workflow journal seq gap at ${entry.seq}.`);
    if (entry.previousEntryHash !== previousEntryHash) {
      throw new WorkflowJournalValidationError(`workflow journal hash chain mismatch at seq ${entry.seq}.`);
    }
    const { entryHash: _ignored, ...withoutEntryHash } = entry;
    if (workflowJournalHash(withoutEntryHash) !== entry.entryHash) {
      throw new WorkflowJournalValidationError(`workflow journal entryHash mismatch at seq ${entry.seq}.`);
    }
    if (entry.taskId !== started.taskId || entry.runId !== started.runId) {
      throw new WorkflowJournalValidationError(`workflow journal task/run mismatch at seq ${entry.seq}.`);
    }
    if (terminalSeen) {
      throw new WorkflowJournalValidationError(`workflow journal has non-terminal entry after terminal at seq ${entry.seq}.`);
    }
    if (entry.kind === 'workflow.agent.started') {
      if (startedAgents.has(entry.agentId)) {
        throw new WorkflowJournalValidationError(`duplicate agentId at seq ${entry.seq}.`);
      }
      if (startedAgentIndexes.has(entry.agentIndex)) {
        throw new WorkflowJournalValidationError(`duplicate agentIndex at seq ${entry.seq}.`);
      }
      if (entry.previousAgentCallKey !== expectedAgentPreviousKey) {
        throw new WorkflowJournalValidationError(`agent call key chain mismatch at seq ${entry.seq}.`);
      }
      // A bounded prompt is a truncated audit preview, so it cannot reproduce the key that was
      // derived from the full prompt; skip the prompt-vs-key cross-check for it. The agentCallKey is
      // still chain-verified above (previousAgentCallKey) and covered by the entry hash.
      if (!entry.promptBounded) {
        const expectedAgentCallKey = computeWorkflowAgentCallKey({
          previousAgentCallKey: entry.previousAgentCallKey,
          prompt: entry.prompt,
          semanticOpts: entry.semanticOpts,
        });
        if (entry.agentCallKey !== expectedAgentCallKey) {
          throw new WorkflowJournalValidationError(`agent call key derivation mismatch at seq ${entry.seq}.`);
        }
      }
      if (agentCallKeys.has(entry.agentCallKey)) {
        throw new WorkflowJournalValidationError(`duplicate agentCallKey at seq ${entry.seq}.`);
      }
      agentCallKeys.add(entry.agentCallKey);
      startedAgentIndexes.add(entry.agentIndex);
      expectedAgentPreviousKey = entry.agentCallKey;
      startedAgents.set(entry.agentId, entry);
    } else if (entry.kind === 'workflow.agent.completed' || entry.kind === 'workflow.agent.failed') {
      const agent = startedAgents.get(entry.agentId);
      if (!agent) throw new WorkflowJournalValidationError(`agent final entry without started entry at seq ${entry.seq}.`);
      if (finalizedAgents.has(entry.agentId)) throw new WorkflowJournalValidationError(`duplicate agent final entry at seq ${entry.seq}.`);
      if (entry.agentIndex !== agent.agentIndex) throw new WorkflowJournalValidationError(`agent final index mismatch at seq ${entry.seq}.`);
      if (entry.agentCallKey !== agent.agentCallKey) throw new WorkflowJournalValidationError(`agent final key mismatch at seq ${entry.seq}.`);
      finalizedAgents.add(entry.agentId);
    } else if (entry.kind === 'workflow.run.completed' || entry.kind === 'workflow.run.failed') {
      const openAgentCount = startedAgents.size - finalizedAgents.size;
      if (
        openAgentCount > 0
        && (entry.kind === 'workflow.run.completed' || entry.reason !== WORKFLOW_JOURNAL_WRITE_FAILED_REASON)
      ) {
        throw new WorkflowJournalValidationError(`workflow journal terminal entry has ${openAgentCount} unfinalized agent(s) at seq ${entry.seq}.`);
      }
      terminalSeen = true;
    }
    previousEntryHash = entry.entryHash;
  }
}

function assertValidWorkflowJournalEntry(value: unknown): asserts value is WorkflowJournalEntry {
  const record = asRecord(value);
  if (!record) throw new WorkflowJournalValidationError('journal entry must be an object.');
  if (record.version !== 1) throw new WorkflowJournalValidationError('journal entry version must be 1.');
  if (!isPositiveInteger(record.seq)) throw new WorkflowJournalValidationError('journal entry seq must be a positive integer.');
  if (!isHash(record.previousEntryHash)) throw new WorkflowJournalValidationError('journal entry previousEntryHash must be sha256 hex.');
  if (!isHash(record.entryHash)) throw new WorkflowJournalValidationError('journal entry entryHash must be sha256 hex.');
  if (typeof record.recordedAt !== 'string' || !record.recordedAt) throw new WorkflowJournalValidationError('journal entry recordedAt must be a string.');
  if (typeof record.taskId !== 'string' || !record.taskId) throw new WorkflowJournalValidationError('journal entry taskId must be a string.');
  if (typeof record.runId !== 'string' || !record.runId) throw new WorkflowJournalValidationError('journal entry runId must be a string.');
  if (!isWorkflowJournalKind(record.kind)) throw new WorkflowJournalValidationError('journal entry kind is unknown.');
  rejectUnknownEntryFields(record, record.kind);
  assertNoOversizedStrings(record, 'entry');
  switch (record.kind) {
    case 'workflow.run.started':
      assertRunStarted(record);
      break;
    case 'workflow.agent.started':
      assertAgentStarted(record);
      break;
    case 'workflow.agent.completed':
      assertAgentCompleted(record);
      break;
    case 'workflow.agent.failed':
      assertAgentFailed(record);
      break;
    case 'workflow.run.completed':
      assertRunCompleted(record);
      break;
    case 'workflow.run.failed':
      assertRunFailed(record);
      break;
  }
}

function assertRunStarted(record: Record<string, unknown>): void {
  if (typeof record.workflowName !== 'string' || !record.workflowName) throw new WorkflowJournalValidationError('workflowName must be a string.');
  if (typeof record.workflowSource !== 'string' || !record.workflowSource) throw new WorkflowJournalValidationError('workflowSource must be a string.');
  if (record.workflowSourcePath !== undefined && typeof record.workflowSourcePath !== 'string') throw new WorkflowJournalValidationError('workflowSourcePath must be a string.');
  if (typeof record.scriptPath !== 'string' || !record.scriptPath) throw new WorkflowJournalValidationError('scriptPath must be a string.');
  if (typeof record.scriptHash !== 'string' || !record.scriptHash.startsWith('sha256:')) throw new WorkflowJournalValidationError('scriptHash must start with sha256:.');
  normalizeJournalJsonValue(record.args, 'args');
  const runtime = asRecord(record.runtime);
  if (!runtime || runtime.schemaVersion !== 1 || typeof runtime.cwd !== 'string') {
    throw new WorkflowJournalValidationError('runtime must include schemaVersion 1 and cwd.');
  }
  rejectUnknownKeys(runtime, ['schemaVersion', 'cwd', 'model', 'workspaceFingerprint'], 'runtime');
  if (runtime.model !== undefined && (typeof runtime.model !== 'string' || !runtime.model)) {
    throw new WorkflowJournalValidationError('runtime.model must be a non-empty string.');
  }
  if (runtime.workspaceFingerprint !== undefined && typeof runtime.workspaceFingerprint !== 'string') {
    throw new WorkflowJournalValidationError('runtime.workspaceFingerprint must be a string.');
  }
}

function assertAgentStarted(record: Record<string, unknown>): void {
  assertAgentCommon(record);
  if (!isHash(record.previousAgentCallKey)) throw new WorkflowJournalValidationError('previousAgentCallKey must be sha256 hex.');
  if (typeof record.prompt !== 'string' || record.prompt.trim() === '') throw new WorkflowJournalValidationError('prompt must be a non-empty string.');
  if (record.promptBounded !== undefined && typeof record.promptBounded !== 'boolean') throw new WorkflowJournalValidationError('promptBounded must be a boolean.');
  assertWorkflowAgentSemanticOpts(record.semanticOpts);
}

function assertAgentCompleted(record: Record<string, unknown>): void {
  assertAgentCommon(record);
  normalizeJournalJsonValue(record.result, 'result');
  assertUsage(record.usage);
  if (!isNonNegativeInteger(record.toolCalls)) throw new WorkflowJournalValidationError('toolCalls must be a non-negative integer.');
}

function assertAgentFailed(record: Record<string, unknown>): void {
  assertAgentCommon(record);
  if (typeof record.reason !== 'string' || !record.reason) throw new WorkflowJournalValidationError('reason must be a string.');
  if (typeof record.message !== 'string') throw new WorkflowJournalValidationError('message must be a string.');
}

function assertRunCompleted(record: Record<string, unknown>): void {
  normalizeJournalJsonValue(record.result, 'result');
  if (typeof record.resultPath !== 'string' || !record.resultPath) throw new WorkflowJournalValidationError('resultPath must be a string.');
  if (!isNonNegativeInteger(record.agentCount)) throw new WorkflowJournalValidationError('agentCount must be a non-negative integer.');
  assertUsage(record.usage);
  if (!isNonNegativeInteger(record.toolCalls)) throw new WorkflowJournalValidationError('toolCalls must be a non-negative integer.');
  if (!isNonNegativeNumber(record.durationMs)) throw new WorkflowJournalValidationError('durationMs must be a non-negative finite number.');
}

function assertRunFailed(record: Record<string, unknown>): void {
  if (typeof record.reason !== 'string' || !record.reason) throw new WorkflowJournalValidationError('reason must be a string.');
  if (typeof record.message !== 'string') throw new WorkflowJournalValidationError('message must be a string.');
  if (record.recovery !== undefined) {
    const recovery = asRecord(record.recovery);
    if (!recovery || typeof recovery.retryable !== 'boolean' || typeof recovery.reason !== 'string') {
      throw new WorkflowJournalValidationError('recovery must include retryable and reason.');
    }
  }
  if (!isNonNegativeNumber(record.durationMs)) throw new WorkflowJournalValidationError('durationMs must be a non-negative finite number.');
}

function assertAgentCommon(record: Record<string, unknown>): void {
  if (!isNonNegativeInteger(record.agentIndex)) throw new WorkflowJournalValidationError('agentIndex must be a non-negative integer.');
  if (typeof record.agentId !== 'string' || !record.agentId) throw new WorkflowJournalValidationError('agentId must be a string.');
  if (!isHash(record.agentCallKey)) throw new WorkflowJournalValidationError('agentCallKey must be sha256 hex.');
}

function assertUsage(value: unknown): void {
  const usage = asRecord(value);
  if (!usage) throw new WorkflowJournalValidationError('usage must be an object.');
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    if (!isNonNegativeNumber(usage[key])) throw new WorkflowJournalValidationError(`usage.${key} must be a non-negative finite number.`);
  }
}

function assertWorkflowAgentSemanticOpts(value: unknown): void {
  const opts = asRecord(value);
  if (!opts) throw new WorkflowJournalValidationError('semanticOpts must be an object.');
  rejectUnknownKeys(opts, ['schema', 'model', 'effort', 'isolation', 'agentType', 'logicalKey'], 'semanticOpts');
  if (typeof opts.model !== 'string' || !opts.model) throw new WorkflowJournalValidationError('semanticOpts.model must be a string.');
  for (const key of ['effort', 'isolation', 'agentType', 'logicalKey']) {
    if (opts[key] !== undefined && typeof opts[key] !== 'string') {
      throw new WorkflowJournalValidationError(`semanticOpts.${key} must be a string.`);
    }
  }
  if (opts.schema !== undefined) normalizeJournalJsonValue(opts.schema, 'semanticOpts.schema');
}

function rejectUnknownEntryFields(record: Record<string, unknown>, kind: WorkflowJournalEntry['kind']): void {
  rejectUnknownKeys(record, ENTRY_KEYS[kind], kind);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) throw new WorkflowJournalValidationError(`${label} contains unknown field ${key}.`);
  }
}

function assertNoOversizedStrings(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
      throw new WorkflowJournalValidationError(`${path} exceeds ${MAX_STRING_BYTES} bytes.`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertNoOversizedStrings(item, `${path}[${index}]`);
    return;
  }
  for (const [key, item] of Object.entries(value)) assertNoOversizedStrings(item, `${path}.${key}`);
}

function normalizeJsonValue(value: unknown, label: string, seen: WeakSet<object>): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkflowJournalValidationError(`${label} must not contain NaN or Infinity.`);
    return value;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new WorkflowJournalValidationError(`${label} must be JSON-serializable.`);
  }
  if (typeof value !== 'object') throw new WorkflowJournalValidationError(`${label} must be JSON-serializable.`);
  if (seen.has(value)) throw new WorkflowJournalValidationError(`${label} must not contain cycles.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJsonValue(item, `${label}[${index}]`, seen));
    }
    if (!isPlainJsonObject(value)) {
      throw new WorkflowJournalValidationError(`${label} must be a plain JSON object.`);
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = normalizeJsonValue(item, `${label}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function stableSerialize(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  const objectValue = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(objectValue).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key] as JsonValue)}`).join(',')}}`;
}

function toWorkflowJournalError(err: unknown, message: string): WorkflowJournalError {
  return err instanceof WorkflowJournalError ? err : new WorkflowJournalError(message, err);
}

function isPlainJsonObject(value: object): boolean {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  return Object.getPrototypeOf(prototype) === null;
}

async function ensureWorkflowTranscriptDir(transcriptDir: string): Promise<void> {
  let before: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    before = await lstat(transcriptDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new WorkflowJournalError(`Workflow transcript directory cannot be inspected: ${transcriptDir}.`, err);
  }
  if (before?.isSymbolicLink()) throw new WorkflowJournalError(`Workflow transcript directory must not be a symlink: ${transcriptDir}.`);
  if (before && !before.isDirectory()) throw new WorkflowJournalError(`Workflow transcript path must be a directory: ${transcriptDir}.`);
  if (!before) {
    try {
      await mkdir(transcriptDir, { recursive: true, mode: TRANSCRIPT_DIR_MODE });
    } catch (err) {
      throw new WorkflowJournalError(`Workflow transcript directory cannot be created: ${transcriptDir}.`, err);
    }
  }
  const after = await lstat(transcriptDir);
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new WorkflowJournalError(`Workflow transcript path must be a real directory: ${transcriptDir}.`);
  }
  await chmod(transcriptDir, TRANSCRIPT_DIR_MODE).catch(() => undefined);
}

async function appendJournalLine(
  journalPath: string,
  entry: WorkflowJournalEntry,
  durability: WorkflowJournalDurability | undefined,
): Promise<void> {
  const line = `${JSON.stringify(entry)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let beforeSize: number | undefined;
  try {
    handle = await open(journalPath, fsConstants.O_APPEND | fsConstants.O_WRONLY, JOURNAL_FILE_MODE);
    beforeSize = (await handle.stat()).size;
    await handle.writeFile(line, 'utf8');
    if (durability?.syncFile) {
      await durability.syncFile(journalPath, entry);
    } else if (typeof handle.datasync === 'function') {
      await handle.datasync();
    } else {
      await handle.sync();
    }
  } catch (err) {
    if (handle && beforeSize !== undefined) {
      await handle.truncate(beforeSize).catch(() => undefined);
      await handle.sync().catch(() => undefined);
    }
    throw new WorkflowJournalError(`Workflow journal entry ${entry.kind} could not be durably written.`, err);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function durableDirectorySync(directoryPath: string, durability: WorkflowJournalDurability | undefined): Promise<void> {
  if (durability?.syncDirectory) {
    await durability.syncDirectory(directoryPath);
    return;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await stat(directoryPath);
    handle = await open(directoryPath, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (err) {
    if (isDirectorySyncUnsupported(err)) return;
    throw new WorkflowJournalError(`Workflow journal directory could not be durably synced: ${directoryPath}.`, err);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isDirectorySyncUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EINVAL' || code === 'EISDIR' || code === 'ENOTSUP' || code === 'EPERM' || code === 'EACCES';
}

function isTruncationParseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Unexpected end|unterminated|end of JSON input|Expected ',' or '}' after property value/i.test(message);
}

function isWorkflowJournalKind(value: unknown): value is WorkflowJournalEntry['kind'] {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENTRY_KEYS, value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Head-preview size kept when an audit-only string is bounded. Small (audit convenience only) and
// far under MAX_STRING_BYTES so the surrounding entry can never approach the line cap.
const JOURNAL_AUDIT_PREVIEW_BYTES = 16 * 1024;

// Bound an AUDIT-only journal string (currently an agent prompt) so an oversized value can never make
// an entry exceed MAX_STRING_BYTES and abort an otherwise-healthy run. This is NOT for load-bearing
// strings (results, keys, hashes) — those must stay exact and remain capped. Correctness is preserved:
// the agent receives the full prompt (this only shapes the journaled copy), and resume recomputes the
// agentCallKey from the live prompt, never from this stored text. When truncated, the journal keeps a
// head preview + the full byte length + a sha256 of the full value for audit correlation.
export function boundJournalAuditString(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES) return value;
  const totalBytes = Buffer.byteLength(value, 'utf8');
  const head = Buffer.from(value, 'utf8').subarray(0, JOURNAL_AUDIT_PREVIEW_BYTES).toString('utf8');
  return `${head}\n\n[ultracode: prompt truncated in journal — ${totalBytes} bytes total, sha256=${sha256(value)}; the full prompt was sent to the agent]`;
}
