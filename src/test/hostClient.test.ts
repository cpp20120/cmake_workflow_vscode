import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, rm, mkdir, access, writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, ParameterStructures, type MessageConnection } from 'vscode-jsonrpc/node';
import { HostClient } from '../hostClient';
import { HostProcess } from '../hostProcess';
import { parseHostInfo, parseToolingPlan, parseDoctorProgress, parseFixPlan, parseFixResult } from '../hostProtocol';
import { parseReportSnapshot, parseTargetResolution, parseMeasurementRows } from '../applicationProtocol';

const tool = { id: 'cmake', displayName: 'CMake', installed: true, command: '/tools with spaces/cmake', version: '4.0.0', minimumVersion: '3.26', diagnostic: null };
const plan = { schemaVersion: 1, ready: true, tools: [tool], steps: [], platform: 'Linux', packageManager: 'None', installDirectory: '/tools with spaces', profiles: ['cmake'] };
const hello = (workspace = os.tmpdir()) => ({ protocolVersion: 1, processId: 123, workspaceDirectory: workspace, capabilities: ['tooling/doctor', 'request-cancellation'], profiles: [{ id: 'cmake', description: 'CMake', tools: ['cmake'] }] });

test('Host protocol rejects incompatible and malformed responses', () => {
  assert.throws(() => parseHostInfo({ ...hello(), protocolVersion: 2 }), /Incompatible/);
  assert.throws(() => parseHostInfo({ ...hello(), capabilities: [] }), /Incompatible/);
  assert.throws(() => parseToolingPlan({ ...plan, ready: false }), /Inconsistent/);
  assert.throws(() => parseToolingPlan({ ...plan, tools: [{ ...tool, installed: 'yes' }] }), /Invalid/);
  assert.throws(() => parseDoctorProgress({ operationId: 'a', sequence: 0, stage: 'started', tool: null }), /Invalid/);
  assert.equal(parseToolingPlan({ ...plan, ready: false, tools: [{ ...tool, installed: false }] }).ready, false);
  assert.throws(() => parseFixPlan({ schemaVersion: 1, planId: 'p', expiresAt: 'invalid', plan }), /Invalid/);
  assert.throws(() => parseFixResult({ schemaVersion: 1, status: 'succeeded', installation: null, verification: plan, diagnostics: [] }), /Unverified/);
});

