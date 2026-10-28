import * as path from 'node:path';
import { comparisonChart } from './comparisonHtml';
import type { HistoryDifference, HistoryMeasurement } from './protocol';
import type { ChartPreset } from './chartPresets';
import { matchesPreset } from './chartPresets';
import { metricKey, type HarnessRun } from './dagflowHarness';

const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const display = (value: number | undefined): string => value === undefined ? '—' : Number(value.toPrecision(5)).toString();
export function harnessMatrixHtml(baseline: HarnessRun, candidate: HarnessRun, keys: string[]): string {
  const cases = [...new Set(keys.map(key => metricKey(key)[0]))];
  const metrics = [...new Set(keys.map(key => metricKey(key)[1]))];
  if (!keys.length) { return '<p>No case/metric pairs match this preset.</p>'; }
  const common = keys.filter(key => baseline.metrics.has(key) && candidate.metrics.has(key)).length;
  const rows = cases.map(caseName => `<tr><th>${escape(caseName)}</th>${metrics.map(metric => {
    const key = JSON.stringify([caseName, metric]);
    if (!keys.includes(key)) { return '<td>—</td>'; }
    const base = baseline.metrics.get(key)?.median, cand = candidate.metrics.get(key)?.median;
    if (base === undefined || cand === undefined) { return `<td title="${base === undefined ? 'Baseline' : 'Candidate'} missing">—</td>`; }
    const index = keys.indexOf(key);
    const link = (label: string): string => index < 150 ? `<a href="#chart-${index}">${label}</a>` : label;
    if (base === 0) { return `<td title="Baseline median is zero; percent change undefined">${link(`${display(base)} → ${display(cand)}`)}</td>`; }
    const change = (cand - base) / Math.abs(base) * 100;
    const bucket = Math.min(3, Math.max(1, Math.ceil(Math.abs(change) / 10)));
    return `<td class="${change >= 0 ? 'up' : 'down'}${bucket}" title="Baseline ${display(base)}; candidate ${display(cand)}">${link(`${change >= 0 ? '+' : ''}${display(change)}%`)}</td>`;
  }).join('')}</tr>`).join('');
  return `${common === 0 ? '<p>No common case/metric pairs: choose two results from the same kind of campaign to see a comparison.</p>' : `<p>${common} case/metric pairs occur in both results.</p>`}<div class="matrix-scroll"><table class="matrix"><thead><tr><th>Case</th>${metrics.map(metric => `<th>${escape(metric)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><p class="small">Orange means a larger candidate median; blue means a smaller one. Color does not indicate better, worse or statistical significance.</p>`;
}

export function renderHarnessHtml(baseline: HarnessRun, candidate: HarnessRun, baselinePath: string, candidatePath: string, preset: ChartPreset, nonce: string): string {
  const keys = [...new Set([...baseline.metrics.keys(), ...candidate.metrics.keys()])].filter(key => {
    const [caseName, metric] = metricKey(key);
    return matchesPreset(preset, metric, caseName);
  }).sort();
  const charts = keys.slice(0, 150).map((key, index) => {
    const [caseName, metric] = metricKey(key);
    const base = baseline.metrics.get(key), cand = candidate.metrics.get(key);
    const samples = (run: HarnessRun): HistoryMeasurement[] => (run.samples.get(key) ?? []).map((value, sampleIndex) => ({ nodeId: null, metric, unit: '', value, variant: null, scenario: caseName, method: 'harness', sampleIndex }));
    const row: HistoryDifference = { metric, unit: '', variant: null, scenario: caseName, method: 'harness', status: base && cand ? 'both present' : 'one side missing', reason: null, baseline: base ? { median: base.median, count: base.count, min: base.median, max: base.median, mean: base.median, standardDeviation: 0 } : null, candidate: cand ? { median: cand.median, count: cand.count, min: cand.median, max: cand.median, mean: cand.median, standardDeviation: 0 } : null, absoluteChange: null, percentChange: null };
    return `<details id="chart-${index}" ${index === 0 ? 'open' : ''}><summary>${escape(caseName)} • ${escape(metric)} — baseline ${display(base?.median)}, candidate ${display(cand?.median)}</summary>${comparisonChart(row, samples(baseline), samples(candidate), 'DagFlow harness')}</details>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;line-height:1.45}
  h1{font-size:1.5rem}.meta{color:var(--vscode-descriptionForeground);word-break:break-all}.small{font-size:.85rem;color:var(--vscode-descriptionForeground)}
  details{border:1px solid var(--vscode-panel-border);padding:10px;margin:10px 0}summary{cursor:pointer;font-weight:600}
  .matrix-scroll{overflow:auto;max-height:700px}.matrix{border-collapse:collapse;white-space:nowrap}.matrix th,.matrix td{border:1px solid var(--vscode-panel-border);padding:6px}.matrix th{position:sticky;top:0;background:var(--vscode-editor-background)}.matrix .up1{background:rgba(210,135,22,.15)}.matrix .up2{background:rgba(210,135,22,.3)}.matrix .up3{background:rgba(210,135,22,.5)}.matrix .down1{background:rgba(79,158,237,.15)}.matrix .down2{background:rgba(79,158,237,.3)}.matrix .down3{background:rgba(79,158,237,.5)}
  .matrix a{color:var(--vscode-foreground);text-decoration:underline}details:target{outline:2px solid var(--vscode-focusBorder)}
  .chart{width:100%;max-width:900px;height:auto}.chart .baseline-ecdf{fill:none;stroke:var(--vscode-charts-blue,#4f9eed);stroke-width:2}.chart .candidate-ecdf{fill:none;stroke:var(--vscode-charts-orange,#d18616);stroke-width:2}.chart .axis{stroke:var(--vscode-descriptionForeground)}.chart .baseline{fill:var(--vscode-charts-blue,#4f9eed)}.chart .candidate{fill:var(--vscode-charts-orange,#d18616)}.chart .baseline-median{stroke:var(--vscode-charts-blue,#4f9eed);stroke-width:3}.chart .candidate-median{stroke:var(--vscode-charts-orange,#d18616);stroke-width:3}.chart text{fill:var(--vscode-descriptionForeground);font-size:12px}
  </style></head><body><h1>DagFlow harness comparison</h1>
  <p><strong>Baseline:</strong> ${escape(path.basename(path.dirname(baselinePath)))} (${escape(baseline.status)})<br><span class="meta">${escape(baselinePath)}</span><br>
  <strong>Candidate:</strong> ${escape(path.basename(path.dirname(candidatePath)))} (${escape(candidate.status)})<br><span class="meta">${escape(candidatePath)}</span></p>
  <p>Preset: <strong>${escape(preset.label)}</strong> • ${keys.length} case/metric pairs</p>
  <p class="small">Medians are from the harness summary (scaled as recorded); dots are successful non-warmup runs from runs.jsonl. This is a visual comparison only; it has no statistical verdict.</p>
  ${baseline.manifestHash === null || candidate.manifestHash === null ? '<p class="small">At least one older harness result has no manifest hash; sample-to-summary identity cannot be verified from that file.</p>' : ''}
  <h2>Case matrix</h2>${harnessMatrixHtml(baseline, candidate, keys)}<h2>Raw samples</h2>
  ${charts || '<p>No matching metrics or raw samples for this preset.</p>'}${keys.length > 150 ? `<p>${keys.length - 150} further pairs are not rendered.</p>` : ''}<script nonce="${nonce}">document.addEventListener('click',event=>{const link=event.target.closest('a[href^="#chart-"]');if(!link)return;const target=document.getElementById(link.getAttribute('href').slice(1));if(target&&target.tagName==='DETAILS')target.open=true;});</script></body></html>`;
}
