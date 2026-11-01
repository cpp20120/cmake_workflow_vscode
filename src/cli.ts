import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { JsonlParser } from './protocol';
import { StringDecoder } from 'node:string_decoder';

export interface CliResult { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; spawnError?: Error; outputError?: Error }
export function cliFailure(result: CliResult, action: string): string | undefined {
  if (result.spawnError) { return `${action}: ${result.spawnError.message}`; }
  if (result.outputError) { return `${action}: ${result.outputError.message}`; }
  if (result.signal) { return `${action}: terminated by ${result.signal}`; }
  if (result.code === 0) { return; }
  const lines = result.stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('[CMakeWorkflow] History:'));
  const diagnostic = lines.find(line => /\b(failed|error|denied|unsupported|unknown)\b|not found|not available/i.test(line)) ?? lines.at(-1);
  return `${action}: CLI exited with code ${result.code}${diagnostic ? `: ${diagnostic.slice(0, 500)}` : '; see CMakeWorkflow output'}`;
}
export interface Invocation { executable: string; prefixArgs: string[]; cwd: string; env?: NodeJS.ProcessEnv }
export type SpawnProcess = (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export class CliClient {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly cancellation = new Map<ChildProcessWithoutNullStreams, ReturnType<typeof setTimeout>>();
  private readonly canceled = new WeakSet<ChildProcessWithoutNullStreams>();
  constructor(private readonly invocation: Invocation, private readonly spawnProcess: SpawnProcess = spawn) {}
  run(args: string[], onEvent?: (line: string) => void, onStderr?: (text: string) => void): Promise<CliResult> {
    return new Promise(resolve => {
      let child: ChildProcessWithoutNullStreams;
      try { child = this.spawnProcess(this.invocation.executable, [...this.invocation.prefixArgs, ...args], { cwd: this.invocation.cwd, env: this.invocation.env, shell: false, windowsHide: true, detached: process.platform !== 'win32' }); }
      catch (error) { resolve({ stdout: '', stderr: '', code: null, signal: null, spawnError: error as Error }); return; }
      this.children.add(child); let stdout = ''; let stderr = ''; let spawnError: Error | undefined; let outputError: Error | undefined; let stdoutBytes = 0;
      const parser = onEvent ? new JsonlParser(onEvent) : undefined;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          if (parser) { parser.push(chunk); }
          else {
            stdoutBytes += chunk.length;
            if (stdoutBytes > 32 * 1024 * 1024) {
              outputError ??= Error('CLI stdout exceeded the 32 MB limit. Narrow the query.');
              this.cancel();
            } else { stdout += stdoutDecoder.write(chunk); }
          }
        } catch (error) { outputError ??= error as Error; this.cancel(); }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk);
        stderr += text;
        if (stderr.length > 1024 * 1024) { stderr = '[CLI stderr truncated to the most recent 1 MiB]\n' + stderr.slice(-1024 * 1024); }
        try { onStderr?.(text); } catch (error) { outputError ??= error as Error; this.cancel(); }
      });
      child.on('error', error => { spawnError = error; });
      child.on('close', (code, signal) => {
        this.children.delete(child);
        const timer = this.cancellation.get(child);
        if (timer) { clearTimeout(timer); this.cancellation.delete(child); }
        try {
          if (parser) { parser.finish(); } else { stdout += stdoutDecoder.end(); }
          const tail = stderrDecoder.end(); stderr += tail; if (tail) { onStderr?.(tail); }
        } catch (error) { outputError ??= error as Error; }
        resolve({ stdout, stderr, code, signal, spawnError, outputError });
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
