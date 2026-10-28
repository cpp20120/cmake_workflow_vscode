import type { HistoryArtifact, HistoryNode, Report, Plan } from './protocol';

const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const number = (value: number): string => Number(value.toPrecision(4)).toString();
const statusClass = (status: string): string => ['succeeded','failed','blocked','canceled','running','pending'].includes(status) ? status : 'pending';

export function timelineHtml(report: Report): string {
  const started = report.startedAt ? Date.parse(report.startedAt) : NaN;
  const rows = report.nodes.filter(node => node.startedAt && node.finishedAt).map(node => ({ node, start: Date.parse(node.startedAt!), end: Date.parse(node.finishedAt!) })).filter(row => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end >= row.start).sort((a, b) => a.start - b.start);
  if (!rows.length) { return '<p>No completed node timestamps in the saved report.</p>'; }
  const origin = Number.isFinite(started) ? started : rows[0].start;
  const end = Math.max(...rows.map(row => row.end));
  const scale = (value: number): number => 210 + (end === origin ? 0 : (value - origin) / (end - origin) * 650);
  const visible = rows.slice(0, 100);
  const height = 30 + visible.length * 27;
  const bars = visible.map((row, index) => {
    const y = 30 + index * 27, x = scale(row.start), width = Math.max(2, scale(row.end) - x);
    const elapsed = row.node.durationSeconds ?? (row.end - row.start) / 1000;
    return `<text x="5" y="${y + 13}">${escape(row.node.id.slice(0, 27))}</text><rect class="${statusClass(row.node.status)}" x="${x.toFixed(2)}" y="${y}" width="${width.toFixed(2)}" height="18"><title>${escape(row.node.id)} • ${escape(row.node.status)} • ${number(elapsed)} s</title></rect>`;
  }).join('');
  return `<p class="small">Observed start and finish times from run.json; simultaneous bars show overlap, not a scheduling prediction.</p><svg class="timeline" viewBox="0 0 880 ${height + 15}" role="img" aria-label="Workflow node timeline"><text x="210" y="18">0 s</text><text x="795" y="18">${number((end - origin) / 1000)} s</text>${bars}</svg>${rows.length > visible.length ? `<p>${rows.length - visible.length} additional nodes are omitted from the chart.</p>` : ''}`;
}

// Separate duration scale: a 540-second invoke must not hide a 0.5-second configure.
// Log scaling here is explicitly *not* a concurrency/timeline visualization.
export function durationBreakdownHtml(report: Report): string {
  const rows = report.nodes.filter(node => node.durationSeconds !== null && node.durationSeconds !== undefined && Number.isFinite(node.durationSeconds) && node.durationSeconds >= 0)
    .map(node => ({ id: node.id, status: node.status, duration: node.durationSeconds! }))
    .sort((a, b) => b.duration - a.duration).slice(0, 80);
  if (!rows.length) { return '<p>No completed node durations.</p>'; }
  const ceiling = Math.max(...rows.map(row => Math.log1p(row.duration)), 0.001);
  const lines = rows.map(row => `<div class="duration-row"><span title="${escape(row.id)}">${escape(row.id)}</span><div class="duration-track"><div class="duration-fill ${statusClass(row.status)}" style="width:${Math.max(0.5, Math.log1p(row.duration) / ceiling * 100).toFixed(2)}%"></div></div><span>${number(row.duration)} s</span></div>`).join('');
  return `<p class="small">Node duration breakdown (log1p scale). Bar lengths are not proportional to wall time; use the timeline above to inspect overlap.</p><div class="duration-breakdown">${lines}</div>`;
}

