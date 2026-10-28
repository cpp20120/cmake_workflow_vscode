import * as path from 'node:path';
import type { HistoryDetail, HistoryMeasurement, Report } from './protocol';
import { matchesPreset, type ChartPreset } from './chartPresets';
import { durationBreakdownHtml, failuresHtml, reportGraphHtml, runVisualCss, timelineHtml } from './runVisuals';

const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const number = (value: number): string => Number(value.toPrecision(5)).toString();

interface Group { label: string; samples: HistoryMeasurement[] }
export function measurementGroups(measurements: HistoryMeasurement[]): Group[] {
  const groups = new Map<string, Group>();
  for (const sample of measurements) {
    const parts = [sample.metric, sample.unit, sample.variant, sample.scenario, sample.method, sample.nodeId];
    const key = JSON.stringify(parts);
    let group = groups.get(key);
    if (!group) {
      group = { label: [sample.metric, sample.variant, sample.scenario, sample.nodeId].filter(Boolean).join(' • ') + ` (${sample.unit || 'unitless'}, ${sample.method})`, samples: [] };
      groups.set(key, group);
    }
    group.samples.push(sample);
  }
  return [...groups.values()].map(group => ({ ...group, samples: group.samples.sort((a, b) => a.sampleIndex - b.sampleIndex) }));
}

