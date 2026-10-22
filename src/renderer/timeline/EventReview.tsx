import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import type { OneRoomApi } from '../../shared/contracts';
import type { Activity } from '../../shared/activity-schemas';
import { IconButton } from '../components/IconButton';
import { errorMessage, unwrap } from '../lib/desktop';
import { formatDateTime } from '../lib/time';

type Props = { api: NonNullable<OneRoomApi['activity']> };
type Draft = Pick<Activity, 'action' | 'activityType'> & { objectLabel: string; topic: string };

const actionLabels = { view: '查看', suspected_edit: '疑似编辑', context_switch: '切换窗口', unknown: '未知' } as const;
const typeLabels = { direct_chat: '私聊', group_chat: '群聊', meeting: '会议', document: '文档', business: '业务操作', unknown: '未知' } as const;
const basisLabels = { observed: '观察事实', inferred: '推断', confirmed: '人工确认' } as const;
const analysisLabels = { not_authorized: '未授权分析', not_configured: '模型待配置', pending: '分析中', ready: '已分析', failed: '分析失败', insufficient: '信息不足' } as const;
const textLabels: Record<string, string> = { pending: '提取中', ready: '已提取', excluded: '已排除', failed: '提取失败', empty: '无可用文字', unavailable: '无可用文字', insufficient: '信息不足' };
const fieldStyle = { minWidth: 0, width: '100%', padding: '8px', border: '1px solid #d8e1da', borderRadius: 4, background: '#fff', color: 'inherit', font: 'inherit' } as const;

function makeDraft(activity: Activity): Draft {
  return { action: activity.action, activityType: activity.activityType, objectLabel: activity.objectLabel ?? '', topic: activity.topic ?? '' };
}

export function EventReview({ api }: Props) {
  const [items, setItems] = useState<Activity[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ action: 'unknown', activityType: 'unknown', objectLabel: '', topic: '' });
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const request = useRef(0);
  const mounted = useRef(true);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const load = useCallback(async (before?: number) => {
    const currentRequest = ++request.current;
    setLoading(true);
    try {
      const page = unwrap(await api.query({ limit: 30, ...(before === undefined ? {} : { before }) }));
      if (!mounted.current || currentRequest !== request.current) return false;
      setItems((current) => before === undefined ? page.items : [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setSelectedId((current) => before === undefined && !page.items.some((item) => item.id === current) ? page.items[0]?.id ?? null : current);
      setNextBefore(page.nextBefore);
      return true;
    } catch (error) {
      if (mounted.current && currentRequest === request.current) setMessage({ error: true, text: errorMessage(error) });
      return false;
    } finally {
      if (mounted.current && currentRequest === request.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; request.current += 1; };
  }, [load]);

  useEffect(() => {
    if (selected) setDraft(makeDraft(selected));
  }, [selected]);

  const save = async () => {
    if (!selected || loading || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      unwrap(await api.review({ id: selected.id, expectedRevision: selected.revision, action: draft.action, activityType: draft.activityType, objectLabel: draft.objectLabel.trim() || null, topic: draft.topic.trim() || null, confirmed: true }));
      if (!mounted.current) return;
      const refreshed = await load();
      if (mounted.current && refreshed) setMessage({ error: false, text: '活动已确认。' });
    } catch (error) {
      if (mounted.current) setMessage({ error: true, text: errorMessage(error) });
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return <section className="page-content" aria-labelledby="activity-review-title">
    <div className="section-heading"><h2 id="activity-review-title">活动校正</h2><IconButton label="刷新活动" disabled={loading || saving} onClick={() => { setMessage(null); void load(); }}><RefreshCw size={16} className={loading ? 'is-spinning' : ''} /></IconButton></div>
    {message && <p role={message.error ? 'alert' : 'status'} className={`inline-message ${message.error ? 'is-error' : 'is-success'}`}>{message.text}</p>}
    {items.length === 0 && <p className="subtle-text">{loading ? '正在读取活动' : '暂无活动'}</p>}
    {items.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 24 }}>
      <div style={{ minWidth: 0 }}>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 500, overflowY: 'auto' }} aria-label="最近活动">
          {items.map((item) => <li key={item.id} style={{ borderBottom: '1px solid #e1e7e2' }}><button type="button" disabled={saving} aria-pressed={selectedId === item.id} onClick={() => { setSelectedId(item.id); setMessage(null); }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, width: '100%', textAlign: 'left', padding: 12, border: 0, borderLeft: selectedId === item.id ? '3px solid #236d4b' : '3px solid transparent', background: selectedId === item.id ? '#eff2ef' : 'transparent', color: 'inherit', cursor: 'pointer', overflowWrap: 'anywhere' }}><span>{item.appName} · {actionLabels[item.action]}</span><span className="subtle-text">{item.objectLabel ?? item.windowTitle ?? '未知对象'}</span><small className="subtle-text">{formatDateTime(item.observedAt)} · {basisLabels[item.basis]}</small></button></li>)}
        </ul>
        {nextBefore !== null && <button className="text-button" type="button" disabled={loading || saving} onClick={() => void load(nextBefore)}><ChevronDown size={16} />更早活动</button>}
      </div>
      {selected && <div style={{ minWidth: 0 }}>
        <dl className="compact-metadata"><div><dt>时间</dt><dd>{formatDateTime(selected.observedAt)}</dd></div><div><dt>依据</dt><dd>{basisLabels[selected.basis]}</dd></div><div><dt>文字来源</dt><dd>{selected.extractionSource === 'accessibility' ? '无障碍树' : selected.extractionSource === 'ocr' ? '本地 OCR' : '无'}</dd></div><div><dt>状态</dt><dd>{textLabels[selected.textStatus] ?? selected.textStatus} · {analysisLabels[selected.analysisStatus]}</dd></div></dl>
        <div className="scope-fields">
          <label className="field-label">行为<select style={fieldStyle} value={draft.action} disabled={saving} onChange={(event) => setDraft((value) => ({ ...value, action: event.target.value as Activity['action'] }))}>{Object.entries(actionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="field-label">类型<select style={fieldStyle} value={draft.activityType} disabled={saving} onChange={(event) => setDraft((value) => ({ ...value, activityType: event.target.value as Activity['activityType'] }))}>{Object.entries(typeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="field-label">对象<input style={fieldStyle} value={draft.objectLabel} maxLength={512} disabled={saving} onChange={(event) => setDraft((value) => ({ ...value, objectLabel: event.target.value }))} /></label>
          <label className="field-label">主题<input style={fieldStyle} value={draft.topic} maxLength={512} disabled={saving} onChange={(event) => setDraft((value) => ({ ...value, topic: event.target.value }))} /></label>
        </div>
        {selected.summary && <p style={{ overflowWrap: 'anywhere' }}>{selected.summary}</p>}
        <div className="settings-actions"><button className="primary-button" type="button" disabled={saving || loading} onClick={() => void save()}><Check size={16} />{saving ? '保存中' : '确认活动'}</button></div>
        <label className="field-label" style={{ marginTop: 16 }}>提取文字<textarea readOnly rows={8} value={selected.text ?? ''} placeholder="无可用文字" style={{ width: '100%', minWidth: 0, resize: 'vertical' }} /></label>
      </div>}
    </div>}
  </section>;
}
