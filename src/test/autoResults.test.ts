import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { automaticBaselines, hasCompatibleMeasurements } from '../autoResults';
import type { HistoryRun, HistoryDifference } from '../protocol';

function run(id: string, workflow: string, startedAt: string): HistoryRun {
  return { id, directory: '/results/' + id, format: 'workflow', workflow, startedAt,
    finishedAt: startedAt, status: 'succeeded', sourceAvailable: true };
}
test('automatic baseline chooses prior successful runs of same workflow, newest first', () => {
  const current = run('current', '/project/bench.json', '2026-10-28T10:00:00Z');
  const older = run('older', current.workflow!, '2026-10-26T10:00:00Z');
  const latest = run('latest', current.workflow!, '2026-10-27T10:00:00Z');
  const different = run('different', '/project/other.json', '2026-10-27T12:00:00Z');
  const future = run('future', current.workflow!, '2026-10-29T10:00:00Z');
  const failed = { ...run('failed', current.workflow!, '2026-10-27T15:00:00Z'), status: 'failed' };
  assert.deepEqual(automaticBaselines([older, latest, current, different, future, failed], current)
    .map(x => x.id), ['latest','older']);
  assert.deepEqual(automaticBaselines([older, latest, current], current, 'older').map(x => x.id), ['older']);
  assert.deepEqual(automaticBaselines([older, latest, current], current, 'missing'), []);
});
test('no baseline can be assumed from an unverified or missing comparison', () => {
  const make = (status: string, count: number): HistoryDifference => ({ metric:'run_p50_us',
    unit:'us', variant:null, scenario:'chain', method:'dagflow-harness', status, reason:null,
    baseline: count ? {count, median:2, min:2, max:2, mean:2, standardDeviation:0} : null,
    candidate: count ? {count, median:2, min:2, max:2, mean:2, standardDeviation:0} : null,
    absoluteChange:null, percentChange:null });
  assert.equal(hasCompatibleMeasurements([make('incompatible', 10)]), false);
  assert.equal(hasCompatibleMeasurements([make('compatible', 0)]), false);
  assert.equal(hasCompatibleMeasurements([make('compatible', 10)]), true);
  assert.equal(hasCompatibleMeasurements([make('compatible', 10)], 'dagflow-harness'), true);
  assert.equal(hasCompatibleMeasurements([make('compatible', 10)], 'other-method'), false);
});
