import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { informationHtml } from './inspectionHtml';
import { hostApiForm, hostApiFormScript } from './hostApiForm';
import { hostRequestSchemas, type HostRpcMethod } from './hostContract.generated';
import { parseHostRequest } from './hostRequestForm';
import type { HostClient } from './hostClient';

interface Services {
  trusted(): boolean;
  folder(): Promise<vscode.WorkspaceFolder | undefined>;
  track(panel: vscode.WebviewPanel): void;
  withHost<T>(folder: vscode.WorkspaceFolder, action: (client: HostClient) => Promise<T>): Promise<T>;
}

const readOnly = new Set<HostRpcMethod>([
  'initialize', 'context/inspect', 'target/resolve', 'workflow/plan', 'workflow/preflight',
  'workflow/recoveryInspect', 'execution/report', 'runs/get', 'operations/get', 'operations/find',
  'operations/list', 'operations/events', 'operations/overview', 'operations/report',
  'operations/artifacts/list', 'operations/artifacts/readChunk',
  'history/indexStatus', 'history/runs', 'history/runsPage', 'history/show', 'history/metrics',
  'history/query', 'history/compare', 'history/detect', 'toolchains/discover', 'toolchains/resolve',
  'toolchains/inspectEnvironment', 'tooling/doctor', 'tooling/planFix', 'environment/plan',
]);

export async function openHostApi(services: Services): Promise<void> {
  if (!services.trusted()) { return; }
  const folder = await services.folder();
  if (!folder) { return; }
  await services.withHost(folder, async client => {
    const methods = (Object.keys(hostRequestSchemas) as HostRpcMethod[]).filter(method => method === 'initialize' || client.supports(method));
    const nonce = randomBytes(16).toString('base64');
    const panel = vscode.window.createWebviewPanel('cmakeWorkflow.hostApi', 'CMakeWorkflow Host API',
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    services.track(panel);
    await new Promise<void>(resolve => {
      let active: AbortController | undefined;
      let canCancel = false;
      let disposed = false;
      let fixPlanId: string | undefined;
      const send = (message: unknown) => {
        if (!disposed) { void panel.webview.postMessage(message); }
      };
      const subscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) { return; }
        if (message.type === 'cancel') {
          if (canCancel) { active?.abort(); }
          return;
        }
        if (message.type !== 'run' || active || !('method' in message) || !('request' in message)) { return; }
        const method = methods.find(candidate => candidate === message.method);
        if (!method) { send({ type: 'result', error: 'This Host operation is unavailable.' }); return; }
        const abort = new AbortController();
        active = abort;
        canCancel = readOnly.has(method);
        let request: unknown;
        try {
          if (!services.trusted()) { throw Error('Trust the workspace before calling the Host.'); }
          if (method === 'initialize') {
            send({ type: 'result', body: JSON.stringify(client.info, null, 2), planId: fixPlanId ?? null });
            return;
          }
          const raw = message.request;
          request = parseHostRequest(method, raw);
          if (!canCancel) {
            const answer = await vscode.window.showWarningMessage(`Run ${method} on ${folder.name}?`,
              { modal: true, detail: JSON.stringify(request, null, 2) }, 'Run Request');
            if (answer !== 'Run Request' || disposed) { send({ type: 'result', error: 'Request canceled.' }); return; }
          }
          send({ type: 'cancellable', enabled: canCancel });
          const progress = (event: { stage: string }) => send({ type: 'progress', message: event.stage });
          let result: unknown;
          if (method === 'tooling/doctor') {
            const args = parseHostRequest(method, raw);
            result = await client.doctor([...args.profiles], progress, abort.signal,
              args.installDirectory ?? null, args.operationId);
          } else if (method === 'tooling/planFix') {
            fixPlanId = undefined;
            const args = parseHostRequest(method, raw);
            const planned = await client.planFix([...args.profiles], args.installDirectory ?? null,
              args.packageManager ?? 'Auto', args.allowFallback ?? true, abort.signal, args.runDirectory);
            fixPlanId = planned.planId;
            result = planned;
          } else if (method === 'tooling/applyFix') {
            const args = parseHostRequest(method, raw);
            if (!fixPlanId || args.planId !== fixPlanId) { throw Error('Run tooling/planFix in this tab and use its plan ID.'); }
            fixPlanId = undefined;
            result = await client.applyFix(args.planId, progress, abort.signal, args.operationId);
          } else {
            result = await client.invoke(method, parseHostRequest(method, raw), abort.signal);
          }
          send({ type: 'result', body: JSON.stringify(result, null, 2), planId: fixPlanId ?? null });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          send({ type: 'result', error: client.closed ? `${message} Open Host API again to reconnect.` : message,
            body: canCancel ? undefined : JSON.stringify(request, null, 2), planId: fixPlanId ?? null });
        } finally {
          active = undefined;
          canCancel = false;
          if (disposed) { resolve(); }
        }
      });
      panel.onDidDispose(() => {
        disposed = true;
        subscription.dispose();
        if (active && canCancel) { active.abort(); }
        if (!active) { resolve(); }
      });
      panel.webview.html = informationHtml(`Host API · ${folder.name}`, hostApiForm(methods, nonce), nonce,
        hostApiFormScript(methods));
    });
  });
}
