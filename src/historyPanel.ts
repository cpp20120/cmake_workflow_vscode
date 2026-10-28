import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { HistoryDetail, Report } from './protocol';
import { renderHistoryHtml } from './historyHtml';
import { renderComparisonHtml } from './comparisonHtml';
import type { HistoryDifference } from './protocol';
import type { ChartPreset } from './chartPresets';
import type { ComparisonEvidence } from './profileEvidence';

export function openHistoryPanel(detail: HistoryDetail, preset?: ChartPreset, report?: Report): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('cmakeWorkflow.runDetails', `CMakeWorkflow: ${path.basename(detail.run.workflow ?? detail.run.directory)}`, vscode.ViewColumn.Active, { enableScripts: true });
  const nonce = randomBytes(16).toString('base64');
  panel.webview.html = renderHistoryHtml(detail, nonce, preset, report);
  const receiver = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== 'object') { return; }
    const request = message as Record<string, unknown>;
    try {
      if (request.type === 'openArtifact' && Number.isInteger(request.index)) {
        const artifact = detail.artifacts[request.index as number];
        if (artifact?.available) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(artifact.path)); }
      } else if (request.type === 'openReport' && detail.run.format === 'workflow' && detail.run.sourceAvailable) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(detail.run.directory, 'run.json')));
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`CMakeWorkflow: Could not open artifact: ${String(error)}`);
    }
  });
  panel.onDidDispose(() => receiver.dispose());
  return panel;
}

export function openComparisonPanel(baseline: HistoryDetail, candidate: HistoryDetail, rows: HistoryDifference[], preset?: ChartPreset, evidence?: ComparisonEvidence): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('cmakeWorkflow.comparison', 'CMakeWorkflow: Comparison', vscode.ViewColumn.Active, { enableScripts: true });
  panel.webview.html = renderComparisonHtml(baseline, candidate, rows, randomBytes(16).toString('base64'), preset, evidence);
  const receiver = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== 'object') { return; }
    const request = message as Record<string, unknown>;
    if (request.type !== 'openProfileArtifact' || !Number.isSafeInteger(request.index)
      || (request.side !== 'baseline' && request.side !== 'candidate')) { return; }
    const source = request.side === 'baseline' ? baseline : candidate;
    const artifact = source.artifacts[request.index as number];
    const allowed = new Set(['trace', 'capture-result', 'capture-manifest', 'etw-summary',
      'analysis.json', 'counter-comparison.json', 'comparison.json', 'cpu-stacks', 'scheduler-timeline']);
    if (!artifact?.available || !allowed.has(artifact.type)) { return; }
    // Resolve symlinks as well as lexical .. escapes; never open an artifact
    // outside the immutable run even if the stored path was later replaced.
    try {
      const root = await realpath(source.run.directory);
      const target = await realpath(artifact.path);
      const relative = path.relative(root, target);
      if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep)
        || path.isAbsolute(relative)) { return; }
      const uri = vscode.Uri.file(target);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      } else {
        await vscode.commands.executeCommand('vscode.open', uri);
      }
    } catch (error) {
      void vscode.window.showWarningMessage(`Profile artifact unavailable: ${String(error)}`);
    }
  });
  panel.onDidDispose(() => receiver.dispose());
  return panel;
}
