/// <reference lib="dom" />
import { escapeHtml } from './inspectionHtml';
import type { HostRequestSchema, HostRpcMethod } from './hostContract.generated';
import { hostRequestSchemas } from './hostContract.generated';

export function hostApiForm(methods: readonly HostRpcMethod[], nonce: string): string {
  const groups = new Map<string, HostRpcMethod[]>();
  for (const method of methods) {
    const group = method.split('/')[0];
    const items = groups.get(group) ?? [];
    items.push(method);
    groups.set(group, items);
  }
  return `<style nonce="${escapeHtml(nonce)}">
    .api-form {max-width:860px} label {display:block;margin:.55rem 0}
    input:not([type=checkbox]),select {box-sizing:border-box;display:block;width:100%;padding:.35rem;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-widget-border))}
    fieldset {margin:.5rem 0;padding:.6rem;border:1px solid var(--vscode-panel-border)}
    legend {padding:0 .25rem} button {margin:.2rem .3rem .2rem 0}
    pre {white-space:pre-wrap;overflow-wrap:anywhere} #status {min-height:1.4em}
  </style>
  <section class="api-form">
    <label>Host operation<select id="method">${[...groups].map(([name, items]) =>
      `<optgroup label="${escapeHtml(name)}">${items.map(method =>
        `<option value="${escapeHtml(method)}">${escapeHtml(method)}</option>`).join('')}</optgroup>`).join('')}</select></label>
    <form id="request"><div id="fields"></div><button id="run" type="submit">Run</button>
    <button id="cancel" type="button" hidden>Cancel request</button></form>
    <p id="status" role="status"></p><pre id="result" aria-label="Host response" tabindex="0"></pre>
  </section>`;
}

export function hostApiFormScript(methods: readonly HostRpcMethod[]): string {
  const schemas = Object.fromEntries(methods.map(method => [method, hostRequestSchemas[method]]));
  return `(${runForm.toString()})(${JSON.stringify(schemas).replace(/</g, '\\u003c')});`;
}

