import { historyEmptyState } from '../historyEmptyState';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyRunFromCommand } from '../historySelection';

test('History row click and context actions accept the run VS Code passes', () => {
  const run = { id: 'abc', directory: '/tmp/run with spaces', status: 'succeeded' };
  assert.equal(historyRunFromCommand(run)?.id, 'abc');
  assert.equal(historyRunFromCommand({ run })?.directory, '/tmp/run with spaces');
  assert.equal(historyRunFromCommand({ label: 'row' }), undefined);
});

test('Empty History explains filters, missing catalogs and observed indexing outcomes', () => {
  const database = '/workspace/history.sqlite';
  const status = { operationId: 'operation', updatedAt: null, diagnosticCode: null, databasePath: database };
  assert.match(historyEmptyState(database, true, false).message, /does not exist/);
  assert.match(historyEmptyState(database, false, true).message, /filters/);
  assert.match(historyEmptyState(database, true, false, { ...status, state: 'disabled' }).message, /disabled/);
  assert.equal(historyEmptyState(database, true, false, { ...status, state: 'failed' }).action, 'cmakeWorkflow.retryHistoryIndex');
  assert.equal(historyEmptyState(database, true, false,
    { ...status, state: 'indexed', databasePath: '/workspace/other.sqlite' }).action, 'cmakeWorkflow.openOperationHistory');
});
