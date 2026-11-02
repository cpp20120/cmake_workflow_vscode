import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource, ParameterStructures, type MessageConnection } from 'vscode-jsonrpc/node';
import { parseDoctorProgress, parseHostInfo, parseToolingPlan, parseFixPlan, parseFixProgress, parseFixResult, type FixPlan, type FixProgress, type FixResult, type PackageManager, type DoctorProgress, type HostInfo, type ToolingPlan } from './hostProtocol';
import { parsePlan, parseHistory, parseHistoryDetail, parseHistoryComparison, parseHistoryDetection } from './protocol';
import { parseContext, parseTargetResolution, parseReportSnapshot, parseMeasurementRows,
  type HistoryRunsRequest, type HistoryMetricsRequest, type HistoryCompareRequest, type HistoryDetectRequest } from './applicationProtocol';
import { parseOperationReference, parseRecoveryInspection, parseOperationEventsPage, parseOperationCancelResult,
  type WorkflowStartRequest } from './durableProtocol';

export class HostClient {
  private readonly connection: MessageConnection;
  private disposed = false;
  private capabilities = new Set<string>();
  private constructor(private readonly socket: net.Socket) {
    this.connection = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    this.connection.onClose(() => this.dispose());
    this.connection.onError(() => this.dispose());
    this.connection.listen();
  }
  static async connect(endpoint: string, workspace: string, signal?: AbortSignal): Promise<{ client: HostClient; info: HostInfo }> {
    if (signal?.aborted) { throw Error('Host request canceled'); }
    const socket = net.createConnection(endpoint);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(Error('Host connection timed out')), 5000);
        const connected = () => finish();
        const canceled = () => finish(Error('Host request canceled'));
        const finish = (error?: Error) => {
          clearTimeout(timer); socket.off('connect', connected); socket.off('error', finish);
          signal?.removeEventListener('abort', canceled);
          if (error) { reject(error); } else { resolve(); }
        };
        socket.once('connect', connected); socket.once('error', finish);
        signal?.addEventListener('abort', canceled, { once: true });
      });
      const client = new HostClient(socket);
      try {
        const info = parseHostInfo(await client.request('initialize', { protocolVersion: 1, workspaceDirectory: workspace }, signal, 10000));
        client.capabilities = new Set(info.capabilities);
        return { client, info };
      } catch (error) { client.dispose(); throw error; }
    } catch (error) { socket.destroy(); throw error; }
  }
  supports(method: string): boolean { return this.capabilities.has(method); }
  private async read<T>(method: string, request: unknown, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    if (!this.supports(method)) { throw Error(`Host does not advertise ${method}; use the CLI fallback for this capability.`); }
    return parse(await this.request(method, request, signal, 60000));
  }
  inspectContext(buildDirectory: string, signal?: AbortSignal) {
    return this.read('context/inspect', { buildDirectory }, parseContext, signal);
  }
  resolveTarget(buildDirectory: string, target: string, configuration: string | null = null, signal?: AbortSignal) {
    return this.read('target/resolve', { buildDirectory, target, configuration }, parseTargetResolution, signal);
  }
  planWorkflow(manifest: string, only: string[] = [], controllerBuildDirectory: string | null = null, signal?: AbortSignal) {
    return this.read('workflow/plan', { manifest, only, controllerBuildDirectory }, parsePlan, signal);
  }
  getRun(runDirectory: string, signal?: AbortSignal) {
    return this.read('runs/get', { runDirectory }, parseReportSnapshot, signal);
  }
  historyRuns(request: HistoryRunsRequest, signal?: AbortSignal) {
    return this.read('history/runs', request, parseHistory, signal);
  }
  historyShow(databasePath: string, runId: string, signal?: AbortSignal) {
    return this.read('history/show', { databasePath, runId }, parseHistoryDetail, signal);
  }
  historyMetrics(request: HistoryMetricsRequest, signal?: AbortSignal) {
    return this.read('history/metrics', request, parseMeasurementRows, signal);
  }
  historyQuery(request: HistoryMetricsRequest, signal?: AbortSignal) {
    return this.read('history/query', request, parseMeasurementRows, signal);
  }
  historyCompare(request: HistoryCompareRequest, signal?: AbortSignal) {
    return this.read('history/compare', request, parseHistoryComparison, signal);
  }
  historyDetect(request: HistoryDetectRequest, signal?: AbortSignal) {
    return this.read('history/detect', request, parseHistoryDetection, signal);
  }
  startWorkflow(request: WorkflowStartRequest, signal?: AbortSignal) {
    return this.read('workflow/start', request, parseOperationReference, signal);
  }
  findOperation(clientRequestId: string, signal?: AbortSignal) {
    return this.read('operations/find', { clientRequestId }, parseOperationReference, signal);
  }
  getOperation(operationId: string, signal?: AbortSignal) {
    return this.read('operations/get', { operationId }, parseOperationReference, signal);
  }
  inspectOperation(operationId: string, signal?: AbortSignal) {
    return this.read('workflow/recoveryInspect', { operationId }, parseRecoveryInspection, signal);
  }
  operationEvents(operationId: string, afterSequence = 0, limit = 100, signal?: AbortSignal) {
    return this.read('operations/events', { operationId, afterSequence, limit }, parseOperationEventsPage, signal);
  }
  cancelOperation(operationId: string, expectedRevision: number, signal?: AbortSignal) {
    return this.read('operations/cancel', { operationId, expectedRevision }, parseOperationCancelResult, signal);
  }
  async doctor(profiles: string[], progress: (value: DoctorProgress) => void, signal?: AbortSignal, installDirectory: string | null = null): Promise<ToolingPlan> {
    const operationId = randomUUID(); let sequence = 0; let finished = false; let failure: Error | undefined;
    const subscription = this.connection.onNotification('tooling/progress', (value: unknown) => {
      try {
        const event = parseDoctorProgress(value);
        if (event.operationId !== operationId) { return; }
        if (event.sequence !== sequence + 1 || finished || (sequence === 0) !== (event.stage === 'started')) { throw Error('Out-of-order Host progress'); }
        sequence = event.sequence; finished = event.stage === 'finished'; progress(event);
      } catch (error) { failure = error as Error; this.dispose(); }
    });
    try {
      const result = await this.request('tooling/doctor', { operationId, profiles, installDirectory }, signal, 300000);
      if (failure) { throw failure; }
      if (!finished) { throw Error('Host Doctor completed without final progress'); }
      return parseToolingPlan(result);
    } catch (error) { throw failure ?? error; }
    finally { subscription.dispose(); }
  }
  private async request(method: string, request: unknown, signal: AbortSignal | undefined, timeout: number): Promise<unknown> {
    if (this.disposed || signal?.aborted) { throw Error('Host request canceled or disconnected'); }
    const cancellation = new CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: () => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const stop = (message: string) => { cancellation.cancel(); reject(Error(message)); this.dispose(); };
      cancel = () => stop('Host request canceled');
      timer = setTimeout(() => stop('Host request timed out'), timeout);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    try { return await Promise.race([this.connection.sendRequest(method, ParameterStructures.byPosition, request, cancellation.token), interrupted]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); cancellation.dispose(); }
  }
  async planFix(profiles: string[], installDirectory: string | null, packageManager: PackageManager,
    allowFallback: boolean, signal?: AbortSignal): Promise<FixPlan> {
    return parseFixPlan(await this.request('tooling/planFix', { profiles, installDirectory, packageManager, allowFallback }, signal, 300000));
  }
  async applyFix(planId: string, progress: (value: FixProgress) => void, signal?: AbortSignal): Promise<FixResult> {
    const operationId = randomUUID(); let sequence = 0; let finished = false; let failure: Error | undefined;
    const subscription = this.connection.onNotification('tooling/fixProgress', (value: unknown) => {
      try {
        const event = parseFixProgress(value);
        if (event.operationId !== operationId) { return; }
        if (event.sequence !== sequence + 1 || finished || (sequence === 0) !== (event.stage === 'started')) { throw Error('Out-of-order Host Fix progress'); }
        sequence = event.sequence; finished = event.stage === 'finished'; progress(event);
      } catch (error) { failure = error as Error; this.dispose(); }
    });
    try {
      const result = await this.request('tooling/applyFix', { operationId, planId }, signal, 4 * 60 * 60 * 1000);
      if (failure) { throw failure; }
      if (!finished) { throw Error('Host Fix completed without final progress. Installation state is unknown; run Doctor before another Fix.'); }
      return parseFixResult(result);
    } catch (error) { throw failure ?? error; }
    finally { subscription.dispose(); }
  }
  dispose(): void {
    if (this.disposed) { return; } this.disposed = true;
    this.connection.dispose(); this.socket.destroy();
  }
}
