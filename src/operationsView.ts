import type { OperationNode } from './operationDetails';
import type { HistoryIndexStatus } from './historyProtocol';
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { OperationPage, OperationReference, RecoveryInspection } from './durableProtocol';
import type { Event } from './protocol';
import { extendObservation, observationLabel, parseTrackedOperations, rememberOperation,
  type OperationObservation, type TrackedOperation } from './operationsModel';

export interface OperationTarget { folderKey: string; operationId: string }
type Kind = 'folder' | 'operation' | 'detail' | 'node' | 'pending' | 'more';
class OperationItem extends vscode.TreeItem {
  constructor(label: string, readonly kind: Kind, readonly folderKey: string, readonly operationId?: string, readonly nodeId?: string) {
    super(label, kind === 'folder' || kind === 'operation'
      ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  }
}
export class OperationsView implements vscode.TreeDataProvider<OperationItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<OperationItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly indexing = new Map<string, HistoryIndexStatus>();
  private readonly finalizedNodes = new Map<string, readonly OperationNode[]>();
  private readonly observations = new Map<string, OperationObservation>();
  private readonly listings = new Map<string, { items: Map<string, OperationReference>; nextCursor: string | null }>();
  constructor(private readonly state: vscode.Memento) {}
  private key(folderKey: string, operationId: string): string { return `${folderKey}\0${operationId}`; }
  private recordsKey(folderKey: string): string { return `durableOperations:${folderKey}`; }
  localRecords(folder: vscode.WorkspaceFolder): TrackedOperation[] {
    const key = folder.uri.toString();
    const current = parseTrackedOperations(this.state.get<unknown>(this.recordsKey(key)));
    const legacy = this.state.get<{ operationId?: string; clientRequestId?: string }>(`durableOperation:${key}`);
    if (legacy && /^[\da-f]{32}$/i.test(legacy.operationId ?? '') && legacy.clientRequestId
      && !current.some(r => r.operationId === legacy.operationId)) {
      return [...current, { operationId: legacy.operationId!, clientRequestId: legacy.clientRequestId,
        manifest: '', submittedAt: '' }].slice(0, 100);
    }
    return current;
  }
  records(folder: vscode.WorkspaceFolder): TrackedOperation[] {
    const local = this.localRecords(folder);
    const listing = this.listings.get(folder.uri.toString());
    if (!listing) { return local; }
    const known = new Map(local.map(record => [record.operationId, record]));
    const listed = Array.from(listing.items.values(), operation => known.get(operation.operationId) ?? {
      operationId: operation.operationId, clientRequestId: operation.clientRequestId,
      manifest: '', submittedAt: '',
    });
    return [...local.filter(record => !listing.items.has(record.operationId)), ...listed];
  }
  setPage(folder: vscode.WorkspaceFolder, page: OperationPage, cursor: string | null): void {
    const key = folder.uri.toString();
    const previous = this.listings.get(key);
    if (cursor !== null && previous?.nextCursor !== cursor) { return; }
    if (cursor !== null && page.nextCursor === cursor) { throw Error('Host operations cursor did not advance'); }
    const items = cursor === null ? new Map<string, OperationReference>() : new Map(previous?.items);
    for (const item of page.items) { items.set(item.operationId, item); }
    this.listings.set(key, { items, nextCursor: page.nextCursor });
    this.refresh();
  }
  rememberLatest(folder: vscode.WorkspaceFolder, page: OperationPage): void {
    const key = folder.uri.toString();
    const listing = this.listings.get(key);
    if (!listing) {
      this.setPage(folder, page, null);
      return;
    }
    const [latest] = page.items;
    if (latest) {
      const items = new Map(listing.items);
      items.delete(latest.operationId);
      this.listings.set(key, {
        items: new Map([[latest.operationId, latest], ...items]),
        nextCursor: listing.nextCursor,
      });
      this.refresh();
    }
  }
  nextCursor(folder: vscode.WorkspaceFolder): string | null {
    return this.listings.get(folder.uri.toString())?.nextCursor ?? null;
  }
  clearListing(folderKey: string): void {
    for (const key of this.indexing.keys()) {
      if (key.startsWith(folderKey + '\0')) { this.indexing.delete(key); }
    }
    for (const cache of [this.observations, this.finalizedNodes]) {
      for (const key of cache.keys()) {
        if (key.startsWith(folderKey + '\0')) { cache.delete(key); }
      }
    }
    this.listings.delete(folderKey);
    this.refresh();
  }
  setHistory(folder: vscode.WorkspaceFolder, status: HistoryIndexStatus): void {
    const key = this.key(folder.uri.toString(), status.operationId);
    const previous = this.indexing.get(key);
    if (previous?.updatedAt && status.updatedAt && previous.updatedAt > status.updatedAt) { return; }
    this.indexing.set(key, status);
    this.refresh();
  }
  setFinalizedNodes(folder: vscode.WorkspaceFolder, operationId: string, nodes: readonly OperationNode[]): void {
    this.finalizedNodes.set(this.key(folder.uri.toString(), operationId), nodes);
    this.refresh();
  }
  nodes(folder: vscode.WorkspaceFolder, operationId: string): readonly OperationNode[] {
    const key = this.key(folder.uri.toString(), operationId);
    return this.finalizedNodes.get(key) ?? [...(this.observations.get(key)?.liveNodes?.values() ?? [])];
  }
  async track(folder: vscode.WorkspaceFolder, record: TrackedOperation): Promise<void> {
    await this.state.update(this.recordsKey(folder.uri.toString()), rememberOperation(this.localRecords(folder), record));
    this.emitter.fire(undefined);
  }
  refresh(): void { this.emitter.fire(undefined); }
  observation(folder: vscode.WorkspaceFolder, id: string): OperationObservation | undefined {
    return this.observations.get(this.key(folder.uri.toString(), id));
  }
  observe(folder: vscode.WorkspaceFolder, id: string, inspection: RecoveryInspection, events: Event[],
    nextSequence: number, hasMore: boolean): void {
    if (inspection.operationId !== id) { throw Error('Host returned another operation'); }
    const key = this.key(folder.uri.toString(), id);
    const old = this.observations.get(key);
    this.observations.set(key, { ...extendObservation(old, events, nextSequence, hasMore), inspection, error: undefined });
    this.emitter.fire(undefined);
  }
  failed(folder: vscode.WorkspaceFolder, id: string, reason: string): void {
    const key = this.key(folder.uri.toString(), id);
    this.observations.set(key, { ...this.observations.get(key), events: this.observations.get(key)?.events ?? [],
      nextSequence: this.observations.get(key)?.nextSequence ?? 0, hasMore: false, error: reason });
    this.emitter.fire(undefined);
  }
  target(value: unknown): { folder: vscode.WorkspaceFolder; operationId: string } | undefined {
    if (!value || typeof value !== 'object') { return; }
    const item = value as OperationTarget;
    const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.toString() === item.folderKey);
    if (!folder || typeof item.operationId !== 'string'
      || !this.records(folder).some(r => r.operationId === item.operationId)) { return; }
    return { folder, operationId: item.operationId };
  }
  getTreeItem(item: OperationItem): vscode.TreeItem { return item; }
  getChildren(item?: OperationItem): OperationItem[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!item && folders.length > 1) {
      return folders.map(folder => {
        const row = new OperationItem(folder.name, 'folder', folder.uri.toString());
        row.iconPath = new vscode.ThemeIcon('root-folder');
        return row;
      });
    }
    if (!item || item.kind === 'folder') {
      const folder = item ? folders.find(f => f.uri.toString() === item.folderKey) : folders[0];
      if (!folder) { return []; }
      const key = folder.uri.toString();
      const operations = this.records(folder).map(record => {
        const row = new OperationItem(path.basename(record.manifest || record.operationId), 'operation', key, record.operationId);
        const observation = this.observation(folder, record.operationId);
        const state = observation ? observationLabel(observation)
          : this.listings.get(key)?.items.get(record.operationId)?.state ?? 'not inspected';
        row.id = `${key}:${record.operationId}`;
        const indexed = this.indexing.get(this.key(key, record.operationId));
        row.description = `${record.operationId.slice(0, 12)} • ${state}${indexed ? ` • History: ${indexed.state}` : ''}`;
        row.tooltip = `${record.operationId}\n${record.manifest || 'Manifest not recorded'}\nLast observation: ${state}`;
        row.contextValue = 'cmakeWorkflowDurableOperation';
        row.iconPath = new vscode.ThemeIcon(state === 'succeeded' ? 'pass-filled'
          : state === 'failed' ? 'error' : state === 'canceled' ? 'circle-slash'
          : state === 'outcome_unknown' || state === 'needs_attention' ? 'warning'
          : state === 'inspection unavailable' ? 'question' : 'history');
        row.command = { command: 'cmakeWorkflow.openDurableOperation', title: 'Inspect Host Operation',
          arguments: [{ folderKey: key, operationId: record.operationId }] };
        return row;
      });
      const pending = this.state.get<{ clientRequestId?: string }>(`durablePending:${key}`);
      if (pending?.clientRequestId) {
        const row = new OperationItem('Admission outcome unknown', 'pending', key);
        row.description = pending.clientRequestId;
        row.tooltip = 'Find this request ID in Host before starting anything else';
        row.iconPath = new vscode.ThemeIcon('warning');
        row.command = { command: 'cmakeWorkflow.inspectDurableWorkflow', title: 'Resolve Pending Host Admission' };
        operations.unshift(row);
      }
      if (this.nextCursor(folder)) {
        const row = new OperationItem('Load more operations', 'more', key);
        row.command = { command: 'cmakeWorkflow.loadMoreDurableOperations', title: 'Load More Host Operations', arguments: [key] };
        operations.push(row);
      }
      return operations;
    }
    if (item.kind !== 'operation' || !item.operationId) { return []; }
    const folder = folders.find(f => f.uri.toString() === item.folderKey);
    if (!folder) { return []; }
    const info = this.observation(folder, item.operationId);
    const create = (label: string, icon: string): OperationItem => {
      const row = new OperationItem(label, 'detail', item.folderKey);
      row.iconPath = new vscode.ThemeIcon(icon); return row;
    };
    const indexed = this.indexing.get(this.key(item.folderKey, item.operationId));
    const lines: OperationItem[] = [];
    if (indexed) {
      const row = new OperationItem(
        `History: ${indexed.state}${indexed.diagnosticCode ? ` (${indexed.diagnosticCode})` : ''}`,
        'detail', item.folderKey, item.operationId);
      row.iconPath = new vscode.ThemeIcon(indexed.state === 'failed' ? 'warning' : 'database');
      if (indexed.state === 'indexed' && indexed.databasePath) {
        row.contextValue = 'cmakeWorkflowHistoryIndexed';
        row.command = { command: 'cmakeWorkflow.openOperationHistory', title: 'Open Operation History',
          arguments: [{ folderKey: item.folderKey, operationId: item.operationId }] };
      } else if (['failed', 'pending', 'indexing'].includes(indexed.state)) {
        row.contextValue = 'cmakeWorkflowHistoryRetryable';
      }
      row.tooltip = [indexed.databasePath, indexed.updatedAt, indexed.diagnosticCode].filter(Boolean).join('\n');
      lines.push(row);
    }
    if (info?.error) { lines.push(create(`Inspection: ${info.error}`, 'warning')); }
    const nodes = this.nodes(folder, item.operationId);
    for (const node of nodes) {
      const row = new OperationItem(node.id, 'node', item.folderKey, item.operationId, node.id);
      row.id = JSON.stringify([item.folderKey, item.operationId, node.id]);
      row.description = `${node.status} · ${node.kind}`;
      row.tooltip = node.error ?? node.status;
      row.iconPath = new vscode.ThemeIcon(node.status === 'failed' ? 'error'
        : node.status === 'succeeded' ? 'pass-filled' : node.status === 'running' ? 'sync~spin' : 'circle-outline');
      row.contextValue = this.finalizedNodes.has(this.key(item.folderKey, item.operationId))
        ? 'cmakeWorkflowFinalizedNode' : 'cmakeWorkflowOperationNode';
      row.command = { command: 'cmakeWorkflow.openOperationNode', title: 'Open Node Details',
        arguments: [{ folderKey: item.folderKey, operationId: item.operationId, nodeId: node.id }] };
      lines.push(row);
    }
    if (!nodes.length && !info?.error) {
      lines.push(create(info ? 'No node state available yet.' : 'Click the operation to load its nodes.', 'info'));
    }
    return lines;
  }
  dispose(): void { this.emitter.dispose(); }
}