async function mockHost(handler: (rpc: MessageConnection) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmwf-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cmakeworkflow-${randomUUID()}` : path.join(directory, 'rpc.sock');
  const connections = new Set<MessageConnection>(); const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const rpc = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    connections.add(rpc); handler(rpc); rpc.listen();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  return { endpoint, async close() {
    for (const rpc of connections) { rpc.dispose(); } for (const socket of sockets) { socket.destroy(); }
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  } };
}

test('IPC client handles progress, missing tools, and reconnect', async () => {
  const server = await mockHost(rpc => {
    rpc.onRequest('initialize', request => hello(request.workspaceDirectory));
    rpc.onRequest('tooling/doctor', async request => {
      await rpc.sendNotification('tooling/progress', { operationId: request.operationId, sequence: 1, stage: 'started', tool: null });
      await rpc.sendNotification('tooling/progress', { operationId: request.operationId, sequence: 2, stage: 'tool_checked', tool });
      await rpc.sendNotification('tooling/progress', { operationId: request.operationId, sequence: 3, stage: 'finished', tool: null });
      return { ...plan, ready: false, tools: [{ ...tool, installed: false }] };
    });
  });
  try {
    for (const workspace of ['/workspace one', '/workspace two']) {
      const { client, info } = await HostClient.connect(server.endpoint, workspace);
      try {
        assert.equal(info.workspaceDirectory, workspace);
        const sequence: number[] = [];
        assert.equal((await client.doctor(['cmake'], e => sequence.push(e.sequence))).ready, false);
        assert.deepEqual(sequence, [1, 2, 3]);
      } finally { client.dispose(); }
    }
  } finally { await server.close(); }
});

test('IPC client rejects truncated and reordered progress', async () => {
  for (const reordered of [false, true]) {
    const server = await mockHost(rpc => {
      rpc.onRequest('initialize', () => hello());
      rpc.onRequest('tooling/doctor', async request => {
        await rpc.sendNotification('tooling/progress', { operationId: request.operationId, sequence: reordered ? 2 : 1, stage: 'started', tool: null });
        return plan;
      });
    });
    try {
      const { client } = await HostClient.connect(server.endpoint, os.tmpdir());
      try { await assert.rejects(client.doctor(['cmake'], () => {}), reordered ? /Out-of-order/ : /without final/); }
      finally { client.dispose(); }
    } finally { await server.close(); }
  }
});

test('IPC cancellation closes an in-flight request without retry', async () => {
  let calls = 0; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const server = await mockHost(rpc => {
    rpc.onRequest('initialize', () => hello());
    rpc.onRequest('tooling/doctor', () => { calls++; started(); return new Promise(resolve => rpc.onDispose(() => resolve(plan))); });
  });
  try {
    const { client } = await HostClient.connect(server.endpoint, os.tmpdir());
    const abort = new AbortController();
    const result = client.doctor(['cmake'], () => {}, abort.signal);
    await entered; abort.abort();
    await assert.rejects(result, /canceled/); assert.equal(calls, 1); client.dispose();
  } finally { await server.close(); }
});

test('owned Host reports missing executable and cleans up startup', async () => {
  const host = new HostProcess({ executable: path.join(os.tmpdir(), randomUUID(), 'missing'), prefixArgs: [], cwd: os.tmpdir() }, () => {});
  await assert.rejects(host.start(), /ENOENT/); await host.stop();
});

const binary = process.env.CMAKEWORKFLOW_HOST_TEST_BINARY;
test('real NativeAOT Host: TypeScript and CLI, simultaneous workspaces, reconnect, cleanup', { skip: !binary, timeout: 60000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cmwf-workspace '));
  const second = path.join(workspace, 'second workspace'); await mkdir(second);
  let log = '';
  const host = new HostProcess({ executable: binary!, prefixArgs: [], cwd: workspace }, text => { log += text; });
  let endpoint = '';
  try {
    endpoint = await host.start();
    const socket = net.createConnection(endpoint);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const raw = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket)); raw.listen();
    try {
      await assert.rejects(raw.sendRequest('initialize', ParameterStructures.byPosition,
        { protocolVersion: 999, workspaceDirectory: workspace }), /Unsupported Host protocol/);
    } finally { raw.dispose(); socket.destroy(); }
    const one = await HostClient.connect(endpoint, workspace), two = await HostClient.connect(endpoint, second);
    try {
      assert.equal(one.info.processId, two.info.processId);
      assert.equal(two.info.workspaceDirectory, second);
      const manifest = path.join(workspace, 'inspect.json');
      await writeFile(manifest, JSON.stringify({ schemaVersion: 2, contexts: { worker: { buildDirectory: 'not built', mode: 'observe' } },
        nodes: [{ id: 'inspect', kind: 'inspect', context: 'worker' }] }));
      assert.ok(one.client.supports('workflow/plan'));
      assert.equal(one.client.supports('workflow/start'), false);
      const planned = await one.client.planWorkflow(manifest);
      assert.equal(planned.nodes[0].id, 'inspect');
      assert.equal((await one.client.inspectContext(path.join(workspace, 'not built'))).state, 'Unknown');
      await assert.rejects(two.client.planWorkflow(manifest), /outside the initialized workspace/);
      const runDirectory = path.join(workspace, 'saved run'); await mkdir(runDirectory);
      const savedReport = JSON.stringify({ schemaVersion: 1, workflow: manifest, status: 'outcome_unknown', error: null,
        nodes: [{ id: 'action', kind: 'invoke', status: 'outcome_unknown', stdout: null, stderr: null, error: null, exitCode: null }] });
      await writeFile(path.join(runDirectory, 'run.json'), savedReport);
      const snapshot = await one.client.getRun(runDirectory);
      assert.equal(snapshot.report.nodes[0].status, 'outcome_unknown');
      assert.equal(snapshot.revision.toLowerCase(), createHash('sha256').update(savedReport).digest('hex'));
      assert.equal(await readFile(path.join(runDirectory, 'run.json'), 'utf8'), savedReport);
      await assert.rejects(one.client.historyRuns({ databasePath: path.join(workspace, 'missing.sqlite') }), /does not exist/);
      await assert.rejects(access(path.join(workspace, 'missing.sqlite')));
      const results = await Promise.all([one.client.doctor(['cmake'], () => {}), two.client.doctor(['ninja'], () => {})]);
      assert.equal(results[0].schemaVersion, 1); assert.equal(results[1].schemaVersion, 1);
      await assert.rejects(two.client.doctor(['not-a-profile'], () => {}), /Unknown/);
    } finally { one.client.dispose(); two.client.dispose(); }
    const reconnected = await HostClient.connect(endpoint, workspace);
    try { assert.equal((await reconnected.client.doctor(['cmake'], () => {})).schemaVersion, 1); }
    finally { reconnected.client.dispose(); }
    const cli = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(binary!, ['host', 'doctor', '--endpoint', endpoint, '--workspace', workspace, '--profile', 'cmake', '--json'], { shell: false });
      let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.ok([0, 2].includes(cli.code!), cli.stderr); assert.equal(JSON.parse(cli.stdout).schemaVersion, 1);
    assert.match(cli.stderr, /finished/);
    // None + no fallback cannot execute a package manager or download a release,
    // even on machines where some of the requested tools are missing.
    const fixer = await HostClient.connect(endpoint, workspace);
    try {
      assert.ok(fixer.info.capabilities.includes('tooling/applyFix'));
      const reviewed = await fixer.client.planFix(['cmake'], null, 'None', false);
      assert.ok(reviewed.plan.steps.every(s => s.method === 'manual'));
      const progress: string[] = [];
      const result = await fixer.client.applyFix(reviewed.planId, event => progress.push(event.stage));
      assert.ok(['succeeded', 'failed'].includes(result.status));
      assert.equal(result.verification?.schemaVersion, 1);
      assert.equal(progress[0], 'started'); assert.equal(progress.at(-1), 'finished');
      await assert.rejects(fixer.client.applyFix(reviewed.planId, () => {}), /consumed/);
    } finally { fixer.client.dispose(); }
    for (const apply of [false, true]) {
      const fixed = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const args = ['host', 'fix', '--endpoint', endpoint, '--workspace', workspace, '--profile', 'cmake', '--pm', 'none', '--no-fallback', '--json'];
        if (apply) { args.push('--yes'); }
        const child = spawn(binary!, args, { shell: false }); let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
        child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
      });
      assert.ok([0, 2].includes(fixed.code!), fixed.stderr);
      if (apply) { assert.equal(parseFixResult(JSON.parse(fixed.stdout)).verification?.schemaVersion, 1); }
      else { assert.ok(parseFixPlan(JSON.parse(fixed.stdout)).planId); assert.doesNotMatch(fixed.stderr, /\[Host fix:/); }
    }
    // A duplicate Host must neither replace nor unlink an active endpoint.
    const collision = spawn(binary!, ['host', 'serve', '--endpoint', endpoint], { shell: false, stdio: 'ignore' });
    const collisionCode = await new Promise<number | null>((resolve, reject) => { collision.once('error', reject); collision.once('close', resolve); });
    assert.notEqual(collisionCode, 0);
    const afterCollision = await HostClient.connect(endpoint, workspace); afterCollision.client.dispose();
    if (process.platform !== 'win32') {
      const tools = path.join(workspace, 'slow tools'); await mkdir(tools);
      const executable = path.join(tools, 'cmake');
      await writeFile(executable, '#!/bin/sh\npwd > "$0.cwd"\necho $$ > "$0.pid"\nexec sleep 30\n', { mode: 0o700 });
      const active = await HostClient.connect(endpoint, second);
      const abort = new AbortController();
      const checking = active.client.doctor(['cmake'], () => {}, abort.signal, tools);
      const deadline = Date.now() + 5000;
      while (true) {
        try { await access(executable + '.pid'); break; } catch {
          if (Date.now() > deadline) { throw Error('Probe did not start'); }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      const pid = Number((await readFile(executable + '.pid', 'utf8')).trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 1);
      assert.equal((await readFile(executable + '.cwd', 'utf8')).trim(), second);
      abort.abort(); await assert.rejects(checking, /canceled/); active.client.dispose();
      while (true) {
        try { process.kill(pid, 0); } catch { break; }
        if (Date.now() > deadline) { throw Error(`Canceled probe ${pid} remained alive`); }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  } catch (error) { throw Error(`${String(error)}\nHost log: ${log}`); }
  finally { await host.stop(); await rm(workspace, { recursive: true, force: true }); }
  if (process.platform !== 'win32') { await assert.rejects(access(endpoint)); }
});

test('Fix client requires ordered final progress and verified success; never retries', async () => {
  for (const mode of ['ok', 'truncated', 'reordered', 'unverified']) {
    let calls = 0;
    const server = await mockHost(rpc => {
      rpc.onRequest('initialize', () => hello());
      rpc.onRequest('tooling/planFix', () => ({ schemaVersion: 1, planId: 'p', expiresAt: new Date(Date.now() + 60000).toISOString(), plan }));
      rpc.onRequest('tooling/applyFix', async request => {
        calls++;
        await rpc.sendNotification('tooling/fixProgress', { operationId: request.operationId, sequence: mode === 'reordered' ? 2 : 1, stage: 'started', tool: null, message: null });
        if (mode !== 'truncated') { await rpc.sendNotification('tooling/fixProgress', { operationId: request.operationId, sequence: 2, stage: 'finished', tool: null, message: 'succeeded' }); }
        return { schemaVersion: 1, status: 'succeeded', installation: { schemaVersion: 1, success: true, ready: ['cmake'], failed: [], diagnostics: [] }, verification: mode === 'unverified' ? null : plan, diagnostics: [] };
      });
    });
    try {
      const { client } = await HostClient.connect(server.endpoint, os.tmpdir());
      try {
        const reviewed = await client.planFix(['cmake'], null, 'None', false);
        const operation = client.applyFix(reviewed.planId, () => {});
        if (mode === 'ok') { assert.equal((await operation).status, 'succeeded'); }
        else { await assert.rejects(operation, /progress|Unverified/); }
        assert.equal(calls, 1);
      } finally { client.dispose(); }
    } finally { await server.close(); }
  }
});

test('read API negotiates capabilities and validates snapshots without retry', async () => {
  let requests = 0;
  const server = await mockHost(rpc => {
    rpc.onRequest('initialize', request => ({ ...hello(request.workspaceDirectory), capabilities: [...hello().capabilities, 'workflow/plan', 'runs/get'] }));
    rpc.onRequest('workflow/plan', request => {
      requests++; assert.equal(request.manifest, '/workspace with spaces/workflow.json');
      return { schemaVersion: 1, workflow: request.manifest, manifestHash: 'hash', valid: false, nodes: [] };
    });
    rpc.onRequest('runs/get', () => { requests++; return { schemaVersion: 1, runDirectory: '/runs', revision: 'not a hash', report: {} }; });
  });
  try {
    const { client } = await HostClient.connect(server.endpoint, '/workspace with spaces');
    try {
      assert.equal((await client.planWorkflow('/workspace with spaces/workflow.json')).valid, false);
      await assert.rejects(client.getRun('/runs'), /revision/);
      await assert.rejects(client.inspectContext('/build'), /does not advertise/);
      assert.equal(requests, 2, 'No implicit retry or unsupported RPC call');
    } finally { client.dispose(); }
  } finally { await server.close(); }
});

test('application DTO validators preserve recovery states and reject incompatible data', () => {
  for (const status of ['needs_attention', 'outcome_unknown']) {
    const value = { schemaVersion: 1, runDirectory: '/run', revision: 'a'.repeat(64),
      report: { schemaVersion: 1, workflow: 'manifest', status, error: null,
        nodes: [{ id: 'x', kind: 'run', status, stdout: null, stderr: null, error: null, exitCode: null }] } };
    assert.equal(parseReportSnapshot(value).report.nodes[0].status, status);
    assert.throws(() => parseReportSnapshot({ ...value, schemaVersion: 2 }), /Invalid/);
  }
  assert.throws(() => parseTargetResolution({ schemaVersion: 2 }), /Invalid/);
  assert.throws(() => parseMeasurementRows([{ value: NaN }]), /Invalid/);
});
