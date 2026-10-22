import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, LoaderCircle, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import type { OneRoomApi } from '../../shared/contracts';
import type { AgentCapabilityView } from '../../shared/execution-schemas';
import { errorMessage, unwrap } from '../lib/desktop';
import { formatDateTime } from '../lib/time';

type Props = { api: NonNullable<OneRoomApi['agent']> };
const authLabels: Record<AgentCapabilityView['authState'], string> = {
  ready: '已登录', missing: '未登录', unknown: '待验证',
};
const capabilityLabels: Record<AgentCapabilityView['capability'], string> = {
  not_checked: '尚未验证', checking: '验证中', passed: '已通过', blocked: '未通过',
};

export function AgentSettings({ api }: Props) {
  const [agents, setAgents] = useState<AgentCapabilityView[]>([]);
  const [pending, setPending] = useState<'load' | 'check' | 'test' | null>('load');
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const current = ++epoch.current;
    setPending('load');
    setConfirmed(false);
    void api.getStatus({}).then((reply) => {
      if (current === epoch.current) setAgents(unwrap(reply));
    }).catch((error) => {
      if (current === epoch.current) setMessage({ text: errorMessage(error), error: true });
    }).finally(() => {
      if (current === epoch.current) setPending(null);
    });
    return () => { epoch.current += 1; };
  }, [api]);

  const perform = async (kind: 'check' | 'test') => {
    if (pending || (kind === 'test' && !confirmed)) return;
    const current = ++epoch.current;
    setPending(kind);
    setMessage(null);
    if (kind === 'test') setConfirmed(false);
    try {
      const result = unwrap(kind === 'check'
        ? await api.check({ provider: 'codex' })
        : await api.testCapability({ provider: 'codex', confirmed: true }));
      if (current !== epoch.current) return;
      setAgents(result);
      if (kind === 'test') {
        const codex = result.find((agent) => agent.provider === 'codex');
        setMessage({ text: codex?.capability === 'passed' ? 'Codex 合成能力验证已通过。' : codex?.reason || 'Codex 合成能力验证未通过。', error: codex?.capability !== 'passed' });
      }
    } catch (error) {
      if (current === epoch.current) setMessage({ text: errorMessage(error), error: true });
    } finally {
      if (current === epoch.current) setPending(null);
    }
  };

  const codex = agents.find((agent) => agent.provider === 'codex');
  const busy = pending !== null;
  const testAvailable = !!codex?.installed && codex.authState === 'ready';

  return <section className="settings-section agent-settings" aria-label="Agent 设置" aria-busy={busy}>
    <div className="section-heading"><h3>Agent</h3><span className="agent-option is-disabled" aria-disabled="true">Claude <small>暂未接入</small></span></div>
    <div className="setting-row">
      <div>
        <h4>Codex</h4>
        <p className="status-line">{pending === 'load' ? <LoaderCircle size={14} className="is-spinning" /> : codex?.installed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{pending === 'load' ? '正在读取状态' : codex?.installed ? '已安装' : '未检测到'}</p>
      </div>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform('check')} title="检查本机安装和认证状态">
        {pending === 'check' ? <LoaderCircle size={15} className="is-spinning" /> : <RefreshCw size={15} />}检测 Codex
      </button>
    </div>
    <dl className="compact-metadata">
      <div><dt>CLI 版本</dt><dd>{codex?.version || '未知'}</dd></div>
      <div><dt>认证</dt><dd>{codex ? authLabels[codex.authState] : '待验证'}</dd></div>
      <div><dt>执行能力</dt><dd>{pending === 'test' ? '验证中' : codex ? capabilityLabels[codex.capability] : '尚未验证'}</dd></div>
    </dl>
    {codex?.reason && <p className="subtle-text">{codex.reason}</p>}
    {codex?.checkedAt != null && <p className="subtle-text">最近能力验证：{formatDateTime(codex.checkedAt)}</p>}
    <label className="consent-confirmation">
      <input type="checkbox" aria-label="同意 Codex 合成能力测试" checked={confirmed} disabled={busy || !testAvailable} onChange={(event) => setConfirmed(event.target.checked)} />
      <span>同意向 Codex 发送合成测试材料，可能产生用量费用</span>
    </label>
    <div className="settings-actions">
      <button type="button" className="secondary-button" disabled={busy || !testAvailable || !confirmed} onClick={() => void perform('test')}>
        {pending === 'test' ? <LoaderCircle size={15} className="is-spinning" /> : codex?.capability === 'passed' ? <ShieldCheck size={15} /> : <FlaskConical size={15} />}合成能力验证
      </button>
    </div>
    {message && <p className={`inline-message ${message.error ? 'is-error' : 'is-success'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
  </section>;
}
