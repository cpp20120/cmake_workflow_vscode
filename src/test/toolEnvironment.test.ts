import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { toolDirectory, toolEnvironment } from '../toolEnvironment';
import { CliClient } from '../cli';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

test('tool directory is resolved per workspace without modifying global environment', () => {
  assert.equal(toolDirectory('tools with spaces', '/workspace'), path.resolve('/workspace/tools with spaces'));
  assert.equal(toolDirectory('', '/workspace'), null);
  assert.throws(() => toolDirectory(['bad'], '/workspace'));
  const base = { PATH: '/usr/bin:/usr/local/bin', HOME: '/user' };
  const one = toolEnvironment('/one/tools', base, 'linux'), two = toolEnvironment('/two/tools', base, 'linux');
  assert.equal(one?.PATH, '/one/tools:/usr/bin:/usr/local/bin');
  assert.equal(two?.PATH, '/two/tools:/usr/bin:/usr/local/bin');
  assert.equal(base.PATH, '/usr/bin:/usr/local/bin');
  assert.equal(toolEnvironment(null, base), undefined);
});

test('Windows PATH has one case-insensitive key and keeps whitespace paths', () => {
  const env = toolEnvironment('C:\\Tools Dir', { Path: 'c:\\tools dir;C:\\Windows', PATH: 'ignored' }, 'win32');
  assert.deepEqual(env, { Path: 'C:\\Tools Dir;C:\\Windows' });
});

test('CLI adapter passes workspace environment without using a shell', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
  const env = { PATH: '/chosen tool dir:/usr/bin' };
  const client = new CliClient({ executable: 'CMakeWorkflow', prefixArgs: [], cwd: '/workspace', env }, (_exe, _args, options) => {
    assert.equal(options.env, env); assert.equal(options.shell, false);
    queueMicrotask(() => child.emit('close', 0, null)); return child;
  });
  assert.equal((await client.run(['tooling', 'doctor'])).code, 0); client.dispose();
});
