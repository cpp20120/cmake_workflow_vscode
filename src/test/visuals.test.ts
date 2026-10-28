import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, type HistoryDetail } from '../protocol';
import { durationBreakdownHtml, failuresHtml, planGraphHtml, reportGraphHtml, timelineHtml } from '../runVisuals';
import { parseTrendSamples, renderTrendHtml, trendIdentity } from '../historyTrend';
import { comparisonChart, environmentComparisonHtml } from '../comparisonHtml';
import { harnessMatrixHtml } from '../harnessHtml';
import { parseHarness } from '../dagflowHarness';
import { renderHistoryHtml } from '../historyHtml';

const report = parseReport({ schemaVersion: 1, workflow: 'w', status: 'failed', error: 'bad', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:03Z', nodes: [
  { id: 'build', kind: 'build', status: 'succeeded', dependencies: [], startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', durationSeconds: 1, target: 'app', stdout: null, stderr: null, error: null, exitCode: 0 },
  { id: '<test>', kind: 'ctest', status: 'failed', dependencies: ['build'], startedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:00:03Z', durationSeconds: 2, target: null, stdout: null, stderr: null, error: '<oops>', exitCode: 1 },
] });
test('saved workflow timeline, dependency arrows and failure log actions use report state', () => {
  assert.ok(timelineHtml(report).includes('2 s'));
  assert.ok(timelineHtml(report).includes('&lt;test&gt;'));
  assert.ok(reportGraphHtml(report).includes('dependency-arrow'));
  assert.ok(planGraphHtml({ schemaVersion: 1, workflow: 'w', manifestHash: 'h', valid: false, nodes: [{ id: '<bad>', kind: 'build', target: '', buildDirectory: '', configuration: null, dependencies: [], observedState: 'Unknown', diagnostics: [{ severity: 'Error', message: '<invalid>' }], resources: [], exclusive: false }] }).includes('&lt;invalid&gt;'));
  const failure = failuresHtml(report, [{ nodeId: '<test>', type: 'stderr', path: '/tmp/log', available: true }]);
  assert.ok(failure.includes('data-artifact-index="0"'));
  assert.ok(failure.includes('&lt;oops&gt;'));
  const detail = { run: { id: 'r', workflow: 'w', directory: '/tmp/r', format: 'workflow', status: 'failed', startedAt: null, finishedAt: null, sourceAvailable: true }, nodes: [], measurements: [], artifacts: [{ nodeId: '<test>', type: 'stderr', path: '/tmp/log', available: true }] } as HistoryDetail;
  const page = renderHistoryHtml(detail, 'nonce', undefined, report);
  assert.ok(page.includes('Execution timeline'));
  assert.ok(page.includes('Problems and logs'));
});
test('history trend plots raw samples from dated runs without aggregating a verdict', () => {
  const samples = parseTrendSamples([{ runId: 'a', metric: 'time', unit: 's', value: 1, variant: null, scenario: null, method: 'wall', sampleIndex: 0 }, { runId: 'b', metric: 'time', unit: 's', value: 2, variant: null, scenario: null, method: 'wall', sampleIndex: 0 }]);
  const runs = [{ id: 'a', startedAt: '2026-01-01T00:00:00Z', status: 'succeeded' }, { id: 'b', startedAt: '2026-01-02T00:00:00Z', status: 'failed' }] as HistoryDetail['run'][];
  const html = renderTrendHtml(runs, samples, trendIdentity(samples[0]));
  assert.ok(html.includes('2 runs • 2 raw samples'));
  assert.ok(html.includes('class="failed"'));
  assert.throws(() => parseTrendSamples([{ ...samples[0], value: '1' }]), /Invalid/);
});
test('environment comparison marks only recorded differences', () => {
  const base = { run: { environment: { cpuModel: 'A', architecture: 'x64', logicalProcessors: 8, operatingSystem: 'Linux', kernelVersion: '1', affinity: null, governor: null }, buildEnvironments: [] } } as unknown as HistoryDetail;
  const candidate = { run: { environment: { ...base.run.environment, cpuModel: 'B' }, buildEnvironments: [] } } as unknown as HistoryDetail;
  assert.ok(environmentComparisonHtml(base, candidate).includes('class="changed"'));
});
test('DagFlow matrix shows descriptive median changes and mismatched campaigns', () => {
  const summary = (caseName: string, median: number) => ({ status: 'passed', manifest_sha256: 'h', cases: { [caseName]: { metrics: { mean_s: { scale: 1000000, count: 1, median } } } } });
  const a = parseHarness(summary('chain', 1000000), ''), b = parseHarness(summary('chain', 2000000), '');
  const key = JSON.stringify(['chain', 'mean_s']);
  assert.ok(harnessMatrixHtml(a, b, [key]).includes('+100%'));
  assert.ok(harnessMatrixHtml(a, b, [key]).includes('href="#chart-0"'));
  const other = parseHarness(summary('steal', 2000000), '');
  assert.ok(harnessMatrixHtml(a, other, [key, JSON.stringify(['steal', 'mean_s'])]).includes('No common case/metric pairs'));
});

test('long invoke durations have a separate labelled logarithmic breakdown', () => {
  const html = durationBreakdownHtml(parseReport({schemaVersion:1, workflow:'w',status:'succeeded',error:null, nodes:[
    {id:'configure',kind:'configure',status:'succeeded',dependencies:[],durationSeconds:.49,error:null,exitCode:0,stdout:null,stderr:null},
    {id:'api',kind:'invoke',status:'succeeded',dependencies:['configure'],durationSeconds:540,error:null,exitCode:0,stdout:null,stderr:null},
  ]}));
  assert.ok(html.includes('log1p scale'));
  assert.ok(html.includes('540 s'));
  assert.ok(html.includes('0.49 s'));
});
test('comparison visualizations preserve full-range outliers and show focused distribution plus ECDF', () => {
  const values = [2.6,2.7,2.72,2.73,2.74,2.75,2.78,2.8,2.9,6.31];
  const make = (number: number) => ({runId:'a',nodeId:null,metric:'wall',unit:'s',value:number,variant:null,scenario:null,method:'wall',sampleIndex:values.indexOf(number)});
  const row = {metric:'wall',unit:'s',variant:null,scenario:null,method:'wall',status:'compatible',reason:null,baseline:{count:10,median:2.745,min:2.6,max:6.31,mean:3,standardDeviation:1},candidate:null,absoluteChange:null,percentChange:null};
  const html = comparisonChart(row, values.map(make), [], 'CLI');
  assert.ok(html.includes('Focus on central distribution'));
  assert.ok(html.includes('ECDF'));
  assert.ok(html.includes('6.31'));
  assert.ok(html.includes('outside focus'));
});

test('profile ratios are log-symmetric, incompatible captures are not fabricated and links stay indexed', () => {
  const { profileSignalCharts, profileArtifactLinks, renderComparisonHtml } = require('../comparisonHtml') as typeof import('../comparisonHtml');
  const stats = (median: number) => ({ count: 1, median, min: median, max: median, mean: median, standardDeviation: 0 });
  const row = { metric: 'ipc', unit: 'instructions/cycle', variant: 'o3', scenario: null, method: 'perf stat derived', status: 'compatible', reason: null, baseline: stats(2.0), candidate: stats(1.0), absoluteChange: -1, percentChange: -50 };
  const blocked = { ...row, metric: '<sched>', method: 'ETW target window', status: 'incompatible', reason: 'host differs', candidate: null, percentChange: null };
  const signal = profileSignalCharts([row, blocked]);
  assert.ok(signal.includes('0.5x'));
  assert.ok(signal.includes('log₂'));
  assert.ok(signal.includes('host differs'));
  assert.ok(signal.includes('&lt;sched&gt;'));
  assert.ok(!signal.includes('<sched>'));
  const detail = { run: { id: 'a', workflow: 'w', directory: '/tmp/run', format: 'workflow', status: 'succeeded', startedAt: null, finishedAt: null, sourceAvailable: true }, nodes: [], measurements: [], artifacts: [
    { nodeId: 'profile', type: 'trace', path: '/tmp/run/traces/raw/perf.data', available: true },
    { nodeId: 'profile', type: 'executable', path: '/bin/sh', available: true },
  ] } as HistoryDetail;
  const links = profileArtifactLinks(detail, detail);
  assert.ok(links.includes('data-profile-side="baseline"'));
  assert.ok(links.includes('data-profile-index="0"'));
  assert.ok(!links.includes('/bin/sh'));
  const page = renderComparisonHtml(detail, detail, [row, blocked], 'nonce');
  assert.ok(page.includes('openProfileArtifact'));
  assert.ok(page.includes("script-src 'nonce-nonce'"));
});
