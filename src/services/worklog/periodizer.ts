import type { Gap, Period } from '../../shared/schemas';
import { dateKey, dayBounds } from '../../shared/time';

export type ObservationFact = {
  id: string; sessionId: string; captureGeneration: number; observedAt: number;
  endTs: number | null; confirmedThrough?: number;
  bundleId: string; appName: string; windowId: number; windowTitle: string | null; revision: number;
};
export type Interval = { startTs: number; endTs: number };
export function unionDuration(intervals: readonly Interval[]): number {
  let end = -Infinity, total = 0;
  for (const value of [...intervals].sort((a, b) => a.startTs - b.startTs)) {
    total += Math.max(0, value.endTs - Math.max(value.startTs, end));
    end = Math.max(end, value.endTs);
  }
  return total;
}
export function clip<T extends Interval>(value: T, rangeStart: number, rangeEnd: number): T {
  return { ...value, startTs: Math.max(value.startTs, rangeStart), endTs: Math.min(value.endTs, rangeEnd) };
}
export function overlaps(value: Interval, rangeStart: number, rangeEnd: number): boolean {
  return value.startTs < rangeEnd && value.endTs > rangeStart;
}

// Coverage ends at committed ends/checkpoints, never wall-clock now or a new session.
export function periodize(observations: readonly ObservationFact[], gaps: readonly Gap[]): Period[] {
  const sorted = [...observations].sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
  const periods: Period[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const observation = sorted[index], next = sorted[index + 1];
    const sameSession = next?.sessionId === observation.sessionId && next.captureGeneration === observation.captureGeneration;
    let endTs = observation.endTs ?? observation.confirmedThrough ?? (sameSession ? next.observedAt : observation.observedAt);
    if (next) endTs = Math.min(endTs, next.observedAt);
    if (gaps.some(gap => gap.startTs <= observation.observedAt && observation.observedAt < gap.endTs)) continue;
    for (const gap of gaps) if (overlaps(gap, observation.observedAt, endTs)) endTs = Math.min(endTs, gap.startTs);
    if (endTs <= observation.observedAt) continue;
    periods.push({
      id: observation.id, startTs: observation.observedAt, endTs,
      appBundleId: observation.bundleId, appName: observation.appName, windowTitle: observation.windowTitle,
      activityType: 'unknown', objectLabel: null, topic: null, summary: null,
      summaryStatus: 'not_authorized', basis: 'observed', revision: observation.revision
    });
  }
  return periods;
}

export function projectDays<T extends Interval>(values: readonly T[]): Map<string, T[]> {
  const days = new Map<string, T[]>();
  for (const value of values) {
    let start = value.startTs;
    while (start < value.endTs) {
      const key = dateKey(start), end = Math.min(value.endTs, dayBounds(key).rangeEnd);
      const entries = days.get(key) ?? [];
      entries.push({ ...value, startTs: start, endTs: end });
      days.set(key, entries);
      start = end;
    }
  }
  return days;
}
