import { createHash } from 'node:crypto';
import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { OperationArtifact, OperationArtifactChunk } from './durableProtocol';

export async function downloadOperationArtifact(destination: string, artifact: OperationArtifact,
  read: (offset: number) => Promise<OperationArtifactChunk>, signal?: AbortSignal): Promise<void> {
  const temporary = await mkdtemp(path.join(path.dirname(destination), '.cmakeworkflow-download-'));
  const partial = path.join(temporary, 'artifact');
  try {
    const file = await open(partial, 'wx', 0o600);
    try {
      const digest = createHash('sha256');
      let offset = 0;
      do {
        signal?.throwIfAborted();
        const chunk = await read(offset);
        const next = offset + chunk.content.length;
        if (chunk.artifactId !== artifact.artifactId || chunk.offset !== offset || chunk.totalSize !== artifact.size
          || chunk.lastWriteUtcTicksText !== artifact.lastWriteUtcTicksText || next > artifact.size
          || chunk.eof !== (next === artifact.size) || (!chunk.eof && next === offset)) {
          throw Error('Host artifact changed during download');
        }
        await file.writeFile(chunk.content);
        digest.update(chunk.content);
        offset = next;
      } while (offset < artifact.size);
      if (digest.digest('hex') !== artifact.sha256.toLowerCase()) { throw Error('Host artifact SHA-256 mismatch'); }
    } finally { await file.close(); }
    signal?.throwIfAborted();
    await rename(partial, destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
