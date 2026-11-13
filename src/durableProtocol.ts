// DTOs for the Host-owned durable workflow operation API (protocol v1).
import { parseEvent, parsePlan, type Event, type Plan } from './protocol';

import { parseHistoryPolicy, type HistoryPolicy } from './historyProtocol';

export interface WorkflowPreflightRequest {
  historyPolicy?: HistoryPolicy;
  only?: readonly string[];
  manifest: string;
  manifestSha256: string;
  jobs: number;
  resultsDirectory: string;
}
export interface WorkflowStartRequest extends WorkflowPreflightRequest {
  clientRequestId: string;
}
export interface WorkflowPreflight extends WorkflowPreflightRequest {
  plan: Plan;
}
export interface OperationReference {
  workspaceId: string;
  operationId: string;
  clientRequestId: string;
  kind: string;
  state: string;
  manifestSha256: string;
  manifestBaseDirectory: string;
}
export interface OperationPage {
  schemaVersion: 1;
  items: OperationReference[];
  nextCursor: string | null;
}
export interface OperationArtifact {
  artifactId: string;
  nodeId?: string | null;
  relativePath: string;
  kind: string;
  size: number;
  sha256: string;
  lastWriteUtcTicksText: string;
}
export interface OperationArtifactChunk {
  artifactId: string;
  offset: number;
  totalSize: number;
  lastWriteUtcTicksText: string;
  content: Buffer;
  eof: boolean;
}
export interface RecoveryInspection {
  operationId: string;
  acceptanceState: string;
  terminalState: string | null;
  cancellationRequested: boolean;
  runDirectory: string | null;
  checkpointSha256: string | null;
  decision: string | null;
  revision: number;
  note: string | null;
}
export interface OperationEventsPage {
  operationId: string;
  afterSequence: number;
  nextSequence: number;
  hasMore: boolean;
  events: Event[];
}
export interface OperationCancelResult {
  operationId: string;
  state: string;
  revision: number;
  requested: boolean;
}

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) { throw Error('Invalid Host operation object'); }
  return input as Record<string, unknown>;
}
function string(input: unknown): input is string { return typeof input === 'string'; }
function optional(input: unknown): input is string | null { return input === null || string(input); }
function integer(input: unknown): input is number { return Number.isSafeInteger(input) && (input as number) >= 0; }
function hash(input: unknown): input is string { return string(input) && /^[a-f\d]{64}$/i.test(input); }
export function parseWorkflowPreflight(input: unknown): WorkflowPreflight {
  const v = record(input);
  const { manifest, manifestSha256, jobs, resultsDirectory, only } = v;
  if (!string(manifest) || !hash(manifestSha256) || !integer(jobs) || jobs === 0
    || !string(resultsDirectory) || (only !== null && only !== undefined
      && (!Array.isArray(only) || !only.every(id => string(id) && !!id.trim())))) {
    throw Error('Invalid workflow preflight');
  }
  const plan = parsePlan({ ...v, workflow: manifest, manifestHash: manifestSha256 });
  return { manifest, manifestSha256, jobs, resultsDirectory, only: only ?? undefined, historyPolicy: parseHistoryPolicy(v.historyPolicy), plan };
}
export function parseOperationReference(input: unknown): OperationReference {
  const v = record(input);
  if (![v.workspaceId, v.operationId, v.clientRequestId, v.kind, v.state, v.manifestBaseDirectory].every(string)
    || !v.operationId || !v.clientRequestId || !hash(v.manifestSha256)) { throw Error('Invalid operation reference'); }
  return v as unknown as OperationReference;
}
export function parseOperationPage(input: unknown): OperationPage {
  const v = record(input);
  if (v.schemaVersion !== 1 || !Array.isArray(v.items) || v.items.length > 200 || !optional(v.nextCursor)) {
    throw Error('Invalid Host operations page');
  }
  return { schemaVersion: 1, items: v.items.map(parseOperationReference), nextCursor: v.nextCursor };
}
function timestamp(value: unknown): value is string { return string(value) && /^\d{1,19}$/.test(value); }
export function parseOperationArtifacts(input: unknown, operationId: string): OperationArtifact[] {
  const v = record(input);
  if (v.operationId !== operationId || !hash(v.reportSha256) || !Array.isArray(v.artifacts) || v.artifacts.length > 512) {
    throw Error('Invalid Host artifact catalog');
  }
  return v.artifacts.map(value => {
    const { artifactId, nodeId, relativePath, kind, size, sha256, lastWriteUtcTicksText } = record(value);
    if (!string(artifactId) || !artifactId || !string(relativePath) || !relativePath || !string(kind)
      || (nodeId !== undefined && !optional(nodeId)) || !integer(size) || !hash(sha256) || !timestamp(lastWriteUtcTicksText)) { throw Error('Invalid Host artifact'); }
    return { artifactId, nodeId, relativePath, kind, size, sha256, lastWriteUtcTicksText };
  });
}
export function parseOperationArtifactChunk(input: unknown): OperationArtifactChunk {
  const { artifactId, offset, totalSize, lastWriteUtcTicksText, content, eof } = record(input);
  if (!string(artifactId) || !integer(offset) || !integer(totalSize) || !timestamp(lastWriteUtcTicksText)
    || !string(content) || content.length > 87384 || typeof eof !== 'boolean') { throw Error('Invalid Host artifact chunk'); }
  const bytes = Buffer.from(content, 'base64');
  if (bytes.length > 65536 || bytes.toString('base64') !== content) { throw Error('Invalid Host artifact bytes'); }
  return { artifactId, offset, totalSize, lastWriteUtcTicksText, content: bytes, eof };
}
export function parseRecoveryInspection(input: unknown): RecoveryInspection {
  const v = record(input);
  if (!string(v.operationId) || !v.operationId || !string(v.acceptanceState)
    || ![v.terminalState, v.runDirectory, v.checkpointSha256, v.decision, v.note].every(optional)
    || (v.checkpointSha256 !== null && !hash(v.checkpointSha256))
    || typeof v.cancellationRequested !== 'boolean' || !integer(v.revision)) { throw Error('Invalid recovery inspection'); }
  return v as unknown as RecoveryInspection;
}
export function parseOperationEventsPage(input: unknown): OperationEventsPage {
  const v = record(input);
  if (!string(v.operationId) || !v.operationId || !integer(v.afterSequence) || !integer(v.nextSequence)
    || v.nextSequence < v.afterSequence || typeof v.hasMore !== 'boolean' || !Array.isArray(v.events)
    || v.events.length > 500) { throw Error('Invalid operation events page'); }
  const events = v.events.map(parseEvent);
  let sequence = v.afterSequence as number;
  for (const event of events) {
    if (event.sequence <= sequence) { throw Error('Non-monotonic operation events'); }
    sequence = event.sequence;
  }
  if (sequence !== v.nextSequence || (v.hasMore && events.length === 0)) { throw Error('Invalid operation event cursor'); }
  return { operationId: v.operationId, afterSequence: v.afterSequence, nextSequence: v.nextSequence, hasMore: v.hasMore, events };
}
export function parseOperationCancelResult(input: unknown): OperationCancelResult {
  const v = record(input);
  if (!string(v.operationId) || !v.operationId || !string(v.state) || !integer(v.revision) || typeof v.requested !== 'boolean') {
    throw Error('Invalid operation cancellation result');
  }
  return v as unknown as OperationCancelResult;
}
