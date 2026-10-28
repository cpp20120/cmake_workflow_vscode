import type { HistoryRun } from './protocol';

export function historyRunFromCommand(value: unknown): HistoryRun | undefined {
  if (!value || typeof value !== 'object') { return; }
  const item = value as Record<string, unknown>;
  const run = item.run && typeof item.run === 'object' ? item.run as Record<string, unknown> : item;
  if (typeof run.id !== 'string' || typeof run.directory !== 'string' || typeof run.status !== 'string') { return; }
  return run as unknown as HistoryRun;
}
