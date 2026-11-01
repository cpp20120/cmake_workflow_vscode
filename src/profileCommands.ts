import * as vscode from 'vscode';
import * as path from 'node:path';
import { inspectContext, type InspectedContext } from './inspectionHtml';
import { parseHistoryDetail } from './protocol';
import { parseProgramArguments, profileReplayArguments, profileRunArguments, replayChoices } from './profileActions';

interface Services {
  register(name: string, action: () => Promise<void>): void;
  trusted(): boolean;
  folder(): Promise<vscode.WorkspaceFolder | undefined>;
  pair(): Promise<[vscode.WorkspaceFolder, string, string] | undefined>;
  call(folder: vscode.WorkspaceFolder, args: string[]): Promise<string>;
  historyArgs(folder: vscode.WorkspaceFolder, args: string[]): string[];
  database(folder: vscode.WorkspaceFolder): string | undefined;
  execute(folder: vscode.WorkspaceFolder, args: string[], directory?: string): Promise<void>;
}

async function directory(folder: vscode.WorkspaceFolder, label: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({ defaultUri: folder.uri,
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: label });
  return picked?.[0]?.fsPath;
}
async function number(prompt: string, initial: number, maximum: number, integer = false): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({ prompt, value: String(initial),
    validateInput: text => {
      const n = Number(text);
      return Number.isFinite(n) && n > 0 && n <= maximum && (!integer || Number.isInteger(n))
        ? undefined : `Enter ${integer ? 'an integer' : 'a number'} greater than 0 and at most ${maximum}.`;
    } });
  return value === undefined ? undefined : Number(value);
}
async function captureOptions(folder: vscode.WorkspaceFolder, replay = false): Promise<{
  backend: string; timeout: number; results: string;
} | undefined> {
  const native = process.platform === 'linux' ? 'perf' : process.platform === 'win32' ? 'etw' : 'instruments';
  const backend = await vscode.window.showQuickPick(replay && native === 'instruments' ? ['auto'] : ['auto', native],
    { placeHolder: 'Profiler backend on the workspace host' });
  if (!backend) { return; }
  const timeout = await number('Timeout per capture, seconds', 300, 86400);
  if (timeout === undefined) { return; }
  const configured = vscode.workspace.getConfiguration('cmakeWorkflow', folder.uri).get<string>('resultsDir');
  const results = await vscode.window.showInputBox({ prompt: 'Parent directory for saved profile results (relative to workspace or absolute)',
    value: configured || path.join('out', 'profiles'), validateInput: text => text.trim() && !text.includes('\0') ? undefined : 'Enter a directory.' });
  if (results === undefined) { return; }
  return { backend, timeout, results: path.resolve(folder.uri.fsPath, results) };
}

