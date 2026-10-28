import * as path from 'node:path';
import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import type { HistoryDetail } from './protocol';

export interface StackRow { frames: string[]; count: number }
export interface StackCapture {
  backend: string; captureId: string; samples: number; symbolizedSamples: number;
  droppedDistinctStacks: number; stacks: StackRow[];
}
export interface SchedulerEvent { timestamp: string; threadId: number; state: 'ready' | 'running' | 'offcpu'; cpu: number | null }
export interface RunEvidence { stacks: StackCapture[]; scheduler: { captureId: string; events: SchedulerEvent[]; truncated: boolean }[]; warnings: string[] }
export interface ComparisonEvidence { baseline: RunEvidence; candidate: RunEvidence }
const blank = (): RunEvidence => ({ stacks: [], scheduler: [], warnings: [] });
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
export function parseStacks(value: unknown): StackCapture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('Invalid stack evidence'); }
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || !['perf', 'etw'].includes(data.backend as string)
    || typeof data.captureId !== 'string' || typeof data.samples !== 'number'
    || !Number.isSafeInteger(data.samples) || data.samples < 0
    || typeof data.symbolizedSamples !== 'number' || !Number.isSafeInteger(data.symbolizedSamples)
    || data.symbolizedSamples < 0 || data.symbolizedSamples > data.samples
    || !Array.isArray(data.stacks) || data.stacks.length > 250) { throw Error('Invalid stack evidence fields'); }
  const rows: StackRow[] = data.stacks.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('Invalid folded stack'); }
    const item = value as Record<string, unknown>;
    if (typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count <= 0
      || !Array.isArray(item.frames) || item.frames.length === 0 || item.frames.length > 96
      || !item.frames.every(x => typeof x === 'string' && x.length <= 500)) { throw Error('Invalid stack frames'); }
    return { count: item.count, frames: item.frames as string[] };
  });
  return { backend: data.backend as string, captureId: data.captureId as string,
    samples: data.samples, symbolizedSamples: data.symbolizedSamples,
    droppedDistinctStacks: typeof data.droppedDistinctStacks === 'number' ? data.droppedDistinctStacks : 0,
    stacks: rows };
}
export function parseSchedulerEvents(text: string): SchedulerEvent[] {
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length > 10000) { throw Error('Scheduler timeline exceeds 10000-event UI cap'); }
  return lines.map(line => {
    const e = JSON.parse(line) as Record<string, unknown>;
    if (!e || typeof e.timestamp !== 'string' || !Number.isFinite(Date.parse(e.timestamp))
      || typeof e.threadId !== 'number' || !Number.isSafeInteger(e.threadId)
      || !['ready', 'running', 'offcpu'].includes(e.state as string)
      || (e.cpu !== null && (typeof e.cpu !== 'number' || !Number.isSafeInteger(e.cpu)))) {
      throw Error('Invalid scheduler event');
    }
    return e as unknown as SchedulerEvent;
  });
}
export async function loadRunEvidence(detail: HistoryDetail): Promise<RunEvidence> {
  const result = blank();
  let root: string;
  try { root = await realpath(detail.run.directory); }
  catch { result.warnings.push('Saved run directory is missing'); return result; }
  for (const item of detail.artifacts) {
    if (!item.available || !['cpu-stacks', 'scheduler-timeline'].includes(item.type)) { continue; }
    try {
      const target = await realpath(item.path);
      if (!inside(root, target)) { throw Error('Artifact is outside run directory'); }
      const stats = await stat(target);
      if (!stats.isFile() || stats.size > 12 * 1024 * 1024) { throw Error('Artifact is not a supported small file'); }
      const text = await readFile(target, 'utf8');
      if (item.type === 'cpu-stacks') {
        result.stacks.push(parseStacks(JSON.parse(text)));
      } else {
        result.scheduler.push({ captureId: path.basename(target, '.timeline.jsonl'),
          events: parseSchedulerEvents(text), truncated: text.split('\n').length > 9999 });
      }
    } catch (error) { result.warnings.push(`${item.type}: ${String(error)}`); }
  }
  return result;
}
export async function loadComparisonEvidence(baseline: HistoryDetail, candidate: HistoryDetail): Promise<ComparisonEvidence> {
  const [left, right] = await Promise.all([loadRunEvidence(baseline), loadRunEvidence(candidate)]);
  return { baseline: left, candidate: right };
}

// A profile replay stores both variants in the same immutable output
// directory. Load only analyzer-owned normalized artifacts, never scan the
// build tree for arbitrary result candidates.
export async function loadStandaloneProfileEvidence(directory: string): Promise<RunEvidence> {
  const result = blank();
  const normalized = path.join(directory, 'traces', 'normalized');
  let files: string[];
  try { files = await readdir(normalized); }
  catch { return result; }
  const normalizedRoot = await realpath(normalized);
  for (const name of files.filter(x => x.endsWith('.stacks.json') || x.endsWith('.timeline.jsonl'))) {
    try {
      const full = path.join(normalized, name);
      const target = await realpath(full);
      if (!inside(normalizedRoot, target)) { throw Error('Profile evidence points outside normalized directory'); }
      const stats = await stat(target);
      if (!stats.isFile() || stats.size > 12 * 1024 * 1024) { throw Error('Profile evidence exceeds viewing limit'); }
      const text = await readFile(target, 'utf8');
      if (name.endsWith('.stacks.json')) {result.stacks.push(parseStacks(JSON.parse(text)));}
      else {result.scheduler.push({ captureId: name.slice(0, -'.timeline.jsonl'.length),
        events: parseSchedulerEvents(text), truncated: text.split('\n').filter(Boolean).length >= 10000 });}
    } catch (error) { result.warnings.push(`${name}: ${String(error)}`); }
  }
  return result;
}