export interface GraphNode { id: string; kind: string; dependencies: string[]; status?: string; diagnostics?: string[] }
export function dependencyGraphHtml(nodes: GraphNode[]): string {
  if (!nodes.length) { return '<p>No nodes to display.</p>'; }
  const visible = nodes.slice(0, 80);
  const byId = new Map(visible.map(node => [node.id, node]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => { if (depths.has(id)) { return depths.get(id)!; } if (visiting.has(id)) { return 0; } visiting.add(id); const node = byId.get(id); const value = node ? Math.max(0, ...node.dependencies.filter(parent => byId.has(parent)).map(parent => depth(parent) + 1)) : 0; visiting.delete(id); depths.set(id, value); return value; };
  for (const node of visible) { depth(node.id); }
  const levels = new Map<number, GraphNode[]>();
  for (const node of visible) { const level = depths.get(node.id)!; const group = levels.get(level) ?? []; group.push(node); levels.set(level, group); }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, group] of levels) { group.forEach((node, index) => positions.set(node.id, { x: 20 + level * 210, y: 20 + index * 56 })); }
  const width = Math.max(440, 40 + (Math.max(...levels.keys()) + 1) * 210);
  const height = Math.max(100, 50 + Math.max(...[...levels.values()].map(group => group.length)) * 56);
  const edges = visible.flatMap(node => node.dependencies.filter(parent => positions.has(parent)).map(parent => { const a = positions.get(parent)!, b = positions.get(node.id)!; return `<path d="M ${a.x + 175} ${a.y + 17} L ${b.x - 3} ${b.y + 17}" marker-end="url(#dependency-arrow)"/>`; })).join('');
  const boxes = visible.map(node => { const p = positions.get(node.id)!; const diagnostics = node.diagnostics?.join(' | ') ?? ''; return `<g><rect class="${statusClass(node.status ?? (diagnostics ? 'failed' : 'pending'))}" x="${p.x}" y="${p.y}" width="175" height="35" rx="5"><title>${escape(node.id)} • ${escape(node.kind)}${diagnostics ? ` • ${escape(diagnostics)}` : ''}</title></rect><text x="${p.x + 7}" y="${p.y + 22}">${escape(node.id.slice(0, 22))}</text></g>`; }).join('');
  return `<p class="small">Arrows show dependencies recorded by the CLI. Hover a node for its kind, status and diagnostics.</p><div class="graph-scroll"><svg class="dependency-graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Workflow dependency graph"><defs><marker id="dependency-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z"/></marker></defs><g class="edges">${edges}</g>${boxes}</svg></div>${nodes.length > visible.length ? `<p>${nodes.length - visible.length} further nodes are not drawn; use the tree for the complete plan.</p>` : ''}`;
}
export function planGraphHtml(plan: Plan): string { return dependencyGraphHtml(plan.nodes.map(node => ({ id: node.id, kind: node.kind, dependencies: node.dependencies, diagnostics: node.diagnostics.filter(item => item.severity === 'Error').map(item => item.message) }))); }
export function reportGraphHtml(report: Report): string { return dependencyGraphHtml(report.nodes.map(node => ({ id: node.id, kind: node.kind, status: node.status, dependencies: node.dependencies }))); }

export function failuresHtml(report: Report | undefined, artifacts: HistoryArtifact[], indexedNodes: HistoryNode[] = []): string {
  const failed = (report?.nodes ?? indexedNodes.map(node => ({ id: node.id, status: node.status, error: null, exitCode: null }))).filter(node => ['failed','blocked','canceled'].includes(node.status));
  if (!failed.length) { return '<p>No failed, blocked or canceled nodes.</p>'; }
  return failed.map(node => {
    const links = artifacts.map((artifact, index) => ({ artifact, index })).filter(item => item.artifact.nodeId === node.id && ['stdout','stderr'].includes(item.artifact.type));
    return `<details><summary>${escape(node.id)} • ${escape(node.status)}${node.exitCode !== null ? ` • exit ${node.exitCode}` : ''}</summary><p>${escape(node.error ?? (node.status === 'blocked' ? 'A prerequisite did not succeed.' : 'No error text recorded.'))}</p>${links.map(({ artifact, index }) => artifact.available ? `<button data-artifact-index="${index}">Open ${escape(artifact.type)}</button>` : `<span>${escape(artifact.type)} missing</span>`).join(' ') || '<p>No indexed stdout/stderr logs for this node.</p>'}</details>`;
  }).join('');
}

export const runVisualCss = `.duration-row{display:grid;grid-template-columns:minmax(100px,170px) minmax(100px,1fr) 90px;align-items:center;gap:10px;padding:4px 0}.duration-row>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.duration-track{background:var(--vscode-input-background);height:14px}.duration-fill{background:var(--vscode-charts-blue,#4f9eed);height:100%}.duration-fill.failed{background:var(--vscode-charts-red,#e05a5a)}.timeline{width:100%;min-width:650px;height:auto}.timeline text,.dependency-graph text{fill:var(--vscode-foreground);font-size:12px}.timeline rect,.dependency-graph rect{fill:var(--vscode-charts-blue,#4f9eed)}.timeline .failed,.dependency-graph .failed{fill:var(--vscode-charts-red,#e05a5a)}.timeline .blocked,.dependency-graph .blocked{fill:var(--vscode-charts-yellow,#c9a227)}.timeline .canceled,.dependency-graph .canceled{fill:var(--vscode-descriptionForeground)}.timeline .running,.dependency-graph .running{fill:var(--vscode-charts-orange,#d18616)}.dependency-graph .edges{fill:none;stroke:var(--vscode-descriptionForeground);stroke-width:1.5}.dependency-graph marker path{fill:var(--vscode-descriptionForeground)}.graph-scroll{max-width:100%;overflow:auto;border:1px solid var(--vscode-panel-border)}`;
