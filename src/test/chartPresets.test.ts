import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtInPresets, matchesPreset, parseCustomPresets } from '../chartPresets';
import { parseHarness } from '../dagflowHarness';
import { renderHarnessHtml } from '../harnessHtml';

test('built-in DagFlow presets match actual metric and case names', () => {
  const graph = builtInPresets.find(preset => preset.id === 'dagflow-graph')!;
  assert.equal(matchesPreset(graph, 'run_p50_us', 'steal_heavy-w2-it0-throughput'), true);
  assert.equal(matchesPreset(graph, 'mean_s', 'steal_heavy-w2-it0-throughput'), false);
  assert.equal(matchesPreset(graph, 'run_p50_us', 'unrelated-case'), false);
});
test('custom presets validate source, fields, and duplicate identifiers', () => {
  const preset = { id: 'mine', label: 'My graph', source: 'dagflow', metrics: ['mean_s'], cases: ['chain'] };
  assert.equal(parseCustomPresets([preset])[0].label, 'My graph');
  assert.throws(() => parseCustomPresets([{ ...preset, source: 'other' }]), /Invalid/);
  assert.throws(() => parseCustomPresets([preset, preset]), /Duplicate/);
  assert.throws(() => parseCustomPresets([{ ...preset, id: 'dagflow-all' }]), /Duplicate/);
});
test('DagFlow harness uses saved scaled median and non-warmup successful samples', () => {
  const summary = { status: 'passed', manifest_sha256: 'hash', cases: { chain: { metrics: { mean_s: { scale: 1000000, count: 2, median: 2000000 } } } } };
  const lines = [
    { case: 'chain', warmup: true, result: '0', output: { mean_s: 99 } },
    { case: 'chain', warmup: false, result: '0', output: { mean_s: 1 } },
    { case: 'chain', warmup: false, result: '1', output: { mean_s: 99 } },
    { case: 'chain', warmup: false, result: '0', output: { mean_s: 3 } },
  ].map(row => JSON.stringify(row)).join('\r\n');
  const run = parseHarness(summary, lines);
  const key = JSON.stringify(['chain', 'mean_s']);
  assert.equal(run.metrics.get(key)?.median, 2);
  assert.deepEqual(run.samples.get(key), [1, 3]);
  const html = renderHarnessHtml(run, run, '/tmp/a/summary.json', '/tmp/b/summary.json', builtInPresets.find(preset => preset.id === 'dagflow-api')!, 'nonce');
  assert.ok(html.includes('chain • mean_s'));
  assert.ok(html.includes('Baseline n=2; candidate n=2'));
  assert.throws(() => parseHarness(summary, '{bad'), /Invalid runs.jsonl line 1/);
  assert.throws(() => parseHarness(summary, JSON.stringify({ case: 'chain', warmup: false, result: '0', manifest_sha256: 'other', output: { mean_s: 1 } })), /hash mismatch/);
  const older = parseHarness({ status: 'passed', cases: summary.cases }, JSON.stringify({ case: 'chain', warmup: false, result: '0', output: { mean_s: 1 } }));
  assert.equal(older.manifestHash, null);
  assert.deepEqual(older.samples.get(key), [1]);
});
