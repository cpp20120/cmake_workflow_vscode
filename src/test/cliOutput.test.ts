import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CliClient, cliFailure } from '../cli';

function child(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
}
test('buffered CLI JSON and diagnostics preserve UTF-8 split at every byte', async () => {
  const process = child();
  const cli = new CliClient({ executable: 'fake', prefixArgs: [], cwd: '/tmp' }, () => {
    queueMicrotask(() => {
      for (const byte of Buffer.from('путь/bench 🚀')) {
        (process.stdout as PassThrough).write(Buffer.from([byte]));
        (process.stderr as PassThrough).write(Buffer.from([byte]));
      }
      process.emit('close', 0, null);
    }); return process;
  });
  let diagnostics = '';
  const result = await cli.run([], undefined, text => { diagnostics += text; });
  assert.equal(result.stdout, 'путь/bench 🚀'); assert.equal(result.stderr, result.stdout); assert.equal(diagnostics, result.stdout);
  cli.dispose();
});
test('an exception while processing the final unterminated line resolves as outputError', async () => {
  const process = child();
  const cli = new CliClient({ executable: 'fake', prefixArgs: [], cwd: '/tmp' }, () => {
    queueMicrotask(() => { (process.stdout as PassThrough).write('last line'); process.emit('close', 0, null); }); return process;
  });
  const result = await cli.run([], () => { throw Error('invalid final event'); });
  assert.match(result.outputError?.message ?? '', /invalid final event/);
  assert.match(cliFailure(result, 'Run') ?? '', /invalid final event/);
  cli.dispose();
});
test('successful History import after failure does not replace the failure diagnostic', () => {
  const message = cliFailure({ code: 1, signal: null, stdout: '', stderr:
    '[CMakeWorkflow] START capture\n[CMakeWorkflow] FAILED capture: permission denied\n[CMakeWorkflow] History: Imported 1\n' }, 'Profile');
  assert.match(message ?? '', /permission denied/); assert.doesNotMatch(message ?? '', /Imported 1/);
});
