import { parseHistory } from './protocol';

export type HistoryPolicy =
  | { mode: 'Disabled' | 'Default' }
  | { mode: 'ExplicitDatabase'; databasePath: string };

const indexStates = ['disabled', 'awaitingFinalization', 'pending', 'indexing', 'indexed', 'failed'] as const;
export interface HistoryIndexStatus {
  operationId: string;
  state: typeof indexStates[number];
  databasePath: string | null;
  updatedAt: string | null;
  diagnosticCode: string | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('Invalid Host History response'); }
  return value as Record<string, unknown>;
}
function nullableText(value: unknown): value is string | null { return value === null || typeof value === 'string'; }

export function parseHistoryPolicy(value: unknown): HistoryPolicy | undefined {
  if (value === undefined || value === null) { return; }
  const { mode, databasePath } = object(value);
  if ((mode === 'Default' || mode === 'Disabled') && (databasePath === undefined || databasePath === null)) { return { mode }; }
  if (mode === 'ExplicitDatabase' && typeof databasePath === 'string' && databasePath.length > 0) {
    return { mode, databasePath };
  }
  throw Error('Invalid Host History policy');
}

export function parseHistoryIndexStatus(value: unknown, operationId: string): HistoryIndexStatus {
  const { operationId: id, state, databasePath, updatedAt, diagnosticCode } = object(value);
  const matched = indexStates.find(candidate => candidate === state);
  if (id !== operationId || !matched || !nullableText(databasePath) || !nullableText(updatedAt)
    || !nullableText(diagnosticCode) || (updatedAt !== null && !Number.isFinite(Date.parse(updatedAt)))) {
    throw Error('Invalid Host History indexing status');
  }
  return { operationId, state: matched, databasePath, updatedAt, diagnosticCode };
}

export function parseHistoryPage(value: unknown) {
  const { schemaVersion, items, nextCursor } = object(value);
  if (schemaVersion !== 1 || !nullableText(nextCursor) || nextCursor === '') { throw Error('Invalid Host History page'); }
  return { items: parseHistory(items), nextCursor };
}

export function parseHistoryImport(value: unknown) {
  const result = object(value);
  function count(key: string): number {
    const value = result[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { throw Error('Invalid Host History import count'); }
    return value;
  }
  if (result.schemaVersion !== 1) { throw Error('Invalid Host History import version'); }
  return { imported: count('imported'), unchanged: count('unchanged'), skipped: count('skipped') };
}
