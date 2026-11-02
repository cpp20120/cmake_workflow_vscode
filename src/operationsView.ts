import * as vscode from 'vscode';
import * as path from 'node:path';
import type { RecoveryInspection } from './durableProtocol';
import type { Event } from './protocol';
import { extendObservation, observationLabel, parseTrackedOperations, rememberOperation,
  type OperationObservation, type TrackedOperation } from './operationsModel';

export interface OperationTarget { folderKey: string; operationId: string }
type Kind = 'folder' | 'operation' | 'detail' | 'event' | 'pending';
class OperationItem extends vscode.TreeItem {
  constructor(label: string, readonly kind: Kind, readonly folderKey: string, readonly operationId?: string) {
    super(label, kind === 'folder' || kind === 'operation'
      ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  }
}
export class OperationsView implements vscode.TreeDataProvider<OperationItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<OperationItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly observations = new Map<string, OperationObservation>();
  constructor(private readonly state: vscode.Memento) {}
  private key(folderKey: string, operationId: string): string { return `${folderKey}\0${operationId}`; }
  private recordsKey(folderKey: string): string { return `durableOperations:${folderKey}`; }
  records(folder: vscode.WorkspaceFolder): TrackedOperation[] {
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
  async track(folder: vscode.WorkspaceFolder, record: TrackedOperation): Promise<void> {
    await this.state.update(this.recordsKey(folder.uri.toString()), rememberOperation(this.records(folder), record));
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
        const state = observationLabel(this.observation(folder, record.operationId));
        row.id = `${key}:${record.operationId}`;
        row.description = `${record.operationId.slice(0, 12)} • ${state}`;
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
    if (!info) { return [create('Not inspected. Use Refresh Operations.', 'info')]; }
    const lines = [create(`State: ${observationLabel(info)}`, info.error ? 'warning' : 'info')];
    if (info.error) { lines.push(create(`Error: ${info.error}`, 'error')); }
    if (info.inspection) {
      lines.push(create(`Acceptance: ${info.inspection.acceptanceState}`, 'database'));
      lines.push(create(`Cancellation requested: ${info.inspection.cancellationRequested ? 'yes' : 'no'}`, 'debug-stop'));
      if (info.inspection.runDirectory) { lines.push(create(`Run: ${info.inspection.runDirectory}`, 'folder')); }
      if (info.inspection.decision) { lines.push(create(`Recovery: ${info.inspection.decision}`, 'warning')); }
    }
    lines.push(create(`Event cursor: ${info.nextSequence}${info.hasMore ? ' (more pages)' : ''}`, 'list-ordered'));
    for (const event of [...info.events].reverse().slice(0, 30)) {
      const line = new OperationItem(`#${event.sequence} ${event.nodeId ?? 'workflow'}: ${event.type} ${event.status ?? ''}`, 'event', item.folderKey);
      line.tooltip = `${event.timestamp}${event.error ? `\n${event.error}` : ''}`;
      line.iconPath = new vscode.ThemeIcon(event.status === 'failed' ? 'error' : event.type === 'node_finished' ? 'check' : 'circle-outline');
      lines.push(line);
    }
    return lines;
  }
  dispose(): void { this.emitter.dispose(); }
}
