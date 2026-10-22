import type { Period } from '../../shared/schemas';
import { dateKey } from '../../shared/time';

export type SemanticSlice = { period: Period; sessionId: string; generation: number; windowId: number };

// Only adjacent observations of the same visible context may share a summary.
export function summarizePeriods(slices: readonly SemanticSlice[]): { periods: Period[]; assignments: Map<string, string> } {
  const periods: Period[] = [], assignments = new Map<string, string>();
  let previous: SemanticSlice | undefined;
  const identity = ({ period: p, sessionId, generation, windowId }: SemanticSlice) => JSON.stringify([
    sessionId, generation, windowId, dateKey(p.startTs), p.appBundleId, p.windowTitle,
    p.action ?? 'unknown', p.activityType, p.objectLabel, p.topic, p.basis, p.summaryStatus,
  ]);
  let summaries = new Set<string>();
  for (const slice of slices) {
    const p = slice.period, last = periods.at(-1);
    if (last && previous && last.endTs === p.startTs && identity(previous) === identity(slice)) {
      last.endTs = p.endTs;
      last.revision += p.revision;
      if (p.summary?.trim()) summaries.add(p.summary.trim());
      last.summary = [...summaries].join('\n').slice(0, 8192) || null;
      assignments.set(p.id, last.id);
    } else {
      summaries = new Set(p.summary?.trim() ? [p.summary.trim()] : []);
      periods.push({ ...p });
      assignments.set(p.id, p.id);
    }
    previous = slice;
  }
  return { periods, assignments };
}
