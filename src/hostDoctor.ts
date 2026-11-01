import * as vscode from 'vscode';
import { HostClient } from './hostClient';
import { HostProcess } from './hostProcess';
import { escapeHtml, toolingPlanHtml } from './inspectionHtml';
import { toolDirectory, toolEnvironment } from './toolEnvironment';
import type { CommandServices } from './commandUi';

export function registerHostDoctor(context: vscode.ExtensionContext, services: CommandServices,
  output: vscode.OutputChannel): void {
  const owned = new Map<string, HostProcess>();
  const connections = new Map<string, HostClient>();
  const operations = new Map<string, AbortController>();
  const pending = new Set<string>(), installing = new Set<string>();
  let disposed = false;
  const clearFolder = (key: string): void => {
    operations.get(key)?.abort();
    connections.get(key)?.dispose(); connections.delete(key);
    owned.get(key)?.dispose(); owned.delete(key);
  };
  context.subscriptions.push({ dispose: () => {
    disposed = true;
    for (const key of new Set([...owned.keys(), ...operations.keys(), ...connections.keys()])) { clearFolder(key); }
  } },
    vscode.workspace.onDidChangeConfiguration(event => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (['executable', 'prefixArgs', 'hostEndpoint', 'toolingInstallDirectory'].some(key => event.affectsConfiguration(`cmakeWorkflow.${key}`, folder.uri))) { clearFolder(folder.uri.toString()); }
      }
    }), vscode.workspace.onDidChangeWorkspaceFolders(event => {
      for (const folder of event.removed) { clearFolder(folder.uri.toString()); }
    }));

  const run = async (fix: boolean): Promise<void> => {
    if (!services.trusted() || disposed) { return; }
    const folder = await services.folder(); if (!folder || disposed) { return; }
    const key = folder.uri.toString();
    if (pending.has(key)) { void vscode.window.showInformationMessage('Host tooling is already running for this workspace.'); return; }
    pending.add(key);
    let activateDirectory: string | undefined;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Host ${fix ? 'Fix' : 'Doctor'}: ${folder.name}`, cancellable: true }, async (progress, token) => {
        const abort = new AbortController(); operations.set(key, abort);
        const subscription = token.onCancellationRequested(() => abort.abort());
        let client: HostClient | undefined; let applyAttempted = false;
        try {
          if (token.isCancellationRequested) { return; }
          const config = vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri);
          const installDirectory = toolDirectory(config.get<string>('toolingInstallDirectory', ''), folder.uri.fsPath);
          let endpoint = config.get<string>('hostEndpoint', '').trim();
          if (!endpoint) {
            let host = owned.get(key);
            if (!host || host.exited) {
              const executable = config.get<string>('executable', 'CMakeWorkflow').trim();
              const prefixArgs = config.get<string[]>('prefixArgs', []);
              if (!executable || !Array.isArray(prefixArgs) || !prefixArgs.every(arg => typeof arg === 'string')) { throw Error('Configure the CLI executable and prefixArgs first.'); }
              host = new HostProcess({ executable, prefixArgs, cwd: folder.uri.fsPath, env: toolEnvironment(installDirectory) }, text => output.append(text));
              owned.set(key, host);
            }
            progress.report({ message: 'Starting local Host…' }); endpoint = await host.start();
          }
          if (abort.signal.aborted || disposed) { return; }
          const connection = await HostClient.connect(endpoint, folder.uri.fsPath, abort.signal);
          client = connection.client; connections.set(key, client);
          output.appendLine(`Connected to Host PID ${connection.info.processId}: ${endpoint}`);
          const canFix = ['tooling/planFix', 'tooling/applyFix', 'tooling/fixProgress'].every(c => connection.info.capabilities.includes(c));
          if (fix && !canFix) { throw Error('This Host does not support Fix. Stop it and start an updated CLI.'); }
          const profile = await vscode.window.showQuickPick(connection.info.profiles.map(p => ({ label: p.id, description: p.description })),
            { placeHolder: `Host ${fix ? 'Fix' : 'Doctor'}: choose tool profile` }, token);
          if (!profile || abort.signal.aborted || disposed) { return; }
          if (!fix) {
            const plan = await client.doctor([profile.label], event => {
              const text = event.tool ? `${event.tool.displayName}: ${event.tool.installed ? 'found' : 'missing'}` : event.stage;
              progress.report({ message: text }); output.appendLine(`[Host doctor ${event.sequence}] ${text}`);
            }, abort.signal, installDirectory);
            services.show(`Host Doctor: ${folder.name} / ${profile.label}`,
              `<p>Host PID ${connection.info.processId} • ${escapeHtml(endpoint)}</p><p class="note">Readiness checks tool presence/version, not compiler features or profiler permissions.</p>${toolingPlanHtml(plan)}`);
            if (plan.ready || !canFix) { return; }
            const choice = await vscode.window.showWarningMessage('Required tools are missing. Review a Fix plan for this workspace?', 'Fix Missing Tools');
            if (choice !== 'Fix Missing Tools') { return; }
          }
          if (abort.signal.aborted || disposed || !services.trusted()) { return; }
          progress.report({ message: 'Preparing Fix plan…' });
          const reviewed = await client.planFix([profile.label], installDirectory, 'Auto', true, abort.signal);
          services.show(`Fix plan: ${folder.name} / ${profile.label}`, toolingPlanHtml(reviewed.plan));
          const steps = reviewed.plan.steps.map(s => `${s.tool}: ${s.method}${s.executable ? ` ${s.executable} ${JSON.stringify(s.arguments)}` : ''}${s.source ? ` (${s.source})` : ''}${s.diagnostic ? ` — ${s.diagnostic}` : ''}`).join('\n');
          const consent = await vscode.window.showInformationMessage('Apply this Host Fix plan?', {
            modal: true,
            detail: `${steps || 'All requested tools are already available.'}\n\nDirectory: ${reviewed.plan.installDirectory}\nAfter successful verification this directory will be prepended to PATH for CLI processes in this workspace. Existing CMake trees retain their recorded toolchain.\nInstallation may modify system packages and download tools. Cancellation, disconnect or closing VS Code may leave a partial installation; there is no rollback. Package versions are selected by the package manager/release source.`,
          }, 'Fix Tools');
          if (consent !== 'Fix Tools' || abort.signal.aborted || disposed || !services.trusted()) { return; }
          applyAttempted = true; installing.add(key);
          const result = await client.applyFix(reviewed.planId, event => {
            const text = `${event.stage}${event.tool ? `: ${event.tool}` : ''}${event.message ? ` — ${event.message}` : ''}`;
            progress.report({ message: text }); output.appendLine(`[Host fix ${event.sequence}] ${text}`);
          }, abort.signal);
          output.appendLine(`Host Fix: ${result.status}`);
          for (const diagnostic of result.diagnostics) { output.appendLine(diagnostic); }
          const diagnostics = result.diagnostics.map(d => `<li>${escapeHtml(d)}</li>`).join('');
          services.show(`Fix result: ${folder.name}`, `<p><strong>${escapeHtml(result.status)}</strong></p><ul>${diagnostics}</ul>${result.verification ? toolingPlanHtml(result.verification) : '<p>Verification unavailable. Run Doctor before another Fix.</p>'}`);
          if (result.status === 'succeeded' && result.verification?.ready) {
            activateDirectory = result.verification.installDirectory;
          } else {
            void vscode.window.showWarningMessage(`Host Fix: ${result.status}. Review the result. No automatic retry was performed.`);
          }
        } catch (error) {
          if (applyAttempted) {
            output.appendLine(`Fix interrupted: ${String(error)}. Installation may be partial. Run Doctor before another Fix.`);
            void vscode.window.showWarningMessage('Fix did not return a verified result. Installation may be partial; run Host Doctor before another Fix.');
          } else if (abort.signal.aborted) { output.appendLine('Host tooling canceled before installation.'); }
          else { throw error; }
        } finally {
          subscription.dispose(); operations.delete(key); installing.delete(key);
          if (client) { connections.delete(key); client.dispose(); }
        }
      });
      if (activateDirectory && !disposed) {
        await vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri).update('toolingInstallDirectory', activateDirectory, vscode.ConfigurationTarget.WorkspaceFolder);
        void vscode.window.showInformationMessage(`Tools verified. CLI processes in ${folder.name} will use ${activateDirectory} on PATH.`);
      }
    } finally { pending.delete(key); }
  };
  services.register('cmakeWorkflow.hostDoctor', () => run(false));
  services.register('cmakeWorkflow.hostFix', () => run(true));
  services.register('cmakeWorkflow.stopHost', async () => {
    const folder = await services.folder(); if (!folder) { return; }
    const key = folder.uri.toString(); const host = owned.get(key);
    if (host) {
      if (installing.has(key) && await vscode.window.showWarningMessage('Stopping Host interrupts Fix and may leave partial installation.', { modal: true }, 'Stop Host') !== 'Stop Host') { return; }
      operations.get(key)?.abort(); owned.delete(key); await host.stop();
    } else { void vscode.window.showInformationMessage('No extension-owned Host for this workspace. External hosts are not stopped.'); }
  });
}
