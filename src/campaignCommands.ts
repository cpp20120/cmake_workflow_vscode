import * as vscode from 'vscode';
import * as path from 'node:path';
import { pickDirectory, type CommandServices } from './commandUi';

interface Field {
  flag: string; label: string; kind?: 'directory' | 'path' | 'integer' | 'boolean';
  required?: boolean; maximum?: number; choices?: string[];
}
interface Campaign { id: string; label: string; command: string[]; fields: Field[] }
const source: Field = { flag: '--source-dir', label: 'DagFlow source tree', kind: 'directory' };
const compiler: Field = { flag: '--cxx', label: 'C++ compiler (CLI default: c++)' };
const report: Field = { flag: '--report', label: 'Report JSON path', kind: 'path' };
const timeout: Field = { flag: '--timeout', label: 'Timeout, seconds', kind: 'integer' };
const runDir: Field = { flag: '--run-dir', label: 'Saved fuzz run directory', kind: 'directory', required: true };
// Options are from CampaignCommand; names and constraints are validated again by
// the CLI. No discovery of binaries, scheduling or corpus processing happens here.
const campaigns: Campaign[] = [
  { id: 'mutationRun', label: 'Mutation campaign', command: ['mutation', 'run'], fields: [source,
    { flag: '--suite', label: 'Suite, model or mutant name (CLI default: all)' }, compiler,
    { flag: '--seed', label: 'Seed' }, { flag: '--cases', label: 'Cases', kind: 'integer' },
    { flag: '--steps', label: 'Steps', kind: 'integer' }, timeout, report] },
  { id: 'weakMemoryRun', label: 'Weak-memory campaign', command: ['weak-memory', 'run'], fields: [source,
    { flag: '--protocol', label: 'Protocol', choices: ['all', 'deque', 'parking', 'completion', 'idle_accounting', 'shutdown'] },
    { flag: '--relacy', label: 'Relacy root containing relacy/relacy.hpp', kind: 'directory', required: true }, compiler, timeout, report] },
  { id: 'fuzzSeed', label: 'Generate fuzz seeds', command: ['fuzz', 'seed'], fields: [source,
    { flag: '--layer', label: 'Fuzz layer', required: true }, { flag: '--output', label: 'Corpus output root', kind: 'path' }] },
  { id: 'fuzzRun', label: 'Fuzz campaign', command: ['fuzz', 'run'], fields: [
    { flag: '--build-dir', label: 'Configured fuzz build tree', kind: 'directory', required: true },
    { flag: '--layer', label: 'Fuzz layer', required: true },
    { flag: '--backend', label: 'Backend (must match build tree)', choices: ['libfuzzer', 'aflpp', 'honggfuzz'] },
    { flag: '--config', label: 'Build configuration' },
    { flag: '--duration', label: 'Campaign duration, seconds', kind: 'integer', maximum: 86400 },
    { ...timeout, maximum: 3600 }, { flag: '--max-len', label: 'Maximum input length', kind: 'integer', maximum: 1048576 },
    { flag: '--corpus', label: 'Input corpus directory', kind: 'directory' },
    { flag: '--results-dir', label: 'Results parent directory', kind: 'path' },
    { flag: '--replay-only', label: 'Replay existing inputs only', kind: 'boolean' }] },
  { id: 'fuzzTriage', label: 'Triage saved fuzz run', command: ['fuzz', 'triage'], fields: [runDir] },
  { id: 'fuzzMerge', label: 'Merge saved fuzz corpus', command: ['fuzz', 'merge'], fields: [runDir,
    { flag: '--output', label: 'Destination corpus directory', kind: 'path' },
    { flag: '--coverage', label: 'Use libFuzzer coverage merge (executes the fuzzer)', kind: 'boolean' }] },
];

export function registerCampaignCommands(services: CommandServices): void {
  for (const campaign of campaigns) {
    services.register(`cmakeWorkflow.${campaign.id}`, async () => {
      if (!services.trusted()) { return; }
      const folder = await services.folder(); if (!folder) { return; }
      const values = new Map<string, string>();
      if (campaign.fields.includes(source)) { values.set('--source-dir', folder.uri.fsPath); }
      while (true) {
        const items: { label: string; description?: string; field?: Field }[] = campaign.fields.map(field => ({
          label: field.label, description: values.get(field.flag) ?? (field.required ? 'Required — select a value' : 'CLI default'), field,
        }));
        items.push({ label: '$(play) Run campaign', description: `dagflow ${campaign.command.join(' ')}` });
        const picked = await vscode.window.showQuickPick(items, { title: campaign.label,
          placeHolder: 'Edit parameters, then select Run campaign. Escape cancels.' });
        if (!picked) { return; }
        const field = picked.field;
        if (!field) {
          const missing = campaign.fields.filter(f => f.required && !values.get(f.flag));
          if (missing.length) { void vscode.window.showWarningMessage(`Set: ${missing.map(f => f.label).join(', ')}`); continue; }
          const args = ['dagflow', ...campaign.command];
          for (const f of campaign.fields) {
            const value = values.get(f.flag); if (value === undefined || value === '') { continue; }
            args.push(f.flag); if (f.kind !== 'boolean') { args.push(value); }
          }
          await services.execute(folder, args);
          return;
        }
        if (field.kind === 'boolean') {
          if (values.has(field.flag)) { values.delete(field.flag); } else { values.set(field.flag, 'ON'); }
          continue;
        }
        if (field.choices) {
          const option = await vscode.window.showQuickPick([{ label: 'CLI default', value: '' }, ...field.choices.map(value => ({ label: value, value }))], { placeHolder: field.label });
          if (option) { if (option.value) { values.set(field.flag, option.value); } else { values.delete(field.flag); } }
          continue;
        }
        if (field.kind === 'directory') {
          if (!field.required) {
            const action = await vscode.window.showQuickPick(['Choose directory', 'Use CLI default'], { placeHolder: field.label });
            if (!action) { continue; }
            if (action === 'Use CLI default') { values.delete(field.flag); continue; }
          }
          const chosen = await pickDirectory(folder, field.label);
          if (chosen) { values.set(field.flag, chosen); } continue;
        }
        const value = await vscode.window.showInputBox({ prompt: `${field.label}${field.required ? '' : ' (blank uses CLI default)'}`,
          value: values.get(field.flag) ?? '', validateInput: text => {
            if (!text) { return field.required ? 'A value is required.' : undefined; }
            if (text.includes('\0') || text.startsWith('--')) { return 'Enter a value, not an option.'; }
            if (field.flag === '--layer' && !/^[a-z][a-z0-9_]*$/.test(text)) { return 'Use a lowercase DagFlow fuzz layer name, e.g. graph_scope or wake_protocol.'; }
            if (field.kind === 'integer' && (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > (field.maximum ?? 2147483647))) {
              return `Enter an integer between 1 and ${field.maximum ?? 2147483647}.`;
            }
            return undefined;
          } });
        if (value === undefined) { continue; }
        if (!value) { values.delete(field.flag); }
        else { values.set(field.flag, field.kind === 'path' ? path.resolve(folder.uri.fsPath, value) : value); }
      }
    });
  }
  services.register('cmakeWorkflow.openCampaignArtifact', async () => {
    const folder = await services.folder(); if (!folder) { return; }
    const selected = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectMany: false,
      canSelectFiles: true, canSelectFolders: false, openLabel: 'Open Saved Campaign Report or Log' });
    if (selected?.[0]) { await vscode.commands.executeCommand('vscode.open', selected[0]); }
  });
}
