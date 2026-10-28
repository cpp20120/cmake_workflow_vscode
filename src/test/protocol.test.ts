import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonlParser, EventSequence, parseEvent, parsePlan, parseReport, parseHistoryComparison, parseHistoryDetection, parseHistoryDetail } from '../protocol';
import { measurementGroups, renderHistoryHtml, sampleChart } from '../historyHtml';
import { comparisonChart, renderComparisonHtml } from '../comparisonHtml';
import { CliClient } from '../cli';
import { configuredJobs, resolveHistoryDatabase } from '../settings';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

const raw = (sequence: number, status = 'running') => ({ schemaVersion: 1, sequence, timestamp: '2026-01-01T00:00:00Z', type: sequence === 1 ? 'workflow_started' : 'node_finished', runDirectory: '/tmp/a b', nodeId: sequence === 1 ? null : 'a', nodeKind: sequence === 1 ? null : 'build', status, exitCode: null, error: null, artifacts: [] });
test('JSONL handles byte splits, multiple lines, CRLF and final line', () => { const lines: string[] = []; const parser = new JsonlParser(line => lines.push(line)); const input = `${JSON.stringify(raw(1))}\r\n${JSON.stringify(raw(2))}\n${JSON.stringify(raw(3))}`; for (const byte of Buffer.from(input)) { parser.push(Buffer.from([byte])); } parser.finish(); assert.equal(lines.length, 3); assert.deepEqual(lines.map(line => parseEvent(JSON.parse(line)).sequence), [1, 2, 3]); });
test('rejects invalid JSON and schema version', () => { assert.throws(() => parseEvent(JSON.parse('{')), SyntaxError); assert.throws(() => parseEvent({ ...raw(1), schemaVersion: 2 }), /Unsupported schemaVersion/); });
test('reorders events and detects gaps and duplicates', () => { const seen: number[] = []; const events = new EventSequence(event => seen.push(event.sequence)); events.push(parseEvent(raw(2))); events.push(parseEvent(raw(1))); assert.deepEqual(seen, [1, 2]); assert.throws(() => events.push(parseEvent(raw(2))), /Duplicate/); const gap = new EventSequence(() => {}); gap.push(parseEvent(raw(3))); assert.throws(() => gap.finish(), /Missing/); });
test('validates plan validity and report node statuses', () => { const plan = parsePlan({ schemaVersion: 1, workflow: 'w', manifestHash: 'h', valid: false, nodes: [] }); assert.equal(plan.valid, false); const report = parseReport({ schemaVersion: 1, workflow: 'w', status: 'failed', error: null, nodes: ['failed','blocked','canceled'].map((status, id) => ({ id: String(id), kind: 'build', status, stdout: null, stderr: null, error: null, exitCode: null })) }); assert.deepEqual(report.nodes.map(n => n.status), ['failed','blocked','canceled']); });
function fakeChild(): ChildProcessWithoutNullStreams { const child = new EventEmitter() as ChildProcessWithoutNullStreams; Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); return child; }
test('process adapter passes whitespace paths and captures nonzero exit', async () => { const child = fakeChild(); const cli = new CliClient({ executable: '/path with spaces/CMakeWorkflow', prefixArgs: ['prefix arg'], cwd: '/workspace with spaces' }, (exe, args, options) => { assert.equal(exe, '/path with spaces/CMakeWorkflow'); assert.deepEqual(args, ['prefix arg', '/tmp/path with spaces']); assert.equal(options.shell, false); assert.equal(options.cwd, '/workspace with spaces'); queueMicrotask(() => { (child.stdout as PassThrough).write('output'); (child.stderr as PassThrough).write('diagnostic'); child.emit('close', 7, null); }); return child; }); const result = await cli.run(['/tmp/path with spaces']); assert.equal(result.stdout, 'output'); assert.equal(result.stderr, 'diagnostic'); assert.equal(result.code, 7); cli.dispose(); });
test('process adapter reports missing executable', async () => { const child = fakeChild(); const cli = new CliClient({ executable: '/missing/CMakeWorkflow', prefixArgs: [], cwd: process.cwd() }, () => { queueMicrotask(() => { child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); child.emit('close', -2, null); }); return child; }); const result = await cli.run([]); assert.equal((result.spawnError as NodeJS.ErrnoException)?.code, 'ENOENT'); cli.dispose(); });
test('process adapter bounds large JSON output', async () => { const child = fakeChild(); const cli = new CliClient({ executable: 'CMakeWorkflow', prefixArgs: [], cwd: process.cwd() }, () => { queueMicrotask(() => { (child.stdout as PassThrough).write(Buffer.alloc(33 * 1024 * 1024)); child.emit('close', null, 'SIGTERM'); }); return child; }); const result = await cli.run(['history','query']); assert.match(result.outputError?.message ?? '', /32 MB limit/); cli.dispose(); });
test('optional jobs ignores schema default but validates configured values', () => { assert.equal(configuredJobs({ defaultValue: 0 }), undefined); assert.equal(configuredJobs({ globalValue: 2, workspaceValue: 3, workspaceFolderValue: 4 }), 4); assert.throws(() => configuredJobs({ workspaceValue: 0 }), /positive integer/); });
test('history database resolves relative paths with spaces', () => { assert.equal(resolveHistoryDatabase(path.resolve('workspace with spaces'), 'out/history.sqlite'), path.resolve('workspace with spaces', 'out/history.sqlite')); assert.equal(resolveHistoryDatabase(path.resolve('workspace'), '  '), undefined); });
const difference = { metric: 'process_wall_time', unit: 'seconds', variant: null, scenario: null, method: 'wall-clock', status: 'compatible', reason: null, baseline: { count: 10, median: 2, min: 1, max: 3, mean: 2, standardDeviation: 0.5 }, candidate: { count: 10, median: 2.2, min: 1.2, max: 3.2, mean: 2.2, standardDeviation: 0.5 }, absoluteChange: 0.2, percentChange: 10 };
test('history comparison validates descriptive samples and diagnostics', () => { const rows = parseHistoryComparison([difference, { ...difference, status: 'unverified', reason: 'host changed', baseline: null, candidate: null, absoluteChange: null, percentChange: null }]); assert.equal(rows[0].baseline?.count, 10); assert.equal(rows[1].reason, 'host changed'); assert.throws(() => parseHistoryComparison([{ ...difference, percentChange: '10' }]), /Invalid absolute change|Invalid percent change/); });
test('history detection validates schema and statistical fields', () => { const report = parseHistoryDetection({ schemaVersion: 1, baselineRun: 'a', candidateRun: 'b', metric: 'process_wall_time', direction: 'higher-worse', minimumEffectPercent: 5, alpha: 0.05, test: 'permutation', results: [{ ...difference, status: 'regression', reason: 'effect passed', pValue: 0.001, adjustedPValue: 0.002, permutations: 9999, exact: false }] }); assert.equal(report.results[0].adjustedPValue, 0.002); assert.throws(() => parseHistoryDetection({ ...report, schemaVersion: 2 }), /Unsupported schemaVersion/); });
test('run detail parses measurements and escapes CLI text in HTML', () => { const detail = parseHistoryDetail({ run: { id: 'id', directory: '/tmp/run', format: 'workflow', workflow: '<script>alert(1)</script>', status: 'succeeded', startedAt: null, finishedAt: null, sourceAvailable: true }, nodes: [{ id: '<img src=x>', kind: 'run', status: 'succeeded', durationSeconds: 1.2, target: null }], measurements: [{ nodeId: null, metric: 'latency', unit: 'ms', value: 3.5, variant: null, scenario: null, method: 'wall', sampleIndex: 0 }], artifacts: [{ type: 'stdout', path: '/tmp/<unsafe>', available: true }] }); const html = renderHistoryHtml(detail, 'nonce'); assert.equal(detail.measurements[0].value, 3.5); assert.equal(measurementGroups(detail.measurements).length, 1); assert.ok(html.includes('&lt;img src=x&gt;')); assert.ok(html.includes('/tmp/&lt;unsafe&gt;')); assert.ok(!html.includes('<img src=x>')); assert.ok(html.includes('<svg')); });
test('chart limits rendered sample points', () => { const samples = Array.from({ length: 1000 }, (_, sampleIndex) => ({ nodeId: null, metric: 'm', unit: '', value: sampleIndex, variant: null, scenario: null, method: 'test', sampleIndex })); const svg = sampleChart(samples); assert.ok(svg.includes('of 1000 samples plotted')); assert.ok((svg.match(/<circle /g) ?? []).length < 500); });
test('comparison chart uses CLI medians and escaped labels', () => { const detail = parseHistoryDetail({ run: { id: 'one', directory: '/tmp/one', format: 'workflow', workflow: '<bad>', status: 'succeeded', startedAt: null, finishedAt: null, sourceAvailable: true }, nodes: [], measurements: [{ nodeId: null, metric: 'process_wall_time', unit: 'seconds', value: 2, variant: null, scenario: null, method: 'wall-clock', sampleIndex: 0 }], artifacts: [] }); const row = parseHistoryComparison([difference])[0]; const chart = comparisonChart(row, detail.measurements, detail.measurements); const html = renderComparisonHtml(detail, detail, [row], 'nonce'); assert.ok(chart.includes('Baseline n=1; candidate n=1')); assert.ok(html.includes('&lt;bad&gt;')); assert.ok(!html.includes('<bad>')); assert.ok(html.includes('10%')); });
test('run detail explicitly shows absence of indexed measurements', () => { const detail = parseHistoryDetail({ run: { id: 'one', directory: '/tmp/one', format: 'workflow', workflow: null, status: 'succeeded', startedAt: null, finishedAt: null, sourceAvailable: true }, nodes: [], measurements: [], artifacts: [] }); assert.ok(renderHistoryHtml(detail, 'nonce').includes('No indexed measurements for this run')); const missing = parseHistoryComparison([{ ...difference, metric: '*', unit: '', method: '', status: 'missing', reason: 'Neither run contains indexed measurements.', baseline: null, candidate: null, absoluteChange: null, percentChange: null }]); assert.ok(renderComparisonHtml(detail, detail, missing, 'nonce').includes('No indexed measurements to plot for this pair')); });

