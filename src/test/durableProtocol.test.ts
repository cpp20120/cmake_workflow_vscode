import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOperationReference, parseRecoveryInspection, parseOperationEventsPage, parseOperationCancelResult } from '../durableProtocol';

const operation = { workspaceId: 'workspace', operationId: 'a'.repeat(32), clientRequestId: 'request-1', kind: 'workflow',
  state: 'accepted_not_dispatched', manifestSha256: 'a'.repeat(64), manifestBaseDirectory: '/workspace' };
const inspection = { operationId: operation.operationId, acceptanceState: 'accepted_not_dispatched', terminalState: null,
  cancellationRequested: false, runDirectory: null, checkpointSha256: null, decision: null, revision: 0, note: null };
const event = { schemaVersion: 1, sequence: 1, timestamp: '2026-11-02T00:00:00Z', type: 'workflow_started',
  runDirectory: '/workspace/out/results/host-1', nodeId: null, nodeKind: null, status: 'running', exitCode: null, error: null, artifacts: [] };

test('durable Host protocol validates IDs, state, and cancellation CAS result', () => {
  assert.equal(parseOperationReference(operation).operationId, operation.operationId);
  assert.throws(() => parseOperationReference({ ...operation, manifestSha256: 'stale' }), /Invalid/);
  assert.equal(parseRecoveryInspection(inspection).revision, 0);
  assert.throws(() => parseRecoveryInspection({ ...inspection, cancellationRequested: 'yes' }), /Invalid/);
  assert.deepEqual(parseOperationCancelResult({ operationId: operation.operationId, state: 'cancel_requested', revision: 1, requested: true }),
    { operationId: operation.operationId, state: 'cancel_requested', revision: 1, requested: true });
  assert.throws(() => parseOperationCancelResult({ operationId: 'x', state: 'x', revision: -1, requested: true }), /Invalid/);
});

test('durable event paging rejects invalid cursors and non-monotonic progress', () => {
  const page = { operationId: operation.operationId, afterSequence: 0, nextSequence: 1, hasMore: true, events: [event] };
  assert.equal(parseOperationEventsPage(page).events[0].type, 'workflow_started');
  assert.throws(() => parseOperationEventsPage({ ...page, nextSequence: 2 }), /cursor/);
  assert.throws(() => parseOperationEventsPage({ ...page, events: [event, event] }), /Non-monotonic/);
  assert.throws(() => parseOperationEventsPage({ ...page, afterSequence: -1 }), /Invalid/);
  assert.throws(() => parseOperationEventsPage({ ...page, events: [], nextSequence: 0 }), /cursor/);
});
