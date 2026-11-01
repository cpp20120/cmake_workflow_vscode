import { cliFailure, type CliClient } from './cli';
import { profileResultDirectory } from './profileActions';

interface Cancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(callback: () => void): { dispose(): void };
}

export async function executeProfile(client: Pick<CliClient, 'run' | 'cancel'>, args: string[],
  token: Cancellation, log: (text: string) => void, knownDirectory?: string): Promise<string | undefined> {
  if (token.isCancellationRequested) { return; }
  const cancellation = token.onCancellationRequested(() => client.cancel());
  let directory = knownDirectory;
  try {
    const result = await client.run(args, line => {
      log(line + '\n');
      directory = profileResultDirectory(line) ?? directory;
    }, log);
    if (token.isCancellationRequested) { log('Profile command canceled; saved results may be incomplete.\n'); return; }
    const failure = cliFailure(result, 'Profile command');
    if (failure) { throw Error(failure); }
    if (!directory) { throw Error('Profile command finished without a result directory. See CMakeWorkflow output; no directory was inferred.'); }
    return directory;
  } finally { cancellation.dispose(); }
}