function runForm(schemas: Record<string, HostRequestSchema>): void {
  const vscode = (globalThis as unknown as { acquireVsCodeApi(): { postMessage(value: unknown): void } }).acquireVsCodeApi();
  const method = document.querySelector<HTMLSelectElement>('#method')!;
  const form = document.querySelector<HTMLFormElement>('#request')!;
  const fields = document.querySelector('#fields')!;
  const run = document.querySelector<HTMLButtonElement>('#run')!;
  const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
  const status = document.querySelector('#status')!;
  const result = document.querySelector('#result')!;
  const values = new Map<string, unknown>();
  let planId: string | undefined;
  let read: () => unknown;
  let current: string;
  let busy = false;

  function button(label: string, action: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button'; element.textContent = label; element.addEventListener('click', action);
    return element;
  }

  function field(parent: Element, schema: HostRequestSchema, name: string, required: boolean, initial: unknown): () => unknown {
    const types = [schema.type].flat();
    const type = types.find(item => item !== 'null');
    const container = document.createElement('fieldset');
    const caption = document.createElement('legend');
    caption.textContent = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    container.append(caption);
    parent.append(container);

    const nullable = types.includes('null');
    const toggle = !required || nullable ? document.createElement('input') : undefined;
    const group = document.createElement('div');
    if (toggle) {
      toggle.type = 'checkbox';
      toggle.checked = initial !== undefined && initial !== null;
      const label = document.createElement('label');
      label.append(toggle, required ? ' Set value' : ' Include');
      container.append(label);
      const sync = () => { group.hidden = !toggle.checked; };
      toggle.addEventListener('change', sync); sync();
    }
    container.append(group);
    let readValue: () => unknown;

    if (type === 'object') {
      const initialObject = initial && typeof initial === 'object' ? initial as Record<string, unknown> : {};
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !schema.properties) {
        const entries: Array<() => [string, unknown]> = [];
        const add = (name = '', value?: unknown) => {
          const row = document.createElement('fieldset'); group.append(row);
          const key = field(row, { type: 'string' }, 'Key', true, name);
          const entry = field(row, schema.additionalProperties as HostRequestSchema, 'Value', true, value);
          const read = (): [string, unknown] => [String(key()), entry()];
          entries.push(read);
          row.append(button('Remove entry', () => { entries.splice(entries.indexOf(read), 1); row.remove(); }));
        };
        for (const [name, value] of Object.entries(initialObject)) { add(name, value); }
        group.append(button('Add entry', () => add()));
        readValue = () => Object.fromEntries(entries.map(entry => entry()));
      } else {
        const entries = Object.entries(schema.properties ?? {}).map(([key, property]) =>
          [key, field(group, property, key, schema.required?.includes(key) ?? false, initialObject[key])] as const);
        readValue = () => Object.fromEntries(entries.map(([key, read]) => [key, read()]).filter(([, value]) => value !== undefined));
      }
    } else if (type === 'array') {
      const entries: Array<() => unknown> = [];
      const add = (value?: unknown) => {
        const row = document.createElement('fieldset');
        group.append(row);
        const read = field(row, schema.items ?? { type: 'string' }, 'Item', true, value);
        entries.push(read);
        row.append(button('Remove item', () => { entries.splice(entries.indexOf(read), 1); row.remove(); }));
      };
      if (Array.isArray(initial)) { initial.forEach(add); }
      group.append(button('Add item', () => add()));
      readValue = () => entries.map(read => read());
    } else if (schema.enum) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', name);
      for (const option of schema.enum) {
        select.add(new Option(String(option), JSON.stringify(option)));
      }
      if (initial !== undefined) { select.value = JSON.stringify(initial); }
      group.append(select);
      readValue = () => JSON.parse(select.value);
    } else {
      const input = document.createElement('input');
      input.setAttribute('aria-label', name);
      const numeric = type === 'integer' || type === 'number';
      input.type = type === 'boolean' ? 'checkbox' : numeric ? 'number' : 'text';
      if (numeric) { input.step = type === 'integer' ? '1' : 'any'; }
      const value = initial ?? schema.default;
      if (input.type === 'checkbox') { input.checked = value === true; }
      else if (value !== undefined && value !== null) { input.value = String(value); }
      group.append(input);
      readValue = () => input.type === 'checkbox' ? input.checked : numeric ? input.valueAsNumber : input.value;
    }
    return () => toggle && !toggle.checked ? (required ? null : undefined) : readValue();
  }

  function render(): void {
    current = method.value;
    fields.replaceChildren();
    const schema = schemas[current];
    if (!schema || current === 'initialize') { read = () => ({}); return; }
    const initial = values.get(current) as Record<string, unknown> | undefined;
    const entries = Object.entries(schema.properties ?? {}).map(([key, property]) => {
      let value = initial?.[key];
      if (key === 'planId' && current === 'tooling/applyFix') { value = planId ?? value; }
      if (value === undefined && (key === 'requestId' || key === 'clientRequestId' || (key === 'operationId' && current.startsWith('tooling/')))) {
        value = crypto.randomUUID().replaceAll('-', '');
      }
      return [key, field(fields, property, key, schema.required?.includes(key) ?? false, value)] as const;
    });
    read = () => Object.fromEntries(entries.map(([key, read]) => [key, read()]).filter(([, value]) => value !== undefined));
  }

  method.addEventListener('change', () => { values.set(current, read()); render(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) { return; }
    const request = read();
    values.set(current, request);
    busy = true; run.disabled = true; method.disabled = true;
    status.textContent = 'Running…';
    result.textContent = '';
    vscode.postMessage({ type: 'run', method: current, request });
  });
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'progress') { status.textContent = message.message; }
    if (message.type === 'cancellable') { cancel.hidden = !message.enabled; }
    if (message.type !== 'result') { return; }
    status.textContent = message.error ?? 'Completed';
    result.textContent = message.body ?? '';
    if (Object.hasOwn(message, 'planId')) { planId = message.planId ?? undefined; }
    busy = false; run.disabled = false; method.disabled = false; cancel.hidden = true;
  });
  render();
}
