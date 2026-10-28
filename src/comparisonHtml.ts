import * as path from 'node:path';
import type { HistoryDetail, HistoryDifference, HistoryMeasurement } from './protocol';
import { profileEvidenceHtml } from './profileVisualization';
import type { ComparisonEvidence } from './profileEvidence';
import { matchesPreset, type ChartPreset } from './chartPresets';

const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const display = (value: number | null | undefined): string => value === null || value === undefined ? '—' : Number(value.toPrecision(5)).toString();
const samplesFor = (detail: HistoryDetail, row: HistoryDifference): HistoryMeasurement[] => detail.measurements.filter(sample => sample.metric === row.metric && sample.unit === row.unit && sample.variant === row.variant && sample.scenario === row.scenario && sample.method === row.method);
export function environmentComparisonHtml(baseline: HistoryDetail, candidate: HistoryDetail): string {
  const a = baseline.run.environment, b = candidate.run.environment;
  const fields: [string, string | number | null | undefined, string | number | null | undefined][] = [
    ['CPU', a?.cpuModel, b?.cpuModel], ['Architecture', a?.architecture, b?.architecture], ['Logical processors', a?.logicalProcessors, b?.logicalProcessors],
    ['OS', a?.operatingSystem, b?.operatingSystem], ['Kernel', a?.kernelVersion, b?.kernelVersion], ['Affinity', a?.affinity, b?.affinity], ['Governor', a?.governor, b?.governor],
  ];
  const builds = Math.max(baseline.run.buildEnvironments?.length ?? 0, candidate.run.buildEnvironments?.length ?? 0);
  for (let index = 0; index < builds; index++) {
    const left = baseline.run.buildEnvironments?.[index], right = candidate.run.buildEnvironments?.[index];
    fields.push([`Build ${index + 1} directory`, left?.directory, right?.directory], [`Build ${index + 1} configuration`, left?.configuration, right?.configuration], [`Build ${index + 1} generator`, left?.generator, right?.generator], [`Build ${index + 1} compiler`, [left?.compilerId, left?.compilerVersion].filter(Boolean).join(' ') || null, [right?.compilerId, right?.compilerVersion].filter(Boolean).join(' ') || null], [`Build ${index + 1} flags`, left?.flags, right?.flags]);
  }
  const rows = fields.map(([name, left, right]) => { const changed = left !== null && left !== undefined && right !== null && right !== undefined && left !== right; return `<tr${changed ? ' class="changed"' : ''}><th>${escape(name)}</th><td>${escape(String(left ?? 'unknown'))}</td><td>${escape(String(right ?? 'unknown'))}</td></tr>`; }).join('');
  return `<h2>Recorded environments</h2><p class="small">Highlighted rows have different recorded values. This display does not decide comparability; use the CLI comparison status below.</p><table><thead><tr><th>Field</th><th>Baseline</th><th>Candidate</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function comparisonChart(row: HistoryDifference, baseline: HistoryMeasurement[], candidate: HistoryMeasurement[], medianSource = 'CLI'): string {
  if (!baseline.length && !candidate.length) { return '<p>No indexed raw samples for this metric.</p>'; }
  const raw = [...baseline, ...candidate].map(sample => sample.value);
  const sorted = [...raw].sort((a, b) => a - b);
  const quantile = (values: number[], fraction: number): number => {
    if (values.length === 0) { return NaN; }
    const index = (values.length - 1) * fraction;
    const low = Math.floor(index), high = Math.ceil(index);
    return values[low] + (values[high] - values[low]) * (index - low);
  };
  let minimum = Infinity, maximum = -Infinity;
  for (const value of raw) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  const medianValues = [row.baseline?.median, row.candidate?.median].filter((x): x is number => x !== undefined && Number.isFinite(x));
  for (const median of medianValues) { minimum = Math.min(minimum, median); maximum = Math.max(maximum, median); }
  if (minimum === maximum) { minimum -= 0.5; maximum += 0.5; }
  const xAt = (value: number, low: number, high: number): number => 90 + (value - low) / (high - low) * 560;
  const chart = (low: number, high: number, focused: boolean): string => {
    const x = (value: number): string => xAt(value, low, high).toFixed(2);
    const dots = (samples: HistoryMeasurement[], y: number, css: string): string => {
      const stride = Math.max(1, Math.ceil(samples.length / 400));
      return samples.filter((sample, index) => (index % stride === 0 || index === samples.length - 1) && sample.value >= low && sample.value <= high)
        .map(sample => `<circle class="${css}" cx="${x(sample.value)}" cy="${y + ((sample.sampleIndex % 7) - 3) * 3}" r="2.5"><title>sample ${sample.sampleIndex}: ${display(sample.value)}</title></circle>`).join('');
    };
    const median = (value: number | undefined, y: number, css: string): string => value === undefined ? '' : `<line class="${css}" x1="${x(Math.min(high, Math.max(low, value)))}" y1="${y - 21}" x2="${x(Math.min(high, Math.max(low, value)))}" y2="${y + 21}"/>`;
    const excluded = focused ? ` • ${baseline.filter(x => x.value < low || x.value > high).length} baseline / ${candidate.filter(x => x.value < low || x.value > high).length} candidate points outside focus (not deleted from full range)` : '';
    return `<svg class="chart" viewBox="0 0 700 190" role="img" aria-label="${focused ? 'Focused' : 'Full range'} raw samples and medians"><text x="5" y="71">Baseline</text><text x="5" y="130">Candidate</text>
      <line class="axis" x1="90" y1="160" x2="650" y2="160"/><text x="90" y="181">${display(low)}</text><text x="600" y="181">${display(high)}</text>
      ${dots(baseline, 66, 'baseline')}${dots(candidate, 126, 'candidate')}
      ${median(row.baseline?.median, 66, 'baseline-median')}${median(row.candidate?.median, 126, 'candidate-median')}</svg><p class="small">${focused ? 'Focused p10–p90 range' : 'Full range'}${excluded}. Dots show up to 400 samples per run; median markers come from ${escape(medianSource)}. Baseline n=${baseline.length}; candidate n=${candidate.length}.</p>`;
  };
  const focusLow = quantile(sorted, 0.1), focusHigh = quantile(sorted, 0.9);
  const margin = Math.max((focusHigh - focusLow) * .15, (maximum - minimum) * 0.002);
  const focus = sorted.length >= 8 && focusHigh > focusLow && (maximum - minimum) > (focusHigh - focusLow) * 1.6
    ? `<details><summary>Focus on central distribution (p10–p90)</summary>${chart(Math.max(minimum, focusLow - margin), Math.min(maximum, focusHigh + margin), true)}</details>` : '';
  // ECDF is monotone and preserves the tail information hidden by a dense dot plot.
  const ecdf = (samples: HistoryMeasurement[], css: string): string => {
    const values = samples.map(sample => sample.value).sort((a, b) => a - b);
    if (!values.length) { return ''; }
    const stride = Math.max(1, Math.ceil(values.length / 500));
    const indices = values.map((_, i) => i).filter(i => i % stride === 0 || i === values.length - 1);
    const points = [[xAt(values[0], minimum, maximum), 158], ...indices.map(i => [xAt(values[i], minimum, maximum), 158 - ((i + 1) / values.length) * 116])];
    return `<polyline class="${css}-ecdf" points="${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}"/>`;
  };
  const ecdfChart = `<details><summary>ECDF — full distribution and tails</summary><svg class="chart" viewBox="0 0 700 190" role="img" aria-label="Empirical cumulative distribution"><line class="axis" x1="90" y1="158" x2="650" y2="158"/><text x="9" y="45">100%</text><text x="24" y="158">0%</text><text x="90" y="181">${display(minimum)}</text><text x="600" y="181">${display(maximum)}</text>${ecdf(baseline, 'baseline')}${ecdf(candidate, 'candidate')}</svg><p class="small">Blue: baseline; orange: candidate. ECDF shows the entire distribution without treating outliers as noise. Descriptive only; no statistical verdict.</p></details>`;
  return `${chart(minimum, maximum, false)}${focus}${ecdfChart}`;
}

export function profileSignalCharts(rows: HistoryDifference[]): string {
  const signal = rows.filter(row => row.method.startsWith('perf stat') || row.method.startsWith('ETW '));
  if (!signal.length) { return ''; }
  const comparable = signal.filter(row => row.status === 'compatible'
    && (row.baseline?.median ?? 0) > 0 && (row.candidate?.median ?? 0) > 0);
  // Symmetric logarithmic ratio: 2x and 0.5x have the same visual distance.
  // Clamp the bar, not the displayed ratio. Do not invent measurements when
  // a counter was unsupported or the attribution/comparability is unknown.
  const entries = comparable.slice(0, 64).map((row, index) => {
    const baseline = row.baseline!.median, candidate = row.candidate!.median;
    const ratio = candidate / baseline;
    const displacement = Math.max(-2, Math.min(2, Math.log2(ratio))) / 2 * 220;
    const y = 33 + index * 36;
    const start = Math.min(345, 345 + displacement);
    const label = `${row.metric} • ${row.variant ?? 'default'} (${row.unit || 'unitless'})`;
    return `<g><text x="4" y="${y + 12}">${escape(label)}</text><rect x="${start.toFixed(2)}" y="${y + 17}" width="${Math.max(1, Math.abs(displacement)).toFixed(2)}" height="11" class="${ratio >= 1 ? 'profile-more' : 'profile-less'}"><title>${escape(label)}: baseline ${display(baseline)}, candidate ${display(candidate)}, ratio ${display(ratio)}x</title></rect><text x="${ratio >= 1 ? 355 + displacement : 355}" y="${y + 27}" class="profile-value">${escape(display(ratio))}x</text></g>`;
  });
  const height = Math.max(90, 44 + entries.length * 36);
  const chart = entries.length ? `<svg class="profile-chart" viewBox="0 0 800 ${height}" role="img" aria-label="Profiler signal ratios in log2 scale"><line class="profile-center" x1="345" y1="14" x2="345" y2="${height - 10}"/>${entries.join('')}</svg><p class="small">Ratio to baseline (log₂): left means a lower value; right means a higher value. Lower is not universally better (for example IPC). Bars are capped visually at 4× and 0.25×. Single captures are descriptive, not a statistical verdict.</p>` : '';
  const unsupported = signal.filter(row => row.status !== 'compatible');
  const issues = unsupported.length ? `<details><summary>${unsupported.length} profiler signals without a compatible comparison</summary><table><thead><tr><th>Signal</th><th>Status</th><th>Reason</th></tr></thead><tbody>${unsupported.map(row => `<tr><td>${escape(row.metric)}</td><td>${escape(row.status)}</td><td>${escape(row.reason ?? '')}</td></tr>`).join('')}</tbody></table></details>` : '';
  return `<h2>Profiler evidence</h2><p class="small">perf PMU and ETW are different measurement backends; their event counts, scheduling intervals and sampled stacks are never combined. Profiling passes are separate from timing.</p>${chart || '<p>No compatible positive-valued profiler signals for ratio plotting.</p>'}${issues}`;
}

export function profileArtifactLinks(baseline: HistoryDetail, candidate: HistoryDetail): string {
  const sources = [{ name: 'Baseline', detail: baseline, id: 'baseline' }, { name: 'Candidate', detail: candidate, id: 'candidate' }];
  const allowed = new Set(['trace', 'capture-result', 'capture-manifest', 'etw-summary',
    'analysis.json', 'counter-comparison.json', 'comparison.json', 'cpu-stacks', 'scheduler-timeline']);
  const groups = sources.map(({ name, detail, id }) => {
    const links = detail.artifacts.map((artifact, index) => ({ artifact, index }))
      .filter(({ artifact }) => artifact.available && allowed.has(artifact.type));
    if (!links.length) { return ''; }
    return `<div class="profile-artifacts"><strong>${name}</strong> ${links.slice(0, 30).map(({ artifact, index }) => `<button type="button" data-profile-side="${id}" data-profile-index="${index}">${escape(artifact.type)} • ${escape(path.basename(artifact.path))}</button>`).join(' ')}</div>`;
  }).filter(Boolean);
  return groups.length ? `<h3>Recorded profile artifacts</h3>${groups.join('')}<p class="small">Open raw perf.data or ETL in the platform profiler for full stack analysis. Profile archives are not regenerated when this panel opens.</p>` : '';
}

export function renderComparisonHtml(baseline: HistoryDetail, candidate: HistoryDetail, rows: HistoryDifference[], nonce: string, preset?: ChartPreset, evidence?: ComparisonEvidence): string {
  const table = rows.map(row => `<tr><td>${escape(row.metric)}</td><td>${escape(row.variant ?? '—')}</td><td>${escape(row.scenario ?? '—')}</td><td>${escape(row.status)}</td><td>${display(row.baseline?.median)}</td><td>${display(row.candidate?.median)}</td><td>${display(row.percentChange)}%</td><td>${escape(row.reason ?? '')}</td></tr>`).join('');
  const chartRows = rows.filter(row => row.metric !== '*' && !row.method.startsWith('perf stat')
    && !row.method.startsWith('ETW ') && (!preset || matchesPreset(preset, row.metric, row.scenario)));
  const visible = chartRows.slice(0, 100);
  const charts = visible.map((row, index) => `<details ${index === 0 ? 'open' : ''}><summary>${escape(row.metric)}${row.variant ? ` • ${escape(row.variant)}` : ''}${row.scenario ? ` • ${escape(row.scenario)}` : ''} • ${escape(row.status)}</summary>${comparisonChart(row, samplesFor(baseline, row), samplesFor(candidate, row))}</details>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;line-height:1.45}
  h1{font-size:1.5rem}.meta{color:var(--vscode-descriptionForeground);word-break:break-all}.small{font-size:.85rem;color:var(--vscode-descriptionForeground)}
  table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--vscode-panel-border);padding:7px;text-align:left;vertical-align:top}
  tr.changed{background:var(--vscode-diffEditor-insertedTextBackground,rgba(120,120,40,.18))}
  details{border:1px solid var(--vscode-panel-border);padding:10px;margin:10px 0}summary{cursor:pointer;font-weight:600}
  .chart{width:100%;max-width:900px;height:auto}.chart .baseline-ecdf{fill:none;stroke:var(--vscode-charts-blue,#4f9eed);stroke-width:2}.chart .candidate-ecdf{fill:none;stroke:var(--vscode-charts-orange,#d18616);stroke-width:2}.chart .axis{stroke:var(--vscode-descriptionForeground)}.chart .baseline{fill:var(--vscode-charts-blue,#4f9eed)}.chart .candidate{fill:var(--vscode-charts-orange,#d18616)}.chart .baseline-median{stroke:var(--vscode-charts-blue,#4f9eed);stroke-width:3}.chart .candidate-median{stroke:var(--vscode-charts-orange,#d18616);stroke-width:3}.chart text{fill:var(--vscode-descriptionForeground);font-size:12px}
  .profile-chart{width:100%;max-width:900px;height:auto}.profile-chart text{font-size:11px;fill:var(--vscode-foreground)}
  .profile-chart .profile-more{fill:var(--vscode-charts-orange,#d18616)}.profile-chart .profile-less{fill:var(--vscode-charts-blue,#4f9eed)}
  .profile-chart .profile-center{stroke:var(--vscode-descriptionForeground);stroke-dasharray:4 4}
  .flamegraph,.scheduler-chart{width:100%;max-width:950px;height:auto}.flamegraph .stack-growth{fill:var(--vscode-charts-red,#c95252)}.flamegraph .stack-shrink{fill:var(--vscode-charts-blue,#488bd3)}.flamegraph .stack-stable{fill:var(--vscode-charts-purple,#8772b3)}.flamegraph .stack-label{fill:var(--vscode-editor-foreground);font-size:9px;pointer-events:none}.scheduler-chart text{fill:var(--vscode-editor-foreground);font-size:13px}.sched-running{fill:var(--vscode-charts-blue,#488bd3)}.sched-ready{fill:var(--vscode-charts-orange,#cc8b34)}.sched-offcpu{fill:var(--vscode-descriptionForeground,#888)}
  .profile-artifacts{margin:10px 0;line-height:2.5}.profile-artifacts button{margin:2px;padding:4px 8px;border:1px solid var(--vscode-button-background);background:transparent;color:var(--vscode-foreground);cursor:pointer}
  </style></head><body><h1>Run comparison</h1>
  <p><strong>Baseline:</strong> ${escape(path.basename(baseline.run.workflow ?? baseline.run.directory))}<br><span class="meta">${escape(baseline.run.id)}</span><br>
  <strong>Candidate:</strong> ${escape(path.basename(candidate.run.workflow ?? candidate.run.directory))}<br><span class="meta">${escape(candidate.run.id)}</span></p>
  <p class="small">Comparison status and medians come from CMakeWorkflow. Charts show indexed raw samples; they do not imply a statistical verdict.</p>
  ${environmentComparisonHtml(baseline, candidate)}
  <h2>CLI comparison</h2><table><thead><tr><th>Metric</th><th>Variant</th><th>Scenario</th><th>Status</th><th>Baseline median</th><th>Candidate median</th><th>Change</th><th>Reason</th></tr></thead><tbody>${table}</tbody></table>
  ${profileSignalCharts(rows)}${evidence ? profileEvidenceHtml(evidence) : ''}${profileArtifactLinks(baseline, candidate)}
  <h2>Samples${preset ? ` • ${escape(preset.label)}` : ''}</h2>${charts || (preset ? '<p>No indexed measurements match this preset for this pair.</p>' : '<p>No indexed measurements to plot for this pair.</p>')}${chartRows.length > visible.length ? `<p>${chartRows.length - visible.length} more metric rows are not plotted.</p>` : ''}
  <script nonce="${nonce}">const vscode=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('button[data-profile-side]');if(button)vscode.postMessage({type:'openProfileArtifact',side:button.dataset.profileSide,index:Number(button.dataset.profileIndex)});});</script>
  </body></html>`;
}
