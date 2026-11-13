import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { HostClient } from '../hostClient';
import { downloadOperationArtifact } from '../operationArtifacts';

const operation = { workspaceId: 'w', operationId: 'a'.repeat(32), clientRequestId: 'request-1', kind: 'workflow',
  state: 'accepted_not_dispatched', manifestSha256: 'b'.repeat(64), manifestBaseDirectory: '/workspace' };
const inspection = { operationId: operation.operationId, acceptanceState: 'accepted_not_dispatched', terminalState: null,
  cancellationRequested: false, runDirectory: null, checkpointSha256: null, decision: null, revision: 0, note: null };

test('Host durable workflow uses typed positional RPC, capability gate, lookup and explicit cancel', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cmwf-durable-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cmakeworkflow-${randomUUID()}` : path.join(dir, 'rpc.sock');
  const sockets = new Set<net.Socket>();
  const connections: ReturnType<typeof createMessageConnection>[] = [];
  const called: { method: string; payload: any }[] = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    const rpc = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    connections.push(rpc);
    rpc.onRequest('initialize', (request: any) => ({ protocolVersion: 1, processId: 1, workspaceDirectory: request.workspaceDirectory,
      profiles: [], capabilities: ['tooling/doctor', 'request-cancellation', 'workflow/start', 'operations/get',
        'operations/find', 'operations/cancel', 'operations/events', 'workflow/recoveryInspect'] }));
    rpc.onRequest('workflow/start', (request: any) => { called.push({ method: 'start', payload: request }); return operation; });
    rpc.onRequest('operations/get', (request: any) => { called.push({ method: 'get', payload: request }); return operation; });
    rpc.onRequest('operations/find', (request: any) => { called.push({ method: 'find', payload: request }); return operation; });
    rpc.onRequest('workflow/recoveryInspect', () => inspection);
    rpc.onRequest('operations/events', (request: any) => ({ operationId: request.operationId, afterSequence: request.afterSequence,
      nextSequence: request.afterSequence, hasMore: false, events: [] }));
    rpc.onRequest('operations/cancel', (request: any) => { called.push({ method: 'cancel', payload: request });
      return { operationId: request.operationId, state: 'cancel_requested', revision: 1, requested: true }; });
    rpc.listen();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  try {
    const { client } = await HostClient.connect(endpoint, os.tmpdir());
    try {
      const request = { clientRequestId: 'request-1', manifest: '/workspace/plan.json', manifestSha256: 'b'.repeat(64),
        jobs: 2, resultsDirectory: '/workspace/out/host-1' };
      assert.throws(() => client.startWorkflow({ ...request, only: ['selected'] }), /does not support running selected/);
      assert.equal((await client.startWorkflow(request)).operationId, operation.operationId);
      assert.equal((await client.findOperation('request-1')).operationId, operation.operationId);
      assert.equal((await client.getOperation(operation.operationId)).state, 'accepted_not_dispatched');
      assert.equal((await client.inspectOperation(operation.operationId)).terminalState, null);
      assert.deepEqual((await client.operationEvents(operation.operationId, 0, 100)).events, []);
      assert.equal((await client.cancelOperation(operation.operationId, 0)).requested, true);
      assert.deepEqual(called.map(x => x.method), ['start', 'find', 'get', 'cancel']);
      assert.deepEqual(called[0].payload, request);
      assert.deepEqual(called[3].payload, { operationId: operation.operationId, expectedRevision: 0 });
    } finally { client.dispose(); }
  } finally {
    for (const rpc of connections) { rpc.dispose(); }
    for (const socket of sockets) { socket.destroy(); }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('artifact download verifies all chunks before replacing a destination', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmwf-download-'));
  const destination = path.join(directory, 'report.json');
  const bytes = Buffer.from('two chunks');
  const artifact = { artifactId: 'opaque', relativePath: 'report.json', kind: 'report', size: bytes.length,
    lastWriteUtcTicksText: '638993245123456789', sha256: createHash('sha256').update(bytes).digest('hex') };
  const read = async (offset: number, corrupt: boolean) => {
    const content = Buffer.from(bytes.subarray(offset, offset === 0 ? 4 : bytes.length));
    if (corrupt && offset > 0) { content[0] = 0; }
    return { artifactId: artifact.artifactId, offset, totalSize: bytes.length,
      lastWriteUtcTicksText: artifact.lastWriteUtcTicksText, content, eof: offset + content.length === bytes.length };
  };
  try {
    await writeFile(destination, 'previous');
    await assert.rejects(downloadOperationArtifact(destination, artifact, offset => read(offset, true)), /SHA-256 mismatch/);
    assert.equal(await readFile(destination, 'utf8'), 'previous');
    assert.deepEqual(await readdir(directory), ['report.json']);
    await downloadOperationArtifact(destination, artifact, offset => read(offset, false));
    assert.deepEqual(await readFile(destination), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
