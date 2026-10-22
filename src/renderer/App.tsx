import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Blocks, CircleHelp, Compass, FileText, History, Settings2, ShieldCheck } from 'lucide-react';
import { CaptureSettings } from './settings/CaptureSettings';
import { TimelineView } from './timeline/TimelineView';
import { dateKey, dayBounds } from './lib/time';
import { fixtureEnabled } from './lib/desktop';
import { useDesktopState } from './lib/use-desktop-state';
import { EventReview } from './timeline/EventReview';
import { desktopApi } from './lib/desktop';
import { ReportView } from './reports/ReportView';
import { HistorySettings } from './settings/HistorySettings';
import { SopWorkbench } from './reuse/SopWorkbench';
import { DiscoveryNotice } from './reuse/DiscoveryNotice';
import { AgentSettings } from './settings/AgentSettings';
import { DocumentWorkbench } from './skills/DocumentWorkbench';
import type { Candidate } from '../services/reuse/types';

type Route = 'timeline' | 'reports' | 'discoveries' | 'skills' | 'settings';

const navigation = [
  { id: 'timeline', label: '时间线', icon: History },
  { id: 'reports', label: '报告', icon: FileText },
  { id: 'discoveries', label: '发现', icon: Compass },
  { id: 'skills', label: '流程', icon: Blocks },
  { id: 'settings', label: '设置', icon: Settings2 },
] as const;

const emptyPages = {
  discoveries: { title: '暂无发现', icon: Compass },
  skills: { title: '暂无流程', icon: Blocks },
} as const;

