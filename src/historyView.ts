import * as vscode from 'vscode';
import * as path from 'node:path';
import type { HistoryDetection, HistoryDetectionReport, HistoryDifference, HistoryRun } from './protocol';

type Kind = 'slot' | 'runs' | 'run' | 'comparisons' | 'detections' | 'difference' | 'detection' | 'detail';
export class HistoryItem extends vscode.TreeItem {
  constructor(label: string, readonly kind: Kind, readonly run?: HistoryRun,
    readonly row?: HistoryDifference | HistoryDetection) {
    super(label, ['runs', 'comparisons', 'detections'].includes(kind) ? vscode.TreeItemCollapsibleState.Expanded
      : ['difference', 'detection'].includes(kind) ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None);
  }
}
interface State {
  runs: HistoryRun[];
  baseline?: HistoryRun;
  candidate?: HistoryRun;
  comparisons?: HistoryDifference[];
  detection?: HistoryDetectionReport;
}
const format = (value: number | null | undefined): string => value === null || value === undefined ? '—' : Number(value.toPrecision(5)).toString();

export class HistoryView implements vscode.TreeDataProvider<HistoryItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<HistoryItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly states = new Map<string, State>();
  private folderKey?: string;
  setFolder(key: string): void { this.folderKey = key; this.state(); this.changed.fire(undefined); }
  private state(): State | undefined { if (!this.folderKey) { return; } let state = this.states.get(this.folderKey); if (!state) { state = { runs: [] }; this.states.set(this.folderKey, state); } return state; }
  setRuns(key: string, runs: HistoryRun[]): void { const state = this.states.get(key) ?? { runs: [] }; state.runs = runs; state.comparisons = undefined; state.detection = undefined; this.states.set(key, state); if (key === this.folderKey) { this.changed.fire(undefined); } }
  runs(): HistoryRun[] { return this.state()?.runs ?? []; }
  clearSelection(): void { const state = this.state(); if (state) { state.baseline = undefined; state.candidate = undefined; state.comparisons = undefined; state.detection = undefined; this.changed.fire(undefined); } }
  setBaseline(run: HistoryRun): void { const state = this.state(); if (!state) { return; } state.baseline = run; state.comparisons = undefined; state.detection = undefined; this.changed.fire(undefined); }
  setCandidate(run: HistoryRun): void { const state = this.state(); if (!state) { return; } state.candidate = run; state.comparisons = undefined; state.detection = undefined; this.changed.fire(undefined); }
  pair(): [string, string] | undefined { const state = this.state(); return state?.baseline && state.candidate ? [state.baseline.id, state.candidate.id] : undefined; }
  baselineId(): string | undefined { return this.state()?.baseline?.id; }
  comparisons(): HistoryDifference[] | undefined { return this.state()?.comparisons; }
  setComparisons(rows: HistoryDifference[]): void { const state = this.state(); if (state) { state.comparisons = rows; state.detection = undefined; this.changed.fire(undefined); } }
  setDetection(report: HistoryDetectionReport): void { const state = this.state(); if (state) { state.detection = report; this.changed.fire(undefined); } }
  getTreeItem(item: HistoryItem): vscode.TreeItem { return item; }
  getChildren(item?: HistoryItem): HistoryItem[] {
    const state = this.state(); if (!state) { return []; }
    if (!item) {
      const baseline = state.baseline;
      const candidate = state.candidate;
      const slot = (label: string, run: HistoryRun | undefined, command: string): HistoryItem => {
        const item = new HistoryItem(`${label}: ${run ? path.basename(run.workflow ?? run.directory) : 'choose run'}`, 'slot');
        item.description = run?.startedAt ?? undefined;
        item.tooltip = run?.id ?? `Click to select ${label.toLowerCase()}`;
        item.iconPath = new vscode.ThemeIcon(run ? 'pinned' : 'circle-outline');
        item.command = { command, title: `Choose ${label}` };
        return item;
      };
      const rows = [slot('Baseline', baseline, 'cmakeWorkflow.pickBaseline'), slot('Candidate', candidate, 'cmakeWorkflow.pickCandidate')];
      const runs = new HistoryItem(`Runs (${state.runs.length})`, 'runs'); runs.iconPath = new vscode.ThemeIcon('history'); rows.push(runs);
      if (state.comparisons) { const comparisons = new HistoryItem(`Comparison (${state.comparisons.length})`, 'comparisons'); comparisons.iconPath = new vscode.ThemeIcon('diff'); rows.push(comparisons); }
      if (state.detection) { const detections = new HistoryItem(`Statistical test (${state.detection.results.length})`, 'detections'); detections.description = `${state.detection.metric} • ${state.detection.direction} • ≥${state.detection.minimumEffectPercent}%`; detections.tooltip = `${state.detection.test}; alpha=${state.detection.alpha}`; detections.iconPath = new vscode.ThemeIcon('beaker'); rows.push(detections); }
      return rows;
    }
    if (item.kind === 'runs') { return state.runs.map(run => { const child = new HistoryItem(`${run.status} • ${path.basename(run.workflow ?? run.directory)}`, 'run', run); child.description = run.startedAt ?? run.id.slice(0, 12); child.tooltip = `${run.id}\n${run.directory}${run.sourceAvailable ? '' : '\nSource missing'}`; child.iconPath = new vscode.ThemeIcon(run.status === 'succeeded' ? 'pass-filled' : run.status === 'failed' ? 'error' : 'circle-outline'); child.contextValue = 'cmakeWorkflowHistoryRun'; child.command = { command: 'cmakeWorkflow.historyDetails', title: 'Run Details', arguments: [run] }; return child; }); }
    if (item.kind === 'comparisons') { return (state.comparisons ?? []).map(row => this.resultItem(row, 'difference')); }
    if (item.kind === 'detections') { return (state.detection?.results ?? []).map(row => this.resultItem(row, 'detection')); }
    if ((item.kind === 'difference' || item.kind === 'detection') && item.row) {
      const row = item.row; const details = [
        `Method: ${row.method}; unit: ${row.unit || '(none)'}`,
        `Variant: ${row.variant ?? '(none)'}; scenario: ${row.scenario ?? '(none)'}`,
        `Baseline: n=${row.baseline?.count ?? '—'}, median=${format(row.baseline?.median)}`,
        `Candidate: n=${row.candidate?.count ?? '—'}, median=${format(row.candidate?.median)}`,
        `Change: ${format(row.absoluteChange)} ${row.unit}; ${format(row.percentChange)}%`,
      ];
      if (item.kind === 'detection') { const detection = row as HistoryDetection; details.push(`p=${format(detection.pValue)}; adjusted p=${format(detection.adjustedPValue)}`); }
      if (row.reason) { details.push(row.reason); }
      return details.map(label => { const child = new HistoryItem(label, 'detail'); child.tooltip = label; child.iconPath = new vscode.ThemeIcon('info'); return child; });
    }
    return [];
  }
  private resultItem(row: HistoryDifference | HistoryDetection, kind: 'difference' | 'detection'): HistoryItem {
    const item = new HistoryItem(`${row.metric}${row.variant ? ` • ${row.variant}` : ''}${row.scenario ? ` • ${row.scenario}` : ''}`, kind, undefined, row);
    item.description = `${row.status}${row.percentChange === null ? '' : ` • ${format(row.percentChange)}%`}`;
    item.tooltip = row.reason ?? row.status;
    item.iconPath = new vscode.ThemeIcon(row.status === 'regression' ? 'error' : row.status === 'compatible' ? 'pass' : row.status === 'inconclusive' ? 'question' : 'warning');
    return item;
  }
  dispose(): void { this.changed.dispose(); }
}
