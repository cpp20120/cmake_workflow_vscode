export type ChartSource = 'history' | 'dagflow';
export interface ChartPreset {
  id: string;
  label: string;
  source: ChartSource;
  metrics: string[];
  cases: string[];
}

export const builtInPresets: readonly ChartPreset[] = [
  { id: 'history-all', label: 'History: all metrics', source: 'history', metrics: ['*'], cases: [] },
  { id: 'history-process', label: 'History: process time', source: 'history', metrics: ['process_wall_time'], cases: [] },
  { id: 'dagflow-all', label: 'DagFlow: all metrics', source: 'dagflow', metrics: ['*'], cases: [] },
  { id: 'dagflow-api', label: 'DagFlow: public API', source: 'dagflow', metrics: ['mean_s', 'throughput_per_s'], cases: [] },
  { id: 'dagflow-runtime', label: 'DagFlow: runtime throughput', source: 'dagflow', metrics: ['payload_tasks_per_second', 'run_p50_us'], cases: [] },
  { id: 'dagflow-graph', label: 'DagFlow: graph and scheduler', source: 'dagflow', metrics: ['payload_tasks_per_second', 'run_p50_us', 'run_p99_us', 'latency_p99_us'], cases: ['graph', 'dag', 'fanout', 'scope', 'steal', 'local_saturated'] },
  { id: 'dagflow-latency', label: 'DagFlow: latency', source: 'dagflow', metrics: ['run_p50_us', 'run_p99_us', 'run_p999_us', 'latency_p50_us', 'latency_p99_us', 'latency_p999_us'], cases: [] },
];

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0);

export function parseCustomPresets(value: unknown): ChartPreset[] {
  if (!Array.isArray(value)) { throw Error('cmakeWorkflow.chartPresets must be an array.'); }
  const ids = new Set(builtInPresets.map(preset => preset.id));
  return value.map((entry, index) => {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id.trim()
      || typeof entry.label !== 'string' || !entry.label.trim()
      || (entry.source !== 'history' && entry.source !== 'dagflow')
      || !stringList(entry.metrics) || !stringList(entry.cases)) {
      throw Error(`Invalid chart preset at index ${index}.`);
    }
    if (ids.has(entry.id)) { throw Error(`Duplicate chart preset ID: ${entry.id}`); }
    ids.add(entry.id);
    return { id: entry.id, label: entry.label, source: entry.source, metrics: entry.metrics, cases: entry.cases };
  });
}

export function matchesPreset(preset: ChartPreset, metric: string, caseName?: string | null): boolean {
  const metricMatches = preset.metrics.includes('*') || preset.metrics.includes(metric);
  const caseMatches = !preset.cases.length || (caseName !== null && caseName !== undefined
    && preset.cases.some(fragment => caseName.toLowerCase().includes(fragment.toLowerCase())));
  return metricMatches && caseMatches;
}

export function defaultPreset(source: ChartSource): ChartPreset {
  return builtInPresets.find(preset => preset.id === `${source === 'dagflow' ? 'dagflow' : 'history'}-all`)!;
}