export function registerProfileCommands(services: Services): void {
  const run = async (multiple: boolean): Promise<void> => {
    if (!services.trusted()) { return; }
    const folder = await services.folder(); if (!folder) { return; }
    const variants: { name: string; build: string; observed: InspectedContext }[] = [];
    do {
      const build = await directory(folder, multiple ? `Choose Build Tree for Variant ${variants.length + 1}` : 'Choose Configured Build Tree');
      if (!build) { return; }
      const observed = inspectContext(JSON.parse(await services.call(folder, ['context', 'inspect', build, '--json'])));
      let name = 'main';
      if (multiple) {
        const value = await vscode.window.showInputBox({ prompt: 'Unique variant name (letters, digits, underscore; start with a lowercase letter)',
          value: `variant_${variants.length + 1}`, validateInput: text => /^[a-z][a-z0-9_]*$/.test(text) && !variants.some(v => v.name === text)
            ? undefined : 'Use a unique lowercase name.' });
        if (value === undefined) { return; } name = value;
        if (variants.some(v => process.platform === 'win32' ? v.build.toLowerCase() === build.toLowerCase() : v.build === build)) {
          throw Error('Each variant must have a distinct build tree.');
        }
      }
      variants.push({ name, build, observed });
      if (!multiple) { break; }
      const next = await vscode.window.showQuickPick([
        { label: 'Add another variant', value: 'add' },
        ...(variants.length >= 2 ? [{ label: 'Continue with these variants', description: variants.map(v => v.name).join(' → '), value: 'continue' }] : []),
      ], { placeHolder: 'Review the variant order; the CLI controls execution and comparison semantics' });
      if (!next) { return; } if (next.value === 'continue') { break; }
    } while (multiple);
    const targets = variants[0].observed.targets.filter(t => t.type === 'EXECUTABLE'
      && variants.every(v => v.observed.targets.some(other => other.type === 'EXECUTABLE'
        && other.name === t.name && other.configuration === t.configuration)));
    if (!targets.length) { throw Error('No common executable target/configuration found. Configure each build tree with CMake File API support first.'); }
    const target = await vscode.window.showQuickPick(targets.map(t => ({ label: t.name, description: t.configuration, target: t })),
      { placeHolder: 'Executable target to build and profile' });
    if (!target) { return; }
    const modes = process.platform === 'linux' ? ['cpu', 'scheduler', 'counters', 'diagnostic'] : ['cpu', 'scheduler', 'diagnostic'];
    const mode = await vscode.window.showQuickPick(modes, { placeHolder: 'Capture mode (diagnostic runs CPU and scheduler passes)' });
    if (!mode) { return; }
    const repeats = await number('Uninstrumented timing repetitions', 3, 100, true); if (repeats === undefined) { return; }
    const text = await vscode.window.showInputBox({ prompt: 'Program arguments as a JSON array; each string is one argument', value: '[]',
      validateInput: value => { try { parseProgramArguments(value); return undefined; } catch { return 'Example: ["--case", "chain-4"]. Strings only.'; } } });
    if (text === undefined) { return; }
    const capture = await captureOptions(folder); if (!capture) { return; }
    await services.execute(folder, profileRunArguments({ ...(multiple ? { variants } : { build: variants[0].build }), target: target.target.name,
      configuration: target.target.configuration, mode, repeats, argv: parseProgramArguments(text), ...capture }, services.database(folder)));
  };
  services.register('cmakeWorkflow.profileRun', () => run(false));
  services.register('cmakeWorkflow.profileVariants', () => run(true));

  services.register('cmakeWorkflow.profileReplay', async () => {
    if (!services.trusted()) { return; }
    const pair = await services.pair(); if (!pair) { return; }
    const [folder, baseline, candidate] = pair;
    const [before, after] = await Promise.all([baseline, candidate].map(async id =>
      parseHistoryDetail(JSON.parse(await services.call(folder, services.historyArgs(folder, ['history', 'show', id, '--json']))))));
    const choices = replayChoices(before, after);
    if (!choices.length) { throw Error('No shared run nodes or indexed DagFlow cases with available saved runs. Replay needs preserved run reports and binaries.'); }
    const picked = await vscode.window.showQuickPick(choices.map(choice => ({ label: choice.node,
      description: choice.caseName ? `${choice.caseName} • harness ${choice.harness}` : 'Direct executable run', choice })),
    { placeHolder: 'Replay baseline → candidate; the CLI verifies preserved binaries and workload' });
    if (!picked) { return; }
    const capture = await captureOptions(folder, true); if (!capture) { return; }
    await services.execute(folder, profileReplayArguments(before.run.directory, after.run.directory,
      picked.choice, capture.backend, capture.timeout, capture.results, services.database(folder)));
  });

  services.register('cmakeWorkflow.profileAnalyze', async () => {
    if (!services.trusted()) { return; }
    const folder = await services.folder(); if (!folder) { return; }
    const saved = await directory(folder, 'Analyze Saved Profile Captures'); if (!saved) { return; }
    await services.execute(folder, ['profile', 'analyze', saved], saved);
  });
}
