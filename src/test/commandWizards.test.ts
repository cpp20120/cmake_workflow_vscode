import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { CommandServices } from '../commandUi';
import type * as vscode from 'vscode';

// Load command modules against a deterministic VS Code UI, without an Electron
// host or any real process. Tests drive the same registered command callbacks.
type Item = string | { label: string; [key: string]: unknown };
let select: (items: Item[], options: Record<string, unknown>) => unknown;
let input: (options: Record<string, unknown>) => string | undefined;
let directories: string[];
let confirm: string | undefined;
let warnings: string[];
const ui = {
  window: {
    showQuickPick: async (items: Item[], options: Record<string, unknown>) => select(items, options),
    showInputBox: async (options: Record<string, unknown>) => input(options),
    showOpenDialog: async () => { const file = directories.shift(); return file ? [{ fsPath: file }] : undefined; },
    showInformationMessage: async () => confirm,
    showWarningMessage: async (text: string) => { warnings.push(text); },
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
};
const moduleLoader = require('node:module') as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = (id, ...args) => id === 'vscode' ? ui : originalLoad(id, ...args);
const { registerProfileCommands } = require('../profileCommands') as typeof import('../profileCommands');
const { registerNativeCommands } = require('../nativeCommands') as typeof import('../nativeCommands');
const { registerCampaignCommands } = require('../campaignCommands') as typeof import('../campaignCommands');
const { metricFilters } = require('../historyTools') as typeof import('../historyTools');
moduleLoader._load = originalLoad;

const folder = { uri: { fsPath: path.resolve('workspace with spaces') }, name: 'Workspace' } as vscode.WorkspaceFolder;
const observed = { buildDirectory: '/build', state: 'Observed', freshness: 'Unverified', presetState: 'Unknown',
  configurations: ['Release'], diagnostics: [], targets: [
    { name: 'worker', type: 'EXECUTABLE', configuration: 'Release', executable: null },
    { name: 'lib', type: 'STATIC_LIBRARY', configuration: 'Release', executable: null },
    { name: 'campaign', type: 'UTILITY', configuration: 'Release', executable: null },
  ] };
function harness() {
  const commands = new Map<string, () => Promise<void>>();
  const calls: string[][] = [], executions: string[][] = [], panels: string[] = [];
  let trusted = true;
  directories = []; warnings = []; confirm = undefined;
  select = items => items[0]; input = options => String(options.value ?? '');
  const services: CommandServices = {
    register: (name, callback) => { commands.set(name, callback); }, trusted: () => trusted,
    folder: async () => folder,
    call: async (_folder, args) => { calls.push(args); return JSON.stringify(observed); },
    execute: async (_folder, args) => { executions.push(args); return ''; },
    show: (_title, html) => { panels.push(html); },
  };
  return { services, commands, calls, executions, panels, untrust: () => { trusted = false; } };
}
const label = (item: Item) => typeof item === 'string' ? item : item.label;
const named = (items: Item[], text: string) => items.find(item => label(item) === text);

test('execution wizards never call the CLI in an untrusted workspace', async () => {
  const h = harness(); registerNativeCommands(h.services); registerCampaignCommands(h.services);
  registerProfileCommands({ ...h.services, pair: async () => undefined, database: () => undefined, historyArgs: (_f, a) => a,
    execute: async (_f, args) => { h.executions.push(args); } });
  h.untrust();
  for (const [name, action] of h.commands) {
    if (name !== 'cmakeWorkflow.openCampaignArtifact') { await action(); }
  }
  assert.deepEqual(h.calls, []); assert.deepEqual(h.executions, []);
});

test('multiple-profile wizard passes ordered variants and one common target to CLI', async () => {
  const h = harness();
  registerProfileCommands({ ...h.services, pair: async () => undefined, database: () => '/catalog with spaces',
    historyArgs: (_f, a) => a, execute: async (_f, a) => { h.executions.push(a); } });
  const first = path.resolve('build o3'), second = path.resolve('build lto'); directories = [first, second];
  let variant = 0, additions = 0;
  select = (items, options) => {
    if (String(options.placeHolder).includes('variant order')) { return ++additions === 1 ? items[0] : items[1]; }
    return items[0];
  };
  input = options => String(options.prompt).startsWith('Unique variant') ? (++variant === 1 ? 'o3' : 'lto') : String(options.value);
  await h.commands.get('cmakeWorkflow.profileVariants')!();
  const args = h.executions[0]; assert.ok(args);
  assert.deepEqual(args.slice(0, 6), ['profile', 'run', '--variant', `o3=${first}`, '--variant', `lto=${second}`]);
  assert.equal(args.includes('--build-dir'), false);
  assert.equal(args[args.indexOf('--target') + 1], 'worker');
  assert.equal(args[args.indexOf('--config') + 1], 'Release');
  assert.equal(args[args.indexOf('--history-db') + 1], '/catalog with spaces');
});

test('canceling a profile wizard before capture never launches it', async () => {
  const h = harness();
  registerProfileCommands({ ...h.services, pair: async () => undefined, database: () => undefined,
    historyArgs: (_f, a) => a, execute: async (_f, a) => { h.executions.push(a); } });
  directories = ['/build']; select = () => undefined;
  await h.commands.get('cmakeWorkflow.profileRun')!();
  assert.deepEqual(h.executions, []);
});

test('native target run excludes libraries/utilities and preserves argv boundaries', async () => {
  const h = harness(); registerNativeCommands(h.services); directories = ['/build with spaces'];
  select = items => { assert.deepEqual(items.map(label), ['worker']); return items[0]; };
  input = () => '["two words", "$(not-a-shell)", "--flag"]';
  await h.commands.get('cmakeWorkflow.targetRun')!();
  assert.deepEqual(h.executions[0], ['target', 'run', '--build-dir', '/build with spaces', '--target', 'worker',
    '--config', 'Release', '--', 'two words', '$(not-a-shell)', '--flag']);
});

test('native build permits libraries but not utility targets', async () => {
  const h = harness(); registerNativeCommands(h.services); directories = ['/build'];
  select = items => { assert.deepEqual(items.map(label), ['worker', 'lib']); return items[1]; };
  await h.commands.get('cmakeWorkflow.targetBuild')!();
  assert.equal(h.executions[0][h.executions[0].indexOf('--target') + 1], 'lib');
});

test('tool setup previews a plan and launches only after Apply Plan', async () => {
  for (const apply of [false, true]) {
    const h = harness(); registerNativeCommands(h.services);
    h.services.call = async (_folder, args) => {
      h.calls.push(args);
      return JSON.stringify(args[1] === 'list' ? { schemaVersion: 1, profiles: [{ id: 'native', description: 'Build tools' }] }
        : { schemaVersion: 1, ready: false, tools: [], steps: [], platform: 'Linux', packageManager: 'None' });
    };
    h.services.execute = async (_folder, args) => { h.executions.push(args); return JSON.stringify({ schemaVersion: 1, success: true, ready: [], failed: [], diagnostics: [] }); };
    select = (items, options) => options.canPickMany ? [items[0]] : options.placeHolder === 'Installation policy' ? items[1] : named(items, 'none');
    input = () => ''; confirm = apply ? 'Apply Plan' : undefined;
    await h.commands.get('cmakeWorkflow.toolingSetup')!();
    assert.ok(h.panels[0].includes('Proposed setup steps'));
    assert.equal(h.executions.length, apply ? 1 : 0);
    if (apply) { assert.deepEqual(h.executions[0], ['tooling', 'setup', '--profile', 'native', '--pm', 'none', '--no-fallback', '--yes', '--json']); }
  }
});

test('campaign wizard blocks missing fields and passes replay-only without a value', async () => {
  const h = harness(); registerCampaignCommands(h.services); directories = ['/fuzz build'];
  let step = 0;
  const picks = ['$(play) Run campaign', 'Configured fuzz build tree', 'Fuzz layer', 'Replay existing inputs only', '$(play) Run campaign'];
  select = items => named(items, picks[step++]); input = () => 'wake_protocol';
  await h.commands.get('cmakeWorkflow.fuzzRun')!();
  assert.equal(warnings.length, 1);
  assert.deepEqual(h.executions[0], ['dagflow', 'fuzz', 'run', '--build-dir', '/fuzz build', '--layer', 'wake_protocol', '--replay-only']);
});

test('History filters narrow scenario choices to the selected variant', async () => {
  harness(); let step = 0;
  select = items => {
    if (step++ === 0) { return named(items, 'lto'); }
    assert.deepEqual(items.map(label), ['All scenarios', 'chain-4']); return items[1];
  };
  assert.deepEqual(await metricFilters('latency', [
    { metric: 'latency', variant: 'o3', scenario: 'chain-8' },
    { metric: 'latency', variant: 'lto', scenario: 'chain-4' },
  ]), ['--variant', 'lto', '--scenario', 'chain-4']);
});

test('sequence forwards both argv lists and restricts the second target to the same configuration', async () => {
  const h = harness(); registerNativeCommands(h.services); directories = ['/build'];
  let inputCount = 0;
  input = () => inputCount++ === 0 ? '["generate", "42"]' : '["a b", "--flag"]';
  await h.commands.get('cmakeWorkflow.runSequence')!();
  assert.deepEqual(h.executions[0], ['workflow', 'sequence', '--build-dir', '/build', '--first', 'worker', '--second', 'worker',
    '--config', 'Release', '--first-arg', 'generate', '--first-arg', '42', '--second-arg', 'a b', '--second-arg', '--flag']);
});

test('coverage corpus merge is an explicit option and keeps destination as one path', async () => {
  const h = harness(); registerCampaignCommands(h.services); directories = ['/saved fuzz run'];
  const picks = ['Saved fuzz run directory', 'Destination corpus directory', 'Use libFuzzer coverage merge (executes the fuzzer)', '$(play) Run campaign'];
  let step = 0; select = items => named(items, picks[step++]); input = () => 'merged corpus';
  await h.commands.get('cmakeWorkflow.fuzzMerge')!();
  assert.deepEqual(h.executions[0], ['dagflow', 'fuzz', 'merge', '--run-dir', '/saved fuzz run',
    '--output', path.resolve(folder.uri.fsPath, 'merged corpus'), '--coverage']);
});

test('new wizard commands are contributed and reachable from view menus', () => {
  const h = harness(); registerNativeCommands(h.services); registerCampaignCommands(h.services);
  registerProfileCommands({ ...h.services, pair: async () => undefined, database: () => undefined, historyArgs: (_f, a) => a,
    execute: async () => {} });
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  const contributed = new Set(manifest.contributes.commands.map((c: { command: string }) => c.command));
  const menus = Object.values(manifest.contributes.menus).flat() as { command?: string }[];
  for (const command of h.commands.keys()) {
    assert.ok(contributed.has(command), `${command} missing from package.json`);
    assert.ok(menus.some(item => item.command === command), `${command} missing from menus`);
  }
});
