import * as path from 'node:path';
import type { HistoryDetail } from './protocol';

export interface ReplayChoice { node: string; caseName?: string; harness?: number }

// These are candidates from indexed data, not a provenance verdict. The CLI
// validates saved descriptors, executable hashes and workload compatibility.
export function replayChoices(before: HistoryDetail, after: HistoryDetail): ReplayChoice[] {
  if (!before.run.sourceAvailable || !after.run.sourceAvailable) { return []; }
  const choices = new Map<string, ReplayChoice>();
  for (const node of after.nodes) {
    if (!before.nodes.some(n => n.id === node.id && n.kind === node.kind)) { continue; }
    if (node.kind === 'run') { choices.set(node.id, { node: node.id }); }
    if (node.kind !== 'invoke') { continue; }
    for (const m of after.measurements) {
      if (m.nodeId !== node.id || m.method !== 'dagflow-harness' || !m.scenario) { continue; }
      if (!before.measurements.some(b => b.nodeId === node.id && b.method === m.method
        && b.scenario === m.scenario && b.variant === m.variant)) { continue; }
      const index = m.variant?.match(/^harness-(\d+)$/);
      if (m.variant?.startsWith('harness-') && !index) { continue; }
      const harness = index ? Number(index[1]) : 0;
      if (!Number.isInteger(harness) || harness > 1000) { continue; }
      const choice = { node: node.id, caseName: m.scenario, harness };
      choices.set(JSON.stringify(choice), choice);
    }
  }
  return [...choices.values()];
}

export function parseProgramArguments(text: string): string[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every(x => typeof x === 'string' && !x.includes('\0'))) {
    throw Error('Enter a JSON array of strings, for example ["--case", "chain-4"].');
  }
  return value;
}

export function profileRunArguments(options: {
  build?: string; variants?: { name: string; build: string }[]; target: string; configuration: string; backend: string;
  mode: string; repeats: number; timeout: number; results: string; argv: string[];
}, database?: string): string[] {
  if (options.variants && (options.build || options.variants.length < 2)) { throw Error('Choose at least two variants with distinct build trees.'); }
  if (!options.variants && !options.build) { throw Error('Choose a build tree.'); }
  const args = ['profile', 'run'];
  if (options.variants) {
    for (const variant of options.variants) { args.push('--variant', `${variant.name}=${variant.build}`); }
  } else { args.push('--build-dir', options.build!); }
  args.push('--target', options.target,
    '--backend', options.backend, '--mode', options.mode, '--repeats', String(options.repeats),
    '--timeout-seconds', String(options.timeout), '--results-dir', options.results);
  if (options.configuration) { args.push('--config', options.configuration); }
  if (database) { args.push('--history-db', database); }
  if (options.argv.length) { args.push('--', ...options.argv); }
  return args;
}

export function profileReplayArguments(before: string, after: string, choice: ReplayChoice,
  backend: string, timeout: number, results: string, database?: string): string[] {
  const args = ['profile', 'replay', before, after, '--node', choice.node,
    '--backend', backend, '--timeout-seconds', String(timeout), '--results-dir', results];
  if (choice.caseName !== undefined) { args.push('--case', choice.caseName, '--harness', String(choice.harness ?? 0)); }
  if (database) { args.push('--history-db', database); }
  return args;
}

// Current CLI has no JSON output mode for profile commands. Use only its
// explicit completion markers, never directory scans or generated-name guesses.
export function profileResultDirectory(line: string): string | undefined {
  if (line.startsWith('Profile replay: ')) {
    const directory = line.slice('Profile replay: '.length);
    return path.isAbsolute(directory) ? directory : undefined;
  }
  if (line.startsWith('Profile analysis: ')) {
    const file = line.slice('Profile analysis: '.length);
    return path.isAbsolute(file) && path.basename(file) === 'analysis.json' ? path.dirname(file) : undefined;
  }
  return undefined;
}
