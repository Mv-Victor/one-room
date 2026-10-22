import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarRange, ChevronDown, FileText, ImageOff, Maximize2, Minus, Plus, Search, Settings2, ZoomIn } from 'lucide-react';
import type { CursorResult, Period } from '../../shared/schemas';
import { IconButton } from '../components/IconButton';
import { connectDesktopApi, errorMessage, unwrap } from '../lib/desktop';
import { dateKey, dayBounds, formatDuration, formatTime } from '../lib/time';
import { queryTimeline, type TimelinePage } from './data-source';
import { TimelineControls } from './TimelineControls';
import { groupPeriodRuns } from './group-period-runs';
import { centeredRange, clampToRecording, fitRecordingSpan, initialNavigation, navigate, scrubDelta, wheelUnits } from './navigation';
import { DAY_MS } from '../../shared/time';
import { useEvidenceImage } from './hooks/use-evidence-image';
import { useContainedImageLayout } from './hooks/use-contained-image-layout';
import { useSmoothZoom } from './hooks/use-smooth-zoom';
import { useSampledCursor } from './hooks/use-sampled-cursor';
import { useReviewTransition } from './hooks/use-review-transition';
import { MonthView } from '../calendar/MonthView';
import { actionLabels, activityLabels, appTone, basisLabels, periodTitle, summaryLabels } from './presentation';
import { isTimelineGestureTarget, subscribeTimelineGestures } from './gesture-adapter';

type Props = { active: boolean; selectedDate: string; cursorTs: number; onDateChange: (date: string) => void;
  onCursorChange: (timestamp: number) => void; onOpenSettings: () => void;
  onOpenReports: (kind: 'daily' | 'weekly', key: string) => void };
const evidenceLabels = { expired: '原图已过期', deleted: '原图已删除', missing: '原图缺失', none: '此记录暂无画面', available: '正在载入画面' };
const gapLabels = { paused: '采集已暂停', locked: '锁屏', sleep: '睡眠', permission: '权限不可用', excluded: '已排除', visibility_unknown: '可见性未知', queue_overflow: '队列已满', capture_error: '捕获失败', process_interrupted: '进程中断' };

