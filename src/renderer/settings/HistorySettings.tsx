import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { MethodOutput } from '../../shared/contracts';
import { connectDesktopApi, errorMessage, unwrap } from '../lib/desktop';
import { dayBounds, moveDay } from '../lib/time';

export function HistorySettings({ selectedDate }: { selectedDate: string }) {
  const [start, setStart] = useState(selectedDate), [end, setEnd] = useState(moveDay(selectedDate, 1));
  const [preview, setPreview] = useState<MethodOutput<'history.previewDelete'> | null>(null);
  const [confirmed, setConfirmed] = useState(false), [available, setAvailable] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void connectDesktopApi().then(api => { if (active) setAvailable(!!api.history); }).catch(() => undefined); return () => { active = false; }; }, []);
  const reset = () => { setPreview(null); setConfirmed(false); setMessage(null); setError(null); };
  const run = async (apply: boolean) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const api = await connectDesktopApi();
      if (!api.history) throw new Error('历史删除存储尚未接入。');
      if (!apply) setPreview(unwrap(await api.history.previewDelete({ rangeStart: dayBounds(start).rangeStart, rangeEnd: dayBounds(end).rangeStart })));
      else if (preview && confirmed) {
        const result = unwrap(await api.history.delete({ deletionRef: preview.deletionRef, expectedRevision: preview.dataRevision, confirmed: true, idempotencyKey: crypto.randomUUID() }));
        reset(); setMessage(result.cleanup === 'complete' ? '所选历史已删除' : '来源已失效，正在清理图片');
      }
    } catch (cause) { setError(errorMessage(cause)); setPreview(null); setConfirmed(false); }
    finally { setBusy(false); }
  };
  return <section className="settings-section history-settings" aria-label="删除历史">
    <h3>删除历史</h3><div className="history-range"><label>开始日期<input aria-label="删除开始日期" type="date" value={start} disabled={busy} onChange={e => { reset(); setStart(e.target.value); }} /></label>
      <label>结束日期（不含）<input aria-label="删除结束日期" type="date" value={end} disabled={busy} onChange={e => { reset(); setEnd(e.target.value); }} /></label>
      <button type="button" className="secondary-button" disabled={!available || busy || !start || !end || end <= start} onClick={() => void run(false)}>预览删除</button></div>
    {!available && <span className="subtle-text">历史删除尚未接入</span>}
    {preview && <div className="delete-preview"><p>{preview.observationCount} 条观察 · {preview.periodCount} 个片段 · {preview.reportCount} 份报告</p>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />确认删除所选历史及关联内容</label>
      <button type="button" className="secondary-button danger-button" disabled={!confirmed || busy} onClick={() => void run(true)}><Trash2 size={14} />删除历史</button></div>}
    {error && <p role="alert" className="history-error">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
