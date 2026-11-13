import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

export function profileOutputRoot(workspace: string, configured?: string): string {
  return path.resolve(workspace, configured?.trim() || path.join('out', 'profiles'));
}

export function isProfileResultFile(name: string): boolean {
  return name.endsWith('.results.json') || ['analysis.json', 'comparison.json', 'counter-comparison.json'].includes(name);
}

export interface SavedProfile {
  directory: string;
  hasCaptures: boolean;
  hasAnalysis: boolean;
  modified: number;
}

export async function findSavedProfiles(roots: readonly string[], recent: readonly string[]): Promise<SavedProfile[]> {
  const pending = [...recent.map(directory => ({ directory, depth: 0 })),
    ...roots.map(directory => ({ directory, depth: 3 }))];
  const visited = new Map<string, number>();
  const profiles = new Map<string, SavedProfile>();
  for (let i = 0; i < pending.length && i < 1024; i++) {
    const { directory, depth } = pending[i];
    if ((visited.get(directory) ?? -1) >= depth) { continue; }
    visited.set(directory, depth);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = entries.filter(entry => entry.isFile() && isProfileResultFile(entry.name));
    const hasCaptures = files.some(entry => entry.name.endsWith('.results.json'));
    const hasAnalysis = files.some(entry => entry.name === 'analysis.json');
    if (hasCaptures || hasAnalysis || files.some(entry => entry.name === 'counter-comparison.json')
      || (files.length && recent.includes(directory))) {
      profiles.set(directory, {
        directory,
        hasCaptures,
        hasAnalysis,
        modified: await stat(directory).then(info => info.mtimeMs, () => 0),
      });
      continue;
    }
    if (depth) {
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          pending.push({ directory: path.join(directory, entry.name), depth: depth - 1 });
        }
      }
    }
  }
  return [...profiles.values()].sort((a, b) => b.modified - a.modified || a.directory.localeCompare(b.directory));
}
