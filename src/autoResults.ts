import type { HistoryDifference, HistoryRun } from './protocol';

// Baseline discovery is an ordering hint, not a compatibility verdict.
// Actual provenance and measurement compatibility belong to CLI history compare.
export function automaticBaselines(runs: HistoryRun[], candidate: HistoryRun, pinnedId?: string): HistoryRun[] {
  const candidateStartedAt = candidate.startedAt;
  if (candidate.format !== 'workflow' || candidate.status !== 'succeeded' || !candidateStartedAt) { return []; }
  const earlier = runs.filter(run => run.id !== candidate.id && run.format === 'workflow'
    && run.workflow === candidate.workflow && run.status === 'succeeded' && run.sourceAvailable
    && !!run.startedAt && run.startedAt < candidateStartedAt);
  earlier.sort((a, b) => b.startedAt!.localeCompare(a.startedAt!));
  if (pinnedId) {
    const pinned = earlier.find(run => run.id === pinnedId);
    return pinned ? [pinned] : [];
  }
  return earlier;
}

export function hasCompatibleMeasurements(rows: HistoryDifference[], method?: string): boolean {
  return rows.some(row => (!method || row.method === method) && row.status === 'compatible'
    && (row.baseline?.count ?? 0) > 0 && (row.candidate?.count ?? 0) > 0);
}
