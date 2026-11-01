import * as vscode from 'vscode';
import { escapeHtml } from './inspectionHtml';
import type { TrendSample } from './historyTrend';

export async function metricFilters(metric: string, rows: {
  metric: string; variant: string | null; scenario: string | null;
}[]): Promise<string[] | undefined> {
  let matching = rows.filter(row => row.metric === metric);
  const args: string[] = [];
  for (const field of ['variant', 'scenario'] as const) {
    const names = [...new Set(matching.map(row => row[field]).filter((v): v is string => typeof v === 'string' && v.length > 0))];
    if (!names.length) { continue; }
    const chosen = await vscode.window.showQuickPick([{ label: `All ${field}s`, value: undefined as string | undefined },
      ...names.map(value => ({ label: value, value }))], { placeHolder: `Filter ${metric} by ${field}` });
    if (!chosen) { return; }
    if (chosen.value !== undefined) {
      args.push(`--${field}`, chosen.value);
      matching = matching.filter(row => row[field] === chosen.value);
    }
  }
  return args;
}

export function metricsHtml(samples: TrendSample[]): string {
  const displayed = samples.slice(0, 1000);
  return `<p>${samples.length} raw measurements returned by CMakeWorkflow.${samples.length > displayed.length ? ' Showing the first 1000; narrow the metric/variant/scenario filters for the remainder.' : ''}</p><table><thead><tr><th>Metric</th><th>Variant</th><th>Scenario</th><th>Method</th><th>Sample</th><th>Value</th><th>Unit</th></tr></thead><tbody>${displayed.map(s => `<tr><td>${escapeHtml(s.metric)}</td><td>${escapeHtml(s.variant ?? '—')}</td><td>${escapeHtml(s.scenario ?? '—')}</td><td>${escapeHtml(s.method)}</td><td>${s.sampleIndex}</td><td>${s.value}</td><td>${escapeHtml(s.unit)}</td></tr>`).join('')}</tbody></table>`;
}
