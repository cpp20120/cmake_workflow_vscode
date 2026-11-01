import * as path from 'node:path';

export function toolDirectory(value: unknown, cwd: string): string | null {
  if (typeof value !== 'string' || value.includes('\0')) { throw Error('cmakeWorkflow.toolingInstallDirectory must be a path string.'); }
  return value.trim() ? path.resolve(cwd, value.trim()) : null;
}
// Resource-scoped child environment only; never mutate process.env or shell profiles.
export function toolEnvironment(directory: string | null, base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv | undefined {
  if (!directory) { return; }
  const result = { ...base };
  const keys = Object.keys(result).filter(key => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
  const key = keys[0] ?? (platform === 'win32' ? 'Path' : 'PATH');
  const delimiter = platform === 'win32' ? ';' : ':';
  const entries = (result[key] ?? '').split(delimiter).filter(Boolean);
  for (const name of keys) { delete result[name]; }
  result[key] = [directory, ...entries.filter(p => platform === 'win32' ? p.toLowerCase() !== directory.toLowerCase() : p !== directory)].join(delimiter);
  return result;
}
