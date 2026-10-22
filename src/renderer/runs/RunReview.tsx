import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, FileCheck2, LoaderCircle, LockKeyhole, RefreshCw, Send, Square } from 'lucide-react';
import type { OneRoomApi } from '../../shared/contracts';
import type { DocumentTarget, RunView } from '../../shared/execution-schemas';
import { IconButton } from '../components/IconButton';
import { errorMessage, unwrap } from '../lib/desktop';
import { formatDateTime } from '../lib/time';

export const runStateLabels: Record<RunView['state'], string> = {
  preparing: '正在准备', awaiting_input_confirmation: '待审核输入', generating: '正在生成', awaiting_review: '待审核差异',
  applying: '正在写入', verifying: '正在核验', succeeded: '已完成', no_change: '无需修改', failed: '失败',
  canceled: '已取消', conflict: '文档冲突', interrupted: '已中断', capability_blocked: '能力未通过', expired: '审核已过期', source_invalidated: '来源已失效',
};
const activeStates = new Set<RunView['state']>(['preparing', 'awaiting_input_confirmation', 'generating', 'awaiting_review', 'applying', 'verifying']);
type Props = { api: OneRoomApi; runId: string; targets: DocumentTarget[]; codexReady: boolean; onChanged: () => void };

export function RunReview({ api, runId, targets, codexReady, onChanged }: Props) {
  const [run, setRun] = useState<RunView | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [inputConfirmed, setInputConfirmed] = useState(false), [diffConfirmed, setDiffConfirmed] = useState(false), [exclusiveConfirmed, setExclusiveConfirmed] = useState(false);
  const [target, setTarget] = useState<DocumentTarget | null>(null), [now, setNow] = useState(Date.now());
  const sequence = useRef(0);
  const targetFromList = targets.find(item => item.id === run?.targetId);
  useEffect(() => { setTarget(targetFromList ?? null); }, [targetFromList?.id, targetFromList?.revision, targetFromList?.exclusiveEditing]);

  const refresh = useCallback(async () => {
    if (!api.run) return;
    const request = ++sequence.current;
    try {
      const result = unwrap(await api.run.get({ runId }));
      if (request !== sequence.current) return;
      setRun(result);
    } catch (error) { if (request === sequence.current) setMessage({ text: errorMessage(error), error: true }); }
  }, [api.run, runId]);
  useEffect(() => {
    setRun(null); setInputConfirmed(false); setDiffConfirmed(false); setExclusiveConfirmed(false); setMessage(null);
    void refresh();
    return () => { sequence.current += 1; };
  }, [refresh]);
  useEffect(() => { setInputConfirmed(false); setDiffConfirmed(false); setExclusiveConfirmed(false); }, [run?.runId, run?.generation, run?.inputSnapshotHash, run?.proposalHash, run?.state]);
  useEffect(() => api.events.subscribe(event => {
    if (event.type === 'source.invalidated') {
      sequence.current += 1;
      setInputConfirmed(false); setDiffConfirmed(false); setExclusiveConfirmed(false);
      setRun(current => current ? { ...current, inputPreview: null, proposal: null, proposalHash: null, diff: null, approvalRef: null } : current);
      void refresh();
    } else if (event.type === 'run.changed' && (event.entityId === runId || event.runId === runId)) void refresh();
  }), [api.events, refresh, runId]);
  useEffect(() => {
    if (!run || !activeStates.has(run.state)) return;
    const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 1200);
    return () => clearInterval(timer);
  }, [run?.state, refresh]);

  const perform = async (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(name); setMessage(null);
    try { await action(); await refresh(); onChanged(); }
    catch (error) { setMessage({ text: errorMessage(error), error: true }); await refresh(); }
    finally { setBusy(null); }
  };
  if (!api.run) return null;
  if (!run) return <section className="document-section" aria-label="执行审核"><p className="subtle-text">正在读取任务…</p>{message && <p role="alert" className="document-message is-error">{message.text}</p>}</section>;
  const expired = now >= run.expiresAt, transaction = run.state === 'applying' || run.state === 'verifying';
  const cancelable = ['preparing', 'awaiting_input_confirmation', 'generating', 'awaiting_review'].includes(run.state);
  const execute = api.run;
  return <section className="document-section run-review" aria-label="执行审核" aria-busy={!!busy}>
    <header className="document-heading">
      <div><h2>执行审核</h2><p className="subtle-text">{target?.displayName ?? '已选文档'} · {formatDateTime(run.createdAt)}</p></div>
      <div className="document-toolbar"><span className={`document-status is-${run.state}`} role="status">{runStateLabels[run.state]}</span>
        <IconButton label="刷新任务" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={15} /></IconButton>
        {run.state === 'verifying' && <IconButton label="核验文件状态" disabled={!!busy} onClick={() => void perform('verify', async () => { unwrap(await execute.verify({ runId })); })}><FileCheck2 size={15} /></IconButton>}
        {(cancelable || transaction) && <IconButton label={transaction ? '文件事务期间不可取消' : '取消任务'} disabled={!!busy || transaction} onClick={() => void perform('cancel', async () => { unwrap(await execute.cancel({ runId, expectedGeneration: run.generation })); })}><Square size={14} /></IconButton>}
      </div>
    </header>
    {run.error && <p className="document-message is-error" role="alert">{run.error.message}</p>}
    {message && <p className={`document-message ${message.error ? 'is-error' : 'is-success'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    {run.state === 'awaiting_input_confirmation' && run.inputPreview !== null && <div className="document-review-step">
      <div className="document-heading"><h3>待发送输入</h3><span className="subtle-text">有效至 {formatDateTime(run.expiresAt)}</span></div>
      <pre className="document-preview" tabIndex={0} aria-label="完整待发送输入">{run.inputPreview}</pre>
      <label className="document-check"><input type="checkbox" checked={inputConfirmed} disabled={!!busy || expired} onChange={event => setInputConfirmed(event.target.checked)} /><span>允许将以上文字发送给 Codex</span></label>
      <div className="document-actions"><button type="button" className="primary-button" disabled={!!busy || !inputConfirmed || !codexReady || expired} title={!codexReady ? 'Codex 能力验证尚未通过' : undefined} onClick={() => void perform('propose', async () => {
        setInputConfirmed(false); unwrap(await execute.propose({ preparedRunId: runId, expectedInputHash: run.inputSnapshotHash, confirmed: true, idempotencyKey: crypto.randomUUID() }));
      })}>{busy === 'propose' ? <LoaderCircle size={15} className="is-spinning" /> : <Send size={15} />}发送给 Codex</button></div>
    </div>}
    {run.state === 'awaiting_review' && run.diff !== null && run.proposalHash && run.approvalRef && <div className="document-review-step">
      <div className="document-heading"><h3>待应用差异</h3><span className="subtle-text">有效至 {formatDateTime(run.expiresAt)}</span></div>
      <pre className="document-preview document-diff" tabIndex={0} aria-label="完整文档差异">{run.diff}</pre>
      <label className="document-check"><input type="checkbox" checked={diffConfirmed} disabled={!!busy || expired} onChange={event => setDiffConfirmed(event.target.checked)} /><span>批准按以上差异更新此章节</span></label>
      {!target?.exclusiveEditing && <div className="document-exclusive">
        <label className="document-check"><input type="checkbox" checked={exclusiveConfirmed} disabled={!!busy || expired || !target} onChange={event => setExclusiveConfirmed(event.target.checked)} /><span>已关闭外部编辑器，由 One Room 独占编辑此文档</span></label>
        <button type="button" className="secondary-button" disabled={!!busy || expired || !exclusiveConfirmed || !target || !api.target} onClick={() => void perform('exclusive', async () => {
          if (!target || !api.target) return;
          const updated = unwrap(await api.target.confirmExclusiveEditing({ targetId: target.id, expectedRevision: target.revision, confirmed: true }));
          setTarget(updated); setExclusiveConfirmed(false);
        })}><LockKeyhole size={15} />确认独占编辑</button>
      </div>}
      {target?.exclusiveEditing && <p className="document-readonly-status"><LockKeyhole size={13} />已确认独占编辑</p>}
      <div className="document-actions">
        <button type="button" className="secondary-button" disabled={!!busy || expired} onClick={() => void perform('export', async () => {
          const result = unwrap(await execute.exportPatch({ runId, expectedGeneration: run.generation, proposalHash: run.proposalHash!, idempotencyKey: crypto.randomUUID() }));
          if (result.exported) setMessage({ text: '补丁已导出。', error: false });
        })}><Download size={15} />导出补丁</button>
        <button type="button" className="primary-button" disabled={!!busy || expired || !diffConfirmed || !target?.exclusiveEditing} onClick={() => void perform('apply', async () => {
          setDiffConfirmed(false); unwrap(await execute.apply({ runId, expectedGeneration: run.generation, proposalHash: run.proposalHash!, expectedTargetHash: run.targetSnapshotHash,
            inputSnapshotHash: run.inputSnapshotHash, skillVersionId: run.skillVersionId, sourceRefs: run.sourceRefs, approvalRef: run.approvalRef!, confirmed: true, idempotencyKey: crypto.randomUUID() }));
        })}>{busy === 'apply' ? <LoaderCircle size={15} className="is-spinning" /> : <FileCheck2 size={15} />}应用已审核差异</button>
      </div>
    </div>}
    {['succeeded', 'no_change'].includes(run.state) && <p className="document-readonly-status"><Check size={15} />{run.state === 'no_change' ? '目标内容无需修改。' : '文档已写入并回读核验。'}</p>}
    {run.operationResult && <div className="document-operation-result" aria-label="文件操作结果">
      <p className="subtle-text">文件结果：{run.operationResult.applied === null ? '是否完成替换尚无法确认' : run.operationResult.applied ? '已执行文件替换' : '未应用文件替换'}</p>
      <dl><div><dt>阶段</dt><dd>{{ intent: '已保存更新记录', temporary_synced: '已保存候选文件', renamed: '已替换文件', directory_synced: '写入已落盘', verified: '已回读核验' }[run.operationResult.stage] ?? run.operationResult.stage}</dd></div>
        <div><dt>写入前 SHA-256</dt><dd>{run.operationResult.beforeHash}</dd></div><div><dt>预期结果 SHA-256</dt><dd>{run.operationResult.afterHash}</dd></div>
        <div><dt>当前 SHA-256</dt><dd>{run.operationResult.observedHash ?? '待核验'}</dd></div>
      </dl>
    </div>}
    <details className="document-metadata"><summary>任务记录</summary><dl>
      <div><dt>任务</dt><dd>{run.runId}</dd></div><div><dt>规则版本</dt><dd>{run.skillVersionId}</dd></div>
      <div><dt>输入 SHA-256</dt><dd>{run.inputSnapshotHash}</dd></div><div><dt>目标 SHA-256</dt><dd>{run.targetSnapshotHash}</dd></div>
      {run.proposalHash && <div><dt>提案 SHA-256</dt><dd>{run.proposalHash}</dd></div>}{run.operationId && <div><dt>文件操作</dt><dd>{run.operationId}</dd></div>}
    </dl></details>
  </section>;
}
