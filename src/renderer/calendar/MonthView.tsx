import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, CalendarRange, ArrowUpRight } from 'lucide-react';
import type { MethodInput } from '../../shared/contracts';
import type { CalendarPage } from '../../shared/schemas';
import { connectDesktopApi, errorMessage, unwrap } from '../lib/desktop';
import { dateKey, formatDuration, monthBounds } from '../lib/time';
import { IconButton } from '../components/IconButton';
import { CalendarEntries } from './CalendarEntries';

type Props = { selectedDate: string; active?: boolean; refreshKey?: number; filters: Pick<MethodInput<'calendar.query'>, 'bundleIds' | 'query'>;
  onSelectDate: (key: string) => void; onOpenDay: (key: string, timestamp?: number) => void; onReport: (kind: 'daily' | 'weekly', key: string) => void };
export const MonthView = memo(function MonthView({ selectedDate, active = true, refreshKey, filters, onSelectDate, onOpenDay, onReport }: Props) {
  const month = selectedDate.slice(0, 7);
  const [page, setPage] = useState<CalendarPage | null>(null), [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const loadedQuery = useRef('');
  const refresh = useCallback(async (clear = false) => {
    const requestKey = JSON.stringify([month, filters]);
    const token = ++generation.current;
    if (clear || loadedQuery.current !== requestKey) setPage(null);
    setError(null);
    try {
      const api = await connectDesktopApi();
      let next = unwrap(await api.calendar.query({ month, ...filters, limit: 500 }));
      const days = new Map(next.days.map(day => [day.dateKey, { ...day, periods: [...day.periods], gaps: [...day.gaps] }]));
      const revision = next.dataRevision, seen = new Set<string>();
      while (next.nextCursor) {
        if (token !== generation.current) return;
        if (seen.has(next.nextCursor)) throw new Error('月历分页未前进。');
        seen.add(next.nextCursor);
        next = unwrap(await api.calendar.query({ month, ...filters, limit: 500, cursor: next.nextCursor }));
        if (next.dataRevision !== revision) throw new Error('记录已更新，请刷新。');
        for (const day of next.days) {
          const prior = days.get(day.dateKey);
          days.set(day.dateKey, prior ? { ...day, periods: [...prior.periods, ...day.periods], gaps: [...prior.gaps, ...day.gaps] } : day);
        }
      }
      if (token === generation.current) { loadedQuery.current = requestKey; setPage({ ...next, days: [...days.values()] }); }
    } catch (cause) { if (token === generation.current) setError(errorMessage(cause)); }
  }, [month, filters]);
  useEffect(() => {
    if (!active) return;
    void refresh(); let unsubscribe: (() => void) | undefined, subscribed = true;
    void connectDesktopApi().then(api => { if (subscribed) unsubscribe = api.events.subscribe(event => {
      if (['timeline.changed', 'source.invalidated', 'report.changed'].includes(event.type)) void refresh(event.type === 'source.invalidated');
    }); }).catch(() => undefined);
    return () => { subscribed = false; generation.current++; unsubscribe?.(); };
  }, [refresh, refreshKey, active]);
  const days = useMemo(() => new Map(page?.days.map(day => [day.dateKey, day])), [page]);
  const range = monthBounds(month), count = Math.round((range.rangeEnd - range.rangeStart) / 86400_000);
  const firstWeekday = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const shiftMonth = (amount: number) => {
    const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + amount);
    onSelectDate(next.toISOString().slice(0, 10));
  };
  return <section className="month-view" aria-label="月历">
    <div className="month-heading"><IconButton label="上个月" onClick={() => shiftMonth(-1)}><ChevronLeft size={17} /></IconButton>
      <h2>{month}</h2><IconButton label="下个月" onClick={() => shiftMonth(1)} disabled={month >= dateKey().slice(0, 7)}><ChevronRight size={17} /></IconButton>
      <span className="subtle-text">{page ? `${page.days.reduce((sum, day) => sum + day.periods.length, 0)} 个片段` : '读取中'}</span></div>
    {error && <div role="alert" className="inline-message is-error">{error}<button type="button" className="text-button" onClick={() => void refresh()}>重试</button></div>}
    <div className="month-weekdays" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="month-grid">
      {Array.from({ length: firstWeekday }, (_, index) => <div className="month-spacer" key={`blank:${index}`} />)}
      {Array.from({ length: count }, (_, index) => {
        const key = `${month}-${String(index + 1).padStart(2, '0')}`, day = days.get(key);
        const hasEntries = Boolean(day?.periods.length || day?.gaps.length);
        return <section key={key} className={`month-day ${key === selectedDate ? 'is-selected' : ''} ${hasEntries ? 'has-entries' : 'is-empty'}`} aria-label={`${key} 工作记录`}>
          <div className="month-day-heading"><button type="button" onClick={() => onSelectDate(key)} onDoubleClick={() => onOpenDay(key)} aria-pressed={key === selectedDate}><span className="month-mobile-month">{month.slice(5)}/</span>{index + 1}</button>
            <span>{day?.recordedMs ? `记录 ${formatDuration(day.recordedMs)}` : '未记录'}</span>
            <IconButton label={`打开 ${key} 日轴`} onClick={() => onOpenDay(key)}><ArrowUpRight size={14} /></IconButton></div>
          <CalendarEntries date={key} day={day} onOpenDay={onOpenDay} />
          <div className="month-report-actions"><span>{day?.recordedMs ? day.recordedMs >= 86_400_000 ? '完整覆盖' : '部分覆盖' : ''}</span><IconButton label={`${key} 日报`} onClick={() => onReport('daily', key)}><FileText size={14} /></IconButton>
            <IconButton label={`${key} 所在周周报`} onClick={() => onReport('weekly', key)}><CalendarRange size={14} /></IconButton></div>
        </section>;
      })}
    </div>
    <span className="month-revision subtle-text">数据版本 {page?.dataRevision ?? '-'}</span>
  </section>;
});
