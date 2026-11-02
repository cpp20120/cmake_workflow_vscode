import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as vscode from 'vscode';

class MockItem {
  description?: string;
  contextValue?: string;
  command?: unknown;
  constructor(readonly label: string, readonly collapsibleState: number) {}
}
class MockEmitter {
  readonly event = () => ({ dispose() {} });
  fire(): void {}
  dispose(): void {}
}
const folder = { name: 'workspace', uri: { fsPath: '/workspace', toString: () => 'file:///workspace' } } as vscode.WorkspaceFolder;
const manifest = { fsPath: '/workspace/workflow.json' } as vscode.Uri;
let starts = 0, cancels = 0, finds = 0, inspections = 0, panels: string[] = [];
let failStart = false;
let terminalState: string | null = null;
const id = 'a'.repeat(32), hash = 'b'.repeat(64);
const op = { operationId: id, clientRequestId: 'request', workspaceId: 'workspace', kind: 'workflow',
  state: 'accepted_not_dispatched', manifestSha256: hash, manifestBaseDirectory: '/workspace' };
const recovery = { operationId: id, acceptanceState: 'dispatch_authorized', terminalState: null,
  cancellationRequested: false, runDirectory: null, checkpointSha256: null, decision: null, revision: 0, note: null };
const fakeClient = {
  supports: () => true,
  planWorkflow: async () => ({ schemaVersion: 1, valid: true, manifestHash: hash, workflow: manifest.fsPath, nodes: [] }),
  startWorkflow: async () => { starts++; if (failStart) { throw Error('lost response'); } return op; },
  findOperation: async () => { finds++; return op; },
  getOperation: async () => op,
  inspectOperation: async () => { inspections++; return { ...recovery, terminalState }; },
  operationEvents: async (_id: string, afterSequence: number) => ({ operationId: id, afterSequence,
    nextSequence: afterSequence, hasMore: false, events: [] }),
  cancelOperation: async (_id: string, rev: number) => { assert.equal(rev, 0); cancels++; return { operationId: id, state: 'cancel_requested', revision: 1, requested: true }; },
  dispose: () => {},
};
const ui = {
  TreeItem: MockItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, ThemeIcon: class { constructor(readonly id: string) {} },
  EventEmitter: MockEmitter,
  ProgressLocation: { Notification: 15 },
  window: {
    registerTreeDataProvider: (_id: string, view: unknown) => { assert.ok(view); return { dispose() {} }; },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => 'Request Cancellation',
    withProgress: async (_options: unknown, callback: (p: { report(msg: unknown): void }, token: unknown) => Promise<void>) =>
      callback({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  },
  workspace: {
    workspaceFolders: [folder],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) => key === 'executable' ? 'CMakeWorkflow' : defaultValue,
      inspect: () => undefined,
    }),
  },
};
class MockHostProcess {
  get exited(): boolean { return false; }
  async start() { return '/tmp/host.sock'; }
  dispose() {}
}
const loader = require('node:module') as { _load: (id: string, ...args: unknown[]) => unknown };
const oldLoad = loader._load;
loader._load = (name, ...args) => {
  if (name === 'vscode') { return ui; }
  if (name === './hostClient') { return { HostClient: { connect: async () => ({ client: fakeClient }) } }; }
  if (name === './hostProcess') { return { HostProcess: MockHostProcess }; }
  if (name === './settings') { return { configuredJobs: () => undefined }; }
  if (name === './toolEnvironment') { return { toolDirectory: () => null, toolEnvironment: () => undefined }; }
  if (name === './inspectionHtml') { return { escapeHtml: (s: string) => s }; }
  return oldLoad(name, ...args);
};
const { registerDurableCommands } = require('../durableCommands') as typeof import('../durableCommands');
loader._load = oldLoad;
function environment() {
  const saved = new Map<string, unknown>();
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
  const state = { keys: () => [...saved.keys()], get: <T>(key: string) => saved.get(key) as T,
    update: async (key: string, value: unknown) => { saved.set(key, value); } };
  const context = { workspaceState: state, subscriptions: [] } as unknown as vscode.ExtensionContext;
  const services = {
    register: (name: string, fn: (...args: unknown[]) => Promise<void>) => { commands.set(name, fn); },
    trusted: () => true, choose: async () => ({ folder, file: manifest }), folder: async () => folder,
    onPlan: () => {}, onEvent: () => {}, onReport: async () => {}, status: () => {},
    show: (_name: string, body: string) => { panels.push(body); },
  };
  registerDurableCommands(context, services, { append: () => {}, appendLine: () => {} } as unknown as vscode.OutputChannel);
  return { saved, commands };
}

