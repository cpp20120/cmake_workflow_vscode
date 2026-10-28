import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedulerEvents, parseStacks } from '../profileEvidence';
import { differentialFlamegraph, profileEvidenceHtml, schedulerTimeline } from '../profileVisualization';
const capture = (frames: string[], samples = 100) => parseStacks({ schemaVersion: 1, backend: 'perf', captureId: 'capture_main',
  samples, symbolizedSamples: samples, droppedDistinctStacks: 0,
  stacks: [{ frames, count: samples }] });
test('folded call chains are validated and escaped, including function symbols', () => {
  const before = capture(['main', 'foo<bar>'], 100);
  const after = capture(['main', 'foo<bar>'], 120);
  const html = differentialFlamegraph(before, after);
  assert.ok(html.includes('Differential CPU flamegraph'));
  assert.ok(html.includes('foo&lt;bar&gt;'));
  assert.ok(!html.includes('foo<bar>'));
  assert.throws(() => parseStacks({ schemaVersion: 99, stacks: [] }), /Invalid/);
  assert.throws(() => parseStacks({ schemaVersion: 1, backend: 'perf', captureId: 'x', samples: 1, symbolizedSamples: 1, stacks: [{ frames: ['x'], count: -1 }] }), /Invalid/);
});
test('unsymbolized callchains never produce a fake differential flamegraph', () => {
  const before = parseStacks({ schemaVersion: 1, backend: 'etw', captureId: 'cpu', samples: 20,
    symbolizedSamples: 0, stacks: [{ frames: ['[unknown]'], count: 20 }] });
  assert.match(differentialFlamegraph(before, before), /insufficiently symbolized/);
});
test('scheduler transitions produce bounded thread timelines with clear state semantics', () => {
  const events = parseSchedulerEvents([
    { timestamp: '2026-10-26T12:00:00Z', threadId: 42, state: 'ready', cpu: 2 },
    { timestamp: '2026-10-26T12:00:00.002Z', threadId: 42, state: 'running', cpu: 2 },
    { timestamp: '2026-10-26T12:00:00.003Z', threadId: 42, state: 'offcpu', cpu: 2 },
  ].map(x => JSON.stringify(x)).join('\n'));
  const html = schedulerTimeline({ captureId: 'scheduler', events, truncated: false }, 'Baseline');
  assert.match(html, /sched-running/);
  assert.match(html, /Off-CPU does not imply sleeping/);
  assert.throws(() => parseSchedulerEvents('{"threadId":42,"state":"flying","timestamp":"2026-10-26T12:00:00Z","cpu":2}'), /Invalid/);
  assert.deepEqual(parseSchedulerEvents(''), []);
});
test('pairing evidence requires stable capture identity or a unique backend pair', () => {
  const result = profileEvidenceHtml({ baseline: { stacks: [capture(['main','A'])], scheduler: [], warnings: [] },
    candidate: { stacks: [capture(['main','B'])], scheduler: [], warnings: [] } });
  assert.match(result, /Differential CPU flamegraph/);
});

test('standalone captured before/after stacks render in saved profile results', () => {
  const { presentProfileResults } = require('../profileResults') as typeof import('../profileResults');
  const before = capture(['main', 'Worker::run'], 100);
  const after = capture(['main', 'Worker::run'], 90);
  const view = presentProfileResults('/tmp/profiles/run', {}, {
    stacks: [{ ...before, captureId: 'capture_before' }, { ...after, captureId: 'capture_after' }],
    scheduler: [], warnings: [],
  });
  assert.match(view.body, /Differential CPU flamegraph/);
});
