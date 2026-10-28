import * as path from 'node:path';

interface ConfiguredValue {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

// inspect() separates user choices from VS Code's inferred schema default.
export function configuredJobs(setting: ConfiguredValue | undefined): number | undefined {
  const value = setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
  if (value === undefined) { return undefined; }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw Error('cmakeWorkflow.jobs must be a positive integer.');
  }
  return value;
}

export function resolveHistoryDatabase(workspacePath: string, configured: string): string | undefined {
  const value = configured.trim();
  return value ? path.resolve(workspacePath, value) : undefined;
}
