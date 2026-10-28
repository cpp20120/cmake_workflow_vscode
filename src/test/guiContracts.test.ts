import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextHtml, inspectContext, resolvedTargetHtml, toolingPlanHtml, toolingProfiles } from '../inspectionHtml';
import { presentProfileResults } from '../profileResults';
import { parseHistoryDetail } from '../protocol';
import { renderHistoryHtml } from '../historyHtml';

test('tooling doctor displays missing tools without treating ready=false as malformed', () => {
  assert.equal(toolingProfiles({ schemaVersion: 1, profiles: [{ id: 'native', description: 'Native', tools: [] }] })[0].id, 'native');
  const html = toolingPlanHtml({ schemaVersion: 1, platform: 'Linux', packageManager: 'None', ready: false, tools: [{ displayName: 'CMake', installed: false, command: null, version: null, diagnostic: '<missing>' }], steps: [{ tool: 'cmake', method: 'manual', diagnostic: 'install' }] });
  assert.ok(html.includes('Missing tools'));
  assert.ok(html.includes('&lt;missing&gt;'));
  assert.throws(() => toolingProfiles({ schemaVersion: 2, profiles: [] }), /Unsupported/);
});
test('build context and target resolution validate CLI fields and escape names', () => {
  const context = inspectContext({ buildDirectory: '/tmp/build', state: 'Observed', freshness: 'Unverified', presetState: 'Unknown', generator: 'Ninja', sourceDirectory: '/tmp/src', configurations: ['Release'], diagnostics: ['<warn>'], targets: [{ name: 'app', configuration: 'Release', type: 'EXECUTABLE', executable: '/tmp/build/app' }] });
  assert.equal(context.targets[0].name, 'app');
  assert.ok(contextHtml(context).includes('&lt;warn&gt;'));
  assert.ok(resolvedTargetHtml({ schemaVersion: 1, buildDirectory: '/tmp/build', target: 'app', configuration: 'Release', executable: '/tmp/build/app' }).includes('/tmp/build/app'));
  assert.throws(() => resolvedTargetHtml({ schemaVersion: 2 }), /Unsupported/);
});
test('history detail shows CLI environment and build identity', () => {
  const detail = parseHistoryDetail({ run: { id: 'r', directory: '/tmp/r', format: 'workflow', workflow: null, status: 'succeeded', startedAt: null, finishedAt: null, sourceAvailable: true, environment: { cpuModel: 'CPU', architecture: 'x64', logicalProcessors: 8, operatingSystem: 'Linux', kernelVersion: '6.0', affinity: null, governor: null }, buildEnvironments: [{ directory: '/tmp/build', configuration: 'Release', generator: 'Ninja', compilerId: 'Clang', compilerVersion: '20', flags: '-O3' }] }, nodes: [], measurements: [], artifacts: [] });
  const html = renderHistoryHtml(detail, 'nonce');
  assert.ok(html.includes('Host environment'));
  assert.ok(html.includes('Clang 20'));
});
test('profile viewer renders saved comparisons and confines artifact links', () => {
  const view = presentProfileResults('/tmp/run', { 'comparison.json': { schemaVersion: 1, measurement: 'seconds', baseline: 'main', variants: [{ name: '<fast>', count: 3, medianSeconds: 1, ratioToBaseline: 1 }] }, 'analysis.json': [{ captureId: 'cpu', backend: 'perf', mode: 'cpu', eventSource: 'perf', rawTrace: '../outside', report: 'report.txt' }] });
  assert.ok(view.body.includes('&lt;fast&gt;'));
  assert.ok(view.body.includes('Outside run directory'));
  assert.ok(view.artifacts.some(artifact => artifact.path === '/tmp/run/report.txt'));
  assert.ok(!view.artifacts.some(artifact => artifact.path === '/tmp/outside'));
  assert.throws(() => presentProfileResults('/tmp/run', { 'comparison.json': { schemaVersion: 2 } }), /Unsupported/);
});

test('profile viewer displays derived perf signals without claiming timing equivalence', () => {
  const view = presentProfileResults('/tmp/run', { 'counter-comparison.json': { schemaVersion: 1, backend: 'perf stat', baseline: 'o3', comparability: 'same host only', variants: [
    { name: 'o3', events: { cycles: { value: 100, unit: '', ratioToBaseline: 1 } }, derived: { ipc: { value: 2.5, unit: 'instructions/cycle', ratioToBaseline: 1 } } },
  ] } });
  assert.ok(view.body.includes('Derived PMU signals'));
  assert.ok(view.body.includes('instructions/cycle'));
  assert.ok(view.body.includes('IPC and misses'));
});
