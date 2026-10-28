import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CliClient, type CliResult } from './cli';
import { configuredJobs, resolveHistoryDatabase } from './settings';
import { HistoryView } from './historyView';
import { openComparisonPanel, openHistoryPanel } from './historyPanel';
import { builtInPresets, defaultPreset, parseCustomPresets, type ChartPreset, type ChartSource } from './chartPresets';
import { parseHarness } from './dagflowHarness';
import { renderHarnessHtml } from './harnessHtml';
import { automaticBaselines, hasCompatibleMeasurements } from './autoResults';
import { contextHtml, informationHtml, inspectContext, resolvedTargetHtml, toolingPlanHtml, toolingProfiles } from './inspectionHtml';
import { loadComparisonEvidence, loadStandaloneProfileEvidence } from './profileEvidence';
import { presentProfileResults } from './profileResults';
import { historyRunFromCommand } from './historySelection';
import { planGraphHtml } from './runVisuals';
import { parseTrendSamples, renderTrendHtml, trendIdentity, trendLabel } from './historyTrend';
import { EventSequence, parseEvent, parseHistory, parseHistoryDetail, parseHistoryComparison, parseHistoryDetection, parsePlan, parseReport, type Artifact, type Event, type HistoryDetail, type HistoryRun, type Plan, type PlanNode, type NodeStatus, type Report } from './protocol';

interface Selection { folder: vscode.WorkspaceFolder; file: vscode.Uri }
interface NodeState { node: PlanNode; status: NodeStatus; artifacts: Artifact[]; error?: string }
type ItemKind = 'workflow' | 'node' | 'detail' | 'artifact';
class Item extends vscode.TreeItem {
  constructor(label: string, readonly kind: ItemKind, readonly state?: NodeState) {
    super(label, kind === 'workflow' ? vscode.TreeItemCollapsibleState.Expanded
      : kind === 'node' ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None);
  }
}
class WorkflowTree implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>(); readonly onDidChangeTreeData = this.changed.event;
  private selection?: Selection; private plan?: Plan; private nodes = new Map<string, NodeState>();
  private activity = 'Select a workflow to begin';
  set(selection: Selection, plan?: Plan): void { this.selection = selection; this.plan = plan; this.nodes = new Map(plan?.nodes.map(node => [node.id, { node, status: 'pending' as const, artifacts: [] }]) ?? []); this.activity = plan ? (plan.valid ? `Plan valid • ${plan.nodes.length} nodes` : 'Plan invalid') : 'Ready to plan'; this.changed.fire(undefined); }
  status(value: string): void { this.activity = value; this.changed.fire(undefined); }
  event(event: Event): void { if (!event.nodeId) { return; } const state = this.nodes.get(event.nodeId); if (!state) { return; } if (event.status && ['pending','running','succeeded','failed','blocked','canceled'].includes(event.status)) { state.status = event.status as NodeStatus; } state.artifacts = event.artifacts; state.error = event.error ?? undefined; this.changed.fire(undefined); }
  async report(report: Report, runDirectory: string): Promise<void> { for (const node of report.nodes) { const state = this.nodes.get(node.id); if (state) { state.status = node.status; state.error = node.error ?? undefined; for (const type of ['stdout','stderr'] as const) { const file = node[type]; if (file && !state.artifacts.some(a => a.type === type)) { const full = path.isAbsolute(file) ? file : path.join(runDirectory, file); try { await vscode.workspace.fs.stat(vscode.Uri.file(full)); state.artifacts.push({ type, path: full, sha256: null }); } catch { /* Saved report may refer to an unavailable log. */ } } } } } this.changed.fire(undefined); }
  getTreeItem(item: Item): vscode.TreeItem { return item; }
  getChildren(item?: Item): Item[] {
    if (!this.selection) { return []; }
    if (!item) {
      const root = new Item(path.basename(this.selection.file.fsPath), 'workflow');
      root.description = this.selection.folder.name;
      root.tooltip = this.selection.file.fsPath;
      root.iconPath = new vscode.ThemeIcon('file-code');
      return [root];
    }
    if (item.kind === 'workflow') {
      const summary = new Item(this.activity, 'detail');
      summary.iconPath = new vscode.ThemeIcon(this.plan?.valid === false ? 'error' : 'info');
      return [summary, ...[...this.nodes.values()].map(state => {
        const child = new Item(state.node.id, 'node', state);
        child.description = `${state.node.kind} • ${state.status}`;
        child.tooltip = `${state.node.target}\n${state.node.buildDirectory}`;
        child.iconPath = new vscode.ThemeIcon(({ pending:'circle-outline', running:'sync~spin', succeeded:'pass-filled', failed:'error', blocked:'debug-pause', canceled:'circle-slash' } as Record<NodeStatus,string>)[state.status]);
        child.contextValue = 'cmakeWorkflowNode';
        return child;
      })];
    }
    if (item.kind !== 'node' || !item.state) { return []; }
    const { node, artifacts, error } = item.state;
    const detail = (label: string, icon = 'info'): Item => { const child = new Item(label, 'detail'); child.iconPath = new vscode.ThemeIcon(icon); return child; };
    const children = [
      detail(`Target: ${node.target || '(none)'}`, 'target'),
      detail(`Build: ${node.buildDirectory}`, 'folder'),
      detail(`Configuration: ${node.configuration ?? '(none)'}`),
      detail(`Observed: ${node.observedState}`),
      detail(`Dependencies: ${node.dependencies.join(', ') || '(none)'}`),
      detail(`Resources: ${node.resources.join(', ') || '(none)'}${node.exclusive ? ' • exclusive' : ''}`),
    ];
    for (const diagnostic of node.diagnostics) {
      children.push(detail(`${diagnostic.severity}: ${diagnostic.message}`, diagnostic.severity === 'Error' ? 'error' : 'warning'));
    }
    if (error) { children.push(detail(`Error: ${error}`, 'error')); }
    for (const artifact of artifacts) {
      const child = new Item(`${artifact.type}: ${path.basename(artifact.path)}`, 'artifact');
      child.description = artifact.path;
      child.tooltip = artifact.path;
      child.iconPath = new vscode.ThemeIcon('file');
      child.command = { command: 'cmakeWorkflow.openArtifact', title: 'Open Artifact', arguments: [artifact.path] };
      children.push(child);
    }
    return children;
  }
  dispose(): void { this.changed.dispose(); }
}

