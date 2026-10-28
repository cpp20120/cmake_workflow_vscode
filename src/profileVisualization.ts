import type { ComparisonEvidence, StackCapture, SchedulerEvent, RunEvidence } from './profileEvidence';
const escape = (value: string): string => value.replace(/[&<>"']/g, x => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[x]!));
interface FrameNode { name: string; before: number; after: number; children: Map<string, FrameNode>; weight: number }
const node = (name: string): FrameNode => ({ name, before: 0, after: 0, weight: 0, children: new Map() });

export function differentialFlamegraph(left: StackCapture, right: StackCapture): string {
  if (left.backend !== right.backend) { return '<p>Call-stack captures use different backends; no differential plot.</p>'; }
  if (left.samples === 0 || right.samples === 0) { return '<p>No CPU samples for a differential flamegraph.</p>'; }
  if (left.symbolizedSamples / left.samples < 0.5 || right.symbolizedSamples / right.samples < 0.5) {
    return `<p>Call stacks insufficiently symbolized (baseline ${(100 * left.symbolizedSamples / left.samples).toFixed(1)}%, candidate ${(100 * right.symbolizedSamples / right.samples).toFixed(1)}%). Raw traces remain available; a symbolic differential graph would be misleading.</p>`;
  }
  const base = node('all sampled stacks');
  for (const [capture, side] of [[left, 'before'], [right, 'after']] as const) {
    for (const row of capture.stacks) {
      const share = row.count / capture.samples;
      let item = base;
      item[side] += share;
      for (const frame of row.frames.slice(0, 18)) {
        let child = item.children.get(frame);
        if (!child) { child = node(frame); item.children.set(frame, child); }
        child[side] += share;
        item = child;
      }
    }
  }
  // Each sampled stack is a leaf; derive widths from the largest observed
  // sample proportion at each leaf. This preserves a non-overlapping tree.
  function calculate(item: FrameNode): number {
    const children = [...item.children.values()];
    const childWidth = children.reduce((sum, child) => sum + calculate(child), 0);
    const residualBefore = item.before - children.reduce((sum, child) => sum + child.before, 0);
    const residualAfter = item.after - children.reduce((sum, child) => sum + child.after, 0);
    item.weight = childWidth + Math.max(0, residualBefore, residualAfter);
    return item.weight;
  }
  calculate(base);
  if (base.weight <= 0) { return '<p>No symbolized stacks.</p>'; }
  const shapes: string[] = [];
  const depthMax = 18;
  function draw(item: FrameNode, x: number, level: number): void {
    if (level >= depthMax || item.weight <= 0) {return;}
    const width = item.weight / base.weight * 940;
    if (width >= 1 && level > 0 && shapes.length < 3000) {
      const delta = (item.after - item.before) * 100;
      const color = delta > 0.001 ? 'stack-growth' : delta < -0.001 ? 'stack-shrink' : 'stack-stable';
      const title = `${item.name} | baseline ${(item.before * 100).toFixed(3)}%, candidate ${(item.after * 100).toFixed(3)}%, change ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} percentage points`;
      shapes.push(`<rect x="${x.toFixed(2)}" y="${(depthMax - level - 1) * 23 + 8}" width="${Math.max(0.5, width - 0.6).toFixed(2)}" height="21" class="${color}"><title>${escape(title)}</title></rect>`);
      if (width > 52) {shapes.push(`<text x="${(x + 3).toFixed(2)}" y="${(depthMax - level - 1) * 23 + 23}" class="stack-label">${escape(item.name.length > Math.floor(width / 7) ? item.name.slice(0, Math.floor(width / 7)) + '…' : item.name)}</text>`);}
    }
    let offset = x;
    for (const child of [...item.children.values()].sort((a, b) => b.weight - a.weight)) {
      draw(child, offset, level + 1);
      offset += child.weight / base.weight * 940;
    }
  }
  draw(base, 0, 0);
  return `<h3>Differential CPU flamegraph — sampled stack share</h3><p class="small">Red: larger fraction of CPU samples in candidate; blue: smaller. Width is based on the larger share across captures, not elapsed time. Mouse over frames for percentages. Neither direction proves causality.</p>
    <svg viewBox="0 0 940 ${depthMax * 23 + 16}" role="img" aria-label="Differential flamegraph of normalized CPU sample shares" class="flamegraph">${shapes.join('')}</svg>
    <p class="small">Baseline: ${left.samples} samples (${(100 * left.symbolizedSamples / left.samples).toFixed(1)}% symbolized); candidate: ${right.samples} (${(100 * right.symbolizedSamples / right.samples).toFixed(1)}% symbolized). ${left.droppedDistinctStacks || right.droppedDistinctStacks ? 'Some distinct stacks were dropped due to the collection cap.' : ''} Up to 250 most frequent stacks from each capture are represented.</p>`;
}

export function schedulerTimeline(capture: { captureId: string; events: SchedulerEvent[]; truncated: boolean }, label: string): string {
  const grouped = new Map<number, SchedulerEvent[]>();
  for (const event of capture.events) {
    const list = grouped.get(event.threadId) ?? [];
    list.push(event);
    grouped.set(event.threadId, list);
  }
  const selected = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  if (!selected.length) { return `<p>No attributed scheduler transitions for ${escape(label)}.</p>`; }
  const all = selected.flatMap(([, events]) => events);
  const minimum = Math.min(...all.map(e => Date.parse(e.timestamp)));
  const maximum = Math.max(...all.map(e => Date.parse(e.timestamp)));
  const span = Math.max(1, maximum - minimum);
  const rects: string[] = [];
  for (const [index, [tid, events]] of selected.entries()) {
    const sorted = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    rects.push(`<text x="4" y="${index * 27 + 28}">TID ${tid}</text>`);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const start = Date.parse(sorted[i].timestamp), end = Date.parse(sorted[i+1].timestamp);
      if (end <= start) {continue;}
      const x = 116 + (start - minimum) / span * 800;
      const width = (end - start) / span * 800;
      rects.push(`<rect x="${x.toFixed(2)}" y="${index * 27 + 11}" width="${Math.max(0.5, width).toFixed(2)}" height="20" class="sched-${sorted[i].state}"><title>${escape(`TID ${tid}, ${sorted[i].state}, ${(end-start).toFixed(2)} ms`)}</title></rect>`);
    }
  }
  return `<h4>${escape(label)} — ${escape(capture.captureId)}</h4><svg class="scheduler-chart" viewBox="0 0 930 ${selected.length * 27 + 45}" role="img" aria-label="Thread scheduling transitions">${rects.join('')}</svg><p class="small">Window ${(span/1000).toFixed(3)} s; up to 8 most active threads. Running (blue), ready (orange), off-CPU (gray). Off-CPU does not imply sleeping. Linux per-task perf traces can miss wakeups from other tasks. ${capture.truncated ? 'Timeline may be truncated at the capture cap.' : ''}</p>`;
}

export function profileEvidenceHtml(evidence: ComparisonEvidence): string {
  const a = evidence.baseline, b = evidence.candidate;
  if (!a.stacks.length && !b.stacks.length && !a.scheduler.length && !b.scheduler.length && !a.warnings.length && !b.warnings.length) {return '';}
  const pairs = a.stacks.flatMap(first => {
    const matching = b.stacks.filter(second => second.backend === first.backend && second.captureId === first.captureId);
    return matching.length === 1 ? [[first, matching[0]] as const] : [];
  });
  if (!pairs.length && a.stacks.length === 1 && b.stacks.length === 1 && a.stacks[0].backend === b.stacks[0].backend) {
    pairs.push([a.stacks[0], b.stacks[0]]);
  }
  const flames = pairs.map(([left, right]) => differentialFlamegraph(left, right)).join('');
  const timelines = [...a.scheduler.slice(0, 2).map(x => schedulerTimeline(x, 'Baseline')),
    ...b.scheduler.slice(0, 2).map(x => schedulerTimeline(x, 'Candidate'))].join('');
  const warnings = [...a.warnings.map(x => 'Baseline: ' + x), ...b.warnings.map(x => 'Candidate: ' + x)];
  return `<h2>CPU stacks and scheduling</h2>${flames || '<p>No unambiguous matching CPU stack captures; raw traces can still be opened.</p>'}${timelines}${warnings.length ? `<p class="small">${warnings.map(escape).join('; ')}</p>` : ''}`;
}
