import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { parseProgramArguments, profileReplayArguments, profileResultDirectory, profileRunArguments, replayChoices } from '../profileActions';
import { executeProfile } from '../profileExecution';
import type { CliResult } from '../cli';
import type { HistoryDetail } from '../protocol';

test('profile arguments preserve whitespace, literal shell tokens and history option boundary', () => {
  const argv = parseProgramArguments('["two words", "$(echo nope)", "--history-db", "C:\\\\data files\\\\x", ""]');
  const args = profileRunArguments({ build: '/build tree', target: 'bench', configuration: 'Release',
    backend: 'auto', mode: 'diagnostic', repeats: 3, timeout: 30, results: '/saved results', argv }, '/history db');
  assert.equal(args[args.indexOf('--build-dir') + 1], '/build tree');
  assert.equal(args[args.indexOf('--history-db') + 1], '/history db');
  assert.deepEqual(args.slice(args.indexOf('--') + 1), argv);
  for (const invalid of ['bad', '{}', '[1]', '[null]', '["\\u0000"]']) { assert.throws(() => parseProgramArguments(invalid)); }
});

function detail(): HistoryDetail {
  return { run: { id: 'id', directory: '/run', format: 'workflow', workflow: null, status: 'succeeded',
    startedAt: null, finishedAt: null, sourceAvailable: true }, artifacts: [],
  nodes: ['run', 'invoke', 'build'].map(kind => ({ id: kind, kind, status: 'succeeded', target: null, durationSeconds: 1 })),
  measurements: [{ nodeId: 'invoke', metric: 'latency', unit: 'us', value: 1, variant: 'harness-2',
    scenario: 'chain-4', method: 'dagflow-harness', sampleIndex: 0 }] };
}

test('replay offers common run nodes and deduplicated shared harness cases only', () => {
  const before = detail(), after = detail();
  after.measurements.push({ ...after.measurements[0], metric: 'throughput' });
  assert.deepEqual(replayChoices(before, after), [{ node: 'run' }, { node: 'invoke', caseName: 'chain-4', harness: 2 }]);
  after.measurements[0] = { ...after.measurements[0], scenario: 'unknown' };
  after.measurements.pop();
  assert.deepEqual(replayChoices(before, after), [{ node: 'run' }]);
  before.run.sourceAvailable = false;
  assert.deepEqual(replayChoices(before, after), []);
});

test('replay does not accept malformed harness indexes or changed node kinds', () => {
  const before = detail(), after = detail();
  before.nodes[0].kind = 'build';
  for (const variant of ['harness-nope', 'harness-1001', 'harness--1']) {
    before.measurements[0].variant = after.measurements[0].variant = variant;
    assert.deepEqual(replayChoices(before, after), []);
  }
});

test('replay parameters include exact saved directories and selected harness', () => {
  assert.deepEqual(profileReplayArguments('/base line', '/candidate', { node: 'api', caseName: 'chain-4', harness: 2 },
    'perf', 60, '/results', '/db'), ['profile', 'replay', '/base line', '/candidate', '--node', 'api',
    '--backend', 'perf', '--timeout-seconds', '60', '--results-dir', '/results',
    '--case', 'chain-4', '--harness', '2', '--history-db', '/db']);
});

test('profile completion uses explicit CLI paths, never guesses a directory', () => {
  const directory = path.resolve('saved runs');
  assert.equal(profileResultDirectory(`Profile analysis: ${path.join(directory, 'analysis.json')}`), directory);
  assert.equal(profileResultDirectory(`Profile replay: ${directory}`), directory);
  for (const line of ['run succeeded', 'Profile replay: relative', 'Profile analysis: /tmp/wrong.json']) {
    assert.equal(profileResultDirectory(line), undefined);
  }
});

const success: CliResult = { stdout: '', stderr: '', code: 0, signal: null };
function cancellation() {
  let listener: (() => void) | undefined;
  return { isCancellationRequested: false, disposed: false,
    onCancellationRequested(callback: () => void) { listener = callback; return { dispose: () => { this.disposed = true; listener = undefined; } }; },
    cancel() { this.isCancellationRequested = true; listener?.(); } };
}

test('failed or truncated profiles never open a directory even when a marker was emitted', async () => {
  for (const result of [ { ...success, code: 1, stderr: 'capture failed' },
    { ...success, code: null, signal: 'SIGTERM' as const },
    { ...success, spawnError: Error('ENOENT') }, { ...success, outputError: Error('truncated') } ]) {
    const token = cancellation();
    await assert.rejects(executeProfile({ cancel() {}, async run(_args, onLine) {
      onLine?.(`Profile replay: ${path.resolve('results')}`); return result;
    } }, ['profile', 'replay'], token, () => {}));
    assert.equal(token.disposed, true);
  }
});

test('cancellation propagates to the client and disposes its listener', async () => {
  const token = cancellation(); let canceled = false;
  const directory = await executeProfile({ cancel() { canceled = true; }, async run() {
    token.cancel(); return success;
  } }, ['profile', 'run'], token, () => {}, '/saved');
  assert.equal(directory, undefined); assert.equal(canceled, true); assert.equal(token.disposed, true);
  let launched = false;
  await executeProfile({ cancel() {}, async run() { launched = true; return success; } }, [], token, () => {});
  assert.equal(launched, false);
});

test('successful profile and analyze open reported or explicitly selected results', async () => {
  const directory = path.resolve('results');
  const token = cancellation();
  assert.equal(await executeProfile({ cancel() {}, async run(_args, onLine) {
    onLine?.(`Profile analysis: ${path.join(directory, 'analysis.json')}`); return success;
  } }, ['profile', 'run'], token, () => {}), directory);
  assert.equal(token.disposed, true);
  assert.equal(await executeProfile({ cancel() {}, async run() { return success; } },
    ['profile', 'analyze', directory], cancellation(), () => {}, directory), directory);
  await assert.rejects(executeProfile({ cancel() {}, async run() { return success; } },
    ['profile', 'run'], cancellation(), () => {}), /without a result directory/);
});
