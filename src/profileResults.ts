import * as path from 'node:path';
import { escapeHtml } from './inspectionHtml';
import type { RunEvidence } from './profileEvidence';
import { differentialFlamegraph, schedulerTimeline } from './profileVisualization';

function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error(`Invalid ${name}`); } return value as Record<string, unknown>; }
function versioned(value: unknown, name: string): Record<string, unknown> { const row = object(value, name); if (row.schemaVersion !== 1) { throw Error(`Unsupported ${name} schemaVersion ${String(row.schemaVersion)}`); } return row; }
const cell = (value: unknown): string => escapeHtml(value === null || value === undefined ? '—' : String(value));
export interface ProfileArtifact { label: string; path: string }
export interface ProfilePresentation { body: string; artifacts: ProfileArtifact[] }
export function presentProfileResults(directory: string, files: Record<string, unknown>, evidence?: RunEvidence): ProfilePresentation {
  const artifacts: ProfileArtifact[] = [];
  const artifact = (label: string, file: string): string => {
    const resolved = path.resolve(directory, file);
    if (resolved !== directory && !resolved.startsWith(directory + path.sep)) { return '<span>Outside run directory</span>'; }
    const index = artifacts.push({ label, path: resolved }) - 1;
    return `<button data-artifact="${index}">Open ${escapeHtml(label)}</button>`;
  };
  let body = `<p>Saved profile results in <code>${escapeHtml(directory)}</code>.</p>`;
  const comparison = files['comparison.json'];
  if (comparison !== undefined) {
    const root = versioned(comparison, 'timing comparison'); if (!Array.isArray(root.variants)) { throw Error('Invalid timing variants'); }
    body += `<h2>Timing comparison</h2><p>${cell(root.measurement)} • baseline: ${cell(root.baseline)}</p><table><tr><th>Variant</th><th>Count</th><th>Median seconds</th><th>Ratio to baseline</th></tr>${root.variants.map(value => { const row = object(value, 'timing variant'); return `<tr><td>${cell(row.name)}</td><td>${cell(row.count)}</td><td>${cell(row.medianSeconds)}</td><td>${cell(row.ratioToBaseline)}</td></tr>`; }).join('')}</table>${artifact('comparison.json', 'comparison.json')}`;
  }
  const counters = files['counter-comparison.json'];
  if (counters !== undefined) {
    const root = versioned(counters, 'counter comparison'); if (!Array.isArray(root.variants)) { throw Error('Invalid counter variants'); }
    const rows = root.variants.flatMap(value => { const variant = object(value, 'counter variant'); const events = object(variant.events, 'counter events'); return Object.entries(events).map(([name, raw]) => { const event = object(raw, 'counter'); return `<tr><td>${cell(variant.name)}</td><td>${cell(name)}</td><td>${cell(event.value)}</td><td>${cell(event.unit)}</td><td>${cell(event.ratioToBaseline)}</td></tr>`; }); });
    const derived = root.variants.flatMap(value => { const variant = object(value, 'counter variant'); const metrics = variant.derived === undefined ? {} : object(variant.derived, 'derived metrics'); return Object.entries(metrics).map(([name, raw]) => { const metric = object(raw, 'derived counter'); return `<tr><td>${cell(variant.name)}</td><td>${cell(name)}</td><td>${cell(metric.value)}</td><td>${cell(metric.unit)}</td><td>${cell(metric.ratioToBaseline)}</td></tr>`; }); });
    body += `<h2>Counters</h2><p>${cell(root.backend)} • baseline: ${cell(root.baseline)}. ${cell(root.comparability)}</p><table><tr><th>Variant</th><th>Event</th><th>Value</th><th>Unit</th><th>Ratio</th></tr>${rows.join('')}</table>${derived.length ? `<h3>Derived PMU signals</h3><p class="note">IPC and misses per thousand instructions are computed from the same profiler capture, not inferred from timing runs.</p><table><tr><th>Variant</th><th>Metric</th><th>Value</th><th>Unit</th><th>Ratio</th></tr>${derived.join('')}</table>` : ''}${artifact('counter-comparison.json', 'counter-comparison.json')}`;
  }
  const analysis = files['analysis.json'];
  if (analysis !== undefined) {
    if (!Array.isArray(analysis)) { throw Error('Invalid profile analysis'); }
    body += `<h2>Captures</h2><table><tr><th>ID</th><th>Backend</th><th>Mode</th><th>Event source</th><th>Files</th></tr>${analysis.map(value => { const capture = object(value, 'profile capture'); const links = ['report','rawTrace','eventDump','samples','stacks','timeline'].flatMap(key => typeof capture[key] === 'string' ? [artifact(key, capture[key])] : []); return `<tr><td>${cell(capture.captureId)}</td><td>${cell(capture.backend)}</td><td>${cell(capture.mode)}</td><td>${cell(capture.eventSource)}</td><td>${links.join(' ')}</td></tr>`; }).join('')}</table>${artifact('analysis.json', 'analysis.json')}`;
  }
  for (const name of Object.keys(files).filter(name => name.endsWith('.results.json'))) {
    const capture = object(files[name], 'capture result');
    body += `<h2>${cell(name)}</h2><p>Status: ${cell(capture.status)} • backend: ${cell(capture.backend)} • mode: ${cell(capture.mode)}</p>${artifact(name, name)}`;
    if (typeof capture.rawTrace === 'string') { body += ` ${artifact('raw trace', capture.rawTrace)}`; }
  }
  if (evidence) {
    const first = evidence.stacks.find(x => x.captureId === 'capture_before');
    const second = evidence.stacks.find(x => x.captureId === 'capture_after');
    if (first && second) {body += differentialFlamegraph(first, second);}
    for (const timeline of evidence.scheduler.slice(0, 4)) {
      body += schedulerTimeline(timeline,
        timeline.captureId.endsWith('_before') ? 'Baseline' : timeline.captureId.endsWith('_after') ? 'Candidate' : 'Capture');
    }
    if (evidence.warnings.length) {body += `<p class="note">${evidence.warnings.map(escapeHtml).join('; ')}</p>`;}
  }
  if (!Object.keys(files).length) { body += '<p>No saved profile analysis or capture result files were found.</p>'; }
  body += '<p class="note">Values and ratios come from saved CLI reports. Opening this view does not rerun analysis or profiling.</p>';
  return { body, artifacts };
}
