import { nodeDetailsHtml, operationDetailsHtml } from './operationDetails';
import type { HistoryIndexStatus, HistoryPolicy } from './historyProtocol';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostClient } from './hostClient';
import { HostProcess } from './hostProcess';
import { configuredJobs } from './settings';
import { toolDirectory, toolEnvironment } from './toolEnvironment';
import { escapeHtml } from './inspectionHtml';
import type { Event, Plan, Report } from './protocol';
import type { OperationReference, WorkflowStartRequest } from './durableProtocol';
import { OperationsView } from './operationsView';
import { downloadOperationArtifact } from './operationArtifacts';

interface Selection { folder: vscode.WorkspaceFolder; file: vscode.Uri }
type Pending = WorkflowStartRequest;
interface LastOperation { operationId: string; clientRequestId: string }

export interface DurableServices {
  register(name: string, action: (...args: unknown[]) => Promise<void>): void;
  trusted(): boolean;
  choose(): Promise<Selection | undefined>;
  folder(): Promise<vscode.WorkspaceFolder | undefined>;
  onPlan(selection: Selection, plan: Plan): void;
  onHistoryStatus?(folder: vscode.WorkspaceFolder, status: HistoryIndexStatus): void;
  onReport(folder: vscode.WorkspaceFolder, report: Report, directory: string, operationId: string): Promise<void>;
  status(message: string): void;
  openHistoryDatabase?(folder: vscode.WorkspaceFolder, databasePath: string): Promise<void>;
  show(title: string, body: string, panelKey?: string): void;
}

