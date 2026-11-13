import { hostRequestSchemas, type HostRequestSchema, type HostRpcMethod, type HostRpcRequests } from './hostContract.generated';

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function validate(value: unknown, schema: HostRequestSchema, field: string): void {
  if (schema.enum && !schema.enum.some(option => option === value)) {
    throw Error(`${field} must be one of ${schema.enum.join(', ')}`);
  }
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
  if (types && !types.some(type => matchesType(value, type))) {
    throw Error(`${field} must be ${types.join(' or ')}`);
  }
  if (Array.isArray(value) && schema.items) {
    const itemSchema = schema.items;
    value.forEach((item, index) => validate(item, itemSchema, `${field}[${index}]`));
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) { throw Error(`${field}.${key} is required`); }
    }
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (property) { validate(item, property, `${field}.${key}`); }
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(item, schema.additionalProperties, `${field}.${key}`);
      } else if (schema.additionalProperties !== true) { throw Error(`${field}.${key} is unknown`); }
    }
  }
}

export function parseHostRequest<Method extends HostRpcMethod>(method: Method, input: unknown): HostRpcRequests[Method] {
  validate(input, hostRequestSchemas[method], 'request');
  return input as HostRpcRequests[Method];
}

export function hostRequestExample(method: HostRpcMethod): string {
  function example(schema: HostRequestSchema): unknown {
    if (schema.default !== undefined) { return schema.default; }
    if (schema.enum) { return schema.enum[0]; }
    const type = typeof schema.type === 'string' ? schema.type : schema.type?.[0];
    switch (type) {
      case 'array': return [];
      case 'boolean': return false;
      case 'integer': case 'number': return 0;
      case 'object': return Object.fromEntries((schema.required ?? []).map(key => [key, example(schema.properties![key])]));
      case 'null': return null;
      default: return '';
    }
  }
  return JSON.stringify(example(hostRequestSchemas[method]));
}
