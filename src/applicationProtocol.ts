import { parseReport, type Report, type HistoryMeasurement } from './protocol';

export interface ContextObservation {
  buildDirectory: string; state: string; freshness: string; presetState: string;
  sourceDirectory: string | null; generator: string | null; multiConfig: boolean | null;
  configurations: string[]; diagnostics: string[];
  targets: { name: string; configuration: string; type: string; executable: string | null; evidence: string }[];
}
export interface TargetResolution { schemaVersion: 1; buildDirectory: string; target: string; configuration: string | null; executable: string }
export interface ReportSnapshot { schemaVersion: 1; runDirectory: string; revision: string; report: Report }
export interface MeasurementRow extends HistoryMeasurement { runId: string; source: string }
export interface HistoryRunsRequest { databasePath: string; limit?: number; status?: string; since?: string; until?: string; workflow?: string; variant?: string }
export interface HistoryMetricsRequest { databasePath: string; runId?: string; metric?: string; variant?: string; scenario?: string }
export interface HistoryCompareRequest { databasePath: string; baselineRunId: string; candidateRunId: string }
export interface HistoryDetectRequest extends HistoryCompareRequest { metric: string; direction: 'higher-worse' | 'lower-worse'; minimumEffectPercent: number; variant?: string; scenario?: string; alpha?: number }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('Invalid application API object'); }
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === 'string'; }
function optionalText(value: unknown): boolean { return value === null || text(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }
export function parseContext(value: unknown): ContextObservation {
  const v = object(value);
  if (![v.buildDirectory, v.state, v.freshness, v.presetState].every(text)
    || !optionalText(v.sourceDirectory) || !optionalText(v.generator)
    || v.multiConfig !== null && typeof v.multiConfig !== 'boolean'
    || !strings(v.configurations) || !strings(v.diagnostics) || !Array.isArray(v.targets)) { throw Error('Invalid context observation'); }
  for (const item of v.targets) {
    const t = object(item);
    if (![t.name, t.configuration, t.type, t.evidence].every(text) || !optionalText(t.executable)) { throw Error('Invalid observed target'); }
  }
  return v as unknown as ContextObservation;
}
export function parseTargetResolution(value: unknown): TargetResolution {
  const v = object(value);
  if (v.schemaVersion !== 1 || ![v.buildDirectory, v.target, v.executable].every(text)
    || !optionalText(v.configuration)) { throw Error('Invalid target resolution'); }
  return v as unknown as TargetResolution;
}
export function parseReportSnapshot(value: unknown): ReportSnapshot {
  const v = object(value);
  if (v.schemaVersion !== 1 || !text(v.runDirectory) || !text(v.revision)
    || !/^[a-f0-9]{64}$/i.test(v.revision)) { throw Error('Invalid report snapshot or revision'); }
  return { schemaVersion: 1, runDirectory: v.runDirectory, revision: v.revision, report: parseReport(v.report) };
}
export function parseMeasurementRows(value: unknown): MeasurementRow[] {
  if (!Array.isArray(value)) { throw Error('Invalid measurement rows'); }
  return value.map(item => {
    const v = object(item);
    if (![v.runId, v.metric, v.unit, v.source, v.method].every(text)
      || ![v.nodeId, v.variant, v.scenario].every(optionalText) || typeof v.value !== 'number' || !Number.isFinite(v.value)
      || !Number.isSafeInteger(v.sampleIndex) || Number(v.sampleIndex) < 0) { throw Error('Invalid measurement row'); }
    return v as unknown as MeasurementRow;
  });
}