test('durable Operations UI refreshes tracked operation without starting it again; cancellation explicit', async () => {
  starts = 0; cancels = 0; finds = 0; inspections = 0; failStart = false; terminalState = null; panels = [];
  const e = environment();
  await e.commands.get('cmakeWorkflow.runDurableWorkflow')!();
  assert.equal(starts, 1);
  const records = e.saved.get('durableOperations:file:///workspace') as { operationId: string }[];
  assert.equal(records[0].operationId, id);
  await e.commands.get('cmakeWorkflow.refreshDurableOperations')!();
  assert.equal(starts, 1);
  assert.equal(inspections, 1);
  const row = { folderKey: folder.uri.toString(), operationId: id };
  await e.commands.get('cmakeWorkflow.openDurableOperation')!(row);
  assert.equal(panels.length, 1);
  assert.match(panels[0], /dispatch_authorized/);
  await e.commands.get('cmakeWorkflow.cancelDurableOperationItem')!(row);
  assert.equal(cancels, 1);
  assert.equal(starts, 1);
  assert.equal(finds, 0);
});

test('lost start response is never retried when refreshing pending request ID', async () => {
  starts = 0; cancels = 0; finds = 0; inspections = 0; failStart = true; terminalState = null; panels = [];
  const e = environment();
  await assert.rejects(e.commands.get('cmakeWorkflow.runDurableWorkflow')!(), /may already be accepted/);
  assert.equal(starts, 1);
  assert.ok(e.saved.get('durablePending:file:///workspace'));
  failStart = false;
  await e.commands.get('cmakeWorkflow.refreshDurableOperations')!();
  assert.equal(starts, 1);
  assert.equal(finds, 1);
  assert.equal(e.saved.get('durablePending:file:///workspace'), undefined);
  assert.equal((e.saved.get('durableOperations:file:///workspace') as { operationId: string }[])[0].operationId, id);
});

test('Follow reports Host completion but never cancels or reexecutes the workflow', async () => {
  starts = 0; cancels = 0; finds = 0; inspections = 0; failStart = false; terminalState = null;
  const e = environment();
  await e.commands.get('cmakeWorkflow.runDurableWorkflow')!();
  terminalState = 'succeeded';
  await e.commands.get('cmakeWorkflow.followDurableOperation')!({ folderKey: folder.uri.toString(), operationId: id });
  assert.equal(starts, 1);
  assert.equal(cancels, 0);
  assert.equal(inspections, 1);
});

test('pending admission is resolved before an older last operation', async () => {
  starts = 0; finds = 0; inspections = 0; failStart = false; terminalState = null;
  const e = environment();
  e.saved.set('durableOperation:file:///workspace', { operationId: 'b'.repeat(32), clientRequestId: 'older' });
  e.saved.set('durablePending:file:///workspace', { clientRequestId: 'request-new', manifest: manifest.fsPath,
    manifestSha256: hash, jobs: 1, resultsDirectory: '/workspace/out/new' });
  await e.commands.get('cmakeWorkflow.inspectDurableWorkflow')!();
  assert.equal(finds, 1, 'must resolve the uncertain request first');
  assert.equal(starts, 0, 'must not re-submit a workflow');
  assert.equal(e.saved.get('durablePending:file:///workspace'), undefined);
  assert.equal((e.saved.get('durableOperation:file:///workspace') as { operationId: string }).operationId, id);
  assert.ok((e.saved.get('durableOperations:file:///workspace') as { operationId: string }[])
    .some(item => item.operationId === id));
});
