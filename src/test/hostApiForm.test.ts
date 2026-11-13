import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { hostApiForm, hostApiFormScript } from '../hostApiForm';
import { parseHostRequest } from '../hostRequestForm';

class Element {
  children: Element[] = [];
  listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  checked = false;
  hidden = false;
  value = '';
  textContent = '';
  type = '';
  ariaLabel = '';
  get valueAsNumber(): number { return this.value === '' ? NaN : Number(this.value); }
  append(...items: Element[]): void { this.children.push(...items.filter(item => item instanceof Element)); }
  replaceChildren(): void { this.children = []; }
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => void): void { this.listeners.set(name, listener); }
  setAttribute(name: string, value: string): void { if (name === 'aria-label') { this.ariaLabel = value; } }
  add(option: Element): void { if (!this.children.length) { this.value = option.value; } this.children.push(option); }
  find(predicate: (element: Element) => boolean): Element | undefined {
    return predicate(this) ? this : this.children.map(child => child.find(predicate)).find(Boolean);
  }
  dispatch(event: string): void { this.listeners.get(event)?.({ preventDefault() {} }); }
}

test('Host API form submits nested typed options without JSON input', () => {
  const elements = new Map(['method', 'request', 'fields', 'run', 'cancel', 'status', 'result'].map(id => [id, new Element()]));
  elements.get('method')!.value = 'workflow/start';
  const messages: unknown[] = [];
  runInNewContext(hostApiFormScript(['workflow/start']), {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }),
    document: { querySelector: (selector: string) => elements.get(selector.slice(1)), createElement: () => new Element() },
    window: { addEventListener() {} },
    crypto: { randomUUID: () => 'generated-id' },
    Option: class extends Element { constructor(label: string, value: string) { super(); this.textContent = label; this.value = value; } },
  });
  const fields = elements.get('fields')!;
  const control = (name: string) => fields.find(element => element.ariaLabel === name)!;
  control('manifest').value = '/workspace/workflow.json';
  control('manifestSha256').value = 'a'.repeat(64);
  control('jobs').value = '2';
  control('resultsDirectory').value = '/workspace/results';
  const policy = fields.find(element => element.children[0]?.textContent === 'history Policy')!;
  const include = policy.find(element => element.type === 'checkbox')!;
  include.checked = true; include.dispatch('change');
  control('mode').value = '"Default"';
  elements.get('request')!.dispatch('submit');

  const sent = JSON.parse(JSON.stringify(messages[0]));
  assert.equal(sent.method, 'workflow/start');
  assert.deepEqual(parseHostRequest('workflow/start', sent.request), {
    manifest: '/workspace/workflow.json', manifestSha256: 'a'.repeat(64), jobs: 2,
    resultsDirectory: '/workspace/results', clientRequestId: 'generatedid', historyPolicy: { mode: 'Default' },
  });
  assert.doesNotMatch(hostApiForm(['workflow/start'], 'test-nonce'), /textarea/);
});

test('Operations toolbar exposes Host API and workflow launch, with inline History actions', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  const menus = manifest.contributes.menus;
  for (const command of ['cmakeWorkflow.openHostApi', 'cmakeWorkflow.runWorkflow']) {
    assert.ok(menus['view/title'].some((item: { command: string; when: string; group: string }) =>
      item.command === command && item.when === 'view == cmakeWorkflow.operations' && item.group.startsWith('navigation')));
  }
  assert.ok(menus['view/item/context'].some((item: { command: string; group: string }) =>
    item.command === 'cmakeWorkflow.retryHistoryIndex' && item.group.startsWith('inline')));
});
