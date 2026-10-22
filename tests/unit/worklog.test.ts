import { describe, expect, it } from 'vitest';
import { createFixtureApi, createFixtureSnapshot, FIXTURE_START, FIXTURE_END } from '../../src/shared/fixtures/worklog';
import { createSnapshotQueries } from '../../src/services/worklog/queries';
import { periodize, projectDays, unionDuration } from '../../src/services/worklog/periodizer';
import { groupPeriodRuns } from '../../src/renderer/timeline/group-period-runs';
import { initialNavigation, navigate, visibleRange } from '../../src/renderer/timeline/navigation';
import { dayBounds, reportBounds, DAY_MS } from '../../src/shared/time';
import { outputSchemas, type Reply } from '../../src/shared/contracts';

function data<T>(reply: Reply<T>): T { if (!reply.ok) throw new Error(reply.error.message); return reply.data; }
describe('worklog core', () => {
  it('preserves the short middle switch, stops at gaps and never extends an open tail', () => {
    const snapshot = createFixtureSnapshot();
    const observations = snapshot.periods.map((p, index) => ({ id: p.id, sessionId: 'session', captureGeneration: 1,
      observedAt: p.startTs, endTs: index === 2 ? p.endTs : null, bundleId: p.appBundleId, appName: p.appName,
      windowId: index + 1, windowTitle: p.windowTitle, revision: 1 }));
    const periods = periodize(observations, snapshot.gaps);
    expect(periods.map(p => p.endTs - p.startTs)).toEqual([600_000, 10_000, 900_000]);
    expect(groupPeriodRuns(periods, snapshot.gaps)).toHaveLength(3);
    expect(periodize([{ ...observations[0], endTs: null }], [])).toEqual([]);
    expect(periodize([{ ...observations[0], endTs: null }, { ...observations[1], sessionId: 'restart', endTs: null }], [])).toEqual([]);
  });
  it('projects midnight without adding duration and counts overlapping coverage once', () => {
    const midnight = dayBounds('2026-10-16').rangeStart;
    const days = projectDays([{ startTs: midnight - 10_000, endTs: midnight + 20_000 }]);
    expect([...days.keys()]).toEqual(['2026-10-15', '2026-10-16']);
    expect([...days.values()].map(rows => unionDuration(rows))).toEqual([10_000, 20_000]);
    expect(unionDuration([{ startTs: 0, endTs: 20 }, { startTs: 10, endTs: 30 }])).toBe(30);
  });
  it('pages facts at a fixed revision and binds continuations to filters', async () => {
    const snapshot = createFixtureSnapshot(), queries = createSnapshotQueries({ read: async () => snapshot });
    const range = { rangeStart: FIXTURE_START, rangeEnd: FIXTURE_END, limit: 1 };
    const first = await queries.timeline(range);
    expect(first.periods).toHaveLength(1);
    expect(first.filteredDurationMs).toBe(1_510_000);
    const second = await queries.timeline({ ...range, cursor: first.nextCursor! });
    expect(second.periods[0].appName).toBe('Kim');
    await expect(queries.timeline({ ...range, bundleIds: ['com.kuaishou.kim'], cursor: first.nextCursor! })).rejects.toMatchObject({ error: { code: 'STALE_REVISION' } });
    snapshot.dataRevision++;
    await expect(queries.timeline({ ...range, cursor: first.nextCursor! })).rejects.toMatchObject({ error: { code: 'STALE_REVISION' } });
  });
  it('keeps full coverage under filters and never borrows evidence across a gap or filtered app', async () => {
    const api = createFixtureApi();
    const page = data(await api.timeline.query({ rangeStart: FIXTURE_START, rangeEnd: FIXTURE_END, bundleIds: ['com.microsoft.VSCode'] }));
    expect(page.filteredDurationMs).toBe(1_500_000); expect(page.coverage.recordedMs).toBe(1_510_000);
    const filtered = data(await api.timeline.resolveCursor({ cursorTs: FIXTURE_START + 605_000, queryRevision: 1, bundleIds: ['com.microsoft.VSCode'] }));
    expect(filtered.period).toBeNull(); expect(filtered.evidence).toBeNull();
    const gap = data(await api.timeline.resolveCursor({ cursorTs: FIXTURE_END - 1, queryRevision: 1 }));
    expect(gap.gap?.reason).toBe('paused'); expect(gap.evidence).toBeNull();
  });
  it('pages a dense calendar day rather than truncating it', async () => {
    const snapshot = createFixtureSnapshot(), queries = createSnapshotQueries({ read: async () => snapshot });
    const first = await queries.calendar({ month: '2026-10', limit: 1 });
    const second = await queries.calendar({ month: '2026-10', limit: 1, cursor: first.nextCursor! });
    expect(first.days[0].recordedMs).toBe(1_510_000);
    expect(second.days[0].periods[0].appName).toBe('Kim');
    outputSchemas['calendar.query'].parse(second);
  });
  it('generates a full-day/week snapshot and invalidates copies after reviewed deletion', async () => {
    const api = createFixtureApi();
    await api.timeline.query({ rangeStart: FIXTURE_START, rangeEnd: FIXTURE_END, bundleIds: ['com.kuaishou.kim'] });
    const generated = data(await api.report!.generate({ kind: 'daily', dateKey: '2026-10-15', expectedDataRevision: 1, idempotencyKey: crypto.randomUUID() }));
    expect(generated.report?.periods).toHaveLength(3); expect(generated.report?.recordedMs).toBe(1_510_000);
    expect(generated.report!.rangeEnd - generated.report!.rangeStart).toBe(DAY_MS);
    expect(reportBounds('weekly', '2026-10-15')).toEqual({ rangeStart: dayBounds('2026-10-12').rangeStart, rangeEnd: dayBounds('2026-10-19').rangeStart });
    const preview = data(await api.history!.previewDelete({ rangeStart: FIXTURE_START, rangeEnd: FIXTURE_END, bundleIds: ['com.kuaishou.kim'] }));
    expect(preview.observationCount).toBe(1); expect(preview.reportCount).toBe(1);
    const request = { deletionRef: preview.deletionRef, expectedRevision: preview.dataRevision, confirmed: true as const, idempotencyKey: crypto.randomUUID() };
    expect(data(await api.history!.delete(request)).cleanup).toBe('complete');
    expect(data(await api.history!.delete(request)).dataRevision).toBe(2);
    expect(data(await api.report!.get({ kind: 'daily', dateKey: '2026-10-15' }))).toEqual({ status: 'invalidated', report: null });
    expect(data(await api.timeline.query({ rangeStart: FIXTURE_START, rangeEnd: FIXTURE_END })).periods).toHaveLength(2);
  });
  it('requires an extra out-step and prevents cross-layer bounce within one gesture', () => {
    const fullDay = navigate(initialNavigation, { type: 'span', spanMs: 86_400_000 });
    const tail = navigate(fullDay, { type: 'zoom', units: 0.2, gestureId: 1 });
    expect(tail.mode).toBe('day');
    const month = navigate(tail, { type: 'zoom', units: 0.8, gestureId: 1 });
    expect(month.mode).toBe('month');
    expect(navigate(month, { type: 'zoom', units: -1, gestureId: 1 }).mode).toBe('month');
    expect(navigate(month, { type: 'zoom', units: -1, gestureId: 2 }).mode).toBe('day');
    const day = dayBounds('2026-10-15'), view = visibleRange('2026-10-15', day.rangeStart + 1, 300_000);
    expect(view.rangeStart).toBe(day.rangeStart); expect(view.rangeEnd).toBe(day.rangeStart + 300_000);
  });
});