test('CLI cancellation gives a cooperative process time to persist canceled state', { skip: process.platform === 'win32' }, async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cmw-cli-cancel-'));
  const script = path.join(tmp, 'child.cjs');
  const marker = path.join(tmp, 'ready');
  const report = path.join(tmp, 'canceled');
  try {
    await fs.writeFile(script, `const fs=require('fs');
      fs.writeFileSync(process.argv[2], 'ready');
      process.on('SIGINT', ()=>{ fs.writeFileSync(process.argv[3], 'canceled'); process.exit(130); });
      setInterval(()=>{},1000);
    `);
    const client = new CliClient({ executable: process.execPath, prefixArgs: [script], cwd: tmp });
    const pending = client.run([marker, report]);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.stat(marker); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 15)); }
    }
    assert.ok(ready, 'test CLI did not start');
    client.cancel();
    const result = await pending;
    assert.equal(result.code, 130);
    assert.equal(await fs.readFile(report, 'utf8'), 'canceled');
    client.dispose();
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('JSONL parser bounds incomplete events rather than retaining unbounded output', () => {
  const parser = new JsonlParser(() => {});
  assert.throws(() => parser.push(Buffer.alloc(8 * 1024 * 1024 + 1, 65)), /8 MiB/);
});
test('process adapter bounds diagnostic stderr while preserving the tail', async () => {
  const child = fakeChild();
  const cli = new CliClient({ executable: 'cli', prefixArgs: [], cwd: process.cwd() }, () => {
    queueMicrotask(() => {
      (child.stderr as PassThrough).write(Buffer.alloc(2 * 1024 * 1024, 65));
      (child.stderr as PassThrough).write('tail-marker');
      child.emit('close', 0, null);
    });
    return child;
  });
  const result = await cli.run([]);
  assert.ok(result.stderr.length < 1.1 * 1024 * 1024);
  assert.ok(result.stderr.includes('truncated'));
  assert.ok(result.stderr.endsWith('tail-marker'));
});
