import { describe, expect, it } from 'vitest';
import type { Period, ReportSnapshot } from '../../src/shared/schemas';
import { DAY_MS, dayBounds, reportBounds } from '../../src/shared/time';
import { deriveReportStory, renderReportHtml } from '../../src/renderer/reports/report-story';
import { createReports } from '../../src/services/worklog/reports';

const start = dayBounds('2026-10-16').rangeStart, HOUR = 3_600_000;
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
function period(number: number, from: number, until: number, extra: Partial<Period> = {}): Period {
  return { id: id(number), startTs: start + from * HOUR, endTs: start + until * HOUR, appBundleId: 'local.editor', appName: 'Editor',
    windowTitle: 'SECRET_WINDOW_TITLE', activityType: 'document', action: 'view', objectLabel: null, topic: null, summary: null,
    summaryStatus: 'not_authorized', basis: 'observed', revision: 1, ...extra };
}
function report(periods: Period[], extra: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return { id: id(99), kind: 'daily', dateKey: '2026-10-16', rangeStart: start, rangeEnd: start + DAY_MS, generatedAt: start + DAY_MS,
    sourceRevision: 7, periods, gaps: [], recordedMs: 0, gapMs: 0, linkedTargetId: null, ...extra };
}

describe('shareable report story', () => {
  it('unions clipped intervals and allocates overlapping classifications without double counting', () => {
    const source = report([period(1, -1, 1.5), period(2, 1, 2, { basis: 'confirmed' }),
      period(3, 1.5, 3, { appBundleId: 'local.kim', appName: 'Kim', activityType: 'meeting', basis: 'inferred' })],
    { rangeEnd: start + 10 * HOUR, recordedMs: 999, gapMs: 999,
      gaps: [{ id: id(4), startTs: start + 2.5 * HOUR, endTs: start + 4 * HOUR, reason: 'paused', revision: 1 }] });
    const story = deriveReportStory(source);
    expect(story.totals).toEqual({ observedMs: 3 * HOUR, gapMs: HOUR, unknownMs: 6 * HOUR, totalMs: 10 * HOUR, coverage: 0.3 });
    expect(story.apps.reduce((sum, row) => sum + row.durationMs, 0)).toBe(3 * HOUR);
    expect(story.activities.reduce((sum, row) => sum + row.durationMs, 0)).toBe(3 * HOUR);
    expect(story.apps.find(row => row.key === 'local.editor')?.durationMs).toBe(1.5 * HOUR);
    expect(story.apps.find(row => row.key === 'overlap:unknown')).toMatchObject({ durationMs: 0.5 * HOUR, bases: ['inferred', 'confirmed'] });
    expect(story.allocations).toEqual(story.apps);
    expect(story.switchCount).toBe(0);
    expect(source.periods[0].startTs).toBe(start - HOUR);
    expect(deriveReportStory({ ...source, periods: [...source.periods].reverse() })).toEqual(story);
  });

  it('counts the short A-B-A app transitions, excludes gaps and describes visible boundaries', () => {
    const story = deriveReportStory(report([period(1, 9, 10), period(2, 10, 10 + 10 / 3600, { appBundleId: 'local.kim', appName: 'Kim' }),
      period(3, 10 + 10 / 3600, 11), period(4, 14, 16, { appBundleId: 'local.browser', appName: 'Browser' })]));
    expect(story.switchCount).toBe(2); expect(story.totalPeriods).toBe(4);
    expect(story.longestPeriod).toMatchObject({ id: id(4), durationMs: 2 * HOUR });
    expect(story.first?.timestamp).toBe(start + 9 * HOUR); expect(story.last?.timestamp).toBe(start + 16 * HOUR);
    expect(story.last?.detail).toContain('区间右边界'); expect(story.lateMoment).toBeNull();
  });

  it('keeps canonical midnight durations while projecting all seven days, including unknown days', () => {
    const midnight = dayBounds('2026-10-17').rangeStart;
    const crossing = period(1, 23 + 50 / 60, 24 + 20 / 60, { topic: 'Source-backed topic', basis: 'inferred' });
    const story = deriveReportStory(report([crossing, { ...crossing, startTs: midnight }],
      { kind: 'weekly', rangeStart: dayBounds('2026-10-12').rangeStart, rangeEnd: dayBounds('2026-10-19').rangeStart }));
    expect(story.rhythm).toHaveLength(7); expect(story.totalPeriods).toBe(1);
    expect(story.totals.observedMs).toBe(30 * 60_000); expect(story.longestPeriod?.durationMs).toBe(30 * 60_000);
    expect(story.rhythm.find(day => day.dateKey === '2026-10-16')?.observedMs).toBe(10 * 60_000);
    expect(story.rhythm.find(day => day.dateKey === '2026-10-17')?.observedMs).toBe(20 * 60_000);
    expect(story.rhythm[0]).toMatchObject({ observedMs: 0, gapMs: 0, unknownMs: DAY_MS, periods: [] });
    expect(story.rhythm.reduce((sum, day) => sum + day.observedMs, 0)).toBe(story.totals.observedMs);
    expect(story.lateMoment?.timestamp).toBe(crossing.startTs);
    expect(story.highlights[0]).toMatchObject({ title: 'Source-backed topic', detail: 'Source-backed topic', basis: 'inferred' });
  });

  it('only creates a night moment from a supplied record start inside the precise night hours', () => {
    for (const [from, hasNight] of [[5 + 59 / 60, true], [6, false], [21 + 59 / 60, false], [22, true]] as const) {
      const story = deriveReportStory(report([period(1, from, Math.min(24, from + 1))]));
      expect(story.lateMoment !== null).toBe(hasNight);
      if (story.lateMoment) { expect(story.lateMoment.timestamp).toBe(start + from * HOUR); expect(story.lateMoment.detail).toContain('可见记录时间'); }
    }
    expect(deriveReportStory(report([period(1, -2, 1)])).lateMoment).toBeNull();
  });

  it('does not invent a midnight moment from an already-clipped generated daily or weekly snapshot', async () => {
    for (const kind of ['daily', 'weekly'] as const) {
      const key = kind === 'daily' ? '2026-10-16' : '2026-10-12', range = reportBounds(kind, key);
      const crossing = period(1, 0, 1, { startTs: range.rangeStart - 2 * HOUR, endTs: range.rangeStart + HOUR });
      const reports = createReports({
        read: async () => ({ dataRevision: 7, periods: [crossing], gaps: [], observations: [] }),
        getReport: async () => ({ status: 'absent', report: null }),
        saveReport: async snapshot => ({ status: 'ready', report: snapshot }),
      }, () => range.rangeEnd);
      const generated = await reports.generate({ kind, dateKey: key, expectedDataRevision: 7, idempotencyKey: id(88) });
      expect(generated.report?.periods[0].startTs).toBe(range.rangeStart);
      const story = deriveReportStory(generated.report!);
      expect(story.totals.observedMs).toBe(HOUR); expect(story.lateMoment).toBeNull();
      expect(story.first).toMatchObject({ timestamp: range.rangeStart, title: '最早可见区间' });
      expect(story.first?.detail).toContain('区间左边界，不代表记录或工作起点');
      const html = renderReportHtml(generated.report!);
      expect(html).toContain('最早可见区间：'); expect(html).not.toMatch(/夜间可见记录|第一条可见记录来自/);
    }
  });

  it('quotes only supplied content, retains basis and never promotes a stale summary', () => {
    const story = deriveReportStory(report([period(1, 9, 10, { objectLabel: '日报', topic: '接口变更', summary: '讨论接口字段。', summaryStatus: 'ready', basis: 'inferred' }),
      period(2, 10, 11, { objectLabel: '评审', topic: '会议议题', summary: 'STALE_UNVERIFIED_SUMMARY', summaryStatus: 'failed', basis: 'confirmed' })]));
    expect(story.highlights).toEqual([
      { periodId: id(1), title: '日报', detail: '讨论接口字段。', basis: 'inferred', startTs: start + 9 * HOUR, endTs: start + 10 * HOUR },
      { periodId: id(2), title: '评审', detail: '会议议题', basis: 'confirmed', startTs: start + 10 * HOUR, endTs: start + 11 * HOUR },
    ]);
    expect(JSON.stringify(story)).not.toMatch(/SECRET_WINDOW_TITLE|STALE_UNVERIFIED_SUMMARY|绩效优秀|高效完成|辛苦加班/);
  });

  it('exports escaped standalone HTML with review and sources, without screenshots, window titles or remote resources', () => {
    const attack = '<script>alert("x")</script><img src="https://example.test/tracker" onerror="alert(1)">&\'';
    const snapshot = report([period(1, 9, 10, { appName: attack, objectLabel: attack, topic: attack, summary: attack, summaryStatus: 'ready', basis: 'inferred' })]);
    const html = renderReportHtml(snapshot);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'); expect(html).toContain('&amp;&#39;');
    expect(html).not.toMatch(/<script|<img|<iframe|<link|<a\s|<[^>]+\ssrc=|SECRET_WINDOW_TITLE|one-room-evidence:|data:image/i);
    expect(html).toContain("default-src 'none'"); expect(html).toContain('发布或转发前，请审阅');
    expect(html).toContain('回顾片段'); expect(html).toContain('来源简表'); expect(html).toContain(id(1));
    expect(html).toContain('推断'); expect(html).toContain('未覆盖'); expect(html).toContain('来源版本 7');
    expect(renderReportHtml(snapshot)).toBe(html);
  });

  it('leaves an empty day unknown instead of inventing activity or moments', () => {
    const story = deriveReportStory(report([]));
    expect(story.totals).toEqual({ observedMs: 0, gapMs: 0, unknownMs: DAY_MS, totalMs: DAY_MS, coverage: 0 });
    expect(story.apps).toEqual([]); expect(story.activities).toEqual([]); expect(story.highlights).toEqual([]);
    expect(story.moments).toEqual([]); expect(story.longestPeriod).toBeNull(); expect(story.switchCount).toBe(0);
    expect(renderReportHtml(report([]))).not.toMatch(/NaN|undefined/);
  });
});
