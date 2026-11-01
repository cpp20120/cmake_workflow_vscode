// Host protocol v1. These DTOs mirror CMakeWorkflow.Host/HostProtocol.cs.
export interface HostInfo {
  protocolVersion: 1; processId: number; workspaceDirectory: string;
  capabilities: string[]; profiles: { id: string; description: string; tools: string[] }[];
}
export interface ToolStatus { id: string; displayName: string; installed: boolean; command: string | null; version: string | null; minimumVersion: string | null; diagnostic: string | null }
export interface ToolingPlan {
  schemaVersion: 1; platform: string; profiles: string[]; installDirectory: string; packageManager: string; ready: boolean;
  tools: ToolStatus[];
  steps: { tool: string; method: string; executable: string | null; arguments: string[]; source: string | null; diagnostic: string | null }[];
}
export interface DoctorProgress { operationId: string; sequence: number; stage: 'started' | 'tool_checked' | 'finished'; tool: ToolStatus | null }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('Invalid Host object'); }
  return value as Record<string, unknown>;
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(x => typeof x === 'string'); }
function nullable(value: unknown): boolean { return value === null || typeof value === 'string'; }
export function parseHostInfo(value: unknown): HostInfo {
  const r = object(value);
  if (r.protocolVersion !== 1 || !Number.isSafeInteger(r.processId) || Number(r.processId) < 1
    || typeof r.workspaceDirectory !== 'string' || !strings(r.capabilities) || !Array.isArray(r.profiles)
    || !r.capabilities.includes('tooling/doctor') || !r.capabilities.includes('request-cancellation')) { throw Error('Incompatible Host protocol or capabilities'); }
  for (const value of r.profiles) {
    const p = object(value);
    if (typeof p.id !== 'string' || typeof p.description !== 'string' || !strings(p.tools)) { throw Error('Invalid Host profile'); }
  }
  return r as unknown as HostInfo;
}
export function parseTool(value: unknown): ToolStatus {
  const r = object(value);
  if (typeof r.id !== 'string' || typeof r.displayName !== 'string' || typeof r.installed !== 'boolean'
    || ![r.command, r.version, r.minimumVersion, r.diagnostic].every(nullable)) { throw Error('Invalid Host tool status'); }
  return r as unknown as ToolStatus;
}
export function parseToolingPlan(value: unknown): ToolingPlan {
  const r = object(value);
  if (r.schemaVersion !== 1 || typeof r.ready !== 'boolean' || !strings(r.profiles)
    || typeof r.installDirectory !== 'string' || !['Linux', 'MacOS', 'Windows'].includes(String(r.platform))
    || !['Auto', 'None', 'Apt', 'Pacman', 'Dnf', 'Brew', 'Winget'].includes(String(r.packageManager))
    || !Array.isArray(r.tools) || !Array.isArray(r.steps)) { throw Error('Unsupported Host tooling plan'); }
  r.tools.forEach(parseTool);
  for (const value of r.steps) {
    const s = object(value);
    if (typeof s.tool !== 'string' || typeof s.method !== 'string' || !strings(s.arguments)
      || ![s.executable, s.source, s.diagnostic].every(nullable)) { throw Error('Invalid Host tooling step'); }
  }
  if (r.ready !== r.tools.every(t => object(t).installed === true)) { throw Error('Inconsistent Host readiness'); }
  return r as unknown as ToolingPlan;
}
export function parseDoctorProgress(value: unknown): DoctorProgress {
  const r = object(value);
  if (typeof r.operationId !== 'string' || !Number.isSafeInteger(r.sequence) || Number(r.sequence) < 1
    || !['started', 'tool_checked', 'finished'].includes(String(r.stage))) { throw Error('Invalid Host progress'); }
  if (r.stage === 'tool_checked') { parseTool(r.tool); } else if (r.tool !== null) { throw Error('Invalid Host progress tool'); }
  return r as unknown as DoctorProgress;
}

export type PackageManager = 'Auto' | 'None' | 'Apt' | 'Pacman' | 'Dnf' | 'Brew' | 'Winget';
export interface FixPlan { schemaVersion: 1; planId: string; expiresAt: string; plan: ToolingPlan }
export interface FixProgress { operationId: string; sequence: number; stage: string; tool: string | null; message: string | null }
export interface FixResult {
  schemaVersion: 1; status: 'succeeded' | 'failed' | 'canceled' | 'plan_changed' | 'busy';
  installation: { schemaVersion: 1; success: boolean; ready: string[]; failed: string[]; diagnostics: string[] } | null;
  verification: ToolingPlan | null; diagnostics: string[];
}
export function parseFixPlan(value: unknown): FixPlan {
  const r = object(value);
  if (r.schemaVersion !== 1 || typeof r.planId !== 'string' || !r.planId || typeof r.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(r.expiresAt))) { throw Error('Invalid Host Fix plan'); }
  parseToolingPlan(r.plan); return r as unknown as FixPlan;
}
export function parseFixProgress(value: unknown): FixProgress {
  const r = object(value);
  if (typeof r.operationId !== 'string' || !Number.isSafeInteger(r.sequence) || Number(r.sequence) < 1
    || !['started', 'package_index', 'package_install', 'verified_release', 'tool_ready', 'tool_failed', 'verifying', 'finished'].includes(String(r.stage))
    || !nullable(r.tool) || !nullable(r.message)) { throw Error('Invalid Host Fix progress'); }
  return r as unknown as FixProgress;
}
export function parseFixResult(value: unknown): FixResult {
  const r = object(value);
  if (r.schemaVersion !== 1 || !['succeeded', 'failed', 'canceled', 'plan_changed', 'busy'].includes(String(r.status))
    || !strings(r.diagnostics)) { throw Error('Unsupported Host Fix result'); }
  if (r.verification !== null) { parseToolingPlan(r.verification); }
  if (r.installation !== null) {
    const i = object(r.installation);
    if (i.schemaVersion !== 1 || typeof i.success !== 'boolean' || !strings(i.ready) || !strings(i.failed) || !strings(i.diagnostics)
      || i.success !== (i.failed.length === 0)) { throw Error('Invalid Host installation result'); }
  }
  if (r.status === 'succeeded' && (!r.installation || !object(r.installation).success || !r.verification || !object(r.verification).ready)) {
    throw Error('Unverified Host Fix success');
  }
  return r as unknown as FixResult;
}
