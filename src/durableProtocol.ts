// DTOs for the Host-owned durable workflow operation API (protocol v1).
import { parseEvent, type Event } from './protocol';

export interface WorkflowStartRequest {
  clientRequestId: string;
  manifest: string;
  manifestSha256: string;
  jobs: number;
  resultsDirectory: string;
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
export function parseOperationReference(input: unknown): OperationReference {
  const v = record(input);
  if (![v.workspaceId, v.operationId, v.clientRequestId, v.kind, v.state, v.manifestBaseDirectory].every(string)
    || !v.operationId || !v.clientRequestId || !hash(v.manifestSha256)) { throw Error('Invalid operation reference'); }
  return v as unknown as OperationReference;
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
