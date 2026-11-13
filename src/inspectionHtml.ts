import { runVisualCss } from './runVisuals';
import { trendCss } from './historyTrend';
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function informationHtml(title: string, body: string, nonce: string, script = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; ${script ? `script-src 'nonce-${nonce}';` : ''}"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;line-height:1.45}
  dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 20px;max-width:880px}dt{color:var(--vscode-descriptionForeground)}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}
  h1{font-size:1.5rem}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--vscode-panel-border);padding:7px;text-align:left;vertical-align:top;word-break:break-word}code{font-family:var(--vscode-editor-font-family)}.note{color:var(--vscode-descriptionForeground)}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 10px;cursor:pointer}${runVisualCss}${trendCss}
  .flamegraph,.scheduler-chart{width:100%;max-width:950px;height:auto}.flamegraph .stack-growth{fill:var(--vscode-charts-red,#c95252)}.flamegraph .stack-shrink{fill:var(--vscode-charts-blue,#488bd3)}.flamegraph .stack-stable{fill:var(--vscode-charts-purple,#8772b3)}.flamegraph .stack-label{fill:var(--vscode-editor-foreground);font-size:9px;pointer-events:none}.scheduler-chart text{fill:var(--vscode-editor-foreground);font-size:13px}.sched-running{fill:var(--vscode-charts-blue,#488bd3)}.sched-ready{fill:var(--vscode-charts-orange,#cc8b34)}.sched-offcpu{fill:var(--vscode-descriptionForeground,#888)}
  </style></head><body><h1>${escapeHtml(title)}</h1>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error(`Invalid ${label}`); } return value as Record<string, unknown>; }
function string(value: unknown, label: string): string { if (typeof value !== 'string') { throw Error(`Invalid ${label}`); } return value; }
function optionalString(value: unknown): string { return value === null || value === undefined ? '—' : string(value, 'text'); }
export function toolingProfiles(value: unknown): { id: string; description: string }[] {
  const root = record(value, 'tooling list'); if (root.schemaVersion !== 1 || !Array.isArray(root.profiles)) { throw Error('Unsupported tooling list schema'); }
  return root.profiles.map(value => { const row = record(value, 'tooling profile'); return { id: string(row.id, 'profile ID'), description: string(row.description, 'profile description') }; });
}
export function toolingPlanHtml(value: unknown): string {
  const root = record(value, 'tooling plan'); if (root.schemaVersion !== 1 || typeof root.ready !== 'boolean' || !Array.isArray(root.tools) || !Array.isArray(root.steps)) { throw Error('Unsupported tooling plan schema'); }
  const tools = root.tools.map(value => { const row = record(value, 'tool status'); if (typeof row.installed !== 'boolean') { throw Error('Invalid tool status'); } return `<tr><td>${escapeHtml(string(row.displayName, 'tool name'))}</td><td>${row.installed ? 'Ready' : 'Missing'}</td><td>${escapeHtml(optionalString(row.command))}</td><td>${escapeHtml(optionalString(row.version))}</td><td>${escapeHtml(optionalString(row.diagnostic))}</td></tr>`; }).join('');
  const steps = root.steps.map(value => { const row = record(value, 'tooling step');
    if (row.arguments !== undefined && (!Array.isArray(row.arguments) || !row.arguments.every(a => typeof a === 'string'))) { throw Error('Invalid tool installation arguments'); }
    return `<tr><td>${escapeHtml(string(row.tool, 'step tool'))}</td><td>${escapeHtml(string(row.method, 'step method'))}</td><td><code>${escapeHtml(optionalString(row.executable))} ${escapeHtml(JSON.stringify(row.arguments ?? []))}</code><br>${escapeHtml(optionalString(row.source))}<br>${escapeHtml(optionalString(row.diagnostic))}</td></tr>`;
  }).join('');
  return `<p><strong>${root.ready ? 'Ready' : 'Missing tools'}</strong> • ${escapeHtml(String(root.platform))} • ${escapeHtml(String(root.packageManager))}</p><p>Installation directory: ${escapeHtml(optionalString(root.installDirectory))}</p><table><thead><tr><th>Tool</th><th>Status</th><th>Command</th><th>Version</th><th>Diagnostic</th></tr></thead><tbody>${tools}</tbody></table><h2>Proposed setup steps</h2><table><tbody>${steps}</tbody></table><p class="note">Doctor and plan only inspect tools. Setup is a separate explicit CLI operation.</p>`;
}
export interface InspectedTarget { name: string; configuration: string; type: string; executable: string | null }
export interface InspectedContext { buildDirectory: string; state: string; freshness: string; presetState: string; generator: string | null; sourceDirectory: string | null; configurations: string[]; targets: InspectedTarget[]; diagnostics: string[] }
export function inspectContext(value: unknown): InspectedContext {
  const root = record(value, 'build context');
  if (!Array.isArray(root.configurations) || !root.configurations.every(x => typeof x === 'string') || !Array.isArray(root.targets) || !Array.isArray(root.diagnostics) || !root.diagnostics.every(x => typeof x === 'string')) { throw Error('Invalid build context'); }
  return { buildDirectory: string(root.buildDirectory, 'build directory'), state: string(root.state, 'state'), freshness: string(root.freshness, 'freshness'), presetState: string(root.presetState, 'preset state'), generator: root.generator === null || root.generator === undefined ? null : string(root.generator, 'generator'), sourceDirectory: root.sourceDirectory === null || root.sourceDirectory === undefined ? null : string(root.sourceDirectory, 'source directory'), configurations: root.configurations, diagnostics: root.diagnostics, targets: root.targets.map(value => { const row = record(value, 'target'); return { name: string(row.name, 'target name'), configuration: string(row.configuration, 'target configuration'), type: string(row.type, 'target type'), executable: row.executable === null || row.executable === undefined ? null : string(row.executable, 'executable') }; }) };
}
export function contextHtml(context: InspectedContext): string {
  const targets = context.targets.map(target => `<tr><td>${escapeHtml(target.name)}</td><td>${escapeHtml(target.configuration)}</td><td>${escapeHtml(target.type)}</td><td>${escapeHtml(target.executable ?? '—')}</td></tr>`).join('');
  return `<p><strong>${escapeHtml(context.state)}</strong> • freshness: ${escapeHtml(context.freshness)} • preset: ${escapeHtml(context.presetState)}</p><p>Build: <code>${escapeHtml(context.buildDirectory)}</code><br>Source: <code>${escapeHtml(context.sourceDirectory ?? '—')}</code><br>Generator: ${escapeHtml(context.generator ?? '—')}<br>Configurations: ${escapeHtml(context.configurations.join(', ') || '—')}</p><h2>Targets (${context.targets.length})</h2><table><thead><tr><th>Name</th><th>Configuration</th><th>Type</th><th>Observed executable</th></tr></thead><tbody>${targets}</tbody></table><h2>Diagnostics</h2><ul>${context.diagnostics.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p class="note">Inspection reads the CMake File API and does not configure or build.</p>`;
}
export function resolvedTargetHtml(value: unknown): string {
  const root = record(value, 'target resolution'); if (root.schemaVersion !== 1) { throw Error('Unsupported target resolution schema'); }
  return `<p>Build: <code>${escapeHtml(string(root.buildDirectory, 'build directory'))}</code><br>Target: ${escapeHtml(string(root.target, 'target'))}<br>Configuration: ${escapeHtml(optionalString(root.configuration))}<br>Executable: <code>${escapeHtml(string(root.executable, 'executable'))}</code></p>`;
}
