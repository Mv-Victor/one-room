import { inputSchemas, type MethodInput } from '../../shared/contracts';
import { DomainError } from '../../shared/errors';
import type { CalendarPage, CursorResult, Period, TimelinePage } from '../../shared/schemas';
import { dateKey, dayBounds, monthBounds } from '../../shared/time';
import type { DatabaseClient } from '../storage/client';
import type { StorageDiagnostics } from '../storage/protocol';
import { clip, overlaps, projectDays, unionDuration } from './periodizer';
import type { WorklogReader } from './repository';

export function matchesPeriod(value: Period, filters: { bundleIds?: string[]; query?: string }): boolean {
  return (!filters.bundleIds?.length || filters.bundleIds.includes(value.appBundleId)) && (!filters.query ||
    [value.appName, value.windowTitle, value.objectLabel, value.topic, value.summary].join(' ').toLocaleLowerCase().includes(filters.query.toLocaleLowerCase()));
}
const changed = (): never => { throw new DomainError('STALE_REVISION', '记录已更新，请刷新。', 'QUERY_SNAPSHOT_CHANGED'); };

export function createSnapshotQueries(reader: WorklogReader, now = Date.now) {
  const continuations = new Map<string, { key: string; revision: number; offset: number }>();
  function paginate<T>(items: T[], input: { cursor?: string; limit?: number }, key: string, revision: number) {
    const prior = input.cursor ? continuations.get(input.cursor) : null;
    if (input.cursor && (!prior || prior.key !== key || prior.revision !== revision)) changed();
    const offset = prior?.offset ?? 0, limit = input.limit ?? 100;
    let nextCursor: string | null = null;
    if (offset + limit < items.length) {
      nextCursor = crypto.randomUUID();
      continuations.set(nextCursor, { key, revision, offset: offset + limit });
      if (continuations.size > 128) continuations.delete(continuations.keys().next().value!);
    }
    return { items: items.slice(offset, offset + limit), nextCursor };
  }
  const ordered = (periods: Period[]) => [...periods].sort((a, b) => a.startTs - b.startTs || a.id.localeCompare(b.id));
  const filterKey = (input: { bundleIds?: string[]; query?: string }) => [input.bundleIds ? [...new Set(input.bundleIds)].sort() : [], input.query ?? ''];

  return {
    async timeline(raw: MethodInput<'timeline.query'>): Promise<TimelinePage> {
      const input = inputSchemas['timeline.query'].parse(raw);
      const snapshot = await reader.read(input);
      const all = ordered(snapshot.periods.filter(p => overlaps(p, input.rangeStart, input.rangeEnd)).map(p => clip(p, input.rangeStart, input.rangeEnd)));
      const filtered = all.filter(p => matchesPeriod(p, input) || (snapshot.matchingPeriodIds?.includes(p.id) && matchesPeriod(p, { bundleIds: input.bundleIds })));
      const gaps = snapshot.gaps.filter(g => overlaps(g, input.rangeStart, input.rangeEnd)).map(g => clip(g, input.rangeStart, input.rangeEnd));
      const key = JSON.stringify(['timeline', input.rangeStart, input.rangeEnd, filterKey(input)]);
      const rows = [...filtered.map(value => ({ kind: 'period' as const, value })), ...gaps.map(value => ({ kind: 'gap' as const, value }))]
        .sort((a, b) => a.value.startTs - b.value.startTs || a.value.id.localeCompare(b.value.id));
      const page = paginate(rows, input, key, snapshot.dataRevision);
      const facts = [...snapshot.periods, ...snapshot.gaps];
      const recordingRange = snapshot.recordingRange === undefined ? (facts.length ? {
        rangeStart: facts.reduce((start, p) => Math.min(start, p.startTs), Infinity), rangeEnd: facts.reduce((end, p) => Math.max(end, p.endTs), 0),
      } : null) : snapshot.recordingRange;
      return {
        recordingRange,
        periods: page.items.flatMap(row => row.kind === 'period' ? [row.value] : []),
        gaps: page.items.flatMap(row => row.kind === 'gap' ? [row.value] : []),
        coverage: { rangeStart: input.rangeStart, rangeEnd: input.rangeEnd, recordedMs: unionDuration(all), gapMs: unionDuration(gaps) },
        filteredDurationMs: unionDuration(filtered), nextCursor: page.nextCursor, dataRevision: snapshot.dataRevision
      };
    },
    async cursor(raw: MethodInput<'timeline.resolveCursor'>): Promise<CursorResult> {
      const input = inputSchemas['timeline.resolveCursor'].parse(raw);
      const snapshot = await reader.read({ ...dayBounds(dateKey(input.cursorTs)), query: input.query });
      if (snapshot.dataRevision !== input.queryRevision) changed();
      const gap = snapshot.gaps.find(g => g.startTs <= input.cursorTs && input.cursorTs < g.endTs) ?? null;
      const period = gap ? null : snapshot.periods.find(p => p.startTs <= input.cursorTs && input.cursorTs < p.endTs &&
        (matchesPeriod(p, input) || (snapshot.matchingPeriodIds?.includes(p.id) && matchesPeriod(p, { bundleIds: input.bundleIds })))) ?? null;
      const observation = period ? [...snapshot.observations].filter(o => o.periodId === period.id && o.observedAt <= input.cursorTs && input.cursorTs < Math.min(o.displayUntil, period.endTs))
        .sort((a, b) => b.observedAt - a.observedAt || b.id.localeCompare(a.id))[0] : undefined;
      const candidate = observation?.evidence;
      const source = candidate && candidate.observedAt <= input.cursorTs && input.cursorTs < candidate.displayUntil ? candidate : null;
      const status = source?.status === 'available' && source.observedAt + 30 * 86400_000 <= now() ? 'expired' : source?.status;
      return {
        cursorTs: input.cursorTs, period, gap, dataRevision: snapshot.dataRevision,
        observation: observation ? { id: observation.id, observedAt: observation.observedAt, revision: observation.revision } : null,
        evidence: source ? { ...source, status: status!, displayUntil: Math.min(source.displayUntil, observation!.displayUntil, period!.endTs),
          requestToken: crypto.randomUUID(), url: status === 'available' ? `one-room-evidence://image/${source.evidenceId}` : null } : null,
        label: { appName: period?.appName ?? null, action: period?.action ?? 'unknown', activityType: period?.activityType ?? 'unknown', objectLabel: period?.objectLabel ?? null,
          topic: period?.topic ?? null, text: period ? `${period.appName} · 对象${period.objectLabel ?? '未知'} · 主题${period.topic ?? '未知'}` : gap ? '未记录' : '无匹配记录' }
      };
    },
    async calendar(raw: MethodInput<'calendar.query'>): Promise<CalendarPage> {
      const input = inputSchemas['calendar.query'].parse(raw), range = monthBounds(input.month);
      const snapshot = await reader.read({ ...range, query: input.query });
      const periods = projectDays(ordered(snapshot.periods.filter(p => overlaps(p, range.rangeStart, range.rangeEnd) &&
        (matchesPeriod(p, input) || (snapshot.matchingPeriodIds?.includes(p.id) && matchesPeriod(p, { bundleIds: input.bundleIds })))).map(p => clip(p, range.rangeStart, range.rangeEnd))));
      const gaps = projectDays(snapshot.gaps.filter(g => overlaps(g, range.rangeStart, range.rangeEnd)).map(g => clip(g, range.rangeStart, range.rangeEnd)));
      const entries = [...[...periods].flatMap(([dateKey, values]) => values.map(value => ({ dateKey, kind: 'period' as const, value }))),
        ...[...gaps].flatMap(([dateKey, values]) => values.map(value => ({ dateKey, kind: 'gap' as const, value })))]
        .sort((a, b) => a.value.startTs - b.value.startTs || a.value.id.localeCompare(b.value.id));
      const page = paginate(entries, input, JSON.stringify(['calendar', input.month, filterKey(input)]), snapshot.dataRevision);
      const keys = [...new Set([...page.items.map(row => row.dateKey), ...Object.keys(snapshot.reports ?? {})])].sort();
      return { month: input.month, timezone: 'Asia/Shanghai', nextCursor: page.nextCursor, dataRevision: snapshot.dataRevision,
        days: keys.map(dateKey => ({ dateKey,
          periods: page.items.flatMap(row => row.dateKey === dateKey && row.kind === 'period' ? [row.value] : []),
          gaps: page.items.flatMap(row => row.dateKey === dateKey && row.kind === 'gap' ? [row.value] : []),
          recordedMs: unionDuration(periods.get(dateKey) ?? []), report: snapshot.reports?.[dateKey] ?? { daily: 'absent', weekly: 'absent' }
        })) };
    }
  };
}

// A injects the transactional reader; nonempty facts never masquerade as empty history.
export function createWorklogQueries(database: DatabaseClient, reader?: WorklogReader) {
  return createSnapshotQueries(reader ?? { read: async () => {
    const result = await database.call<StorageDiagnostics>('bootstrap');
    if (result.data.observationCount) throw new DomainError('CAPABILITY_BLOCKED', '工作回顾存储接口尚未接入。', 'WORKLOG_READER_NOT_CONNECTED');
    return { dataRevision: result.dataRevision, periods: [], gaps: [], observations: [] };
  } });
}
