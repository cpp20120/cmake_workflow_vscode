import type { OperationNode } from './operationDetails';
import type { RecoveryInspection } from './durableProtocol';
import type { Event } from './protocol';

// This is a local UI index, not the Host's authoritative operation database.
// Deliberately store only identifiers and user-visible labels; all status is observed.
export interface TrackedOperation {
  operationId: string;
  clientRequestId: string;
  manifest: string;
  submittedAt: string;
}
export interface OperationObservation {
  inspection?: RecoveryInspection;
  events: Event[];
  liveNodes?: ReadonlyMap<string, OperationNode>;
  nextSequence: number;
  hasMore: boolean;
  error?: string;
  refreshedAt?: string;
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{32}$/i.test(value);
export function parseTrackedOperations(value: unknown): TrackedOperation[] {
  if (!Array.isArray(value)) { return []; }
  const seen = new Set<string>();
  const result: TrackedOperation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { continue; }
    const record = raw as Record<string, unknown>;
    if (!validId(record.operationId) || typeof record.clientRequestId !== 'string' || !record.clientRequestId
      || typeof record.manifest !== 'string' || typeof record.submittedAt !== 'string'
      || seen.has(record.operationId)) { continue; }
    seen.add(record.operationId);
    result.push(record as unknown as TrackedOperation);
    if (result.length >= 100) { break; }
  }
  return result;
}
export function rememberOperation(previous: readonly TrackedOperation[], entry: TrackedOperation): TrackedOperation[] {
  if (!validId(entry.operationId) || !entry.clientRequestId) { throw Error('Invalid tracked operation'); }
  return [entry, ...previous.filter(p => p.operationId !== entry.operationId)].slice(0, 100);
}
export function extendObservation(previous: OperationObservation | undefined, incoming: readonly Event[],
  nextSequence: number, hasMore: boolean): OperationObservation {
  const last = previous?.nextSequence ?? 0;
  if (!Number.isSafeInteger(nextSequence) || nextSequence < last) { throw Error('Regressed operation event cursor'); }
  let cursor = last;
  for (const event of incoming) {
    if (event.sequence <= cursor || event.sequence > nextSequence) { throw Error('Out-of-order operation event'); }
    cursor = event.sequence;
  }
  if (cursor !== nextSequence) { throw Error('Unmatched operation event cursor'); }
  const liveNodes = new Map(previous?.liveNodes);
  for (const event of incoming) {
    if (!event.nodeId || !event.status) { continue; }
    const before = liveNodes.get(event.nodeId);
    liveNodes.set(event.nodeId, {
      id: event.nodeId, kind: event.nodeKind ?? before?.kind ?? 'node', status: event.status,
      dependencies: [], startedAt: event.type === 'node_started' ? event.timestamp : before?.startedAt ?? null,
      finishedAt: event.type === 'node_finished' ? event.timestamp : null,
      error: event.error, exitCode: event.exitCode,
      stdout: event.artifacts.find(item => item.type === 'stdout')?.path ?? before?.stdout ?? null,
      stderr: event.artifacts.find(item => item.type === 'stderr')?.path ?? before?.stderr ?? null,
    });
  }
  return { ...previous, liveNodes, events: [...(previous?.events ?? []), ...incoming].slice(-100),
    nextSequence, hasMore, refreshedAt: new Date().toISOString() };
}
export function observationLabel(value: OperationObservation | undefined): string {
  if (!value) { return 'not inspected'; }
  if (value.error) { return 'inspection unavailable'; }
  const inspection = value.inspection;
  if (!inspection) { return 'not inspected'; }
  return inspection.terminalState ?? (inspection.cancellationRequested ? 'cancel_requested'
    : inspection.decision ?? inspection.acceptanceState);
}