// This Host has a separate lifecycle from the request. Closing one RPC client
// does not cancel an accepted workflow. Stopping the Host DOES interrupt execution.
export function registerDurableCommands(context: vscode.ExtensionContext, services: DurableServices,
  output: vscode.OutputChannel) {
  const operationsView = new OperationsView(context.workspaceState);
  context.subscriptions.push(operationsView, vscode.window.registerTreeDataProvider('cmakeWorkflow.operations', operationsView));
  const hosts = new Map<string, HostProcess>();
  const busy = new Set<string>();
  const following = new Set<string>();
  const active = new Set<HostClient>();
  const stop = (key: string): void => { hosts.get(key)?.dispose(); hosts.delete(key); operationsView.clearListing(key); };
  context.subscriptions.push({ dispose: () => {
    for (const client of active) { client.dispose(); }
    for (const key of hosts.keys()) { stop(key); }
  } }, vscode.workspace.onDidChangeWorkspaceFolders(event => {
    for (const folder of event.removed) { stop(folder.uri.toString()); }
  }), vscode.workspace.onDidChangeConfiguration(event => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (['executable', 'prefixArgs', 'hostEndpoint', 'toolingInstallDirectory'].some(key =>
        event.affectsConfiguration(`cmakeWorkflow.${key}`, folder.uri))) { stop(folder.uri.toString()); }
    }
  }));

  const connect = async (folder: vscode.WorkspaceFolder): Promise<{ client: HostClient; release(): void }> => {
    const config = vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri);
    const key = folder.uri.toString();
    let endpoint = config.get<string>('hostEndpoint', '').trim();
    if (!endpoint) {
      let host = hosts.get(key);
      if (!host || host.exited) {
        const executable = config.get<string>('executable', 'CMakeWorkflow').trim();
        const prefixArgs = config.get<string[]>('prefixArgs', []);
        if (!executable || !Array.isArray(prefixArgs) || !prefixArgs.every(arg => typeof arg === 'string')) {
          throw Error('Configure cmakeWorkflow.executable and prefixArgs.');
        }
        host = new HostProcess({ executable, prefixArgs, cwd: folder.uri.fsPath,
          env: toolEnvironment(toolDirectory(config.get<string>('toolingInstallDirectory', ''), folder.uri.fsPath)) }, text => output.append(text));
        hosts.set(key, host);
      }
      endpoint = await host.start();
    }
    const { client } = await HostClient.connect(endpoint, folder.uri.fsPath);
    active.add(client);
    return { client, release: () => { active.delete(client); client.dispose(); } };
  };
  const pendingKey = (folder: vscode.WorkspaceFolder) => `durablePending:${folder.uri.toString()}`;
  const operationKey = (folder: vscode.WorkspaceFolder) => `durableOperation:${folder.uri.toString()}`;
  const ensure = (client: HostClient, ...methods: string[]): void => {
    for (const method of methods) {
      if (!client.supports(method)) { throw Error(`Host does not advertise ${method}. Install a newer CMakeWorkflow Host.`); }
    }
  };
  const chooseOperation = async (folder: vscode.WorkspaceFolder, client: HostClient): Promise<OperationReference | undefined> => {
    ensure(client, 'operations/get', 'operations/find');
    // Resolve an uncertain start BEFORE falling back to the last known operation.
    // Otherwise a lost second start response would be hidden by an older run.
    const pending = context.workspaceState.get<Pending>(pendingKey(folder));
    if (pending) {
      const found = await client.findOperation(pending.clientRequestId);
      await context.workspaceState.update(operationKey(folder), { operationId: found.operationId, clientRequestId: found.clientRequestId });
      await context.workspaceState.update(pendingKey(folder), undefined);
      await operationsView.track(folder, { operationId: found.operationId, clientRequestId: found.clientRequestId,
        manifest: pending.manifest, submittedAt: new Date().toISOString() });
      return found;
    }
    const last = context.workspaceState.get<LastOperation>(operationKey(folder));
    if (last) { return client.getOperation(last.operationId); }
    void vscode.window.showInformationMessage('No durable Host operation was started in this workspace.');
    return;
  };
  const withOperation = async (action: (folder: vscode.WorkspaceFolder, client: HostClient) => Promise<void>): Promise<void> => {
    if (!services.trusted()) { return; }
    const folder = await services.folder(); if (!folder) { return; }
    const key = folder.uri.toString();
    if (busy.has(key)) { void vscode.window.showInformationMessage('A durable Host command is already in progress for this workspace.'); return; }
    busy.add(key);
    try { const connection = await connect(folder); try { await action(folder, connection.client); } finally { connection.release(); } }
    finally { busy.delete(key); }
  };

  const runWorkflow = async (selectNodes: boolean, selectedIds?: string[]): Promise<void> => {
    if (!services.trusted()) { return; }
    const selection = await services.choose(); if (!selection) { return; }
    const key = selection.folder.uri.toString();
    if (busy.has(key)) { void vscode.window.showInformationMessage('A durable Host command is already in progress for this workspace.'); return; }
    const pending = context.workspaceState.get<Pending>(pendingKey(selection.folder));
    if (pending) {
      const choice = await vscode.window.showWarningMessage(
        'A previous Host start has an unknown acceptance result. Inspect it before launching another workflow.',
        { modal: true }, 'Start New Anyway');
      if (choice !== 'Start New Anyway') { return; }
    }
    busy.add(key);
    try {
      const connection = await connect(selection.folder);
      try {
        const client = connection.client;
        ensure(client, 'workflow/plan', 'workflow/start', 'operations/find');
        services.status('Planning via Host…');
        const planned = await client.planWorkflow(selection.file.fsPath);
        let only = selectedIds;
        if (selectNodes || only?.length) {
          ensure(client, 'workflow/nodeSelection', 'workflow/preflight');
          if (selectNodes) {
            const nodes = await vscode.window.showQuickPick(planned.nodes.map(node => ({
              label: node.id, description: `${node.kind} • ${node.target}`,
            })), { canPickMany: true, placeHolder: 'Select workflow nodes to run with their prerequisites' });
            if (!nodes?.length) { return; }
            only = nodes.map(node => node.label);
          }
        } else {
          services.onPlan(selection, planned);
          if (!planned.valid) { throw Error('Host workflow plan is invalid. Inspect its node diagnostics.'); }
        }
        const config = vscode.workspace.getConfiguration('cmakeWorkflow', selection.folder.uri);
        let historyPolicy: HistoryPolicy | undefined;
        if (client.supports('workflow/historyPolicy')) {
          const configured = config.get<string>('historyDb', '').trim();
          const disabled = config.get<boolean>('noHistory', false);
          const choices = [
            { label: 'Default', description: 'Workspace History database', mode: 'Default' as const },
            { label: 'Disabled', description: 'Skip History indexing', mode: 'Disabled' as const },
            { label: 'Explicit Database', description: 'Choose a database within the workspace', mode: 'ExplicitDatabase' as const },
          ];
          const preferred = disabled ? 'Disabled' : configured ? 'ExplicitDatabase' : 'Default';
          const selected = await vscode.window.showQuickPick(
            [...choices.filter(item => item.mode === preferred), ...choices.filter(item => item.mode !== preferred)],
            { placeHolder: 'Choose History indexing for this run' });
          if (!selected) { return; }
          if (selected.mode === 'ExplicitDatabase') {
            const value = await vscode.window.showInputBox({ prompt: 'History database path on the workspace host',
              value: configured, validateInput: input => input.trim() ? undefined : 'Enter a database path.' });
            if (value === undefined) { return; }
            historyPolicy = { mode: selected.mode, databasePath: path.resolve(selection.folder.uri.fsPath, value.trim()) };
          } else {
            historyPolicy = { mode: selected.mode };
          }
        }
        const jobs = configuredJobs(config.inspect<number>('jobs')) ?? 1;
        const root = config.get<string>('resultsDir', '').trim() || 'out/results';
        const outputRoot = path.resolve(selection.folder.uri.fsPath, root);
        const relative = path.relative(selection.folder.uri.fsPath, outputRoot);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw Error('Host requires cmakeWorkflow.resultsDir to be inside the workspace.');
        }
        // The Host checks the exact manifest hash again before durable admission.
        const input = { manifest: selection.file.fsPath,
          manifestSha256: planned.manifestHash, jobs, resultsDirectory: path.join(outputRoot, `host-${randomUUID()}`), only, historyPolicy };
        if (!/^[0-9a-f]{64}$/i.test(input.manifestSha256)) { throw Error('Invalid manifest hash from Host plan.'); }
        let admission = input;
        if (client.supports('workflow/preflight')) {
          const reviewed = await client.preflightWorkflow(input);
          services.onPlan(selection, reviewed.plan);
          if (reviewed.historyPolicy?.mode !== historyPolicy?.mode) { throw Error('Host preflight returned a different History policy.'); }
          admission = { ...input, historyPolicy: reviewed.historyPolicy };
          if (!reviewed.plan.valid) { throw Error('Host workflow preflight failed. Inspect its node diagnostics.'); }
          if (only?.length) {
            const reviewedIds = new Set(reviewed.only);
            if (reviewedIds.size !== only.length || only.some(id => !reviewedIds.has(id))) {
              throw Error('Host preflight returned a different workflow selection.');
            }
            const answer = await vscode.window.showInformationMessage(
              `Run ${reviewed.plan.nodes.length} nodes including prerequisites?`, { modal: true }, 'Run Nodes');
            if (answer !== 'Run Nodes') { return; }
          }
        }
        const request: Pending = { ...admission, clientRequestId: randomUUID() };
        await context.workspaceState.update(pendingKey(selection.folder), request);
        operationsView.refresh();
        services.status('Submitting workflow to Host…');
        try {
          const accepted = await client.startWorkflow(request);
          await context.workspaceState.update(operationKey(selection.folder), {
            operationId: accepted.operationId, clientRequestId: accepted.clientRequestId,
          } satisfies LastOperation);
          await context.workspaceState.update(pendingKey(selection.folder), undefined);
          await operationsView.track(selection.folder, { operationId: accepted.operationId,
            clientRequestId: accepted.clientRequestId, manifest: request.manifest, submittedAt: new Date().toISOString() });
          services.status(`Host operation ${accepted.state}`);
          output.appendLine(`Host accepted ${accepted.operationId}: ${accepted.state} (request ${request.clientRequestId})`);
          void vscode.window.showInformationMessage(`Host accepted workflow ${accepted.operationId.slice(0, 12)}. Use Inspect Host Operation to track it.`);
        } catch (error) {
          operationsView.refresh();
          output.appendLine(`Host start result unknown for request ${request.clientRequestId}: ${String(error)}. Use Inspect Host Operation; do not automatically resubmit.`);
          throw Error(`Host start response unavailable. Request ${request.clientRequestId} may already be accepted. Inspect before retrying. ${String(error)}`);
        }
      } finally { connection.release(); }
    } finally { busy.delete(key); }
  };
  services.register('cmakeWorkflow.runWorkflow', () => runWorkflow(false));
  services.register('cmakeWorkflow.runDurableWorkflow', () => runWorkflow(false));
  services.register('cmakeWorkflow.runSelectedNodes', () => runWorkflow(true));
  services.register('cmakeWorkflow.runSelectedNodesViaHost', () => runWorkflow(true));

  const updateHistory = async (folder: vscode.WorkspaceFolder, client: HostClient, id: string, signal?: AbortSignal) => {
    if (!client.supports('history/indexStatus')) { return; }
    try {
      const status = await client.historyIndexStatus(id, signal);
      operationsView.setHistory(folder, status);
      if (operationsView.records(folder)[0]?.operationId === status.operationId) { services.onHistoryStatus?.(folder, status); }
      return status;
    }
    catch (error) { if (!signal?.aborted) { output.appendLine(`History status for ${id}: ${String(error)}`); } }
  };

  const inspectOne = async (folder: vscode.WorkspaceFolder, client: HostClient, id: string, show = false, signal?: AbortSignal): Promise<HistoryIndexStatus | undefined> => {
    ensure(client, 'workflow/recoveryInspect', 'operations/events');
    try {
      const inspection = await client.inspectOperation(id, signal);
      const old = operationsView.observation(folder, id);
      let sequence = old?.nextSequence ?? 0;
      let hasMore = old?.hasMore ?? false;
      const fresh: Event[] = [];
      let finalized = false;
      if (inspection.terminalState && client.supports('operations/overview')) {
        try {
          const overview = await client.operationOverview(id, signal);
          if (overview.schemaVersion !== 1 || overview.operation.operationId !== id || !overview.isFinalized) {
            throw Error('Host did not return a finalized overview for this operation.');
          }
          operationsView.setFinalizedNodes(folder, id, overview.nodes);
          finalized = true;
        } catch (error) {
          if (signal?.aborted) { throw error; }
          output.appendLine(`Verified overview for ${id}: ${String(error)}`);
        }
      }
      if (!finalized) {
        for (let page = 0; page < 4; page++) {
          const batch = await client.operationEvents(id, sequence, 500, signal);
          if (batch.operationId !== id || batch.afterSequence !== sequence) { throw Error('Unexpected Host event cursor'); }
          sequence = batch.nextSequence; hasMore = batch.hasMore;
          fresh.push(...batch.events);
          if (!hasMore) { break; }
        }
      }
      operationsView.observe(folder, id, inspection, fresh, sequence, hasMore);
      const historyStatus = await updateHistory(folder, client, id, signal);
      if (show) {
        services.show(`Host operation: ${id.slice(0, 12)}`,
          operationDetailsHtml(inspection, operationsView.nodes(folder, id).length, historyStatus?.state),
          'operation-summary');
      }
      if (show && inspection.runDirectory && inspection.terminalState) {
        try {
          const operation = await client.getOperation(id);
          if (operation.kind === 'workflow') {
            const saved = client.supports('operations/report')
              ? await client.operationReport(id) : await client.getRun(inspection.runDirectory);
            await services.onReport(folder, saved.report, saved.runDirectory, id);
          }
        } catch (error) { output.appendLine(`Host report unavailable for ${id}: ${String(error)}`); }
      }
      if (show) { services.status(inspection.terminalState ? `Host operation ${inspection.terminalState}` : `Host operation ${inspection.acceptanceState}`); }
      return historyStatus;
    } catch (error) {
      if (!signal?.aborted) { operationsView.failed(folder, id, String(error)); }
      throw error;
    }
  };
  // Tree actions identify an explicitly tracked operation, not an arbitrary path
  // or RPC identifier passed by untrusted UI content.
  const withTarget = async (value: unknown, action: (folder: vscode.WorkspaceFolder, client: HostClient, id: string) => Promise<void>): Promise<void> => {
    if (!services.trusted()) { return; }
    const target = operationsView.target(value);
    if (!target) { throw Error('Choose a tracked operation from the Operations view.'); }
    const key = target.folder.uri.toString();
    if (busy.has(key)) { void vscode.window.showInformationMessage('A Host operation command is already running in this workspace.'); return; }
    busy.add(key);
    try {
      const connection = await connect(target.folder);
      try { await action(target.folder, connection.client, target.operationId); }
      finally { connection.release(); }
    } finally { busy.delete(key); }
  };
  services.register('cmakeWorkflow.refreshDurableOperations', async () => {
    if (!services.trusted()) { return; }
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const key = folder.uri.toString();
      if (busy.has(key)) { continue; }
      busy.add(key);
      try {
        const connection = await connect(folder);
        try {
          const pending = context.workspaceState.get<Pending>(pendingKey(folder));
          if (pending) {
            try {
              ensure(connection.client, 'operations/find');
              const found = await connection.client.findOperation(pending.clientRequestId);
              await context.workspaceState.update(operationKey(folder), {
                operationId: found.operationId, clientRequestId: found.clientRequestId,
              } satisfies LastOperation);
              await operationsView.track(folder, { operationId: found.operationId,
                clientRequestId: found.clientRequestId, manifest: pending.manifest, submittedAt: new Date().toISOString() });
              await context.workspaceState.update(pendingKey(folder), undefined);
            } catch (error) {
              output.appendLine(`Pending request ${pending.clientRequestId} still unresolved: ${String(error)}. No execution was retried.`);
            }
          }
          if (connection.client.supports('operations/list')) {
            const page = await connection.client.listOperations();
            operationsView.setPage(folder, page, null);
            for (const item of page.items) { await updateHistory(folder, connection.client, item.operationId); }
          }
          for (const record of operationsView.localRecords(folder)) {
            try { await inspectOne(folder, connection.client, record.operationId); }
            catch (error) { output.appendLine(`Host operation ${record.operationId}: ${String(error)}`); }
          }
        } finally { connection.release(); }
      } catch (error) { output.appendLine(`Host ${folder.name}: ${String(error)}`); }
      finally { busy.delete(key); }
    }
    operationsView.refresh();
  });
  services.register('cmakeWorkflow.loadMoreDurableOperations', async value => {
    if (!services.trusted()) { return; }
    const folder = (vscode.workspace.workspaceFolders ?? []).find(candidate => candidate.uri.toString() === value);
    if (!folder) { return; }
    const key = folder.uri.toString();
    const cursor = operationsView.nextCursor(folder);
    if (!cursor || busy.has(key)) { return; }
    busy.add(key);
    try {
      const connection = await connect(folder);
      try {
        const page = await connection.client.listOperations(cursor);
        operationsView.setPage(folder, page, cursor);
        for (const item of page.items) { await updateHistory(folder, connection.client, item.operationId); }
      }
      finally { connection.release(); }
    } finally { busy.delete(key); }
  });
  services.register('cmakeWorkflow.openDurableOperation', async (...args: unknown[]) => {
    await withTarget(args[0], async (folder, client, id) => { await inspectOne(folder, client, id, true); });
  });
  services.register('cmakeWorkflow.openOperationNode', async value => {
    if (!services.trusted()) { return; }
    const target = operationsView.target(value);
    const nodeId = (value as { nodeId?: unknown } | undefined)?.nodeId;
    if (!target || typeof nodeId !== 'string') { return; }
    const node = operationsView.nodes(target.folder, target.operationId).find(item => item.id === nodeId);
    if (node) { services.show(`Node: ${node.id}`, nodeDetailsHtml(node), 'operation-node'); }
  });
  services.register('cmakeWorkflow.openOperationEvents', async value => {
    await withTarget(value, async (folder, client, id) => {
      const events: Event[] = [];
      let cursor = 0;
      let hasMore = false;
      for (let page = 0; page < 4; page++) {
        const batch = await client.operationEvents(id, cursor, 500);
        if (batch.operationId !== id || batch.afterSequence !== cursor || (batch.hasMore && batch.nextSequence <= cursor)) {
          throw Error('Unexpected Host event cursor');
        }
        cursor = batch.nextSequence;
        events.push(...batch.events);
        hasMore = batch.hasMore;
        if (!hasMore) { break; }
      }
      services.show(`Raw events: ${id.slice(0, 12)}`,
        `<p>${events.length} events${hasMore ? ' · first 2,000 events shown' : ''}</p>`
        + `<pre>${escapeHtml(events.map(event => JSON.stringify(event)).join('\n'))}</pre>`,
        JSON.stringify([folder.uri.toString(), id, 'events']));
    });
  });
  services.register('cmakeWorkflow.openOperationHistory', async value => {
    await withTarget(value, async (folder, client, id) => {
      ensure(client, 'history/indexStatus');
      const status = await client.historyIndexStatus(id);
      operationsView.setHistory(folder, status);
      if (operationsView.records(folder)[0]?.operationId === status.operationId) { services.onHistoryStatus?.(folder, status); }
      if (status.state !== 'indexed' || !status.databasePath) {
        void vscode.window.showInformationMessage(`History indexing: ${status.state}`);
        return;
      }
      await services.openHistoryDatabase?.(folder, status.databasePath);
    });
  });
  services.register('cmakeWorkflow.retryHistoryIndex', async value => {
    await withTarget(value, async (folder, client, id) => {
      ensure(client, 'history/retryIndex');
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'Retrying History indexing' }, () => client.retryHistoryIndex(id));
      operationsView.setHistory(folder, result);
      if (operationsView.records(folder)[0]?.operationId === result.operationId) { services.onHistoryStatus?.(folder, result); }
      void vscode.window.showInformationMessage(`History indexing: ${result.state}${result.diagnosticCode ? ` (${result.diagnosticCode})` : ''}`);
    });
  });
  services.register('cmakeWorkflow.downloadDurableArtifact', async value => {
    await withTarget(value, async (folder, client, id) => {
      ensure(client, 'operations/artifacts/list', 'operations/artifacts/readChunk', 'operations/artifacts/timestampText');
      const catalog = await client.listOperationArtifacts(id);
      const nodeId = (value as { nodeId?: unknown } | undefined)?.nodeId;
      const artifacts = typeof nodeId === 'string' ? catalog.filter(item => item.nodeId === nodeId) : catalog;
      if (!artifacts.length) { void vscode.window.showInformationMessage('No finalized artifacts are available.'); return; }
      const picked = await vscode.window.showQuickPick(artifacts.map(artifact => ({ label: artifact.relativePath,
        description: `${artifact.kind} • ${artifact.size} bytes`, artifact })), { placeHolder: 'Choose a Host artifact' });
      if (!picked) { return; }
      const { artifact } = picked;
      const name = path.posix.basename(artifact.relativePath.replace(/\\/g, '/'));
      const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder.uri, name), saveLabel: 'Save Artifact' });
      if (!destination) { return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `Downloading ${name}`, cancellable: true }, async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) { abort.abort(); }
        try {
          await downloadOperationArtifact(destination.fsPath, artifact, async offset => {
            progress.report({ message: `${offset} of ${artifact.size} bytes` });
            return client.readOperationArtifactChunk(id, artifact, offset, abort.signal);
          }, abort.signal);
          void vscode.window.showInformationMessage(`Verified artifact saved to ${destination.fsPath}.`);
        } catch (error) { if (!abort.signal.aborted) { throw error; } }
        finally { subscription.dispose(); }
      });
    });
  });
  services.register('cmakeWorkflow.recoverDurableOperation', async value => {
    await withTarget(value, async (folder, client, id) => {
      ensure(client, 'workflow/recoveryInspect');
      const observed = await client.inspectOperation(id);
      if (observed.operationId !== id || observed.terminalState || observed.cancellationRequested
        || observed.acceptanceState !== 'dispatch_authorized') {
        throw Error('Host operation is unavailable for recovery. Inspect its current state.');
      }
      let action: () => Promise<unknown>;
      let label: string;
      if (!observed.decision && observed.revision === 0) {
        ensure(client, 'workflow/reconcile');
        const picked = await vscode.window.showQuickPick([
          { label: 'Needs attention', description: 'Review the checkpoint for possible resume', value: 'needs_attention' as const },
          { label: 'Outcome unknown', description: 'Record an unresolved outcome', value: 'outcome_unknown' as const },
        ], { placeHolder: 'Record a recovery decision' });
        if (!picked) { return; }
        const note = await vscode.window.showInputBox({ prompt: 'Record what you verified and why you chose this decision',
          validateInput: text => text.trim() && text.length <= 4096 ? undefined : 'Enter a note of 1–4096 characters.' });
        if (note === undefined) { return; }
        label = 'Record Decision';
        action = () => client.reconcileOperation(id, observed.revision, picked.value, note);
      } else if (observed.decision === 'needs_attention' && observed.revision === 1) {
        ensure(client, 'workflow/resume');
        label = 'Prepare Resume';
        action = () => client.admitOperationResume(id, observed.revision);
      } else if (observed.decision === 'needs_attention' && observed.revision === 2) {
        ensure(client, 'workflow/resumeExecute');
        label = 'Execute Resume';
        action = () => client.executeOperationResume(id, observed.revision);
      } else {
        throw Error('Host recovery has no available next step for this operation.');
      }
      const answer = await vscode.window.showWarningMessage(`${label} for ${id}?`, {
        modal: true, detail: 'Confirm that all prior processes for this operation have stopped.',
      }, label);
      if (answer !== label) { return; }
      await action();
      await inspectOne(folder, client, id, true);
    });
  });
  services.register('cmakeWorkflow.cancelDurableOperationItem', async (...args: unknown[]) => {
    await withTarget(args[0], async (folder, client, id) => {
      ensure(client, 'operations/cancel', 'workflow/recoveryInspect');
      const state = await client.inspectOperation(id);
      if (state.terminalState || state.cancellationRequested) {
        void vscode.window.showInformationMessage(state.terminalState ? `Host operation already ${state.terminalState}.` : 'Cancellation is already requested.');
        return;
      }
      const answer = await vscode.window.showWarningMessage(`Request cancellation of ${id}? This is not confirmation that child processes stopped.`,
        { modal: true }, 'Request Cancellation');
      if (answer !== 'Request Cancellation') { return; }
      const result = await client.cancelOperation(id, 0);
      output.appendLine(`Host operation ${id}: cancellation ${result.state}; revision ${result.revision}`);
      await inspectOne(folder, client, id);
    });
  });
  services.register('cmakeWorkflow.followDurableOperation', async (...args: unknown[]) => {
    if (!services.trusted()) { return; }
    const target = operationsView.target(args[0]);
    if (!target) { throw Error('Choose a tracked operation in Operations.'); }
    const key = `${target.folder.uri.toString()}\0${target.operationId}`;
    if (following.has(key)) { return; }
    following.add(key);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `Following Host ${target.operationId.slice(0, 12)} (Cancel stops watching only)`, cancellable: true }, async (progress, token) => {
        const connection = await connect(target.folder);
        const abort = new AbortController();
        const canceled = token.onCancellationRequested(() => abort.abort());
        try {
          while (!token.isCancellationRequested) {
            let historyState;
            try { historyState = (await inspectOne(target.folder, connection.client, target.operationId, false, abort.signal))?.state; }
            catch (error) { if (abort.signal.aborted) { break; } throw error; }
            const state = operationsView.observation(target.folder, target.operationId);
            const terminal = state?.inspection?.terminalState;
            progress.report({ message: terminal ?? state?.inspection?.acceptanceState ?? 'checking…' });
            if (terminal && historyState !== 'pending' && historyState !== 'indexing') { break; }
            if (terminal && historyState) { progress.report({ message: `${terminal} • History: ${historyState}` }); }
            await new Promise<void>(resolve => {
              const timeout = setTimeout(() => { subscription.dispose(); resolve(); }, 1200);
              const subscription = token.onCancellationRequested(() => { clearTimeout(timeout); subscription.dispose(); resolve(); });
            });
          }
        } finally { canceled.dispose(); connection.release(); }
      });
    } finally { following.delete(key); }
  });

  services.register('cmakeWorkflow.inspectDurableWorkflow', async () => withOperation(async (folder, client) => {
    const operation = await chooseOperation(folder, client); if (!operation) { return; }
    await inspectOne(folder, client, operation.operationId, true);
  }));

  services.register('cmakeWorkflow.cancelDurableWorkflow', async () => withOperation(async (folder, client) => {
    ensure(client, 'workflow/recoveryInspect', 'operations/cancel');
    const operation = await chooseOperation(folder, client); if (!operation) { return; }
    const inspection = await client.inspectOperation(operation.operationId);
    if (inspection.terminalState) { void vscode.window.showInformationMessage(`Host operation already ${inspection.terminalState}.`); return; }
    if (inspection.cancellationRequested) { void vscode.window.showInformationMessage('Host cancellation was already requested. This is not proof the process stopped.'); return; }
    const answer = await vscode.window.showWarningMessage(
      `Request cancellation of Host operation ${operation.operationId}? This does not guarantee immediate termination.`,
      { modal: true }, 'Request Cancellation');
    if (answer !== 'Request Cancellation') { return; }
    // Cancellation CAS uses its own revision (initially 0), NOT recovery.revision.
    const result = await client.cancelOperation(operation.operationId, 0);
    output.appendLine(`Host operation ${result.operationId}: ${result.state} (requested=${result.requested}, revision=${result.revision})`);
    void vscode.window.showInformationMessage(`Host cancellation: ${result.state}. Inspect again to verify terminal outcome.`);
  }));

  services.register('cmakeWorkflow.stopDurableHost', async () => {
    const folder = await services.folder(); if (!folder) { return; }
    const key = folder.uri.toString();
    if (!hosts.has(key)) { void vscode.window.showInformationMessage('No extension-owned durable Host in this workspace. External Hosts are not stopped.'); return; }
    const answer = await vscode.window.showWarningMessage(
      'Stop the extension-owned durable Host? Running workflows may be interrupted and require manual recovery.',
      { modal: true }, 'Stop Host');
    if (answer === 'Stop Host') { stop(key); }
  });

  const withHost = async <T>(folder: vscode.WorkspaceFolder, action: (client: HostClient) => Promise<T>): Promise<T> => {
    const connection = await connect(folder);
    try { return await action(connection.client); }
    finally { connection.release(); }
  };
  const refreshLatestHistoryStatus = async (folder: vscode.WorkspaceFolder): Promise<void> => {
    await withHost(folder, async client => {
      if (!client.supports('history/indexStatus')) { return; }
      let latest = operationsView.records(folder)[0]?.operationId;
      if (client.supports('operations/list')) {
        const page = await client.listOperations();
        operationsView.rememberLatest(folder, page);
        latest = page.items[0]?.operationId ?? latest;
      }
      if (latest) {
        const status = await client.historyIndexStatus(latest);
        operationsView.setHistory(folder, status);
        services.onHistoryStatus?.(folder, status);
      }
    });
  };
  return { withHost, refreshLatestHistoryStatus, runNode: (id: string) => runWorkflow(false, [id]) };
}
