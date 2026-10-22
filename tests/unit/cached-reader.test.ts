import { describe, expect, it } from 'vitest';
import { createCachedWorklogReader } from '../../src/services/worklog/cached-reader';
import type { WorklogSnapshot } from '../../src/services/worklog/repository';

describe('revision-checked navigation snapshots', () => {
  it('reuses paginated snapshots and rereads after a source revision changes', async () => {
    let revision = 1, reads = 0;
    const reader = createCachedWorklogReader({ read: async () => {
      reads++;
      return { dataRevision: revision, periods: [], gaps: [], observations: [] };
    } }, async () => revision, () => 10_000);
    const range = { rangeStart: 1, rangeEnd: 100 };
    const [first, second] = await Promise.all([reader.read(range), reader.read(range)]);
    expect(first).toBe(second);
    expect(reads).toBe(1);
    revision++;
    expect((await reader.read(range)).dataRevision).toBe(2);
    expect(reads).toBe(2);
  });

  it('keeps live gaps and frozen report reads outside the reusable cache', async () => {
    let clock = 10_000, reads = 0;
    const reader = createCachedWorklogReader({ read: async range => {
      reads++;
      return { dataRevision: 1, periods: [], observations: [], gaps: [{
        id: '00000000-0000-4000-8000-000000000001', startTs: 1,
        endTs: range.asOf ?? clock, reason: 'paused', revision: 1,
      }] } satisfies WorklogSnapshot;
    } }, async () => 1, () => clock);
    const range = { rangeStart: 1, rangeEnd: 50_000 };
    expect((await reader.read(range)).gaps[0].endTs).toBe(10_000);
    clock++;
    expect((await reader.read(range)).gaps[0].endTs).toBe(10_001);
    expect((await reader.read({ ...range, asOf: 5_000 })).gaps[0].endTs).toBe(5_000);
    expect(reads).toBe(3);
  });
});