export function TimelineView({ active, selectedDate, cursorTs, onDateChange, onCursorChange, onOpenSettings, onOpenReports }: Props) {
  const [navigation, dispatch] = useReducer(navigate, initialNavigation);
  const [pageState, setPage] = useState<{ key: string; page: TimelinePage } | null>(null);
  const [railState, setRail] = useState<{ scope: string; page: TimelinePage } | null>(null);
  const positioned = useRef(false);
  const dateToLocate = useRef<string | null>(null);
  const [cursorState, setCursor] = useState<{ key: string; scope: string; result: CursorResult } | null>(null);
  const [error, setError] = useState<string | null>(null), [epoch, setEpoch] = useState(0), [playing, setPlaying] = useState(false);
  const [appFilter, setAppFilter] = useState(''), [search, setSearch] = useState('');
  const [apps, setApps] = useState<{ id: string; name: string }[]>([]);
  const [assistantRange, setAssistantRange] = useState(() => ({ start: selectedDate, end: selectedDate }));
  const filters = useMemo(() => ({ ...(appFilter ? { bundleIds: [appFilter] } : {}), ...(search.trim() ? { query: search.trim() } : {}) }), [appFilter, search]);
  const pageKey = JSON.stringify([selectedDate, filters, epoch]);
  const page = pageState?.key === pageKey ? pageState.page : null;
  const railScope = JSON.stringify([filters, epoch]);
  // Keep the buffered rail through midnight while the adjacent window loads.
  const rail = railState?.scope === railScope && railState.page.coverage.rangeStart <= cursorTs && cursorTs < railState.page.coverage.rangeEnd ? railState.page : null;
  const recording = railState?.scope === railScope ? railState.page.recordingRange : null;
  const sampledCursor = useSampledCursor(cursorTs);
  const resultScope = JSON.stringify([railScope, rail?.dataRevision]);
  const selectionKey = JSON.stringify([resultScope, sampledCursor]);
  const currentPeriod = rail?.periods.find(p => p.startTs <= cursorTs && cursorTs < p.endTs);
  const gap = rail?.gaps.find(g => g.startTs <= cursorTs && cursorTs < g.endTs);
  const result = cursorState?.scope === resultScope && !gap && cursorState.result.period?.id === currentPeriod?.id &&
    (!cursorState.result.evidence || cursorState.result.evidence.observedAt <= cursorTs) ? cursorState.result : null;
  const evidenceScope = `${resultScope}:${currentPeriod?.id ?? 'none'}`;
  const { image, expired: imageExpired, failed: imageFailed, loading: imageLoading } = useEvidenceImage(result?.evidence ?? null, evidenceScope, true, cursorTs);
  const { ref: imageRef, size: imageSize } = useContainedImageLayout(image);
  const span = useSmoothZoom(navigation.spanMs), range = centeredRange(cursorTs, span);
  const transition = useReviewTransition(navigation.mode);
  const trackRef = useRef<HTMLElement>(null), gesture = useRef(0), gestureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorLive = useRef(cursorTs), modeLive = useRef(navigation.mode), spanLive = useRef(span);
  cursorLive.current = cursorTs; modeLive.current = navigation.mode; spanLive.current = span;
  const cursorFrame = useRef<number | null>(null), pendingCursor = useRef<number | null>(null);
  const pointerDrag = useRef<{ id: number; x: number; ts: number; width: number; span: number; moved: boolean } | null>(null);
  const callbacks = useRef({ onDateChange, onCursorChange, onOpenReports });
  callbacks.current = { onDateChange, onCursorChange, onOpenReports };
  const selectCalendarDate = useCallback((key: string) => { dateToLocate.current = key; setPlaying(false); callbacks.current.onDateChange(key); }, []);
  const openCalendarDay = useCallback((key: string, timestamp?: number) => {
    dateToLocate.current = timestamp === undefined ? key : null;
    callbacks.current.onDateChange(key);
    if (timestamp !== undefined) callbacks.current.onCursorChange(timestamp);
    setPlaying(false); dispatch({ type: 'mode', mode: 'day' });
  }, []);
  const openCalendarReport = useCallback((kind: 'daily' | 'weekly', key: string) => callbacks.current.onOpenReports(kind, key), []);
  const refresh = useCallback(() => { setPage(null); setCursor(null); setEpoch(value => value + 1); }, []);

  useEffect(() => {
    let current = true;
    const bounds = dayBounds(selectedDate);
    void queryTimeline({ rangeStart: Math.max(0, bounds.rangeStart - DAY_MS), rangeEnd: bounds.rangeEnd + DAY_MS }, filters).then(next => {
      if (current) setRail({ scope: railScope, page: next });
    }).catch(cause => { if (current) setError(errorMessage(cause)); });
    return () => { current = false; };
  }, [selectedDate, filters, railScope]);
  useEffect(() => {
    const locating = dateToLocate.current === selectedDate;
    if ((positioned.current && !locating) || !recording || !page || !rail) return;
    const facts = [...page.periods, ...page.gaps].filter(p => p.endTs > recording.rangeStart && p.startTs < recording.rangeEnd);
    if (locating && !page.periods.length) { dateToLocate.current = null; return; }
    if (!facts.length && selectedDate !== dateKey(recording.rangeEnd - 1)) {
      onCursorChange(recording.rangeEnd - 1);
      return;
    }
    const bounds = facts.length ? { rangeStart: Math.max(recording.rangeStart, Math.min(...facts.map(p => p.startTs))), rangeEnd: Math.min(recording.rangeEnd, Math.max(...facts.map(p => p.endTs))) } : recording;
    let target = clampToRecording(cursorTs, bounds);
    if (page.periods.length && !page.periods.some(p => p.startTs <= target && target < p.endTs)) target = page.periods.at(-1)!.endTs - 1;
    positioned.current = true;
    dateToLocate.current = null;
    onCursorChange(target);
    if (navigation.mode === 'day') dispatch({ type: 'span', spanMs: fitRecordingSpan(bounds, target) });
  }, [recording, page, rail, selectedDate, cursorTs, onCursorChange, navigation.mode]);

  useEffect(() => {
    let active = true; setError(null);
    void queryTimeline(selectedDate, filters).then(next => {
      if (!active) return;
      setPage({ key: pageKey, page: next });
      if (!filters.bundleIds && !filters.query) setApps([...new Map(next.periods.map(p => [p.appBundleId, { id: p.appBundleId, name: p.appName }])).values()]);
    }).catch(cause => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [selectedDate, filters, pageKey]);
  useEffect(() => {
    if (!rail || !active || navigation.mode !== 'day') return;
    let resolving = true;
    void connectDesktopApi().then(api => api.timeline.resolveCursor({ cursorTs: sampledCursor, queryRevision: rail.dataRevision, ...filters })).then(reply => {
      if (!resolving) return;
      if (!reply.ok && reply.error.code === 'STALE_REVISION') {
        refresh();
        return;
      }
      const next = unwrap(reply);
      if (next.cursorTs === sampledCursor && next.dataRevision === rail.dataRevision) setCursor({ key: selectionKey, scope: resultScope, result: next });
    }).catch(cause => { if (resolving) setError(errorMessage(cause)); });
    return () => { resolving = false; };
  }, [rail, selectionKey, sampledCursor, resultScope, filters, refresh, active, navigation.mode]);
  useEffect(() => {
    let active = true, unsubscribe: (() => void) | undefined;
    void connectDesktopApi().then(api => { if (active) unsubscribe = api.events.subscribe(event => {
      if (['timeline.changed', 'source.invalidated', 'evidence.expired'].includes(event.type)) refresh();
    }); }).catch(() => undefined);
    return () => { active = false; unsubscribe?.(); };
  }, [refresh]);
  useEffect(() => {
    if (!playing || !active || navigation.mode !== 'day' || !recording) return;
    const timer = window.setTimeout(() => {
      const next = clampToRecording(cursorTs + 1000, recording);
      onCursorChange(next);
      if (next >= recording.rangeEnd - 1) setPlaying(false);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [playing, active, navigation.mode, cursorTs, recording, onCursorChange]);
  useEffect(() => { if (!active) setPlaying(false); }, [active]);
  useEffect(() => {
    if (!active) return;
    let subscribed = true, unsubscribe: (() => void) | undefined;
    void connectDesktopApi().then(api => {
      if (subscribed) unsubscribe = subscribeTimelineGestures(api, units => {
        if (!isTimelineGestureTarget(trackRef.current)) return;
        setPlaying(false);
        dispatch({ type: 'zoom', units, gestureId: ++gesture.current });
      });
    }).catch(() => undefined);
    return () => { subscribed = false; unsubscribe?.(); };
  }, [active]);
  const selectCursor = useCallback((timestamp: number) => { setPlaying(false); if (recording) onCursorChange(clampToRecording(timestamp, recording)); }, [recording, onCursorChange]);
  const scheduleCursor = useCallback((timestamp: number) => {
    pendingCursor.current = timestamp;
    if (cursorFrame.current !== null) return;
    cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = null;
      const next = pendingCursor.current;
      pendingCursor.current = null;
      if (next !== null) selectCursor(next);
    });
  }, [selectCursor]);
  useEffect(() => () => {
    if (cursorFrame.current !== null) cancelAnimationFrame(cursorFrame.current);
    cursorFrame.current = null; pendingCursor.current = null; pointerDrag.current = null;
  }, [active]);
  useEffect(() => {
    const element = trackRef.current;
    if (!element || !active) return;
    const wheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('textarea, select, input:not(.timeline-slider), [contenteditable="true"], [role="dialog"]')) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault(); setPlaying(false);
        if (!gestureTimer.current) gesture.current++;
        else clearTimeout(gestureTimer.current);
        dispatch({ type: 'zoom', units: wheelUnits(event.deltaY, event.deltaMode), gestureId: gesture.current });
        gestureTimer.current = setTimeout(() => { gestureTimer.current = null; }, 180);
        return;
      }
      // Adapted from Screenpipe use-scroll-zoom.ts L95-183 (MIT, locked
      // 1b3e4186): RAF coalescing, zoom-scaled navigation and scoped wheel input.
      if (modeLive.current !== 'day' || !target.closest('.evidence-stage, .timeline-track-section')) return;
      event.preventDefault(); setPlaying(false);
      if (gestureTimer.current) return;
      const width = element.querySelector('.time-track')?.getBoundingClientRect().width || element.clientWidth;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      scheduleCursor((pendingCursor.current ?? cursorLive.current) + scrubDelta(delta, event.deltaMode, spanLive.current, width));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { element.removeEventListener('wheel', wheel); if (gestureTimer.current) clearTimeout(gestureTimer.current); gestureTimer.current = null; };
  }, [active, scheduleCursor]);
  const zoom = (units: number) => { setPlaying(false); dispatch({ type: 'zoom', units, gestureId: ++gesture.current }); };
  const pan = (direction: number) => {
    selectCursor(cursorTs + direction * navigation.spanMs / 4);
  };
  const selectPeriod = useCallback((period: Period, focus = false) => {
    selectCursor(period.startTs);
    if (focus) dispatch({ type: 'span', spanMs: Math.max(300_000, (period.endTs - period.startTs) * 3) });
  }, [selectCursor]);
  const runs = useMemo(() => groupPeriodRuns(rail?.periods ?? [], rail?.gaps ?? []), [rail]);
  const allocation = useMemo(() => {
    const groups = new Map<string, { name: string; id: string; ranges: Period[] }>();
    for (const period of page?.periods ?? []) {
      const group = groups.get(period.appBundleId) ?? { name: period.appName, id: period.appBundleId, ranges: [] };
      group.ranges.push(period); groups.set(group.id, group);
    }
    return [...groups.values()].map(group => {
      let end = 0, duration = 0;
      for (const period of group.ranges.sort((a, b) => a.startTs - b.startTs)) {
        duration += Math.max(0, period.endTs - Math.max(period.startTs, end));
        end = Math.max(end, period.endTs);
      }
      return { ...group, duration };
    }).sort((a, b) => b.duration - a.duration);
  }, [page]);
  const allocationTotal = allocation.reduce((sum, app) => sum + app.duration, 0);
  const evidenceTitle = !rail ? error ? '记录读取失败' : '正在读取记录' : gap ? '未记录' : !currentPeriod ? '此时段未记录' :
    !result ? '正在定位画面' : imageExpired ? '原图已过期' : imageFailed ? '原图无法读取' : result.evidence ? evidenceLabels[result.evidence.status] : '此记录暂无画面';
  return <div className="timeline-page">
    <TimelineControls selectedDate={selectedDate} onDateChange={selectCalendarDate} onRefresh={refresh} loading={!page && !error}
      playing={playing} onTogglePlay={() => setPlaying(value => !value)} mode={navigation.mode} onModeChange={mode => { setPlaying(false); dispatch({ type: 'mode', mode }); }}
      onNow={() => { if (recording) selectCursor(recording.rangeEnd - 1); dispatch({ type: 'mode', mode: 'day' }); }} />
    <div className="view-filters"><label><Search size={15} /><input aria-label="搜索记录" type="search" placeholder="搜索记录" maxLength={200} value={search} onChange={event => { setPlaying(false); setSearch(event.target.value); }} /></label>
      <select aria-label="软件筛选" value={appFilter} onChange={event => { setPlaying(false); setAppFilter(event.target.value); }}><option value="">全部软件</option>{apps.map(app => <option value={app.id} key={app.id}>{app.name}</option>)}</select>
      {(appFilter || search) && <span className="subtle-text">筛选后 {formatDuration(page?.filteredDurationMs ?? 0)}</span>}
      <div className="daily-report-actions"><IconButton label="当日日报" onClick={() => onOpenReports('daily', selectedDate)}><FileText size={16} /></IconButton>
        <IconButton label="所在周周报" onClick={() => onOpenReports('weekly', selectedDate)}><CalendarRange size={16} /></IconButton></div></div>
    {error && <div className="inline-message is-error" role="alert">{error}<button type="button" className="text-button" onClick={refresh}>重试</button></div>}
    <section ref={trackRef} className="navigation-surface" aria-label="时间回顾" tabIndex={-1}>
      <div className="review-planes" data-mode={navigation.mode} data-transition={transition ? `${transition.from}-to-${transition.to}` : undefined}>
      <div className={`review-plane review-day ${navigation.mode === 'day' ? 'is-active' : ''} ${transition?.from === 'day' ? 'is-leaving' : ''} ${transition?.to === 'day' ? 'is-entering' : ''}`}
        hidden={navigation.mode !== 'day' && transition?.from !== 'day'} aria-hidden={navigation.mode !== 'day'} ref={element => { if (element) element.inert = navigation.mode !== 'day'; }}>
        <section className="day-overview" aria-label="当日时间分配"><div className="day-overview-heading"><span>已记录 <strong>{formatDuration(page?.coverage.recordedMs ?? 0)}</strong></span>
          <span>缺口 {formatDuration(page?.coverage.gapMs ?? 0)}</span><span>{selectedDate}</span></div>
          {allocation.length > 0 && <><div className="allocation-bar" aria-hidden="true">{allocation.map(app => <span key={app.id} className={appTone(app.id)} style={{ width: `${app.duration / allocationTotal * 100}%` }} />)}</div>
            <div className="allocation-legend">{allocation.map(app => <button key={app.id} type="button" aria-pressed={appFilter === app.id} onClick={() => { setPlaying(false); setAppFilter(appFilter === app.id ? '' : app.id); }} title={`${app.name} ${formatDuration(app.duration)}`}><i className={appTone(app.id)} /><span>{app.name}</span><time>{formatDuration(app.duration)}</time></button>)}</div></>}
        </section>
        <section className="evidence-stage" aria-label="选定时刻画面">
          <div className="evidence-image-area" ref={imageRef}>{image ? <img key={image.key} src={image.url} alt={`${currentPeriod?.appName ?? ''} ${formatTime(image.observedAt, true)} 的画面`} style={{ width: imageSize.width || '100%', height: imageSize.height || '100%' }} onError={refresh} /> :
            <div className="empty-evidence"><ImageOff size={30} strokeWidth={1.3} /><h2>{imageLoading ? '正在载入画面' : evidenceTitle}</h2>{gap && <span>{gapLabels[gap.reason]}</span>}
              {!page?.periods.length && <button type="button" className="secondary-button" onClick={onOpenSettings}><Settings2 size={15} />采集设置</button>}</div>}</div>
          <div className="evidence-footer"><span>{image || result?.evidence ? `画面观察于 ${formatTime(image?.observedAt ?? result?.evidence?.observedAt, true)}` : '无图像证据'}</span>
            <span>{currentPeriod ? `${formatTime(currentPeriod.startTs, true)} – ${formatTime(currentPeriod.endTs, true)} · ${formatDuration(currentPeriod.endTs - currentPeriod.startTs)}` : gap ? gapLabels[gap.reason] : '未记录'}</span></div>
        </section>
        <section className="current-context" aria-label="当前活动"><div className="cursor-label" aria-live="polite"><div className="cursor-identity"><time>{formatTime(cursorTs, true)}</time>
          <strong><i className={currentPeriod ? appTone(currentPeriod.appBundleId) : ''} />{currentPeriod?.appName ?? '未记录'}</strong></div>
          <span className="cursor-action"><small>活动</small>{currentPeriod ? `${actionLabels[currentPeriod.action ?? 'unknown']} · ${activityLabels[currentPeriod.activityType]}` : gap ? gapLabels[gap.reason] : '未记录'}</span>
          <span><small>对象</small>{currentPeriod?.objectLabel ?? '未知'}</span><span><small>主题</small>{currentPeriod?.topic ?? '未知'}</span></div>
          {currentPeriod && <div className="period-summary"><span className={`summary-state ${currentPeriod.summaryStatus === 'ready' ? 'is-ready' : ''}`}>{summaryLabels[currentPeriod.summaryStatus]}</span>
            {currentPeriod.summary && <details className="summary-copy"><summary><ChevronDown size={13} aria-hidden="true" /><span>{currentPeriod.summary}</span><small>周期总结</small></summary><p>{currentPeriod.summary}</p></details>}
            <details className="period-source"><summary>来源与窗口</summary><div><span>{basisLabels[currentPeriod.basis]}</span><span>{currentPeriod.windowTitle ?? '窗口未知'}</span><span>版本 {currentPeriod.revision}</span></div></details></div>}
        </section>
        <section className="timeline-track-section" aria-label="时间轨道"><div className="track-toolbar"><h2>时间线</h2><div className="track-tools">
          <IconButton label="向前平移" onClick={() => pan(-1)}><ArrowLeft size={16} /></IconButton>
          <IconButton label="向后平移" onClick={() => pan(1)}><ArrowRight size={16} /></IconButton>
          <IconButton label="适配录制范围" onClick={() => { if (recording) { const target = clampToRecording(cursorTs, recording); selectCursor(target); dispatch({ type: 'span', spanMs: fitRecordingSpan(recording, target) }); } }}><Maximize2 size={15} /></IconButton>
          <IconButton label="缩小" onClick={() => zoom(1)}><Minus size={16} /></IconButton><span className="zoom-label">{formatDuration(navigation.spanMs)}</span>
          <IconButton label="放大" onClick={() => zoom(-1)}><Plus size={16} /></IconButton>
        </div></div>
          <div className="time-ruler" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => {
            const timestamp = range.rangeStart + span * i / 6;
            const outside = !recording || timestamp < recording.rangeStart || timestamp >= recording.rangeEnd;
            return <span className={i === 3 ? 'ruler-current' : ''} data-outside={outside} title={`${dateKey(timestamp)} ${formatTime(timestamp, true)}`} key={i}>{outside && i !== 3 ? '' : `${dateKey(timestamp) !== selectedDate ? `${dateKey(timestamp).slice(5)} ` : ''}${formatTime(timestamp, i === 3)}`}</span>;
          })}</div>
          <div className="time-track">
            {recording && recording.rangeStart < range.rangeEnd && recording.rangeEnd > range.rangeStart && <div className="recording-extent" style={{ left: `${Math.max(0, (recording.rangeStart - range.rangeStart) / span * 100)}%`, width: `${Math.max(0, Math.min(recording.rangeEnd, range.rangeEnd) - Math.max(recording.rangeStart, range.rangeStart)) / span * 100}%` }} />}
            {rail?.gaps.filter(g => g.endTs > range.rangeStart && g.startTs < range.rangeEnd && recording && g.endTs > recording.rangeStart && g.startTs < recording.rangeEnd).map(g => <div key={g.id} className="gap-segment" title={gapLabels[g.reason]} style={{ left: `${Math.max(0, (Math.max(g.startTs, recording!.rangeStart) - range.rangeStart) / span * 100)}%`, width: `${(Math.min(g.endTs, range.rangeEnd, recording!.rangeEnd) - Math.max(g.startTs, range.rangeStart, recording!.rangeStart)) / span * 100}%` }} />)}
            {runs.filter(run => run.endTs > range.rangeStart && run.startTs < range.rangeEnd).map(run => <div key={run.periods[0].id} className={`period-segment ${appTone(run.periods[0].appBundleId)} ${run.periods.some(p => p.id === currentPeriod?.id) ? 'is-selected' : ''}`} data-period-id={run.periods[0].id} title={`${formatTime(run.startTs, true)} – ${formatTime(run.endTs, true)} · ${periodTitle(run.periods[0])}`}
              style={{ left: `${(Math.max(run.startTs, range.rangeStart) - range.rangeStart) / span * 100}%`, width: `${(Math.min(run.endTs, range.rangeEnd) - Math.max(run.startTs, range.rangeStart)) / span * 100}%` }}><span>{run.periods[0].appName}</span></div>)}
            <div className="cursor-marker" style={{ left: '50%' }} aria-hidden="true"><span /></div>
            <input className="timeline-slider" type="range" min={recording?.rangeStart ?? Math.floor(range.rangeStart)} max={recording ? recording.rangeEnd - 1 : Math.ceil(range.rangeEnd - 1)} step={1} value={cursorTs}
              aria-label="回看时间游标" aria-valuetext={`${formatTime(cursorTs, true)} ${currentPeriod ? periodTitle(currentPeriod) : '未记录'}`} onChange={event => selectCursor(Number(event.target.value))}
              onKeyDown={event => {
                const increment = event.shiftKey ? 60_000 : 1_000;
                const next = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? cursorTs - increment : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? cursorTs + increment : event.key === 'Home' ? recording?.rangeStart : event.key === 'End' ? recording ? recording.rangeEnd - 1 : undefined : undefined;
                if (next !== undefined) { event.preventDefault(); selectCursor(next); }
              }}
              onPointerDown={event => {
                if (event.button !== 0) return;
                event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); setPlaying(false);
                pointerDrag.current = { id: event.pointerId, x: event.clientX, ts: cursorTs, width: event.currentTarget.getBoundingClientRect().width, span, moved: false };
              }}
              onPointerMove={event => {
                const drag = pointerDrag.current;
                if (!drag || drag.id !== event.pointerId) return;
                const distance = event.clientX - drag.x;
                drag.moved ||= Math.abs(distance) > 3;
                if (drag.moved) scheduleCursor(drag.ts - distance * drag.span / drag.width);
              }}
              onPointerUp={event => {
                const drag = pointerDrag.current;
                if (!drag || drag.id !== event.pointerId) return;
                if (!drag.moved) selectCursor(drag.ts + (event.clientX - event.currentTarget.getBoundingClientRect().left - drag.width / 2) * drag.span / drag.width);
                pointerDrag.current = null; event.currentTarget.releasePointerCapture(event.pointerId);
              }} onPointerCancel={() => { pointerDrag.current = null; }} onLostPointerCapture={() => { pointerDrag.current = null; }} />
          </div><div className="rail-selection-caption" title={currentPeriod ? periodTitle(currentPeriod) : gap ? gapLabels[gap.reason] : '未记录'}><strong>{currentPeriod?.appName ?? '未记录'}</strong><span>{currentPeriod ? `${actionLabels[currentPeriod.action ?? 'unknown']} · ${currentPeriod.topic ?? currentPeriod.objectLabel ?? activityLabels[currentPeriod.activityType]}` : gap ? gapLabels[gap.reason] : ''}</span></div>
          <div className="track-caption"><span>{recording ? `${dateKey(recording.rangeStart).slice(5)} ${formatTime(recording.rangeStart, true)} 至 ${dateKey(recording.rangeEnd).slice(5)} ${formatTime(recording.rangeEnd, true)}` : '暂无录制'}</span><span>数据版本 {rail?.dataRevision ?? '-'}</span></div>
        </section>
        {!!page?.periods.length && <section className="period-log" aria-label="活动片段"><div className="period-log-heading"><h2>当天活动</h2><span>{page.periods.length} 个片段</span></div>
          <div className="period-list">{page.periods.map(period => <PeriodRow key={`${period.id}:${period.startTs}`} period={period} selected={period.id === currentPeriod?.id} onSelect={selectPeriod} />)}</div>
        </section>}</div>
      <div className={`review-plane review-month ${navigation.mode === 'month' ? 'is-active' : ''} ${transition?.from === 'month' ? 'is-leaving' : ''} ${transition?.to === 'month' ? 'is-entering' : ''}`}
        hidden={navigation.mode !== 'month' && transition?.from !== 'month'} aria-hidden={navigation.mode !== 'month'} ref={element => { if (element) element.inert = navigation.mode !== 'month'; }}>
        <MonthView active={active && navigation.mode === 'month'} selectedDate={selectedDate} refreshKey={epoch} filters={filters} onSelectDate={selectCalendarDate}
          onOpenDay={openCalendarDay} onReport={openCalendarReport} />
        <div className="month-zoom"><IconButton label="缩小" onClick={() => zoom(1)}><Minus size={16} /></IconButton><IconButton label="放大" onClick={() => zoom(-1)}><Plus size={16} /></IconButton></div>
      </div></div>
    </section>
    <div className="assistant-range"><span>助手范围</span><label>从<input type="date" aria-label="助手开始日期" value={assistantRange.start} onChange={e => { if (e.target.value) setAssistantRange(value => ({ ...value, start: e.target.value })); }} /></label>
      <label>至<input type="date" aria-label="助手结束日期" min={assistantRange.start} value={assistantRange.end} onChange={e => { if (e.target.value) setAssistantRange(value => ({ ...value, end: e.target.value })); }} /></label>
      <div className="assistant-agents"><button type="button" disabled title="Codex 暂未接入">Codex<small>待接入</small></button><button type="button" disabled title="Claude 暂未接入">Claude<small>暂未接入</small></button></div></div>
  </div>;
}

const PeriodRow = memo(function PeriodRow({ period, selected, onSelect }: {
  period: Period; selected: boolean; onSelect: (period: Period, focus?: boolean) => void;
}) {
  const start = formatTime(period.startTs, true);
  return <div className={selected ? 'is-selected' : ''}>
    <button type="button" aria-label={`选择 ${period.appName} ${start}`} aria-pressed={selected} onClick={() => onSelect(period)} title={periodTitle(period)}><time>{start} – {formatTime(period.endTs, true)}</time>
      <span className="period-row-context"><strong><i className={appTone(period.appBundleId)} />{period.appName}</strong><span>{actionLabels[period.action ?? 'unknown']} · {activityLabels[period.activityType]} · {period.objectLabel ?? '对象未知'} · {period.topic ?? '主题未知'}</span>{period.summary && <span className="period-row-summary">{period.summary}</span>}</span>
      <span className="period-duration">{formatDuration(period.endTs - period.startTs)}</span></button>
    <IconButton label={`放大 ${period.appName} ${start}`} onClick={() => onSelect(period, true)}><ZoomIn size={15} /></IconButton>
  </div>;
});
