import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, mode] = process.argv;
if (!input || (mode !== undefined && mode !== '--check')) {
  throw Error('Usage: node scripts/host-contract/generate.mjs SCHEMA_JSON [--check]');
}
const catalog = JSON.parse(readFileSync(input, 'utf8'));
const entries = Object.entries(catalog).sort(([first], [second]) => first < second ? -1 : Number(first !== second));
const output = new URL('../../src/hostContract.generated.ts', import.meta.url);

function typescript(schema) {
  if (schema === true) { return 'unknown'; }
  if (schema === false) { return 'never'; }
  if (schema.$ref) {
    // Recursive and shared JSON schema references are validated by the Host.
    return 'unknown';
  }
  if (schema.enum) { return schema.enum.map(value => JSON.stringify(value)).join(' | '); }
  return [schema.type].flat().map(type => {
    switch (type) {
      case 'integer': case 'number': return 'number';
      case 'boolean': case 'string': case 'null': return type;
      case 'array': return `ReadonlyArray<${typescript(schema.items ?? true)}>`;
      case 'object': {
        if (!schema.properties) {
          return schema.additionalProperties
            ? `Readonly<Record<string, ${typescript(schema.additionalProperties)}>>` : 'Record<string, never>';
        }
        const fields = Object.entries(schema.properties).map(([name, value]) =>
          `readonly ${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${typescript(value)}`);
        return `{ ${fields.join('; ')} }`;
      }
      default: throw Error(`Unsupported schema type: ${type}`);
    }
  }).join(' | ');
}

const source = [
  '// Generated from HostJson and IHostRpc. Run scripts/host-contract/generate.mjs to update.',
  'export interface HostRpcRequests {',
  ...entries.map(([method, { request }]) => `  ${JSON.stringify(method)}: ${typescript(request)};`),
  '}',
  '',
  'export interface HostRpcResults {',
  ...entries.map(([method, { result }]) => `  ${JSON.stringify(method)}: ${typescript(result)};`),
  '}',
  '',
  'export type HostRpcMethod = keyof HostRpcRequests;',
  'export interface HostRequestSchema {',
  '  type?: string | readonly string[];',
  '  enum?: readonly (string | number | boolean | null)[];',
  '  default?: unknown;',
  '  properties?: Readonly<Record<string, HostRequestSchema>>;',
  '  required?: readonly string[];',
  '  items?: HostRequestSchema;',
  '  additionalProperties?: boolean | HostRequestSchema;',
  '}',
  'export const hostRequestSchemas: Readonly<Record<HostRpcMethod, HostRequestSchema>> = {',
  ...entries.map(([method, { request }]) => `  ${JSON.stringify(method)}: ${JSON.stringify(request)},`),
  '};',
  '',
].join('\n');
if (mode === '--check') {
  if (readFileSync(output, 'utf8') !== source) { throw Error('Generated Host RPC contract is stale.'); }
} else { writeFileSync(output, source); }
