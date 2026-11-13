import type { HostRpcResults } from './hostContract.generated';
import { escapeHtml } from './inspectionHtml';
import type { RecoveryInspection } from './durableProtocol';

export type OperationOverview = HostRpcResults['operations/overview'];
export type OperationNode = OperationOverview['nodes'][number];

export function nodeDetailsHtml(node: OperationNode): string {
  const fields = [
    ['State', node.status], ['Kind', node.kind], ['Dependencies', node.dependencies.join(', ')],
    ['Started', node.startedAt ? new Date(node.startedAt).toLocaleString() : null],
    ['Finished', node.finishedAt ? new Date(node.finishedAt).toLocaleString() : null],
    ['Exit code', node.exitCode], ['Standard output', node.stdout], ['Standard error', node.stderr],
  ];
  return `<dl>${fields.filter(([, value]) => value !== null && value !== '').map(([label, value]) =>
    `<dt>${escapeHtml(String(label))}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')}</dl>`
    + (node.error ? `<h2>Diagnostic</h2><pre>${escapeHtml(node.error)}</pre>` : '');
}

export function operationDetailsHtml(inspection: RecoveryInspection, nodeCount: number, history?: string): string {
  const lines = [inspection.terminalState ?? inspection.acceptanceState, history ? `History: ${history}` : null,
    inspection.cancellationRequested ? 'Cancellation requested' : null, inspection.decision ? `Recovery: ${inspection.decision}` : null];
  return `<p>${lines.filter(Boolean).map(value => escapeHtml(value!)).join(' · ')}</p>`
    + (inspection.runDirectory ? `<p><code>${escapeHtml(inspection.runDirectory)}</code></p>` : '')
    + (nodeCount ? `<p>Select a node under this operation in Host Operations to see its details.</p>` : '');
}