export function sampleChart(samples: HistoryMeasurement[]): string {
  if (!samples.length) { return '<p>No samples.</p>'; }
  const ordered = [...samples].sort((a, b) => a.sampleIndex - b.sampleIndex);
  const stride = Math.max(1, Math.ceil(ordered.length / 400));
  const plotted = ordered.filter((_, index) => index % stride === 0 || index === ordered.length - 1);
  let minimum = ordered[0].value, maximum = ordered[0].value;
  for (const sample of ordered) { minimum = Math.min(minimum, sample.value); maximum = Math.max(maximum, sample.value); }
  const low = minimum === maximum ? minimum - 0.5 : minimum;
  const high = minimum === maximum ? maximum + 0.5 : maximum;
  const firstIndex = ordered[0].sampleIndex, lastIndex = ordered.at(-1)!.sampleIndex;
  const points = plotted.map((sample, index) => {
    const x = 48 + (lastIndex === firstIndex ? index / Math.max(1, plotted.length - 1) : (sample.sampleIndex - firstIndex) / (lastIndex - firstIndex)) * 600;
    const y = 145 - ((sample.value - low) / (high - low)) * 112;
    return { x, y, sample };
  });
  const polyline = points.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const dots = points.map(point => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="2.5"><title>sample ${point.sample.sampleIndex}: ${number(point.sample.value)}</title></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 690 180" role="img" aria-label="Samples by sample index">
    <line class="axis" x1="48" y1="33" x2="48" y2="145"/><line class="axis" x1="48" y1="145" x2="648" y2="145"/>
    <text x="4" y="37">${number(maximum)}</text><text x="4" y="146">${number(minimum)}</text>
    <text x="48" y="167">${firstIndex}</text><text x="625" y="167">${lastIndex}</text>
    <polyline points="${polyline}"/>${dots}</svg>
    <p class="small">${plotted.length} of ${ordered.length} samples plotted${stride > 1 ? ' (evenly sampled for display)' : ''}.</p>`;
}

export function renderHistoryHtml(detail: HistoryDetail, nonce: string, preset?: ChartPreset, report?: Report): string {
  const { run } = detail;
  const groups = measurementGroups(detail.measurements.filter(sample => !preset || matchesPreset(preset, sample.metric, sample.scenario)));
  const visible = groups.slice(0, 100);
  const nodes = detail.nodes.map(node => `<tr><td>${escape(node.id)}</td><td>${escape(node.kind)}</td><td>${escape(node.status)}</td><td>${node.durationSeconds === null ? '—' : number(node.durationSeconds)} s</td><td>${escape(node.target ?? '—')}</td></tr>`).join('');
  const artifacts = detail.artifacts.map((artifact, index) => `<tr><td>${escape(artifact.type)}</td><td class="path">${escape(artifact.path)}</td><td>${artifact.available ? `<button data-artifact-index="${index}">Open</button>` : 'Missing'}</td></tr>`).join('');
  const environment = run.environment ? `<h2>Host environment</h2><table><tbody>${Object.entries({ CPU: run.environment.cpuModel, Architecture: run.environment.architecture, 'Logical processors': run.environment.logicalProcessors, OS: run.environment.operatingSystem, Kernel: run.environment.kernelVersion, Affinity: run.environment.affinity, Governor: run.environment.governor }).map(([key, value]) => `<tr><th>${escape(key)}</th><td>${escape(String(value ?? 'unknown'))}</td></tr>`).join('')}</tbody></table>` : '';
  const builds = run.buildEnvironments?.length ? `<h2>Build environments</h2><table><thead><tr><th>Directory</th><th>Configuration</th><th>Generator</th><th>Compiler</th><th>Flags</th></tr></thead><tbody>${run.buildEnvironments.map(build => `<tr><td class="path">${escape(build.directory)}</td><td>${escape(build.configuration ?? '—')}</td><td>${escape(build.generator ?? '—')}</td><td>${escape([build.compilerId, build.compilerVersion].filter(Boolean).join(' ') || '—')}</td><td>${escape(build.flags ?? '—')}</td></tr>`).join('')}</tbody></table>` : '';
  const charts = visible.map((group, index) => `<details ${index === 0 ? 'open' : ''}><summary>${escape(group.label)} • ${group.samples.length} samples</summary>${sampleChart(group.samples)}</details>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;line-height:1.45}
  h1{font-size:1.5rem;margin:0 0 10px}h2{font-size:1.15rem;margin-top:28px}.meta{color:var(--vscode-descriptionForeground)}.path{word-break:break-all}
  .cards{display:flex;flex-wrap:wrap;gap:10px}.card{border:1px solid var(--vscode-panel-border);padding:10px 14px;min-width:110px}.card strong{display:block;font-size:1.3rem}
  table{border-collapse:collapse;width:100%;font-size:.95rem}th,td{border-bottom:1px solid var(--vscode-panel-border);padding:7px;text-align:left;vertical-align:top}
  details{border:1px solid var(--vscode-panel-border);padding:10px;margin:10px 0}summary{cursor:pointer;font-weight:600}.small{font-size:.85rem;color:var(--vscode-descriptionForeground)}
  .chart{width:100%;max-width:900px;height:auto}.chart .axis{stroke:var(--vscode-descriptionForeground)}.chart polyline{fill:none;stroke:var(--vscode-charts-blue,#4f9eed);stroke-width:2}.chart circle{fill:var(--vscode-charts-orange,#d18616)}.chart text{fill:var(--vscode-descriptionForeground);font-size:12px}
  button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 10px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}
  ${runVisualCss}
  </style></head><body>
  <h1>${escape(path.basename(run.workflow ?? run.directory))}</h1><p class="meta">${escape(run.status)} • ${escape(run.format)} • ${escape(run.id)}</p>
  <div class="cards"><div class="card"><strong>${detail.nodes.length}</strong>nodes</div><div class="card"><strong>${detail.measurements.length}</strong>measurements</div><div class="card"><strong>${detail.artifacts.length}</strong>artifacts</div></div>
  <p><strong>Started:</strong> ${escape(run.startedAt ?? 'unknown')}<br><strong>Finished:</strong> ${escape(run.finishedAt ?? 'unknown')}<br><strong>Source:</strong> <span class="path">${escape(run.directory)}</span> ${run.sourceAvailable ? '' : '(missing)'}</p>
  ${environment}${builds}
  ${run.format === 'workflow' && run.sourceAvailable ? '<button data-open-report="true">Open run.json</button>' : ''}
  ${report ? `<h2>Execution timeline</h2>${timelineHtml(report)}<h2>Node durations</h2>${durationBreakdownHtml(report)}<h2>Dependencies</h2>${reportGraphHtml(report)}` : ''}
  <h2>Problems and logs</h2>${failuresHtml(report, detail.artifacts, detail.nodes)}
  <h2>Nodes</h2>${nodes ? `<table><thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Duration</th><th>Target</th></tr></thead><tbody>${nodes}</tbody></table>` : '<p>No indexed nodes.</p>'}
  <h2>Measurements${preset ? ` • ${escape(preset.label)}` : ''}</h2>${charts || (preset ? '<p>No indexed measurements match this preset for this run.</p>' : '<p>No indexed measurements for this run. The CLI cannot plot or statistically compare this run.</p>')}${groups.length > visible.length ? `<p>${groups.length - visible.length} more measurement groups are not rendered.</p>` : ''}
  <h2>Artifacts</h2>${artifacts ? `<table><thead><tr><th>Type</th><th>Path</th><th></th></tr></thead><tbody>${artifacts}</tbody></table>` : '<p>No indexed artifacts.</p>'}
  <script nonce="${nonce}">const vscode=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.artifactIndex!==undefined)vscode.postMessage({type:'openArtifact',index:Number(button.dataset.artifactIndex)});else if(button.dataset.openReport)vscode.postMessage({type:'openReport'});});</script>
  </body></html>`;
}

