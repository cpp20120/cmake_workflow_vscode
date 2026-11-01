import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { CommandServices } from '../commandUi';

let configListener: (event: unknown) => void, foldersListener: (event: unknown) => void;
let endpoint = '', canceled = false, consent: string | undefined, missing = false, fixStatus = 'succeeded', fixSupported = true;
let applies = 0, planned = 0, updates: unknown[] = [];
let progressSubscriptions = 0, listenerDisposals = 0;
const folders = ['one', 'two'].map(name => ({ name, uri: { fsPath: `/workspace ${name}`, toString: () => `file:///workspace ${name}` } })) as vscode.WorkspaceFolder[];
const ui = {
  ProgressLocation: { Notification: 1 }, ConfigurationTarget: { WorkspaceFolder: 3 },
  workspace: {
    workspaceFolders: folders,
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'hostEndpoint' ? endpoint : fallback, update: async (...args: unknown[]) => { updates.push(args); } }),
    onDidChangeConfiguration: (fn: typeof configListener) => { configListener = fn; return { dispose: () => listenerDisposals++ }; },
    onDidChangeWorkspaceFolders: (fn: typeof foldersListener) => { foldersListener = fn; return { dispose: () => listenerDisposals++ }; },
  },
  window: {
    withProgress: async (_options: unknown, fn: (progress: unknown, token: unknown) => Promise<void>) => fn({ report: () => {} }, {
      isCancellationRequested: canceled, onCancellationRequested: () => { progressSubscriptions++; return { dispose: () => progressSubscriptions-- }; },
    }),
    showQuickPick: async (items: unknown[]) => items[0],
    showInformationMessage: async () => consent,
    showWarningMessage: async () => undefined,
  },
};
const loader = require('node:module') as { _load: (id: string, ...rest: unknown[]) => unknown };
const original = loader._load;
loader._load = (id, ...rest) => id === 'vscode' ? ui : original(id, ...rest);
const { registerHostDoctor } = require('../hostDoctor') as typeof import('../hostDoctor');
loader._load = original;
const { HostClient } = require('../hostClient') as typeof import('../hostClient');
const { HostProcess } = require('../hostProcess') as typeof import('../hostProcess');

function harness() {
  endpoint = ''; canceled = false; consent = undefined; missing = false; fixStatus = 'succeeded'; fixSupported = true; applies = 0; planned = 0; updates = []; progressSubscriptions = 0; listenerDisposals = 0;
  let folder = folders[0], trusted = true, launches = 0, stops = 0, closes = 0, calls = 0;
  const commands = new Map<string, () => Promise<void>>(); const panels: string[] = [];
  const subscriptions: vscode.Disposable[] = [];
  const start = HostProcess.prototype.start, dispose = HostProcess.prototype.dispose, stop = HostProcess.prototype.stop, connect = HostClient.connect;
  HostProcess.prototype.start = async () => { launches++; return '/private/rpc.sock'; };
  HostProcess.prototype.dispose = () => { stops++; };
  HostProcess.prototype.stop = async () => { stops++; };
  HostClient.connect = async () => {
    calls++;
    return { info: { protocolVersion: 1, processId: 12, workspaceDirectory: folder.uri.fsPath,
      capabilities: fixSupported ? ['tooling/planFix', 'tooling/applyFix', 'tooling/fixProgress'] : [], profiles: [{ id: 'cmake', description: 'CMake', tools: [] }] },
    client: { dispose: () => { closes++; }, doctor: async () => ({ schemaVersion: 1, ready: !missing, tools: [], steps: [] }),
      planFix: async () => { planned++; return { planId: 'reviewed', plan: { schemaVersion: 1, ready: false, installDirectory: '/tools with spaces', tools: [], steps: [] } }; },
      applyFix: async (id: string) => { assert.equal(id, 'reviewed'); applies++; return { status: fixStatus, diagnostics: [], verification: { schemaVersion: 1, ready: fixStatus === 'succeeded', installDirectory: '/tools with spaces', tools: [], steps: [] } }; } } as unknown as import('../hostClient').HostClient };
  };
  const services: CommandServices = {
    trusted: () => trusted, folder: async () => folder,
    register: (name, action) => { commands.set(name, action); }, call: async () => { throw Error('No direct CLI calls'); },
    execute: async () => { throw Error('No installations'); }, show: (_title, body) => { panels.push(body); },
  };
  registerHostDoctor({ subscriptions } as vscode.ExtensionContext, services, { append: () => {}, appendLine: () => {} } as unknown as vscode.OutputChannel);
  return { commands, panels, subscriptions, services, stats: () => ({ launches, stops, closes, calls }),
    folder: (index: number) => { folder = folders[index]; }, untrust: () => { trusted = false; },
    cleanup: () => {
      for (const disposable of subscriptions) { disposable.dispose(); }
      HostProcess.prototype.start = start; HostProcess.prototype.dispose = dispose; HostProcess.prototype.stop = stop; HostClient.connect = connect;
    } };
}

