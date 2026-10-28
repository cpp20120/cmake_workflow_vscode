import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { JsonlParser } from './protocol';

export interface CliResult { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; spawnError?: Error; outputError?: Error }
export interface Invocation { executable: string; prefixArgs: string[]; cwd: string }
export type SpawnProcess = (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export class CliClient {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly cancellation = new Map<ChildProcessWithoutNullStreams, ReturnType<typeof setTimeout>>();
  private readonly canceled = new WeakSet<ChildProcessWithoutNullStreams>();
  constructor(private readonly invocation: Invocation, private readonly spawnProcess: SpawnProcess = spawn) {}
  run(args: string[], onEvent?: (line: string) => void, onStderr?: (text: string) => void): Promise<CliResult> {
    return new Promise(resolve => {
      let child: ChildProcessWithoutNullStreams;
      try { child = this.spawnProcess(this.invocation.executable, [...this.invocation.prefixArgs, ...args], { cwd: this.invocation.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32' }); }
      catch (error) { resolve({ stdout: '', stderr: '', code: null, signal: null, spawnError: error as Error }); return; }
      this.children.add(child); let stdout = ''; let stderr = ''; let spawnError: Error | undefined; let outputError: Error | undefined; let stdoutBytes = 0;
      const parser = onEvent ? new JsonlParser(onEvent) : undefined;
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          if (parser) { parser.push(chunk); }
          else {
            stdoutBytes += chunk.length;
            if (stdoutBytes > 32 * 1024 * 1024) {
              outputError ??= Error('CLI stdout exceeded the 32 MB limit. Narrow the query.');
              this.cancel();
            } else { stdout += chunk.toString('utf8'); }
          }
        } catch (error) { outputError ??= error as Error; this.cancel(); }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderr += text;
        if (stderr.length > 1024 * 1024) { stderr = '[CLI stderr truncated to the most recent 1 MiB]\n' + stderr.slice(-1024 * 1024); }
        onStderr?.(text);
      });
      child.on('error', error => { spawnError = error; });
      child.on('close', (code, signal) => {
        this.children.delete(child);
        const timer = this.cancellation.get(child);
        if (timer) { clearTimeout(timer); this.cancellation.delete(child); }
        parser?.finish(); resolve({ stdout, stderr, code, signal, spawnError, outputError });
      });
    });
  }
  // Cancellation is deliberately different from dispose: allow the CLI to write
  // its canceled run.json and release build-tree ownership before escalation.
  cancel(): void {
    for (const child of this.children) {
      if (this.canceled.has(child)) { continue; }
      this.canceled.add(child);
      if (process.platform === 'win32') {
        // Node's child.kill() terminates only the immediate child on Windows.
        // taskkill /T makes tree cleanup explicit; forced termination cannot
        // guarantee that the CLI will finish writing run.json.
        if (child.pid) {
          try { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); killer.on('error', () => { child.kill(); }); }
          catch { child.kill(); }
        } else { child.kill(); }
      } else {
        // Send SIGINT only to the CLI first. Its CancelKeyPress handler triggers
        // cooperative CancellationToken cleanup of CMake/benchmark descendants.
        if (!child.kill('SIGINT')) { continue; }
        const timer = setTimeout(() => {
          if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
        }, 5000);
        timer.unref(); this.cancellation.set(child, timer);
      }
    }
  }
  dispose(): void { this.cancel(); }
}
