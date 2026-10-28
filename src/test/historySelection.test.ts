import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyRunFromCommand } from '../historySelection';

test('History row click and context actions accept the run VS Code passes', () => {
  const run = { id: 'abc', directory: '/tmp/run with spaces', status: 'succeeded' };
  assert.equal(historyRunFromCommand(run)?.id, 'abc');
  assert.equal(historyRunFromCommand({ run })?.directory, '/tmp/run with spaces');
  assert.equal(historyRunFromCommand({ label: 'row' }), undefined);
});