test('Host Doctor is opt-in, respects trust and cancellation, disposes listeners', async () => {
  const h = harness();
  try {
    assert.equal(h.stats().launches, 0);
    canceled = true; await h.commands.get('cmakeWorkflow.hostDoctor')!();
    canceled = false; h.untrust(); await h.commands.get('cmakeWorkflow.hostDoctor')!();
    assert.equal(h.stats().calls, 0); assert.equal(progressSubscriptions, 0);
  } finally { h.cleanup(); }
  assert.equal(listenerDisposals, 2);
});

test('Host ownership and invalidation are scoped to workspace folders', async () => {
  const h = harness();
  try {
    await h.commands.get('cmakeWorkflow.hostDoctor')!();
    h.folder(1); await h.commands.get('cmakeWorkflow.hostDoctor')!();
    assert.equal(h.stats().stops, 0); assert.equal(h.stats().closes, 2);
    foldersListener({ removed: [folders[0]] }); assert.equal(h.stats().stops, 1);
    configListener({ affectsConfiguration: (_key: string, uri: vscode.Uri) => uri === folders[1].uri });
    assert.equal(h.stats().stops, 2);
    await h.commands.get('cmakeWorkflow.hostDoctor')!();
    await h.commands.get('cmakeWorkflow.stopHost')!(); assert.equal(h.stats().stops, 3);
    assert.equal(h.panels.length, 3); assert.equal(progressSubscriptions, 0);
  } finally { h.cleanup(); }
});

test('external Host is connected but never launched or stopped by extension', async () => {
  const h = harness(); endpoint = '/external/rpc.sock';
  try {
    await h.commands.get('cmakeWorkflow.hostDoctor')!(); await h.commands.get('cmakeWorkflow.stopHost')!();
    assert.equal(h.stats().launches, 0); assert.equal(h.stats().stops, 0); assert.equal(h.stats().closes, 1);
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    for (const command of h.commands.keys()) {
      assert.ok(manifest.contributes.commands.some((c: { command: string }) => c.command === command));
      assert.ok(manifest.contributes.menus['cmakeWorkflow.toolsMenu'].some((c: { command: string }) => c.command === command));
    }
  } finally { h.cleanup(); }
  assert.equal(h.stats().stops, 0);
});

test('Fix previews a plan; only explicit consent applies and activates verified tools', async () => {
  for (const accepted of [false, true]) {
    const h = harness(); consent = accepted ? 'Fix Tools' : undefined;
    try {
      await h.commands.get('cmakeWorkflow.hostFix')!();
      assert.equal(planned, 1); assert.ok(h.panels[0].includes('Proposed setup steps'));
      assert.equal(applies, accepted ? 1 : 0);
      assert.equal(updates.length, accepted ? 1 : 0);
      if (accepted) { assert.deepEqual(updates[0], ['toolingInstallDirectory', '/tools with spaces', 3]); }
      assert.equal(progressSubscriptions, 0);
    } finally { h.cleanup(); }
  }
});

test('Fix never activates failed/canceled/changed/busy results, or falls back on an old Host', async () => {
  for (const status of ['failed', 'canceled', 'plan_changed', 'busy']) {
    const h = harness(); consent = 'Fix Tools'; fixStatus = status;
    try { await h.commands.get('cmakeWorkflow.hostFix')!(); assert.equal(applies, 1); assert.deepEqual(updates, []); }
    finally { h.cleanup(); }
  }
  const h = harness(); fixSupported = false;
  try { await assert.rejects(h.commands.get('cmakeWorkflow.hostFix')!(), /does not support Fix/); assert.equal(applies, 0); }
  finally { h.cleanup(); }
});

test('Fix cannot launch in an untrusted workspace or after cancellation before consent', async () => {
  const h = harness(); consent = 'Fix Tools';
  try {
    canceled = true; await h.commands.get('cmakeWorkflow.hostFix')!();
    canceled = false; h.untrust(); await h.commands.get('cmakeWorkflow.hostFix')!();
    assert.equal(planned, 0); assert.equal(applies, 0); assert.deepEqual(updates, []);
  } finally { h.cleanup(); }
});
