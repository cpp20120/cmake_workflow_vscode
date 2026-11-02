import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostClient } from './hostClient';
import { HostProcess } from './hostProcess';
import { configuredJobs } from './settings';
import { toolDirectory, toolEnvironment } from './toolEnvironment';
import { escapeHtml } from './inspectionHtml';
import type { Event, Plan, Report } from './protocol';
import type { OperationReference } from './durableProtocol';
import { OperationsView } from './operationsView';

interface Selection { folder: vscode.WorkspaceFolder; file: vscode.Uri }
interface Pending { clientRequestId: string; manifest: string; manifestSha256: string; jobs: number; resultsDirectory: string }
interface LastOperation { operationId: string; clientRequestId: string }

export interface DurableServices {
  register(name: string, action: (...args: unknown[]) => Promise<void>): void;
  trusted(): boolean;
  choose(): Promise<Selection | undefined>;
  folder(): Promise<vscode.WorkspaceFolder | undefined>;
  onPlan(selection: Selection, plan: Plan): void;
  onEvent(event: Event): void;
  onReport(folder: vscode.WorkspaceFolder, report: Report, directory: string): Promise<void>;
  status(message: string): void;
  show(title: string, body: string): void;
}

// This Host has a separate lifecycle from the request. Closing one RPC client
// does not cancel an accepted workflow. Stopping the Host DOES interrupt execution.
export function registerDurableCommands(context: vscode.ExtensionContext, services: DurableServices,
  output: vscode.OutputChannel): void {
  const operationsView = new OperationsView(context.workspaceState);
  context.subscriptions.push(operationsView, vscode.window.registerTreeDataProvider('cmakeWorkflow.operations', operationsView));
  const hosts = new Map<string, HostProcess>();
  const busy = new Set<string>();
  const following = new Set<string>();
  const active = new Set<HostClient>();
  const stop = (key: string): void => { hosts.get(key)?.dispose(); hosts.delete(key); };
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

  services.register('cmakeWorkflow.runDurableWorkflow', async () => {
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
        services.onPlan(selection, planned);
        if (!planned.valid) { throw Error('Host workflow plan is invalid. Inspect its node diagnostics.'); }
        const config = vscode.workspace.getConfiguration('cmakeWorkflow', selection.folder.uri);
        const jobs = configuredJobs(config.inspect<number>('jobs')) ?? 1;
        const root = config.get<string>('resultsDir', '').trim() || 'out/results';
        const outputRoot = path.resolve(selection.folder.uri.fsPath, root);
        const relative = path.relative(selection.folder.uri.fsPath, outputRoot);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw Error('Host requires cmakeWorkflow.resultsDir to be inside the workspace.');
        }
        // The Host checks the exact manifest hash again before durable admission.
        const request: Pending = { clientRequestId: randomUUID(), manifest: selection.file.fsPath,
          manifestSha256: planned.manifestHash, jobs, resultsDirectory: path.join(outputRoot, `host-${randomUUID()}`) };
        if (!/^[0-9a-f]{64}$/i.test(request.manifestSha256)) { throw Error('Invalid manifest hash from Host plan.'); }
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
  });

  const inspectOne = async (folder: vscode.WorkspaceFolder, client: HostClient, id: string, show = false, signal?: AbortSignal): Promise<void> => {
    ensure(client, 'workflow/recoveryInspect', 'operations/events');
    try {
      const inspection = await client.inspectOperation(id, signal);
      const old = operationsView.observation(folder, id);
      let sequence = old?.nextSequence ?? 0;
      let hasMore = false;
      const fresh: Event[] = [];
      // Replay is paginated and explicitly bounded. Subsequent refreshes continue
      // from the last cursor; never treat an incomplete event feed as a checkpoint.
      for (let page = 0; page < 4; page++) {
        const batch = await client.operationEvents(id, sequence, 500, signal);
        if (batch.operationId !== id || batch.afterSequence !== sequence) { throw Error('Unexpected Host event cursor'); }
        sequence = batch.nextSequence; hasMore = batch.hasMore;
        fresh.push(...batch.events);
        if (!hasMore) { break; }
      }
      operationsView.observe(folder, id, inspection, fresh, sequence, hasMore);
      const observed = operationsView.observation(folder, id)!;
      if (show) {
        const rows = observed.events.slice(-60).map(e => `<tr><td>${e.sequence}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.nodeId ?? '—')}</td><td>${escapeHtml(e.status ?? '—')}</td></tr>`).join('');
        services.show(`Host operation: ${id.slice(0, 12)}`,
          `<p><strong>Operation:</strong> ${escapeHtml(id)}</p>`
          + `<p><strong>Acceptance:</strong> ${escapeHtml(inspection.acceptanceState)} • <strong>Terminal:</strong> ${escapeHtml(inspection.terminalState ?? 'not finalized')}</p>`
          + `<p><strong>Cancellation requested:</strong> ${inspection.cancellationRequested ? 'yes' : 'no'} • <strong>Recovery decision:</strong> ${escapeHtml(inspection.decision ?? 'none')}</p>`
          + `<p><strong>Run directory:</strong> ${escapeHtml(inspection.runDirectory ?? 'not dispatched')}</p>`
          + `<p>Observed events through sequence ${sequence}${hasMore ? ' (more available; Refresh to continue)' : ''}. This is not a recovery checkpoint.</p>`
          + `<table><thead><tr><th>#</th><th>Event</th><th>Node</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`);
      }
      if (show && inspection.runDirectory && inspection.terminalState) {
        try {
          const saved = await client.getRun(inspection.runDirectory);
          await services.onReport(folder, saved.report, saved.runDirectory);
        } catch (error) { output.appendLine(`Host report unavailable for ${id}: ${String(error)}`); }
      }
      if (show) { services.status(inspection.terminalState ? `Host operation ${inspection.terminalState}` : `Host operation ${inspection.acceptanceState}`); }
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
      if (busy.has(key) || (!operationsView.records(folder).length && !context.workspaceState.get<Pending>(pendingKey(folder)))) { continue; }
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
          for (const record of operationsView.records(folder)) {
            try { await inspectOne(folder, connection.client, record.operationId); }
            catch (error) { output.appendLine(`Host operation ${record.operationId}: ${String(error)}`); }
          }
        } finally { connection.release(); }
      } catch (error) { output.appendLine(`Host ${folder.name}: ${String(error)}`); }
      finally { busy.delete(key); }
    }
    operationsView.refresh();
  });
  services.register('cmakeWorkflow.openDurableOperation', async (...args: unknown[]) => {
    await withTarget(args[0], (folder, client, id) => inspectOne(folder, client, id, true));
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
            try { await inspectOne(target.folder, connection.client, target.operationId, false, abort.signal); }
            catch (error) { if (abort.signal.aborted) { break; } throw error; }
            const state = operationsView.observation(target.folder, target.operationId);
            const terminal = state?.inspection?.terminalState;
            progress.report({ message: terminal ?? state?.inspection?.acceptanceState ?? 'checking…' });
            if (terminal) { break; }
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
}
