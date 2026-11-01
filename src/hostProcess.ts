import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliClient, cliFailure, type Invocation } from './cli';

// Owns only a Host launched by this extension. External endpoints are never stopped.
export class HostProcess {
  private readonly client: CliClient;
  private stopped = false;
  private completed = false;
  private startup?: Promise<string>;
  private completion?: Promise<void>;
  constructor(invocation: Invocation, private readonly log: (text: string) => void) { this.client = new CliClient(invocation); }
  get exited(): boolean { return this.completed; }
  start(): Promise<string> { return this.startup ??= this.launch(); }
  private async launch(): Promise<string> {
    const directory = process.platform === 'win32' ? undefined : await mkdtemp(path.join(os.tmpdir(), 'cmwf-'));
    const endpoint = directory ? path.join(directory, 'rpc.sock') : `\\\\.\\pipe\\cmakeworkflow-${randomUUID()}`;
    if (this.stopped) { if (directory) { await rm(directory, { recursive: true, force: true }); } throw Error('Host stopped'); }
    let resolveReady!: (endpoint: string) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let diagnostic = '';
    const timer = setTimeout(() => { rejectReady(Error('Host startup timed out')); this.dispose(); }, 15000);
    this.completion = this.client.run(['host', 'serve', '--endpoint', endpoint], undefined, text => {
      this.log(text); diagnostic = (diagnostic + text).slice(-16384);
      if (diagnostic.includes(`[Host] Listening: ${endpoint}`)) { clearTimeout(timer); resolveReady(endpoint); }
    }).then(async result => {
      this.completed = true; clearTimeout(timer);
      rejectReady(Error(cliFailure(result, 'Start Host') ?? 'Host exited before connecting'));
      if (directory) { await rm(directory, { recursive: true, force: true }); }
    }).catch(error => { this.completed = true; clearTimeout(timer); rejectReady(error as Error); this.log(`Host cleanup: ${String(error)}\n`); });
    this.log(`Host endpoint: ${endpoint}\n`);
    return ready;
  }
  dispose(): void { this.stopped = true; this.client.dispose(); }
  async stop(): Promise<void> { this.dispose(); await this.completion; }
}