export function App() {
  const [route, setRoute] = useState<Route>('timeline');
  const [selectedDate, setSelectedDate] = useState(dateKey);
  const [cursorTs, setCursorTs] = useState(() => fixtureEnabled ? dayBounds(dateKey()).rangeStart + 9 * 3_600_000 + 300_000 : Date.now());
  const [reportKind, setReportKind] = useState<'daily' | 'weekly'>('daily');
  const [reportDate, setReportDate] = useState(dateKey);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [documentCandidate, setDocumentCandidate] = useState<Candidate | null>(null);
  const [workflowView, setWorkflowView] = useState<'document' | 'workflow'>('workflow');
  const positions = useRef(new Map<string, number>());
  const currentSelection = useRef({ selectedDate, cursorTs });
  currentSelection.current = { selectedDate, cursorTs };
  const { snapshot, loading, error, refresh } = useDesktopState();
  const routeLabel = navigation.find((item) => item.id === route)?.label;
  const captureState = snapshot?.status.capture.state;
  const captureLabel = captureState === 'running' ? '正在采集' : captureState === 'paused' ? '采集已暂停' : captureState === 'error' ? '采集异常' : '采集未就绪';
  const emptyPage = route === 'discoveries' || route === 'skills' ? emptyPages[route] : null;
  const reuseApi = fixtureEnabled ? undefined : window.oneRoom?.reuse;
  const executionApi = fixtureEnabled ? undefined : window.oneRoom;

  useEffect(() => {
    if (!import.meta.env.DEV || !fixtureEnabled) return;
    let active = true;
    void import('../shared/fixtures/worklog').then(({ FIXTURE_DATE_KEY, FIXTURE_START }) => {
      if (!active) return;
      setSelectedDate(FIXTURE_DATE_KEY);
      setCursorTs(FIXTURE_START + 300_000);
      setReportDate(FIXTURE_DATE_KEY);
    });
    return () => { active = false; };
  }, []);

  const selectDate = useCallback((nextDate: string) => {
    positions.current.set(currentSelection.current.selectedDate, currentSelection.current.cursorTs);
    setSelectedDate(nextDate);
    setCursorTs(positions.current.get(nextDate) ?? dayBounds(nextDate).rangeStart + (fixtureEnabled ? 9 * 3_600_000 + 300_000 : 12 * 3_600_000));
  }, []);
  const selectCursor = useCallback((timestamp: number) => {
    const nextDate = dateKey(timestamp);
    positions.current.set(currentSelection.current.selectedDate, currentSelection.current.cursorTs);
    positions.current.set(nextDate, timestamp);
    setSelectedDate(nextDate);
    setCursorTs(timestamp);
  }, []);
  const openReport = useCallback((kind: 'daily' | 'weekly', key: string) => { setReportKind(kind); setReportDate(key); setRoute('reports'); }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand"><span className="brand-symbol"><Activity size={19} strokeWidth={2.2} /></span><span>One Room</span></div>
        <nav>{navigation.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={`nav-item ${route === id ? 'is-active' : ''}`} aria-current={route === id ? 'page' : undefined} title={label} onClick={() => setRoute(id)}><Icon size={18} strokeWidth={1.7} /><span>{label}</span></button>)}</nav>
        <div className="sidebar-bottom">
          <div className="local-only"><ShieldCheck size={15} /><span>{fixtureEnabled ? '测试数据' : '本机存储'}</span></div>
          <button type="button" className="capture-status" onClick={() => setRoute('settings')} title="查看采集设置"><span className={`status-dot ${captureState === 'running' ? 'is-active' : ''}`} /><span>{snapshot ? captureLabel : loading ? '连接中' : '桌面未连接'}</span><ArrowRight size={13} /></button>
          <span className="app-version">{snapshot ? `v${snapshot.status.appVersion}` : 'One Room'}</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="app-header"><div><h1>{routeLabel}</h1>{route === 'timeline' && <span className="header-context">工作回顾</span>}</div><div className="header-status"><span className={`status-dot ${snapshot?.status.storage.state === 'ready' ? 'is-active' : ''}`} />{fixtureEnabled ? '测试连接' : snapshot?.status.storage.state === 'ready' ? '本地已连接' : loading ? '连接中' : '未连接'}</div></header>
        <main>
          {snapshot && reuseApi && <DiscoveryNotice api={reuseApi} onOpen={() => setRoute('discoveries')} />}
          {fixtureEnabled && <div className="fixture-banner" role="status">测试数据 · 独立开发模式 · 不写入本机历史</div>}
          {error && <div className="connection-error" role="alert"><CircleHelp size={16} /><span>{error}</span><button className="text-button" type="button" onClick={() => void refresh()} disabled={loading}>重新连接</button></div>}
          <div hidden={route !== 'timeline'}><TimelineView active={route === 'timeline'} selectedDate={selectedDate} cursorTs={cursorTs} onDateChange={selectDate} onCursorChange={selectCursor} onOpenSettings={() => setRoute('settings')} onOpenReports={openReport} />
            {snapshot && !fixtureEnabled && <details className="activity-review-drawer" onToggle={event => setReviewOpen(event.currentTarget.open)}><summary>活动校正</summary>{reviewOpen && <EventReview api={desktopApi().activity} />}</details>}</div>
          {route === 'reports' && <ReportView selectedDate={reportDate} kind={reportKind} onDateChange={setReportDate} onKindChange={setReportKind} />}
          {route === 'settings' && <><CaptureSettings snapshot={snapshot} loading={loading} refresh={refresh} /><div className="page-content history-content">{executionApi?.agent && <AgentSettings api={executionApi.agent} />}<HistorySettings selectedDate={selectedDate} /></div></>}
          {route === 'skills' && executionApi?.run && reuseApi && <div className="workflow-view-switch"><div className="segmented-control" aria-label="流程类型"><button type="button" aria-pressed={workflowView === 'workflow'} onClick={() => setWorkflowView('workflow')}><Blocks size={14} />操作流程</button><button type="button" aria-pressed={workflowView === 'document'} onClick={() => setWorkflowView('document')}><FileText size={14} />文档更新</button></div></div>}
          {route === 'skills' && executionApi?.run && workflowView === 'document' && <DocumentWorkbench api={executionApi} candidate={documentCandidate} onCandidateUsed={() => setDocumentCandidate(null)} />}
          {(route === 'discoveries' || (route === 'skills' && workflowView === 'workflow')) && reuseApi && <SopWorkbench api={reuseApi} onLocalSkill={candidate => { setDocumentCandidate(candidate); setWorkflowView('document'); setRoute('skills'); }} />}
          {emptyPage && !reuseApi && <div className="placeholder-page"><emptyPage.icon size={32} strokeWidth={1.3} /><h2>{emptyPage.title}</h2></div>}
        </main>
      </div>
    </div>
  );
}
