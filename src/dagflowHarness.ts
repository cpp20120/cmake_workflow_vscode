export interface HarnessMetric { median: number; count: number }
export interface HarnessRun { status: string; manifestHash: string | null; metrics: Map<string, HarnessMetric>; samples: Map<string, number[]> }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error(`Invalid ${label}`); }
  return value as Record<string, unknown>;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) { throw Error(`Invalid ${label}`); }
  return value;
}
export function parseHarness(summary: unknown, jsonl: string): HarnessRun {
  const root = object(summary, 'harness summary');
  if (typeof root.status !== 'string' || (root.manifest_sha256 !== undefined && typeof root.manifest_sha256 !== 'string')) { throw Error('Invalid harness status or manifest hash'); }
  const cases = object(root.cases, 'harness cases');
  const metrics = new Map<string, HarnessMetric>();
  for (const [caseName, rawCase] of Object.entries(cases)) {
    for (const [metricName, rawMetric] of Object.entries(object(object(rawCase, `case ${caseName}`).metrics, 'case metrics'))) {
      const metric = object(rawMetric, metricName);
      const scale = finite(metric.scale, 'metric scale');
      const count = finite(metric.count, 'metric count');
      if (scale <= 0 || !Number.isSafeInteger(count) || count < 0) { throw Error(`Invalid metric scale or count: ${caseName}/${metricName}`); }
      metrics.set(JSON.stringify([caseName, metricName]), { median: finite(metric.median, 'metric median') / scale, count });
    }
  }
  const samples = new Map<string, number[]>();
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) { continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw Error(`Invalid runs.jsonl line ${index + 1}`); }
    const row = object(parsed, `runs.jsonl line ${index + 1}`);
    if (typeof row.case !== 'string' || typeof row.warmup !== 'boolean' || typeof row.result !== 'string') { throw Error(`Invalid runs.jsonl line ${index + 1}`); }
    if (root.manifest_sha256 !== undefined && row.manifest_sha256 !== undefined && row.manifest_sha256 !== root.manifest_sha256) { throw Error(`Manifest hash mismatch at runs.jsonl line ${index + 1}`); }
    if (row.warmup || row.result !== '0') { continue; }
    const output = object(row.output, `output at line ${index + 1}`);
    for (const metricName of Object.keys(output)) {
      const key = JSON.stringify([row.case, metricName]);
      if (!metrics.has(key)) { continue; }
      const value = finite(output[metricName], `${metricName} at line ${index + 1}`);
      const points = samples.get(key) ?? [];
      points.push(value);
      samples.set(key, points);
    }
  }
  return { status: root.status, manifestHash: root.manifest_sha256 ?? null, metrics, samples };
}

export function metricKey(key: string): [string, string] { return JSON.parse(key) as [string, string]; }
