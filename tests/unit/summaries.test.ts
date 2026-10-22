import { describe, expect, it } from 'vitest';
import { createFixtureSnapshot } from '../../src/shared/fixtures/worklog';
import { summarizePeriods, type SemanticSlice } from '../../src/services/worklog/summaries';

describe('semantic period summaries', () => {
  const base = createFixtureSnapshot().periods[0];
  const slice = (startTs: number, endTs: number, changes: Partial<SemanticSlice['period']> = {}): SemanticSlice => ({
    period: { ...base, id: crypto.randomUUID(), startTs, endTs, ...changes },
    sessionId: 'same-session', generation: 1, windowId: 42,
  });
  it('combines adjacent grounded summaries and retains every observation assignment', () => {
    const a = slice(base.startTs, base.startTs + 1000, { action: 'view', summary: 'Reviewed requirements' });
    const b = slice(a.period.endTs, a.period.endTs + 1000, { action: 'view', summary: 'Reviewed implementation' });
    const result = summarizePeriods([a, b]);
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0]).toMatchObject({ id: a.period.id, endTs: b.period.endTs, summary: 'Reviewed requirements\nReviewed implementation' });
    expect([...result.assignments.values()]).toEqual([a.period.id, a.period.id]);
    const changed = summarizePeriods([a, { ...b, period: { ...b.period, revision: b.period.revision + 1 } }]);
    expect(changed.periods[0].revision).toBe(result.periods[0].revision + 1);
  });
  it('keeps short switches, topic changes, gaps and manual boundaries', () => {
    const a = slice(base.startTs, base.startTs + 1000);
    const b = slice(a.period.endTs, a.period.endTs + 10, { objectLabel: 'Other conversation' });
    const back = slice(b.period.endTs, b.period.endTs + 1000);
    const gap = slice(back.period.endTs + 1, back.period.endTs + 1000);
    const reviewed = slice(gap.period.endTs, gap.period.endTs + 1000, { basis: 'confirmed' });
    expect(summarizePeriods([a, b, back, gap, reviewed]).periods).toHaveLength(5);
  });
});
