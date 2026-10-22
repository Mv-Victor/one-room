import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, CalendarDays, Clock3, FilePlus2, List, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react';
import type { ReportResult } from '../../shared/schemas';
import { connectDesktopApi, errorMessage, unwrap } from '../lib/desktop';
import { dateKey, dayBounds, formatDateTime, formatDuration, formatTime, reportBounds } from '../lib/time';
import { actionLabels, activityLabels, appTone, basisLabels, summaryLabels } from '../timeline/presentation';
import { deriveReportStory, renderReportHtml } from './report-story';
import './reports.css';

const colors = ['#287f72', '#d17b59', '#7385b0', '#b3983c', '#887a98', '#628d61', '#75939d', '#af747b'];
const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;

export function ReportView({ selectedDate, kind, onDateChange, onKindChange }: {
  selectedDate: string; kind: 'daily' | 'weekly'; onDateChange: (key: string) => void; onKindChange: (kind: 'daily' | 'weekly') => void;
}) {
  const [result, setResult] = useState<ReportResult | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [connected, setConnected] = useState(false), [loading, setLoading] = useState(true);
  const [view, setView] = useState<'review' | 'facts'>('review'), [exporting, setExporting] = useState(false);
  const generation = useRef(0), range = reportBounds(kind, selectedDate);
  const refresh = useCallback(async () => {
    const token = ++generation.current; setResult(null); setError(null); setConnected(false); setLoading(true);
    try {
      const api = await connectDesktopApi();
      if (!api.report) return;
      const next = unwrap(await api.report.get({ kind, dateKey: selectedDate }));
      if (token === generation.current) { setConnected(true); setResult(next); }
    } catch (cause) { if (token === generation.current) setError(errorMessage(cause)); }
    finally { if (token === generation.current) setLoading(false); }
  }, [kind, selectedDate]);
  useEffect(() => {
    void refresh(); let active = true, unsubscribe: (() => void) | undefined;
    void connectDesktopApi().then(api => { if (active) unsubscribe = api.events.subscribe(event => {
      if (['source.invalidated', 'report.changed'].includes(event.type)) void refresh();
    }); }).catch(() => undefined);
    return () => { active = false; generation.current++; unsubscribe?.(); };
  }, [refresh]);
  const generate = async () => {
    setBusy(true); setError(null);
    const token = generation.current;
    try {
      const api = await connectDesktopApi(), status = unwrap(await api.app.getStatus({}));
      if (!api.report) throw new Error('报告存储接口尚未接入。');
      const next = unwrap(await api.report.generate({ kind, dateKey: selectedDate, expectedDataRevision: status.dataRevision, idempotencyKey: crypto.randomUUID() }));
      if (token === generation.current) setResult(next);
    } catch (cause) { if (token === generation.current) setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const stored = result?.report;
  const report = stored?.kind === kind && stored.rangeStart === range.rangeStart && stored.rangeEnd === range.rangeEnd ? stored : null;
  const story = useMemo(() => report ? deriveReportStory(report) : null, [report]);
  const exportHtml = async () => {
    if (!report || !story || exporting) return;
    const token = generation.current; setExporting(true); setError(null);
    try {
      const api = await connectDesktopApi();
      if (!api.report) throw new Error('报告存储尚未接入。');
      const current = unwrap(await api.report.get({ kind, dateKey: selectedDate }));
      if (token !== generation.current) return;
      if (current.status !== 'ready' || !current.report || current.report.id !== report.id || current.report.sourceRevision !== report.sourceRevision || current.report.generatedAt !== report.generatedAt) {
        await refresh(); throw new Error('报告来源已变化，请重新生成后导出。');
      }
      const html = renderReportHtml(current.report), url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `one-room-${report.kind}-${dateKey(report.rangeStart)}.html`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { if (token === generation.current) setError(errorMessage(cause)); }
    finally { setExporting(false); }
  };
  return <section className="report-page page-content" aria-label="工作报告">
    <div className="report-toolbar"><div className="segmented-control" aria-label="报告类型">{(['daily', 'weekly'] as const).map(value => <button key={value} type="button" aria-pressed={kind === value} onClick={() => onKindChange(value)}>{value === 'daily' ? '日报' : '周报'}</button>)}</div>
      <input type="date" aria-label="报告日期" max={dateKey()} value={selectedDate} onChange={event => { if (event.target.value) onDateChange(event.target.value); }} />
      <div className="report-toolbar-actions"><button className="secondary-button" type="button" onClick={() => void generate()} disabled={!connected || busy || loading || exporting}>{busy ? <LoaderCircle size={15} className="is-spinning" /> : <FilePlus2 size={15} />}{busy ? '正在生成' : report ? '重新生成' : '生成事实报告'}</button>
        <button className="secondary-button" type="button" disabled={!report || busy || loading || exporting} onClick={() => void exportHtml()}>{exporting ? <LoaderCircle size={15} className="is-spinning" /> : <ArrowDownToLine size={15} />}导出 HTML</button></div></div>
    <p className="report-export-note">分享前请检查应用、对象和主题中是否包含敏感信息。</p>
    {error && <div className="inline-message is-error" role="alert">{error}</div>}
    <header className="report-intro"><div><p className="report-kicker">ONE ROOM · {kind === 'daily' ? 'DAILY REVIEW' : 'WEEKLY REVIEW'}</p><h2>{report ? kind === 'daily' ? '这一天，留下了这些记录' : '这一周，留下了这些记录' : kind === 'daily' ? '每日回顾' : '每周回顾'}</h2><p className="report-caption">{dateKey(range.rangeStart)}{kind === 'weekly' ? ` 至 ${dateKey(range.rangeEnd - 1)}` : ''}</p></div>
      <div className="segmented-control report-view-control" aria-label="报告视图"><button type="button" aria-pressed={view === 'review'} onClick={() => setView('review')}><Sparkles size={13} />回顾</button><button type="button" aria-pressed={view === 'facts'} onClick={() => setView('facts')}><List size={13} />事实</button></div>
    </header>
    <div className="report-metadata"><span>上海时间 · 完整{kind === 'daily' ? '日' : '周'}</span><span>{report?.periods.some(period => period.summary) ? '含活动总结' : '已捕获事实'}</span>{report && <span>生成于 {formatDateTime(report.generatedAt)}</span>}</div>
    {!report && <div className="report-empty" role="status">{loading ? '正在读取报告' : result?.status === 'invalidated' ? '来源已变更，报告已失效' : connected ? '暂无报告' : '报告存储尚未接入'}</div>}
    {report && story && <><dl className="report-totals"><div><dt>已记录</dt><dd>{formatDuration(story.totals.observedMs)}</dd>{story.first && <p className="report-first-line">最早可见区间：{kind === 'weekly' ? `${dateKey(story.first.timestamp).slice(5)} ` : ''}{formatTime(story.first.timestamp)} · {story.first.detail}</p>}</div><div><dt>明确缺口</dt><dd>{formatDuration(story.totals.gapMs)}</dd></div><div><dt>未覆盖</dt><dd>{formatDuration(story.totals.unknownMs)}</dd></div><div><dt>活动片段</dt><dd>{story.totalPeriods}<small>段</small></dd></div></dl>
      {!report.periods.length && <p className="report-empty" role="status">此范围没有记录</p>}
      <div className="report-review" hidden={view !== 'review'}>
        <section className="report-band report-distribution" aria-label="时间分配"><div className="report-band-heading"><div><span className="report-section-index">01</span><h3>时间，都去了哪里</h3></div><p>{story.totals.coverage === null ? '覆盖情况未知' : `记录覆盖 ${percent(story.totals.coverage)}`}</p></div>
          <div className="report-allocation-strip" role="img" aria-label={story.allocations.map(item => `${item.label} ${formatDuration(item.durationMs)}`).join('，') || '暂无应用时间记录'}>{story.allocations.map((item, index) => <span key={item.key} style={{ width: percent(item.share), backgroundColor: colors[index % colors.length] }} title={`${item.label} · ${formatDuration(item.durationMs)}`} />)}</div>
          <div className="report-allocation-list">{story.allocations.map((item, index) => <div key={item.key}><span className="report-app-dot" style={{ backgroundColor: colors[index % colors.length] }} /><span className="report-allocation-name">{item.label}</span><div className="report-allocation-bar"><span style={{ width: percent(item.share), backgroundColor: colors[index % colors.length] }} /></div><strong>{formatDuration(item.durationMs)}</strong><small>{percent(item.share)}</small></div>)}</div>
          {!story.allocations.length && <p className="report-neutral">此范围没有可分配的记录</p>}
        </section>
        <section className="report-band" aria-label="工作节奏"><div className="report-band-heading"><div><span className="report-section-index">02</span><h3>{kind === 'daily' ? '这一天的节奏' : '这一周的节奏'}</h3></div><p>{story.switchCount} 次应用切换</p></div>
          <div className="report-rhythm-axis" aria-hidden="true"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
          <div className="report-rhythm">{story.rhythm.map(day => {
            const bounds = dayBounds(day.dateKey);
            return <div className="report-rhythm-day" key={day.dateKey}><span className="report-rhythm-date">{day.dateKey.slice(5)}</span><div className="report-rhythm-track" role="img" aria-label={`${day.dateKey} 已记录 ${formatDuration(day.observedMs)}`}>{day.periods.map(period => {
              const index = Math.max(0, story.allocations.findIndex(item => item.key === period.appBundleId));
              return <span key={`${period.id}:${period.startTs}`} style={{ left: percent((period.startTs - bounds.rangeStart) / (bounds.rangeEnd - bounds.rangeStart)), width: percent(period.durationMs / (bounds.rangeEnd - bounds.rangeStart)), backgroundColor: colors[index % colors.length] }} title={`${formatTime(period.startTs)} – ${formatTime(period.endTs)} · ${period.appName} · ${period.objectLabel ?? '对象未知'}`} />;
            })}</div><strong>{formatDuration(day.observedMs)}</strong></div>;
          })}</div>
          <dl className="report-rhythm-summary"><div><dt><Clock3 size={13} />最早可见区间</dt><dd>{story.first ? formatDateTime(story.first.timestamp) : '未知'}</dd></div><div><dt><CalendarDays size={13} />可见记录截至</dt><dd>{story.last ? formatDateTime(story.last.timestamp) : '未知'}</dd></div><div><dt>最长可见片段</dt><dd>{story.longestPeriod ? `${story.longestPeriod.appName} · ${formatDuration(story.longestPeriod.durationMs)}` : '未知'}</dd></div></dl>
        </section>
        <section className="report-band" aria-label="关键记录"><div className="report-band-heading"><div><span className="report-section-index">03</span><h3>值得回看的工作线索</h3></div><p>{story.highlights.length} 条</p></div>
          <div className="report-highlights">{story.highlights.map((highlight, index) => <article key={`${highlight.periodId}:${index}`}><time>{kind === 'weekly' && <span>{dateKey(highlight.startTs).slice(5)}</span>}{formatTime(highlight.startTs)}</time><div><div className="report-highlight-title"><h4>{highlight.title}</h4><span>{basisLabels[highlight.basis]}</span></div><p>{highlight.detail}</p></div></article>)}</div>
          {!story.highlights.length && <p className="report-neutral">暂无可归纳的对象、主题或活动总结</p>}
        </section>
        <section className="report-band" aria-label="记录时刻"><div className="report-band-heading"><div><span className="report-section-index">04</span><h3>几个具体的时刻</h3></div></div><div className="report-moments">{story.moments.map((moment, index) => <article key={`${moment.timestamp}:${index}`}><span className="report-moment-number">{String(index + 1).padStart(2, '0')}</span><div><p className="report-moment-title">{moment.title}</p><time>{kind === 'weekly' ? formatDateTime(moment.timestamp) : formatTime(moment.timestamp)}</time><p>{moment.detail}</p><small>{basisLabels[moment.basis]}</small></div></article>)}</div>{!story.moments.length && <p className="report-neutral">此范围没有记录时刻</p>}</section>
      </div>
      <div className="report-facts" hidden={view !== 'facts'}><div className="report-band-heading"><div><List size={15} /><h3>按时序的事实</h3></div><p>来源版本 {report.sourceRevision}</p></div><div className="report-rows">{[...report.periods].sort((a, b) => a.startTs - b.startTs).map(p => <article key={`${p.id}:${p.startTs}`}><time>{dateKey(p.startTs)}<br />{formatTime(p.startTs, true)} – {formatTime(p.endTs, true)}</time><div><h3><i className={appTone(p.appBundleId)} />{p.appName}<small>{actionLabels[p.action ?? 'unknown']} · {activityLabels[p.activityType]}</small></h3>
        <p>{p.objectLabel ?? '对象未知'} · {p.topic ?? '主题未知'}</p><p className="report-period-summary">{p.summary ?? summaryLabels[p.summaryStatus]}</p>
        <details className="report-source"><summary>{basisLabels[p.basis]} · 来源版本 {p.revision}</summary><p>{p.windowTitle ?? '窗口未知'}</p></details></div><strong>{formatDuration(p.endTs - p.startTs)}</strong></article>)}</div>
      </div>
      <footer className="report-footnote"><span>ONE ROOM</span><span>来源版本 {report.sourceRevision} · 已记录事实与推断分别标注</span></footer></>}
    <button type="button" className="text-button report-refresh" onClick={() => void refresh()} disabled={busy || exporting}><RotateCcw size={14} />刷新</button>
  </section>;
}
