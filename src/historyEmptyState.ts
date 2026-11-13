import * as path from 'node:path';
import type { HistoryIndexStatus } from './historyProtocol';

export interface HistoryEmptyState {
  message: string;
  action: 'cmakeWorkflow.showHistory' | 'cmakeWorkflow.filterHistory' | 'cmakeWorkflow.chooseHistoryDb'
    | 'cmakeWorkflow.refreshDurableOperations' | 'cmakeWorkflow.openOperationHistory' | 'cmakeWorkflow.retryHistoryIndex';
  operationId?: string;
}

export function historyEmptyState(database: string, missing: boolean, filtered: boolean,
  status?: HistoryIndexStatus): HistoryEmptyState {
  if (status?.state === 'indexed' && status.databasePath && path.relative(database, status.databasePath)) {
    return { message: 'Latest observed run was indexed in another database. Open its history.',
      action: 'cmakeWorkflow.openOperationHistory', operationId: status.operationId };
  }
  if (status?.state === 'failed') {
    return { message: `History indexing failed${status.diagnosticCode ? ` (${status.diagnosticCode})` : ''}. Retry indexing.`,
      action: 'cmakeWorkflow.retryHistoryIndex', operationId: status.operationId };
  }
  if (status?.state === 'pending' || status?.state === 'indexing') {
    return { message: 'History indexing is in progress. Refresh History to check again.', action: 'cmakeWorkflow.showHistory' };
  }
  if (status?.state === 'disabled') {
    return { message: 'History was disabled for the latest observed run. Choose a database to see other runs.',
      action: 'cmakeWorkflow.chooseHistoryDb' };
  }
  if (filtered && !missing) {
    return { message: 'No runs match the current filters. Change or clear filters.', action: 'cmakeWorkflow.filterHistory' };
  }
  return missing
    ? { message: 'This History database does not exist yet. Choose an existing database or run with History enabled.',
      action: 'cmakeWorkflow.chooseHistoryDb' }
    : { message: 'This database has no indexed runs. Refresh Operations to check indexing.',
      action: 'cmakeWorkflow.refreshDurableOperations' };
}
