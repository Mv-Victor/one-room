// Adapted from Screenpipe timeline.tsx L619-706, MIT, commit
// 1b3e4186ec5a624b95a581c7187c1d48284bea9a. Retain only contiguous run/flush.
import type { Gap, Period } from '../../shared/schemas';
import { dateKey } from '../../shared/time';

export type PeriodRun = { startTs: number; endTs: number; periods: Period[] };
export function groupPeriodRuns(periods: readonly Period[], gaps: readonly Gap[] = []): PeriodRun[] {
  const runs: PeriodRun[] = [];
  let current: PeriodRun | null = null;
  const flush = () => { if (current) runs.push(current); current = null; };
  for (const period of [...periods].sort((a, b) => a.startTs - b.startTs || a.id.localeCompare(b.id))) {
    const prior = current?.periods.at(-1);
    const same = prior && prior.endTs === period.startTs && dateKey(prior.startTs) === dateKey(period.startTs) &&
      prior.appBundleId === period.appBundleId && prior.windowTitle === period.windowTitle && prior.activityType === period.activityType &&
      prior.objectLabel === period.objectLabel && prior.topic === period.topic &&
      !gaps.some(gap => gap.startTs < period.endTs && gap.endTs > prior.startTs);
    if (!same) flush();
    if (!current) current = { startTs: period.startTs, endTs: period.endTs, periods: [period] };
    else { current.periods.push(period); current.endTs = period.endTs; }
  }
  flush();
  return runs;
}
