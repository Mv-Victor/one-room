import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CalendarPage } from '../../shared/schemas';
import { formatTime } from '../lib/time';
import { actionLabels, activityLabels, appTone, summaryLabels } from '../timeline/presentation';

type Day = CalendarPage['days'][number];
type Entry = { kind: 'period'; period: Day['periods'][number]; startTs: number } |
  { kind: 'gap'; gap: Day['gaps'][number]; startTs: number };
type Props = { date: string; day?: Day; onOpenDay: (date: string, timestamp?: number) => void };
const PERIOD_HEIGHT = 152, GAP_HEIGHT = 48, OVERSCAN = 2;

function entryAt(offsets: number[], position: number): number {
  let low = 0, high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (offsets[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return Math.min(low, offsets.length - 2);
}

export const CalendarEntries = memo(function CalendarEntries({ date, day, onOpenDay }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 220 });
  const entries = useMemo<Entry[]>(() => [
    ...(day?.periods.map(period => ({ kind: 'period' as const, startTs: period.startTs, period })) ?? []),
    ...(day?.gaps.map(gap => ({ kind: 'gap' as const, startTs: gap.startTs, gap })) ?? []),
  ].sort((a, b) => a.startTs - b.startTs), [day]);
  const offsets = useMemo(() => {
    const result = [0];
    for (const entry of entries) result.push(result.at(-1)! + (entry.kind === 'period' ? PERIOD_HEIGHT : GAP_HEIGHT));
    return result;
  }, [entries]);
  const virtual = entries.length > 8;
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    // Removing or shortening the scroll area can clamp scrollTop without a scroll event.
    const top = element.scrollTop, height = element.clientHeight;
    setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
  }, [entries]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(previous => {
      const height = element.clientHeight;
      return height === previous.height ? previous : { top: element.scrollTop, height };
    }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const first = virtual ? Math.max(0, entryAt(offsets, viewport.top) - OVERSCAN) : 0;
  const last = virtual ? Math.min(entries.length, entryAt(offsets, viewport.top + viewport.height) + OVERSCAN + 1) : entries.length;
  return <div ref={container} className={`month-entries${virtual ? ' is-windowed' : ''}`} tabIndex={entries.length ? 0 : undefined}
    aria-label={`${date} 时序活动`} data-entry-count={entries.length}
    onScroll={virtual ? event => {
      const top = event.currentTarget.scrollTop;
      setViewport(previous => previous.top === top ? previous : { ...previous, top });
    } : undefined}>
    {virtual && <div className="calendar-entry-space" aria-hidden="true" style={{ height: offsets.at(-1) }} />}
    {entries.slice(first, last).map((entry, relativeIndex) => {
      const index = first + relativeIndex;
      const style: CSSProperties | undefined = virtual ? { top: offsets[index], height: offsets[index + 1] - offsets[index] } : undefined;
      if (entry.kind === 'gap') return <span className="calendar-gap" key={`gap:${entry.gap.id}`} style={style}>
        <time>{formatTime(entry.gap.startTs)} – {formatTime(entry.gap.endTs)}</time>未记录</span>;
      const { period } = entry;
      const object = `${period.objectLabel ?? '对象未知'} · ${period.topic ?? '主题未知'}`;
      return <button type="button" key={`${period.id}:${period.startTs}`} style={style} data-entry-index={index}
        onClick={() => onOpenDay(date, period.startTs)} title={`${period.appName} · ${object}${period.summary ? `\n${period.summary}` : ''}`}>
        <time>{formatTime(period.startTs, true)} – {formatTime(period.endTs, true)}</time>
        <strong><i className={appTone(period.appBundleId)} /><span className="calendar-app-name">{period.appName}</span></strong>
        <span className="calendar-activity">{actionLabels[period.action ?? 'unknown']} · {activityLabels[period.activityType]}</span>
        <span className="calendar-object">{object}</span>
        {period.summary ? <p>{period.summary}</p> : <span className="calendar-summary-state">{summaryLabels[period.summaryStatus]}</span>}
      </button>;
    })}
  </div>;
});
