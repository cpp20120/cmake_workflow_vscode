import * as vscode from 'vscode';
import * as path from 'node:path';
import { escapeHtml, inspectContext, toolingPlanHtml, toolingProfiles, type InspectedTarget } from './inspectionHtml';
import { pickDirectory, programArguments, type CommandServices } from './commandUi';

async function targetChoice(targets: InspectedTarget[], prompt: string): Promise<InspectedTarget | undefined> {
  if (!targets.length) { throw Error('No suitable targets observed. Configure the build tree with CMake File API metadata first.'); }
  const item = await vscode.window.showQuickPick(targets.map(target => ({ label: target.name,
    description: `${target.type} • ${target.configuration || '(default)'}`, target })), { placeHolder: prompt });
  return item?.target;
}

export function registerNativeCommands(services: CommandServices): void {
  for (const action of ['build', 'invoke', 'run'] as const) {
    services.register(`cmakeWorkflow.target${action[0].toUpperCase()}${action.slice(1)}`, async () => {
      if (!services.trusted()) { return; }
      const folder = await services.folder(); if (!folder) { return; }
      const build = await pickDirectory(folder, 'Choose Configured Build Tree'); if (!build) { return; }
      const context = inspectContext(JSON.parse(await services.call(folder, ['context', 'inspect', build, '--json'])));
      const allowed = ['EXECUTABLE', 'STATIC_LIBRARY', 'SHARED_LIBRARY', 'MODULE_LIBRARY', 'OBJECT_LIBRARY'];
      const targets = context.targets.filter(t => action === 'invoke' || (action === 'run' ? t.type === 'EXECUTABLE' : allowed.includes(t.type)));
      let target: InspectedTarget | undefined;
      if (action === 'invoke') {
        const choice = await vscode.window.showQuickPick([
          ...targets.map(t => ({ label: t.name, description: `${t.type} • ${t.configuration}`, target: t })),
          { label: 'Enter target name…', description: 'For native targets absent from File API', target: undefined },
        ], { placeHolder: 'Intentionally invoke a native target (may run project commands)' });
        if (!choice) { return; }
        target = choice.target;
        if (!target) {
          const name = await vscode.window.showInputBox({ prompt: 'Native target name', validateInput: s => s.trim() && !s.includes('\0') ? undefined : 'Enter a target name.' });
          if (name === undefined) { return; }
          const configuration = await vscode.window.showInputBox({ prompt: 'Configuration (blank uses CLI default)', value: '' });
          if (configuration === undefined) { return; }
          target = { name, configuration, type: 'UTILITY', executable: null };
        }
      } else { target = await targetChoice(targets, `Target to ${action}`); }
      if (!target) { return; }
      const args = ['target', action, '--build-dir', build, '--target', target.name];
      if (target.configuration) { args.push('--config', target.configuration); }
      if (action === 'run') {
        const argv = await programArguments('Program arguments as a JSON array'); if (!argv) { return; }
        if (argv.length) { args.push('--', ...argv); }
      }
      await services.execute(folder, args);
    });
  }

  services.register('cmakeWorkflow.runSequence', async () => {
    if (!services.trusted()) { return; }
    const folder = await services.folder(); if (!folder) { return; }
    const build = await pickDirectory(folder, 'Choose Sequence Build Tree'); if (!build) { return; }
    const context = inspectContext(JSON.parse(await services.call(folder, ['context', 'inspect', build, '--json'])));
    const targets = context.targets.filter(t => t.type === 'EXECUTABLE');
    const first = await targetChoice(targets, 'First target: build and run'); if (!first) { return; }
    const second = await targetChoice(targets.filter(t => t.configuration === first.configuration), 'Second target: build and run after the first completes');
    if (!second) { return; }
    const firstArgs = await programArguments(`Arguments for first target ${first.name}`); if (!firstArgs) { return; }
    const secondArgs = await programArguments(`Arguments for second target ${second.name}`); if (!secondArgs) { return; }
    const args = ['workflow', 'sequence', '--build-dir', build, '--first', first.name, '--second', second.name];
    if (first.configuration) { args.push('--config', first.configuration); }
    for (const arg of firstArgs) { args.push('--first-arg', arg); }
    for (const arg of secondArgs) { args.push('--second-arg', arg); }
    await services.execute(folder, args);
  });

  for (const setup of [false, true]) {
    services.register(setup ? 'cmakeWorkflow.toolingSetup' : 'cmakeWorkflow.toolingPlan', async () => {
      if (!services.trusted()) { return; }
      const folder = await services.folder(); if (!folder) { return; }
      const profiles = toolingProfiles(JSON.parse(await services.call(folder, ['tooling', 'list', '--json'])));
      const selected = await vscode.window.showQuickPick(profiles.map(p => ({ label: p.id, description: p.description })),
        { canPickMany: true, placeHolder: 'Tool profiles to plan' });
      if (!selected?.length) { return; }
      const pm = await vscode.window.showQuickPick(['auto', 'none', 'apt', 'pacman', 'dnf', 'brew', 'winget'], { placeHolder: 'Package manager on the workspace host' });
      if (!pm) { return; }
      const install = await vscode.window.showInputBox({ prompt: 'Optional standalone tool installation directory; blank uses CLI default', value: '' });
      if (install === undefined) { return; }
      const fallback = await vscode.window.showQuickPick([{ label: 'Allow CLI fallback installation', value: true },
        { label: 'Disable fallback installation', value: false }], { placeHolder: 'Installation policy' });
      if (!fallback) { return; }
      const options = selected.flatMap(p => ['--profile', p.label]); options.push('--pm', pm);
      if (install) { options.push('--install-dir', path.resolve(folder.uri.fsPath, install)); }
      if (!fallback.value) { options.push('--no-fallback'); }
      const plan: unknown = JSON.parse(await services.call(folder, ['tooling', 'plan', ...options, '--json']));
      services.show('Tool installation plan', toolingPlanHtml(plan));
      if (!setup) { return; }
      const confirm = await vscode.window.showInformationMessage('Apply this CLI tool installation plan to the workspace host?',
        { modal: true, detail: `Profiles: ${selected.map(p => p.label).join(', ')}. Review the displayed plan. Installation can change system packages and download tools.` }, 'Apply Plan');
      if (confirm !== 'Apply Plan') { return; }
      const output = await services.execute(folder, ['tooling', 'setup', ...options, '--yes', '--json'], true);
      if (output === undefined) { return; }
      const result: unknown = JSON.parse(output);
      if (!result || typeof result !== 'object') { throw Error('Invalid tooling result'); }
      const r = result as Record<string, unknown>;
      if (r.schemaVersion !== 1 || typeof r.success !== 'boolean'
        || ![r.ready, r.failed, r.diagnostics].every(a => Array.isArray(a) && a.every(x => typeof x === 'string'))) { throw Error('Unsupported tooling result'); }
      const list = (value: unknown): string => (value as string[]).map(s => `<li>${escapeHtml(s)}</li>`).join('');
      services.show('Tool installation result', `<p>${r.success ? 'Succeeded' : 'Failed'}</p><h2>Ready</h2><ul>${list(r.ready)}</ul><h2>Failed</h2><ul>${list(r.failed)}</ul><h2>Diagnostics</h2><ul>${list(r.diagnostics)}</ul>`);
    });
  }
}
