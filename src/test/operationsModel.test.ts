import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extendObservation, observationLabel, parseTrackedOperations, rememberOperation } from '../operationsModel';
import type { Event } from '../protocol';

const one = { operationId: 'a'.repeat(32), clientRequestId: 'request-a', manifest: '/w/one.json', submittedAt: '2026-11-02T01:00:00Z' };
const two = { operationId: 'b'.repeat(32), clientRequestId: 'request-b', manifest: '/w/two.json', submittedAt: '2026-11-02T02:00:00Z' };
const event = (sequence: number): Event => ({ schemaVersion: 1, sequence, timestamp: '2026-11-02T01:00:00Z',
  type: 'node_finished', runDirectory: '/w/out', nodeId: 'build', nodeKind: 'build', status: 'succeeded',
  exitCode: 0, error: null, artifacts: [] });

test('operation index migrates, rejects untrusted malformed entries, orders newest first', () => {
  assert.deepEqual(parseTrackedOperations(undefined), []);
  assert.deepEqual(parseTrackedOperations([one, one, { ...two, operationId: '../bad' }, two]), [one, two]);
  assert.deepEqual(rememberOperation([one, two], one), [one, two]);
  assert.deepEqual(rememberOperation([one], two), [two, one]);
  assert.throws(() => rememberOperation([], { ...one, operationId: '' }), /Invalid/);
});

test('incremental event feed never conflates replay with a checkpoint', () => {
  const first = extendObservation(undefined, [event(1), event(2)], 2, true);
  const next = extendObservation(first, [event(4)], 4, false);
  assert.deepEqual(next.events.map(e => e.sequence), [1, 2, 4]);
  assert.equal(next.hasMore, false);
  assert.throws(() => extendObservation(first, [event(2)], 2, false), /Out-of-order/);
  assert.throws(() => extendObservation(first, [event(3)], 5, false), /Unmatched/);
  assert.throws(() => extendObservation(first, [], 0, false), /Regressed/);
  let current = next;
  for (let i = 5; i <= 180; i++) { current = extendObservation(current, [event(i)], i, false); }
  assert.equal(current.events.length, 100);
  assert.equal(current.events[0].sequence, 81);
});

test('observation labels distinguish unknown from confirmed terminal outcomes', () => {
  assert.equal(observationLabel(undefined), 'not inspected');
  assert.equal(observationLabel({ events: [], nextSequence: 0, hasMore: false, error: 'connection lost' }), 'inspection unavailable');
  const inspection = { operationId: one.operationId, acceptanceState: 'dispatch_authorized', terminalState: null,
    cancellationRequested: true, runDirectory: null, checkpointSha256: null, decision: null, revision: 0, note: null };
  assert.equal(observationLabel({ events: [], nextSequence: 0, hasMore: false, inspection }), 'cancel_requested');
  assert.equal(observationLabel({ events: [], nextSequence: 0, hasMore: false,
    inspection: { ...inspection, cancellationRequested: false, terminalState: 'succeeded' } }), 'succeeded');
});