const activeClients = new Set<CliClient>();
function messageFor(result: CliResult, action: string): string | undefined { if (result.spawnError) { return `${action}: ${result.spawnError.message}`; } if (result.outputError) { return `${action}: ${result.outputError.message}`; } if (result.signal) { return `${action}: terminated by ${result.signal}`; } if (result.code !== 0) { return `${action}: CLI exited with code ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().split('\n').at(-1)}` : ''}`; } return undefined; }
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CMakeWorkflow'); const tree = new WorkflowTree(); const history = new HistoryView();
  const panels = new Set<vscode.WebviewPanel>();
  const trackPanel = (panel: vscode.WebviewPanel): void => { panels.add(panel); panel.onDidDispose(() => panels.delete(panel)); };
  context.subscriptions.push(output, tree, history, vscode.window.registerTreeDataProvider('cmakeWorkflow.workflows', tree), vscode.window.registerTreeDataProvider('cmakeWorkflow.history', history));
  context.subscriptions.push({ dispose: () => { for (const panel of panels) { panel.dispose(); } panels.clear(); } });
  const selected = new Map<string, Selection>(); const lastRuns = new Map<string, string>();
  // Only explicit user selections pin a baseline; automatic selections should
  // advance to the latest compatible predecessor on the next run.
  const manuallyPinnedBaselines = new Map<string, string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) { const value = context.workspaceState.get<string>(`workflow:${folder.uri.toString()}`); if (value) { selected.set(folder.uri.toString(), { folder, file: vscode.Uri.file(value) }); } }
  let current: Selection | undefined = [...selected.values()][0]; let historyFolder: vscode.WorkspaceFolder | undefined = current?.folder; if (current) { tree.set(current); history.setFolder(current.folder.uri.toString()); }
  const reportError = (error: unknown): void => { const text = error instanceof Error ? error.message : String(error); tree.status(`Error: ${text}`); output.appendLine(text); output.show(true); if (text.includes('ENOENT')) { void vscode.window.showErrorMessage(`CMakeWorkflow: ${text}. Choose the CLI executable for this workspace.`, 'Choose CLI Executable').then(choice => { if (choice) { void vscode.commands.executeCommand('cmakeWorkflow.configureCli'); } }); } else { void vscode.window.showErrorMessage(`CMakeWorkflow: ${text}`); } };
  const trusted = (): boolean => { if (!vscode.workspace.isTrusted) { reportError('Trust this workspace before running CMakeWorkflow.'); return false; } return true; };
  const clientFor = (folder: vscode.WorkspaceFolder): CliClient => { const config = vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri); const executable = config.get<string>('executable', 'CMakeWorkflow').trim(); const prefixArgs = config.get<string[]>('prefixArgs', []); if (!executable || !Array.isArray(prefixArgs) || !prefixArgs.every(x => typeof x === 'string')) { throw Error('Configure cmakeWorkflow.executable and prefixArgs.'); } return new CliClient({ executable, prefixArgs, cwd: folder.uri.fsPath }); };
  const historyDb = (folder: vscode.WorkspaceFolder): string | undefined => resolveHistoryDatabase(folder.uri.fsPath, vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri).get<string>('historyDb', ''));
  const historyArgs = (folder: vscode.WorkspaceFolder, args: string[]): string[] => { const database = historyDb(folder); return database ? [...args, '--db', database] : args; };
  const call = async (folder: vscode.WorkspaceFolder, args: string[]): Promise<string> => { const client = clientFor(folder); activeClients.add(client); try { output.appendLine(`Running ${args.join(' ')}`); const result = await client.run(args, undefined, text => output.append(text)); const problem = messageFor(result, args.slice(0, 2).join(' ')); if (problem) { throw Error(problem); } return result.stdout; } finally { activeClients.delete(client); client.dispose(); } };
  const callWithCodes = async (folder: vscode.WorkspaceFolder, args: string[], accepted: number[]): Promise<string> => { const client = clientFor(folder); activeClients.add(client); try { output.appendLine(`Running ${args.join(' ')}`); const result = await client.run(args, undefined, text => output.append(text)); if (result.spawnError || result.signal || !accepted.includes(result.code ?? -1)) { throw Error(messageFor(result, args.slice(0, 2).join(' ')) ?? 'CLI failed'); } return result.stdout; } finally { activeClients.delete(client); client.dispose(); } };
  const infoPanel = (title: string, body: string): vscode.WebviewPanel => { const panel = vscode.window.createWebviewPanel('cmakeWorkflow.information', title, vscode.ViewColumn.Active, { enableScripts: false }); panel.webview.html = informationHtml(title, body, randomBytes(16).toString('base64')); trackPanel(panel); return panel; };
  const selectFolder = async (): Promise<vscode.WorkspaceFolder | undefined> => { const folders = vscode.workspace.workspaceFolders ?? []; if (!folders.length) { reportError('Open a workspace folder first.'); return; } if (folders.length === 1) { return folders[0]; } const choice = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: 'Choose workspace folder' }); return choice?.folder; };
  const selectWorkflow = async (): Promise<Selection | undefined> => { const folder = await selectFolder(); if (!folder) { return; } const files = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'JSON workflow': ['json'] }, openLabel: 'Select Workflow' }); const file = files?.[0]; if (!file) { return; } if (vscode.workspace.getWorkspaceFolder(file)?.uri.toString() !== folder.uri.toString()) { throw Error('Select a workflow in the chosen workspace folder.'); } const selection = { folder, file }; selected.set(folder.uri.toString(), selection); current = selection; historyFolder = folder; history.setFolder(folder.uri.toString()); await context.workspaceState.update(`workflow:${folder.uri.toString()}`, file.fsPath); tree.set(selection); return selection; };
  const choose = async (): Promise<Selection | undefined> => current ?? selectWorkflow();
  const plan = async (selection: Selection, only?: string, allowInvalid = false): Promise<Plan> => { const client = clientFor(selection.folder); activeClients.add(client); tree.status('Planning…'); try { const args = ['workflow','plan',selection.file.fsPath,'--json']; if (only) { args.push('--only', only); } const result = await client.run(args, undefined, text => output.append(text)); if (result.spawnError || result.signal) { throw Error(messageFor(result, 'Plan workflow')); } let parsed: Plan; try { parsed = parsePlan(JSON.parse(result.stdout)); } catch (error) { throw Error(`Invalid plan JSON: ${String(error)}${result.stderr ? `\n${result.stderr}` : ''}`); } tree.set(selection, parsed); output.appendLine(`Plan: ${parsed.valid ? 'valid' : 'invalid'}; ${parsed.nodes.length} nodes`); for (const node of parsed.nodes) { output.appendLine(`${node.id}: ${node.kind} ${node.target}; build=${node.buildDirectory}; config=${node.configuration ?? '(none)'}; after=[${node.dependencies.join(', ')}]; observed=${node.observedState}; resources=[${node.resources.join(', ')}]${node.exclusive ? '; exclusive' : ''}`); for (const diagnostic of node.diagnostics) { output.appendLine(`  ${diagnostic.severity}: ${diagnostic.message}`); } } if ((result.code !== 0 || !parsed.valid) && !allowInvalid) { throw Error(`Workflow plan invalid (exit ${result.code}). Expand nodes in the CMakeWorkflow view for diagnostics.`); } return parsed; } finally { activeClients.delete(client); client.dispose(); } };
  const openReport = async (folder: vscode.WorkspaceFolder, directory: string, showFile = false): Promise<Report> => { let report: Report; try { report = parseReport(JSON.parse(await call(folder, ['workflow','report',directory,'--json']))); } catch (error) { throw Error(`Report unavailable or incomplete: ${String(error)}`); } await tree.report(report, directory); tree.status(`Run ${report.status} • ${report.nodes.length} nodes`); output.appendLine(`Report: ${report.status}${report.error ? ` — ${report.error}` : ''}`); for (const node of report.nodes) { output.appendLine(`${node.id}: ${node.status}${node.error ? ` — ${node.error}` : ''}`); } if (showFile) { const uri = vscode.Uri.file(path.join(directory, 'run.json')); try { await vscode.workspace.fs.stat(uri); await vscode.window.showTextDocument(uri); } catch { void vscode.window.showWarningMessage('Report was read by the CLI, but run.json is unavailable at the reported path.'); } } return report; };
  const historyContext = async (): Promise<vscode.WorkspaceFolder | undefined> => { const folder = historyFolder ?? current?.folder ?? await selectFolder(); if (folder) { historyFolder = folder; history.setFolder(folder.uri.toString()); } return folder; };
  const historyFilters = new Map<string, string[]>();
  const presetsFor = (folder: vscode.WorkspaceFolder): ChartPreset[] => [...builtInPresets, ...parseCustomPresets(vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri).get<unknown>('chartPresets', []))];
  const activePreset = (folder: vscode.WorkspaceFolder, source: ChartSource): ChartPreset => {
    const id = context.workspaceState.get<string>(`chartPreset:${source}:${folder.uri.toString()}`);
    return presetsFor(folder).find(preset => preset.source === source && preset.id === id) ?? defaultPreset(source);
  };
  const choosePreset = async (folder: vscode.WorkspaceFolder, source: ChartSource): Promise<ChartPreset | undefined> => {
    const picked = await vscode.window.showQuickPick(presetsFor(folder).filter(preset => preset.source === source).map(preset => ({ label: preset.label, description: preset.id, preset })), { placeHolder: `Chart preset for ${source}` });
    if (picked) { await context.workspaceState.update(`chartPreset:${source}:${folder.uri.toString()}`, picked.preset.id); }
    return picked?.preset;
  };
  const readHarness = async (summaryUri: vscode.Uri) => {
    if (path.basename(summaryUri.fsPath) !== 'summary.json') { throw Error('Select a DagFlow harness summary.json file.'); }
    const runsUri = vscode.Uri.file(path.join(path.dirname(summaryUri.fsPath), 'runs.jsonl'));
    const [summaryStat, runsStat] = await Promise.all([vscode.workspace.fs.stat(summaryUri), vscode.workspace.fs.stat(runsUri)]);
    const limit = 32 * 1024 * 1024;
    if (summaryStat.size > limit || runsStat.size > limit) { throw Error('Harness file exceeds the 32 MB viewing limit.'); }
    const [summary, runs] = await Promise.all([vscode.workspace.fs.readFile(summaryUri), vscode.workspace.fs.readFile(runsUri)]);
    return parseHarness(JSON.parse(Buffer.from(summary).toString('utf8')), Buffer.from(runs).toString('utf8'));
  };
  const refreshHistory = async (): Promise<void> => { const folder = await historyContext(); if (!folder) { return; } const runs = parseHistory(JSON.parse(await call(folder, historyArgs(folder, ['history','runs','--limit','50',...(historyFilters.get(folder.uri.toString()) ?? []),'--json'])))); history.setRuns(folder.uri.toString(), runs); };
  const pickHistoryRun = async (role: string, excludeId?: string): Promise<HistoryRun | undefined> => { if (!trusted()) { return; } if (!history.runs().length) { await refreshHistory(); } const choices = history.runs().filter(run => run.id !== excludeId); if (!choices.length) { void vscode.window.showInformationMessage('No other indexed CMakeWorkflow run was found.'); return; } const picked = await vscode.window.showQuickPick(choices.map(run => ({ label: `${run.status} • ${path.basename(run.workflow ?? run.directory)}`, description: run.startedAt ?? run.id.slice(0, 12), detail: run.id, run })), { placeHolder: `Choose ${role.toLowerCase()} run` }); return picked?.run; };
  const comparisonPair = async (): Promise<[vscode.WorkspaceFolder, string, string] | undefined> => { const folder = await historyContext(); if (!folder || !trusted()) { return; } let pair = history.pair(); if (!pair) { const baseline = await pickHistoryRun('Baseline'); if (!baseline) { return; } history.setBaseline(baseline); manuallyPinnedBaselines.set(folder.uri.toString(), baseline.id); const candidate = await pickHistoryRun('Candidate', baseline.id); if (!candidate) { return; } history.setCandidate(candidate); pair = history.pair(); } if (!pair) { return; } if (pair[0] === pair[1]) { void vscode.window.showWarningMessage('Choose two different runs for baseline and candidate.'); return; } return [folder, pair[0], pair[1]]; };
  const showHistoryDetail = async (run: HistoryRun): Promise<void> => { const folder = await historyContext(); if (!folder || !trusted()) { return; } const detail = parseHistoryDetail(JSON.parse(await call(folder, historyArgs(folder, ['history','show',run.id,'--json'])))); let report: Report | undefined; if (detail.run.format === 'workflow' && detail.run.sourceAvailable) { try { report = parseReport(JSON.parse(await call(folder, ['workflow','report',detail.run.directory,'--json']))); } catch (error) { output.appendLine(`Saved workflow report unavailable: ${String(error)}`); } } trackPanel(openHistoryPanel(detail, activePreset(folder, 'history'), report)); };
  const register = (name: string, fn: (...args: unknown[]) => Promise<void>): void => { context.subscriptions.push(vscode.commands.registerCommand(name, (...args: unknown[]) => { void fn(...args).catch(reportError); })); };
  register('cmakeWorkflow.selectWorkflow', async () => { await selectWorkflow(); });
  register('cmakeWorkflow.configureCli', async () => { const folder = current?.folder ?? await selectFolder(); if (!folder) { return; } const mode = await vscode.window.showQuickPick([
    { label: 'Native executable', description: 'CMakeWorkflow or CMakeWorkflow.exe', value: 'native' },
    { label: '.NET DLL', description: 'Run dotnet path/to/CMakeWorkflow.dll', value: 'dotnet' },
  ], { placeHolder: `Configure CLI for ${folder.name}` }); if (!mode) { return; }
    const files = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: mode.value === 'native' ? 'Choose CMakeWorkflow executable' : 'Choose CMakeWorkflow.dll' }); const file = files?.[0]; if (!file) { return; }
    const config = vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri);
    await config.update('executable', mode.value === 'native' ? file.fsPath : 'dotnet', vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('prefixArgs', mode.value === 'native' ? [] : [file.fsPath], vscode.ConfigurationTarget.WorkspaceFolder);
    tree.status(`CLI configured for ${folder.name}`);
    void vscode.window.showInformationMessage(`CMakeWorkflow CLI configured for ${folder.name}. Use Plan in the sidebar.`);
  });
  register('cmakeWorkflow.openArtifact', async (value: unknown) => { if (typeof value !== 'string') { return; } await vscode.window.showTextDocument(vscode.Uri.file(value)); });
  register('cmakeWorkflow.planWorkflow', async () => { if (!trusted()) { return; } const selection = await choose(); if (selection) { await plan(selection); } });
  register('cmakeWorkflow.showWorkflowGraph', async () => { if (!trusted()) { return; } const selection = await choose(); if (!selection) { return; } const planned = await plan(selection, undefined, true); infoPanel(`Workflow graph: ${path.basename(selection.file.fsPath)}`, `<p>${planned.nodes.length} nodes • ${planned.valid ? 'valid' : 'invalid'} plan</p>${planGraphHtml(planned)}`); });
  const runWorkflow = async (only?: string): Promise<void> => {
    if (!trusted()) { return; }
    const selection = await choose(); if (!selection) { return; }
    const planned = await plan(selection, only);
    if (only) { const confirmation = await vscode.window.showQuickPick([{ label: `Run ${only} and ${planned.nodes.length - 1} prerequisite node(s)`, value: true }], { placeHolder: 'Review the planned dependency closure in the Workflow view, then confirm' }); if (!confirmation) { return; } }
    const config = vscode.workspace.getConfiguration('cmakeWorkflow', selection.folder.uri);
    const args = ['workflow', 'run', selection.file.fsPath, '--json'];
    if (only) { args.push('--only', only); }
    const jobs = configuredJobs(config.inspect<number>('jobs'));
    if (jobs !== undefined) { args.push('--jobs', String(jobs)); }
    const results = config.get<string>('resultsDir');
    if (results) { args.push('--results-dir', results); }
    const database = historyDb(selection.folder);
    if (database) { args.push('--history-db', database); }
    const client = clientFor(selection.folder);
    activeClients.add(client);
    tree.status('Running workflow…');
    let indexedRuns: HistoryRun[] = [];
    let completedReport: Report | undefined;
    let runDirectory: string | undefined;
    let finished = false;
    let streamError: Error | undefined;
    const sequence = new EventSequence(event => {
      if (runDirectory && runDirectory !== event.runDirectory) { throw Error('Run directory changed in event stream'); }
      runDirectory = event.runDirectory;
      if (event.type === 'workflow_finished') { finished = true; }
      tree.event(event);
    });
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'CMakeWorkflow running', cancellable: true }, async (_progress, token) => {
        const cancel = token.onCancellationRequested(() => {
          output.appendLine('Cancellation requested; waiting for CLI shutdown (Windows uses forced process-tree termination).');
          client.cancel();
        });
        try {
          const result = await client.run(args, line => {
            try { sequence.push(parseEvent(JSON.parse(line))); }
            catch (error) { streamError = error as Error; output.appendLine(`Invalid JSONL event: ${line}\n${String(error)}`); }
          }, text => output.append(text));
          try { sequence.finish(); } catch (error) { streamError = error as Error; }
          let saved: Report | undefined;
          if (runDirectory) {
            lastRuns.set(selection.folder.uri.toString(), runDirectory);
            saved = await openReport(selection.folder, runDirectory);
            try {
              const runs = parseHistory(JSON.parse(await call(selection.folder, historyArgs(selection.folder, ['history', 'runs', '--limit', '50', '--json']))));
              indexedRuns = runs;
              history.setRuns(selection.folder.uri.toString(), runs);
            } catch (error) { output.appendLine(`History refresh failed: ${String(error)}`); }
          }
          const problem = messageFor(result, 'Run workflow');
          if (problem || streamError || !finished || saved?.status !== 'succeeded') {
            throw Error(problem ?? streamError?.message ?? (!finished ? 'Workflow event stream ended without workflow_finished.' : `Workflow report status: ${saved?.status ?? 'missing'}`));
          }
          completedReport = saved;
        } finally { cancel.dispose(); }
      });
      if (runDirectory && completedReport && config.get<boolean>('autoPresentResults', true)) {
        // End the execution progress notification before fetching historical
        // comparisons; UI/reporting errors never change the run's exit status.
        try { await presentCompletedRun(selection.folder, runDirectory, completedReport, indexedRuns); }
        catch (error) { output.appendLine(`Automatic results view unavailable: ${String(error)}`); }
      }
    } finally { activeClients.delete(client); client.dispose(); }
  };
  // Profile statistically confirmed regressions. The native case recipe is
  // selected by History's scenario/variant grouping; only the C# backend
  // validates and executes the saved original benchmark binary.
  const autoDiagnoseRegression = async (folder: vscode.WorkspaceFolder,
    baseline: HistoryDetail, candidate: HistoryDetail): Promise<void> => {
    const config = vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri);
    if (!config.get<boolean>('autoProfileRegressions', false)) { return; }
    const minimum = config.get<number>('regressionMinimumEffectPercent', 5);
    if (!Number.isFinite(minimum) || minimum <= 0 || minimum > 100) { return; }
    const ranked = ['run_p50_us', 'run_p99_us', 'payload_tasks_per_second', 'process_wall_time'];
    const available = [...new Set(candidate.measurements.map(m => m.metric))];
    const metrics = [...ranked.filter(m => available.includes(m)),
      ...available.filter(m => /(?:latency|duration|elapsed)_us$/.test(m) && !ranked.includes(m))].slice(0, 6);
    let replay: string[] | undefined;
    for (const metric of metrics) {
      const direction = /(?:throughput|per_second)/.test(metric) ? 'lower-worse' : 'higher-worse';
      const test = parseHistoryDetection(JSON.parse(await call(folder, historyArgs(folder,
        ['history', 'detect', baseline.run.id, candidate.run.id, '--metric', metric,
          '--direction', direction, '--min-percent', String(minimum), '--json']))));
      for (const row of test.results.filter(r => r.status === 'regression'
        && r.adjustedPValue !== null && r.adjustedPValue <= test.alpha)) {
        const shared = candidate.measurements.find(m => m.metric === metric
          && m.variant === row.variant && m.scenario === row.scenario && m.nodeId
          && baseline.measurements.some(other => other.metric === metric && other.nodeId === m.nodeId
            && other.scenario === m.scenario && other.variant === m.variant));
        if (!shared?.nodeId) { continue; }
        const beforeNode = baseline.nodes.find(n => n.id === shared.nodeId);
        const afterNode = candidate.nodes.find(n => n.id === shared.nodeId);
        if (!beforeNode || !afterNode || beforeNode.kind !== afterNode.kind) { continue; }
        if (beforeNode.kind === 'run' && shared.method === 'uninstrumented process wall time') {
          replay = ['--node', shared.nodeId];
        } else if (beforeNode.kind === 'invoke' && shared.method === 'dagflow-harness' && shared.scenario) {
          replay = ['--node', shared.nodeId, '--case', shared.scenario];
          if (shared.variant?.startsWith('harness-')) {
            const index = Number(shared.variant.slice('harness-'.length));
            if (!Number.isInteger(index) || index < 0 || index > 1000) { replay = undefined; continue; }
            replay.push('--harness', String(index));
          }
        }
        if (replay) { break; }
      }
      if (replay) { break; }
    }
    if (!replay) {
      output.appendLine('No statistically confirmed, native-replayable regression found. Harness cases require saved replayCases provenance and binary snapshots.');
      return;
    }
    const client = clientFor(folder);
    activeClients.add(client);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `CMakeWorkflow profiling regression: ${replay.join(' ')}`, cancellable: true }, async (_progress, token) => {
        const cancellation = token.onCancellationRequested(() => client.cancel());
        try {
          const args = ['profile', 'replay', baseline.run.directory, candidate.run.directory,
            ...replay!, '--results-dir', path.join(folder.uri.fsPath, 'out', 'profiles')];
          const result = await client.run(args, undefined, line => output.append(line));
          const error = messageFor(result, 'Profile regression');
          if (error) { output.appendLine(`Automatic profiler skipped/failed: ${error}`); return; }
          const directory = result.stdout.split(/\r?\n/).find(line => line.startsWith('Profile replay: '))?.slice('Profile replay: '.length);
          if (directory) { await showProfileDirectory(vscode.Uri.file(directory)); }
          else { output.appendLine('Profiler finished without a saved replay directory.'); }
        } finally { cancellation.dispose(); }
      });
    } finally { activeClients.delete(client); client.dispose(); }
  };

  const presentCompletedRun = async (folder: vscode.WorkspaceFolder, directory: string,
    report: Report, runs: HistoryRun[]): Promise<void> => {
    const candidate = runs.find(run => run.directory === directory);
    if (!candidate) {
      output.appendLine(`Workflow completed; no indexed History row for ${directory}. Open the saved report manually.`);
      return;
    }
    const candidateDetail = parseHistoryDetail(JSON.parse(await call(folder,
      historyArgs(folder, ['history', 'show', candidate.id, '--json']))));
    if (!candidateDetail.measurements.length) {
      output.appendLine('Workflow completed without indexed measurements; showing execution report.');
      trackPanel(openHistoryPanel(candidateDetail, activePreset(folder, 'history'), report));
      return;
    }
    const baselines = automaticBaselines(runs, candidate,
      manuallyPinnedBaselines.get(folder.uri.toString())).slice(0, 8);
    for (const baseline of baselines) {
      try {
        const rows = parseHistoryComparison(JSON.parse(await call(folder,
          historyArgs(folder, ['history', 'compare', baseline.id, candidate.id, '--json']))));
        if (!hasCompatibleMeasurements(rows,
          candidateDetail.measurements.some(measurement => measurement.method === 'dagflow-harness')
            ? 'dagflow-harness' : undefined)) { continue; }
        const baselineDetail = parseHistoryDetail(JSON.parse(await call(folder,
          historyArgs(folder, ['history', 'show', baseline.id, '--json']))));
        history.setBaseline(baseline);
        history.setCandidate(candidate);
        history.setComparisons(rows);
        trackPanel(openComparisonPanel(baselineDetail, candidateDetail, rows, activePreset(folder, 'history'),
          await loadComparisonEvidence(baselineDetail, candidateDetail)));
        output.appendLine(`Automatically compared ${baseline.id} -> ${candidate.id}; CLI confirms compatible measurements.`);
        void autoDiagnoseRegression(folder, baselineDetail, candidateDetail)
          .catch(error => output.appendLine(`Automatic regression diagnosis unavailable: ${String(error)}`));
        return;
      } catch (error) { output.appendLine(`Skipped candidate baseline ${baseline.id}: ${String(error)}`); }
    }
    trackPanel(openHistoryPanel(candidateDetail, activePreset(folder, 'history'), report));
    output.appendLine('No previous compatible benchmark run found; showing current measurements.');
  };
  register('cmakeWorkflow.runWorkflow', async () => { await runWorkflow(); });
  register('cmakeWorkflow.runNode', async (value: unknown) => { if (value instanceof Item && value.kind === 'node' && value.state) { await runWorkflow(value.state.node.id); } });
  register('cmakeWorkflow.openLastReport', async () => { if (!trusted()) { return; } const selection = await choose(); if (!selection) { return; } const directory = lastRuns.get(selection.folder.uri.toString()); if (!directory) { throw Error('No run recorded in this session for this workspace folder.'); } await openReport(selection.folder, directory, true); });
  register('cmakeWorkflow.showHistory', async () => { if (!trusted()) { return; } await refreshHistory(); });
  register('cmakeWorkflow.selectHistoryWorkspace', async () => { const folder = await selectFolder(); if (!folder || !trusted()) { return; } historyFolder = folder; history.setFolder(folder.uri.toString()); await refreshHistory(); });
  register('cmakeWorkflow.chooseHistoryDb', async () => { if (!trusted()) { return; } const folder = await historyContext(); if (!folder) { return; } const files = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(path.join(folder.uri.fsPath, 'out')), canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { SQLite: ['sqlite', 'db'] }, openLabel: 'Choose History Database' }); const file = files?.[0]; if (!file) { return; } const relative = path.relative(folder.uri.fsPath, file.fsPath); const setting = relative.startsWith('..') || path.isAbsolute(relative) ? file.fsPath : relative; await vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri).update('historyDb', setting, vscode.ConfigurationTarget.WorkspaceFolder); manuallyPinnedBaselines.delete(folder.uri.toString()); history.clearSelection(); await refreshHistory(); });
  register('cmakeWorkflow.filterHistory', async () => {
    const folder = await historyContext(); if (!folder || !trusted()) { return; }
    const field = await vscode.window.showQuickPick([
      { label: 'Status', option: '--status' }, { label: 'Since (ISO timestamp)', option: '--since' },
      { label: 'Until (ISO timestamp)', option: '--until' }, { label: 'Workflow text', option: '--workflow' },
      { label: 'Variant', option: '--variant' }, { label: 'Clear filters', option: '' },
    ], { placeHolder: 'Filter indexed history runs' }); if (!field) { return; }
    if (!field.option) { historyFilters.delete(folder.uri.toString()); await refreshHistory(); return; }
    const currentFilters = historyFilters.get(folder.uri.toString()) ?? [];
    const position = currentFilters.indexOf(field.option);
    const value = await vscode.window.showInputBox({ prompt: `${field.label}; leave blank to remove this filter`, value: position >= 0 ? currentFilters[position + 1] : '' }); if (value === undefined) { return; }
    const next = currentFilters.filter((_entry, index) => position < 0 || (index !== position && index !== position + 1));
    if (value.trim()) { next.push(field.option, value.trim()); }
    historyFilters.set(folder.uri.toString(), next);
    await refreshHistory();
  });
  register('cmakeWorkflow.importHistory', async () => {
    const folder = await historyContext(); if (!folder || !trusted()) { return; }
    const folders = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Import saved results' });
    const directory = folders?.[0]; if (!directory) { return; }
    const recursive = await vscode.window.showQuickPick([{ label: 'This directory', flag: false }, { label: 'This directory and subdirectories', flag: true }], { placeHolder: 'Import scope' }); if (!recursive) { return; }
    const args = ['history','import',directory.fsPath,'--json']; if (recursive.flag) { args.push('--recursive'); }
    const result = JSON.parse(await call(folder, historyArgs(folder, args))) as Record<string, unknown>;
    if (result.schemaVersion !== 1 || !['imported','unchanged','skipped'].every(key => Number.isSafeInteger(result[key]))) { throw Error('Invalid history import result'); }
    await refreshHistory();
    void vscode.window.showInformationMessage(`History: ${result.imported} imported, ${result.unchanged} unchanged, ${result.skipped} skipped.`);
  });
  register('cmakeWorkflow.historyTrend', async () => {
    const folder = await historyContext(); if (!folder || !trusted()) { return; }
    if (!history.runs().length) { await refreshHistory(); }
    if (!history.runs().length) { void vscode.window.showInformationMessage('No indexed runs in the current history view.'); return; }
    const metric = await vscode.window.showInputBox({ prompt: 'Exact CLI history metric name', value: 'process_wall_time', validateInput: text => text.trim() ? undefined : 'Enter a metric' }); if (!metric) { return; }
    const samples = parseTrendSamples(JSON.parse(await call(folder, historyArgs(folder, ['history','query','--metric',metric.trim(),'--json']))));
    const recentIds = new Set(history.runs().map(run => run.id));
    const identities = [...new Set(samples.filter(sample => recentIds.has(sample.runId)).map(trendIdentity))];
    if (!identities.length) { void vscode.window.showInformationMessage(`No indexed ${metric} samples in the current 50-run history view.`); return; }
    const choice = identities.length === 1 ? identities[0] : (await vscode.window.showQuickPick(identities.map(id => ({ label: trendLabel(id), id })), { placeHolder: 'Choose unit, variant, scenario and method' }))?.id;
    if (choice) { infoPanel(`History trend: ${metric}`, renderTrendHtml(history.runs(), samples, choice)); }
  });
  register('cmakeWorkflow.toolingDoctor', async () => {
    const folder = await historyContext(); if (!folder || !trusted()) { return; }
    const profiles = toolingProfiles(JSON.parse(await call(folder, ['tooling','list','--json'])));
    const profile = await vscode.window.showQuickPick(profiles.map(item => ({ label: item.id, description: item.description })), { placeHolder: 'Check tools for a profile' }); if (!profile) { return; }
    const result = JSON.parse(await callWithCodes(folder, ['tooling','doctor','--profile',profile.label,'--json'], [0, 2]));
    infoPanel(`CMakeWorkflow tools: ${profile.label}`, toolingPlanHtml(result));
  });
  register('cmakeWorkflow.inspectBuildTree', async () => {
    const folder = await historyContext(); if (!folder || !trusted()) { return; }
    const picked = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Inspect Build Tree' }); const directory = picked?.[0]; if (!directory) { return; }
    const observed = inspectContext(JSON.parse(await call(folder, ['context','inspect',directory.fsPath,'--json'])));
    infoPanel(`Build tree: ${path.basename(directory.fsPath)}`, contextHtml(observed));
  });
  register('cmakeWorkflow.resolveTarget', async () => {
    const folder = await historyContext(); if (!folder || !trusted()) { return; }
    const picked = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Choose Build Tree' }); const directory = picked?.[0]; if (!directory) { return; }
    const observed = inspectContext(JSON.parse(await call(folder, ['context','inspect',directory.fsPath,'--json'])));
    const executableTargets = observed.targets.filter(target => target.type === 'EXECUTABLE');
    if (!executableTargets.length) { void vscode.window.showInformationMessage('No executable targets were observed in this build tree.'); return; }
    const pickedTarget = await vscode.window.showQuickPick(executableTargets.map(target => ({ label: target.name, description: target.configuration, target })), { placeHolder: 'Resolve an executable target without building' }); if (!pickedTarget) { return; }
    const args = ['target','resolve','--build-dir',directory.fsPath,'--target',pickedTarget.target.name]; if (pickedTarget.target.configuration) { args.push('--config', pickedTarget.target.configuration); } args.push('--json');
    infoPanel(`Target: ${pickedTarget.target.name}`, resolvedTargetHtml(JSON.parse(await call(folder, args))));
  });
  const showProfileDirectory = async (directory: vscode.Uri): Promise<void> => {
    const entries = await vscode.workspace.fs.readDirectory(directory);
    const names = entries.filter(([name, type]) => type === vscode.FileType.File && (['analysis.json','comparison.json','counter-comparison.json'].includes(name) || name.endsWith('.results.json'))).map(([name]) => name);
    const files: Record<string, unknown> = {};
    for (const name of names) { const uri = vscode.Uri.file(path.join(directory.fsPath, name)); const stat = await vscode.workspace.fs.stat(uri); if (stat.size > 16 * 1024 * 1024) { throw Error(`${name} exceeds the 16 MB viewing limit.`); } files[name] = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')); }
    const presentation = presentProfileResults(directory.fsPath, files,
      await loadStandaloneProfileEvidence(directory.fsPath));
    const panel = vscode.window.createWebviewPanel('cmakeWorkflow.profileResults', `Profile: ${path.basename(directory.fsPath)}`, vscode.ViewColumn.Active, { enableScripts: true });
    const nonce = randomBytes(16).toString('base64');
    panel.webview.html = informationHtml('Saved profile results', presentation.body, nonce, "const vscode=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('button[data-artifact]');if(button)vscode.postMessage({index:Number(button.dataset.artifact)});});");
    const receiver = panel.webview.onDidReceiveMessage(async (message: unknown) => { const request = message as { index?: unknown }; if (!Number.isSafeInteger(request?.index)) { return; } const artifact = presentation.artifacts[request.index as number]; if (!artifact) { return; } try { const uri = vscode.Uri.file(artifact.path); const stat = await vscode.workspace.fs.stat(uri); if (stat.type === vscode.FileType.Directory) { await vscode.commands.executeCommand('revealFileInOS', uri); } else { await vscode.commands.executeCommand('vscode.open', uri); } } catch { void vscode.window.showWarningMessage(`Profile artifact is unavailable: ${artifact.path}`); } });
    panel.onDidDispose(() => receiver.dispose()); trackPanel(panel);
  };
  register('cmakeWorkflow.openProfileResults', async () => {
    const folder = await historyContext(); if (!folder) { return; }
    const picked = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Open Saved Profile Results' }); const directory = picked?.[0]; if (!directory) { return; }
    await showProfileDirectory(directory);
  });
  register('cmakeWorkflow.selectChartPreset', async () => { const folder = await historyContext(); if (!folder) { return; } const source = await vscode.window.showQuickPick([{ label: 'CLI history', value: 'history' as const }, { label: 'DagFlow harness', value: 'dagflow' as const }], { placeHolder: 'Select chart source' }); if (source) { await choosePreset(folder, source.value); } });
  register('cmakeWorkflow.createChartPreset', async () => {
    const folder = await historyContext(); if (!folder) { return; }
    const source = await vscode.window.showQuickPick([{ label: 'CLI history', value: 'history' as const }, { label: 'DagFlow harness', value: 'dagflow' as const }], { placeHolder: 'Preset source' }); if (!source) { return; }
    const label = await vscode.window.showInputBox({ prompt: 'Preset name', validateInput: value => value.trim() ? undefined : 'Enter a name' }); if (!label) { return; }
    const metrics = await vscode.window.showInputBox({ prompt: 'Metric names separated by commas; * selects all', value: '*' }); if (metrics === undefined) { return; }
    const cases = await vscode.window.showInputBox({ prompt: 'Optional case/scenario name fragments separated by commas', value: '' }); if (cases === undefined) { return; }
    const preset: ChartPreset = { id: `custom-${randomBytes(8).toString('hex')}`, label: label.trim(), source: source.value, metrics: metrics.split(',').map(x => x.trim()).filter(Boolean), cases: cases.split(',').map(x => x.trim()).filter(Boolean) };
    const config = vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri);
    const existing = parseCustomPresets(config.get<unknown>('chartPresets', []));
    if (!preset.metrics.length) { throw Error('Choose at least one metric.'); }
    await config.update('chartPresets', [...existing, preset], vscode.ConfigurationTarget.WorkspaceFolder);
    await context.workspaceState.update(`chartPreset:${source.value}:${folder.uri.toString()}`, preset.id);
    void vscode.window.showInformationMessage(`Chart preset “${preset.label}” created and selected for ${folder.name}.`);
  });
  register('cmakeWorkflow.compareDagFlowHarness', async () => {
    const folder = await historyContext(); if (!folder) { return; }
    const pick = async (role: string): Promise<vscode.Uri | undefined> => (await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] }, openLabel: `Choose ${role} summary.json` }))?.[0];
    const baseUri = await pick('baseline'); if (!baseUri) { return; }
    const candidateUri = await pick('candidate'); if (!candidateUri) { return; }
    if (baseUri.toString() === candidateUri.toString()) { throw Error('Choose two different harness summaries.'); }
    const [baseline, candidate] = await Promise.all([readHarness(baseUri), readHarness(candidateUri)]);
    const preset = activePreset(folder, 'dagflow');
    const panel = vscode.window.createWebviewPanel('cmakeWorkflow.harnessComparison', 'DagFlow: Harness Comparison', vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.html = renderHarnessHtml(baseline, candidate, baseUri.fsPath, candidateUri.fsPath, preset, randomBytes(16).toString('base64'));
    trackPanel(panel);
  });
  register('cmakeWorkflow.historyDetails', async (value: unknown) => { const run = historyRunFromCommand(value); if (run) { await showHistoryDetail(run); } });
  register('cmakeWorkflow.pickBaseline', async () => { const run = await pickHistoryRun('Baseline'); if (run) { history.setBaseline(run); const folder = await historyContext(); if (folder) { manuallyPinnedBaselines.set(folder.uri.toString(), run.id); } } });
  register('cmakeWorkflow.pickCandidate', async () => { const run = await pickHistoryRun('Candidate', history.baselineId()); if (run) { history.setCandidate(run); } });
  register('cmakeWorkflow.setBaseline', async (value: unknown) => { const run = historyRunFromCommand(value); if (run) { history.setBaseline(run); const folder = await historyContext(); if (folder) { manuallyPinnedBaselines.set(folder.uri.toString(), run.id); } } });
  register('cmakeWorkflow.setCandidate', async (value: unknown) => { const run = historyRunFromCommand(value); if (run) { history.setCandidate(run); } });
  register('cmakeWorkflow.compareHistory', async () => { const pair = await comparisonPair(); if (!pair) { return; } const [folder, baseline, candidate] = pair; const rows = parseHistoryComparison(JSON.parse(await call(folder, historyArgs(folder, ['history','compare',baseline,candidate,'--json'])))); history.setComparisons(rows);
    const [baselineDetail, candidateDetail] = await Promise.all([
      call(folder, historyArgs(folder, ['history','show',baseline,'--json'])).then(text => parseHistoryDetail(JSON.parse(text))),
      call(folder, historyArgs(folder, ['history','show',candidate,'--json'])).then(text => parseHistoryDetail(JSON.parse(text))),
    ]);
    trackPanel(openComparisonPanel(baselineDetail, candidateDetail, rows, activePreset(folder, 'history'),
          await loadComparisonEvidence(baselineDetail, candidateDetail)));
    if (rows.length === 1 && rows[0].metric === '*') { void vscode.window.showWarningMessage(`${rows[0].reason ?? 'No indexed measurements to compare.'} Baseline: ${baselineDetail.measurements.length} samples; candidate: ${candidateDetail.measurements.length}. Choose two measured runs, or use Compare DagFlow Harness Results for invoke campaigns.`); }
  });
  register('cmakeWorkflow.detectRegression', async () => { const pair = await comparisonPair(); if (!pair) { return; } const [folder, baseline, candidate] = pair;
    let rows = history.comparisons(); if (!rows) { rows = parseHistoryComparison(JSON.parse(await call(folder, historyArgs(folder, ['history','compare',baseline,candidate,'--json'])))); history.setComparisons(rows); }
    const metrics = [...new Set(rows.map(row => row.metric).filter(metric => metric !== '*'))];
    if (!metrics.length) { void vscode.window.showInformationMessage('These runs have no indexed measurements for a statistical test.'); return; }
    const metric = await vscode.window.showQuickPick(metrics, { placeHolder: 'Metric to test' }); if (!metric) { return; }
    const direction = await vscode.window.showQuickPick([
      { label: 'Higher is worse', value: 'higher-worse' },
      { label: 'Lower is worse', value: 'lower-worse' },
    ], { placeHolder: 'Declare the regression direction' }); if (!direction) { return; }
    const minimum = await vscode.window.showInputBox({ prompt: 'Minimum practical effect, percent', value: '5', validateInput: text => { const number = Number(text); return Number.isFinite(number) && number > 0 ? undefined : 'Enter a positive number'; } }); if (minimum === undefined) { return; }
    const report = parseHistoryDetection(JSON.parse(await call(folder, historyArgs(folder, ['history','detect',baseline,candidate,'--metric',metric,'--direction',direction.value,'--min-percent',minimum,'--json']))));
    history.setDetection(report);
    if (report.results.every(row => row.pValue === null)) { void vscode.window.showInformationMessage('No statistical verdict: expand the test results for CLI diagnostics.'); }
  });
  context.subscriptions.push({ dispose: () => { for (const client of activeClients) { client.dispose(); } activeClients.clear(); } });
}
export function deactivate(): void { for (const client of activeClients) { client.dispose(); } activeClients.clear(); }
