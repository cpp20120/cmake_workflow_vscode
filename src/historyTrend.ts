import type { HistoryRun } from './protocol';

export interface TrendSample { runId: string; metric: string; unit: string; value: number; variant: string | null; scenario: string | null; method: string; sampleIndex: number }
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('Invalid history metric row'); } return value as Record<string, unknown>; };
const string = (value: unknown, name: string): string => { if (typeof value !== 'string') { throw Error(`Invalid ${name}`); } return value; };
const optional = (value: unknown): string | null => value === null ? null : string(value, 'metric identity');
const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const display = (value: number): string => Number(value.toPrecision(5)).toString();

export function parseTrendSamples(value: unknown): TrendSample[] {
  if (!Array.isArray(value)) { throw Error('Invalid history query result'); }
  return value.map(raw => { const row = object(raw); if (typeof row.value !== 'number' || !Number.isFinite(row.value) || !Number.isSafeInteger(row.sampleIndex) || (row.sampleIndex as number) < 0) { throw Error('Invalid history measurement'); } return { runId: string(row.runId, 'run ID'), metric: string(row.metric, 'metric'), unit: string(row.unit, 'unit'), value: row.value, variant: optional(row.variant), scenario: optional(row.scenario), method: string(row.method, 'method'), sampleIndex: row.sampleIndex as number }; });
}
export function trendIdentity(sample: TrendSample): string { return JSON.stringify([sample.metric, sample.unit, sample.variant, sample.scenario, sample.method]); }
export function trendLabel(identity: string): string { const [metric, unit, variant, scenario, method] = JSON.parse(identity) as [string,string,string|null,string|null,string]; return [metric, unit || 'unitless', variant, scenario, method].filter(Boolean).join(' • '); }
export function renderTrendHtml(runs: HistoryRun[], samples: TrendSample[], identity: string): string {
  const runMap = new Map(runs.map(run => [run.id, run]));
  const matching = samples.filter(sample => trendIdentity(sample) === identity && runMap.has(sample.runId));
  const measuredIds = new Set(matching.map(sample => sample.runId));
  const entries = [...runMap.values()].filter(run => measuredIds.has(run.id) && run.startedAt && Number.isFinite(Date.parse(run.startedAt))).sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!));
  if (!entries.length) { return '<p>No recent runs with timestamps and samples match this metric.</p>'; }
  const plottedIds = new Set(entries.map(run => run.id));
  const selected = matching.filter(sample => plottedIds.has(sample.runId));
  let minimum = Infinity, maximum = -Infinity;
  for (const sample of selected) { minimum = Math.min(minimum, sample.value); maximum = Math.max(maximum, sample.value); }
  const low = minimum === maximum ? minimum - 0.5 : minimum, high = minimum === maximum ? maximum + 0.5 : maximum;
  const x = (index: number): number => 65 + (entries.length === 1 ? 350 : index / (entries.length - 1) * 760);
  const y = (value: number): number => 300 - (value - low) / (high - low) * 240;
  const limited = selected.length > 2000 ? selected.filter((_, index) => index % Math.ceil(selected.length / 2000) === 0) : selected;
  const indexOf = new Map(entries.map((run, index) => [run.id, index]));
  const dots = limited.flatMap(sample => { const index = indexOf.get(sample.runId); if (index === undefined) { return []; } const run = runMap.get(sample.runId)!; const jitter = (sample.sampleIndex % 7 - 3) * 2; return [`<circle class="${escape(run.status === 'failed' ? 'failed' : run.status === 'canceled' ? 'canceled' : 'succeeded')}" cx="${(x(index) + jitter).toFixed(2)}" cy="${y(sample.value).toFixed(2)}" r="3"><title>${escape(run.startedAt ?? '')} • ${escape(run.id.slice(0, 12))} • sample ${sample.sampleIndex}: ${display(sample.value)} (${escape(run.status)})</title></circle>`]; }).join('');
  const labels = entries.filter((_, index) => index === 0 || index === entries.length - 1 || index % Math.max(1, Math.floor(entries.length / 5)) === 0).map(run => { const index = indexOf.get(run.id)!; return `<text x="${x(index).toFixed(2)}" y="335" text-anchor="middle">${escape((run.startedAt ?? '').slice(0, 10))}</text>`; }).join('');
  return `<p>${escape(trendLabel(identity))} • ${entries.length} runs • ${selected.length} raw samples</p><p class="small">Dots are indexed raw measurements. Time runs left to right; no trend statistic or regression verdict is inferred.</p><svg class="trend" viewBox="0 0 900 355" role="img" aria-label="Raw measurements across history runs"><line x1="65" y1="60" x2="65" y2="300"/><line x1="65" y1="300" x2="830" y2="300"/><text x="5" y="65">${display(high)}</text><text x="5" y="300">${display(low)}</text>${labels}${dots}</svg>${selected.length > limited.length ? `<p>${limited.length} of ${selected.length} points shown.</p>` : ''}`;
}
export const trendCss = `.trend{width:100%;max-width:1000px;height:auto}.trend line{stroke:var(--vscode-descriptionForeground)}.trend text{fill:var(--vscode-descriptionForeground);font-size:12px}.trend circle.succeeded{fill:var(--vscode-charts-blue,#4f9eed)}.trend circle.failed{fill:var(--vscode-charts-red,#e05a5a)}.trend circle.canceled{fill:var(--vscode-descriptionForeground)}`;
