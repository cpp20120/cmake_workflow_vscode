import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { findSavedProfiles, profileOutputRoot } from '../savedProfiles';

test('saved profile discovery includes existing output and remembered runs without listing ordinary workflows', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cmwf-profiles-'));
  try {
    const standard = profileOutputRoot(workspace);
    const configured = profileOutputRoot(workspace, 'custom captures');
    const first = path.join(standard, 'run with spaces');
    const second = path.join(configured, 'nested', 'raw-run');
    const recent = path.join(workspace, 'outside standard roots');
    const workflow = path.join(standard, 'plain workflow');
    for (const directory of [first, second, recent, workflow]) { await mkdir(directory, { recursive: true }); }
    await writeFile(path.join(first, 'analysis.json'), '{}');
    await writeFile(path.join(second, 'capture.results.json'), '{}');
    await writeFile(path.join(recent, 'counter-comparison.json'), '{}');
    await writeFile(path.join(workflow, 'run.json'), '{}');
    await writeFile(path.join(workflow, 'comparison.json'), '{}');
    await utimes(first, 1, 1);
    await utimes(second, 3, 3);
    await utimes(recent, 2, 2);

    const profiles = await findSavedProfiles([standard, configured, path.join(workspace, 'missing')], [recent, first]);
    assert.deepEqual(profiles.map(({ directory, hasCaptures, hasAnalysis }) => [directory, hasCaptures, hasAnalysis]), [
      [second, true, false], [recent, false, false], [first, false, true],
    ]);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
