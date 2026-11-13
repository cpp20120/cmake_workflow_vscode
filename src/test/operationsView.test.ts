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
const folder = { name: 'work', uri: { fsPath: '/work', toString: () => 'file:///work' } } as vscode.WorkspaceFolder;
const ui = { TreeItem: MockItem, TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class { constructor(readonly id: string) {} }, EventEmitter: MockEmitter,
  workspace: { workspaceFolders: [folder] } };
const loader = require('node:module') as { _load: (id: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = (id, ...args) => id === 'vscode' ? ui : original(id, ...args);
const { OperationsView } = require('../operationsView') as typeof import('../operationsView');
loader._load = original;

function state(): vscode.Memento {
  const values = new Map<string, unknown>();
  return { keys: () => [...values.keys()], get: <T>(k: string, fallback?: T) => (values.get(k) as T) ?? fallback,
    update: async (k: string, v: unknown) => { values.set(k, v); } };
}
const record = { operationId: '1'.repeat(32), clientRequestId: 'req-1', manifest: '/work/workflow.json', submittedAt: '2026-11-02' };
const inspection = { operationId: record.operationId, acceptanceState: 'dispatch_authorized', terminalState: null,
  cancellationRequested: false, runDirectory: '/work/results', checkpointSha256: null, decision: null,
  revision: 0, note: null };

test('Operations View tracks multiple runs, preserves old last-run index, and never fabricates status', async () => {
  const view = new OperationsView(state());
  try {
    assert.deepEqual(view.records(folder), []);
    await view.track(folder, record);
    const rows = view.getChildren();
    assert.equal(rows.length, 1);
    assert.match(String(rows[0].description), /not inspected/);
    const target = { folderKey: folder.uri.toString(), operationId: record.operationId };
    assert.deepEqual(view.target(target), { folder, operationId: record.operationId });
    assert.equal(view.target({ ...target, operationId: '2'.repeat(32) }), undefined);
    assert.equal(view.target({ ...target, folderKey: 'file:///another' }), undefined);
    view.observe(folder, record.operationId, inspection, [], 0, false);
    assert.match(String(view.getChildren()[0].description), /dispatch_authorized/);
    view.failed(folder, record.operationId, 'Host unavailable');
    assert.match(String(view.getChildren()[0].description), /inspection unavailable/);
    assert.ok(view.getChildren(view.getChildren()[0]).some(item => String(item.label).includes('Host unavailable')));
  } finally { view.dispose(); }
});

test('Operations View displays paged Host operations without a local run index', () => {
  const view = new OperationsView(state());
  const operation = { workspaceId: 'workspace', operationId: record.operationId, clientRequestId: 'remote',
    kind: 'workflow', state: 'succeeded', manifestSha256: 'a'.repeat(64), manifestBaseDirectory: '/work' };
  try {
    view.setPage(folder, { schemaVersion: 1, items: [operation], nextCursor: 'page-2' }, null);
    assert.match(String(view.getChildren()[0].description), /succeeded/);
    assert.equal(view.getChildren()[1].label, 'Load more operations');
    assert.ok(view.target({ folderKey: folder.uri.toString(), operationId: operation.operationId }));
    view.setPage(folder, { schemaVersion: 1, items: [{ ...operation, operationId: '2'.repeat(32) }], nextCursor: null }, 'page-2');
    assert.equal(view.getChildren().length, 2);
    assert.equal(view.localRecords(folder).length, 0);
  } finally { view.dispose(); }
});

test('Operations shows workflow success and History failure independently', async () => {
  const view = new OperationsView(state());
  try {
    await view.track(folder, record);
    view.observe(folder, record.operationId, { ...inspection, terminalState: 'succeeded' }, [], 0, false);
    view.setHistory(folder, { operationId: record.operationId, state: 'failed', databasePath: null,
      updatedAt: null, diagnosticCode: 'report_changed' });
    const row = view.getChildren()[0];
    assert.match(String(row.description), /succeeded.*History: failed/);
    assert.ok(view.getChildren(row).some(item => String(item.label).includes('report_changed')));
  } finally { view.dispose(); }
});

test('Operations projects live events into node rows and replaces them with finalized node state', async () => {
  const view = new OperationsView(state());
  try {
    await view.track(folder, record);
    view.observe(folder, record.operationId, inspection, [{
      schemaVersion: 1, sequence: 1, timestamp: '2026-11-02T00:00:00Z', type: 'node_started',
      runDirectory: '/work/results', nodeId: 'build', nodeKind: 'build', status: 'running', exitCode: null,
      error: null, artifacts: [],
    }], 1, false);
    const root = view.getChildren()[0];
    assert.deepEqual(view.getChildren(root).map(item => item.label), ['build']);
    assert.match(String(view.getChildren(root)[0].description), /running/);
    view.setFinalizedNodes(folder, record.operationId, [{ id: 'build', kind: 'build', status: 'succeeded',
      dependencies: ['configure'], startedAt: null, finishedAt: null, exitCode: 0, error: null, stdout: null, stderr: null }]);
    assert.match(String(view.getChildren(root)[0].description), /succeeded/);
  } finally { view.dispose(); }
});
