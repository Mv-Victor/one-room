import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, LoaderCircle, Pause, Play, RefreshCw, Save, ShieldCheck, XCircle } from 'lucide-react';
import { IconButton } from '../components/IconButton';
import { desktopApi, errorMessage, unwrap, type DesktopSnapshot } from '../lib/desktop';
import { formatDateTime } from '../lib/time';
import { ModelSettings } from './ModelSettings';

type Props = {
  snapshot: DesktopSnapshot | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const permissionLabels = {
  screen: '屏幕录制',
  accessibility: '辅助功能',
  inputMonitoring: '输入监控',
} as const;

const permissionStatusLabels = {
  unknown: '未知',
  not_determined: '尚未授权',
  granted: '已授权',
  denied: '未授权',
  restricted: '受系统限制',
  not_required: '无需此权限',
} as const;

const captureStateLabels = {
  paused: '已暂停',
  blocked: '采集未就绪',
  running: '正在采集',
  stopped: '已停止',
  error: '采集异常',
} as const;

const reasonLabels: Record<string, string> = {
  paused: '已暂停', excluded: '当前应用不在采集范围', locked: '屏幕已锁定', sleep: '电脑已休眠',
  permission: '系统权限不足，请授权后继续', capture_error: '窗口截图失败，将在下一事件重试',
  visibility_unknown: '无法确认窗口完整可见', process_interrupted: '原生连接中断，请重新开始采集', queue_overflow: '采集队列已满',
  capture_not_connected: '采集器尚未接入',
  helper_unavailable: '原生助手未就绪',
  permission_not_granted: '未检测到授权',
  DEVELOPMENT_FIXTURE: '独立测试模式',
};

function bundleIds(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function CaptureSettings({ snapshot, loading, refresh }: Props) {
  const [allowed, setAllowed] = useState('');
  const [excluded, setExcluded] = useState('');
  const [textAllowed, setTextAllowed] = useState('');
  const [textConfirmed, setTextConfirmed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const loadedRevision = useRef<number | null>(null);
  const settings = snapshot?.settings;

  useEffect(() => {
    if (!settings || loadedRevision.current === settings.revision) return;
    loadedRevision.current = settings.revision;
    setAllowed(settings.allowedBundleIds.join('\n'));
    setExcluded(settings.excludedBundleIds.join('\n'));
    setTextAllowed(settings.textConsent.allowedBundleIds.join('\n'));
    setTextConfirmed(false);
  }, [settings]);

  const perform = async (key: string, action: () => Promise<unknown>, success: string) => {
    setPending(key);
    setMessage(null);
    try {
      await action();
      await refresh();
      setMessage({ text: success, error: false });
    } catch (error) {
      setMessage({ text: errorMessage(error), error: true });
    } finally {
      setPending(null);
    }
  };

  const capture = snapshot?.status.capture;
  const dirty = settings && (
    bundleIds(allowed).join('\n') !== settings.allowedBundleIds.join('\n') ||
    bundleIds(excluded).join('\n') !== settings.excludedBundleIds.join('\n')
  );
  const textScope = bundleIds(textAllowed);
  const textScopeValid = !!settings && textScope.length > 0 && textScope.every((id) => settings.allowedBundleIds.includes(id) && !settings.excludedBundleIds.includes(id));
  const textScopeChanged = !!settings && textScope.join('\n') !== settings.textConsent.allowedBundleIds.join('\n');

  const updateTextConsent = (enabled: boolean) => {
    if (!settings) return;
    void perform('textConsent', async () => unwrap(await desktopApi().settings.updateTextConsent({
      expectedRevision: settings.revision, enabled,
      allowedBundleIds: enabled ? textScope : settings.textConsent.allowedBundleIds,
      confirmed: enabled ? textConfirmed : false,
    })), enabled ? '后台文字授权已保存' : '后台文字分析已关闭');
  };

  return (
    <div className="settings-page page-content">
      <div className="section-heading">
        <h2>采集</h2>
        <IconButton label="重新检查状态" onClick={() => void refresh()} disabled={loading || !!pending}><RefreshCw size={16} className={loading ? 'is-spinning' : ''} /></IconButton>
      </div>
      <section className="settings-section">
        <div className="setting-row">
          <div>
            <h3>本机采集</h3>
            <p className="status-line"><span className={`status-dot ${capture?.state === 'running' ? 'is-active' : ''}`} />{capture ? captureStateLabels[capture.state] : '正在连接'}</p>
            {capture?.reason && capture.reason !== capture.state && <p className="subtle-text">{reasonLabels[capture.reason] ?? capture.reason}</p>}
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={!capture || !!pending}
            onClick={() => {
              if (!capture) return;
              const running = settings?.captureEnabled ?? false;
              void perform('capture', async () => unwrap(await desktopApi().capture[running ? 'pause' : 'resume']({ expectedRevision: capture.revision })), running ? '采集已暂停' : '采集已恢复');
            }}
          >
            {pending === 'capture' ? <LoaderCircle size={16} className="is-spinning" /> : settings?.captureEnabled ? <Pause size={16} /> : <Play size={16} />}
            {settings?.captureEnabled ? '暂停采集' : '继续采集'}
          </button>
        </div>
        <dl className="compact-metadata">
          <div><dt>最近成功</dt><dd>{formatDateTime(capture?.lastSuccessfulAt)}</dd></div>
          <div><dt>截图保留</dt><dd>30 天</dd></div>
          <div><dt>数据库</dt><dd>{snapshot?.status.storage.state === 'ready' ? '已就绪' : snapshot?.status.storage.state === 'failed' ? '异常' : '等待连接'}</dd></div>
        </dl>
      </section>

      <section className="settings-section">
        <div className="section-heading"><h3>应用范围</h3><span className="subtle-text">排除优先</span></div>
        <div className="scope-fields">
          <label className="field-label">允许的应用 Bundle ID<textarea rows={4} value={allowed} onChange={(event) => setAllowed(event.target.value)} placeholder="com.apple.Safari" spellCheck={false} disabled={!settings || !!pending} /></label>
          <label className="field-label">排除的应用 Bundle ID<textarea rows={4} value={excluded} onChange={(event) => setExcluded(event.target.value)} placeholder="com.apple.systempreferences" spellCheck={false} disabled={!settings || !!pending} /></label>
        </div>
        <div className="settings-actions">
          <button className="primary-button" type="button" disabled={!settings || !dirty || !!pending} onClick={() => {
            if (!settings) return;
            void perform('scope', async () => unwrap(await desktopApi().settings.updateCaptureScope({ expectedRevision: settings.revision, allowedBundleIds: bundleIds(allowed), excludedBundleIds: bundleIds(excluded) })), '应用范围已保存');
          }}><Save size={16} />保存范围</button>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-heading"><h3>系统权限</h3><ShieldCheck size={17} className="muted-icon" /></div>
        <div className="permission-list">
          {(Object.keys(permissionLabels) as (keyof typeof permissionLabels)[]).map((kind) => {
            const permission = snapshot?.permissions[kind];
            const granted = permission?.status === 'granted' || permission?.status === 'not_required';
            return <div className="permission-row" key={kind}>
              <div className="permission-name"><span>{permissionLabels[kind]}</span><small>{permission?.responsibleProcess ?? '等待检测'}</small>{permission?.reason && <small>{reasonLabels[permission.reason] ?? permission.reason}</small>}</div>
              <span className={`permission-status ${granted ? 'is-granted' : ''}`}>{granted ? <CheckCircle2 size={15} /> : <XCircle size={15} />}{permission ? permissionStatusLabels[permission.status] : '未知'}</span>
              <IconButton label={`申请${permissionLabels[kind]}权限并打开系统设置`} disabled={!snapshot || !!pending} onClick={() => void perform(kind, async () => {
                const result = unwrap(await desktopApi().permissions.openSettings({ kind }));
                if (!result.opened) throw new Error('系统设置未打开。');
              }, `已申请权限，请在系统设置中授权 ${permission?.responsibleProcess ?? 'One Room'}，然后重新检查状态`)}>{pending === kind ? <LoaderCircle size={16} className="is-spinning" /> : <ExternalLink size={16} />}</IconButton>
            </div>;
          })}
        </div>
      </section>

      <section className="settings-section">
        <div className="setting-row"><div><h3>后台文字分析</h3><p className="subtle-text">仅发送提取文字，截图不上传。</p></div><label className="consent-toggle"><input aria-label="后台文字分析" role="switch" type="checkbox" checked={settings?.textConsent.enabled ?? false} disabled={!settings || !!pending || (!settings.textConsent.enabled && (!textScopeValid || !textConfirmed))} onChange={(event) => updateTextConsent(event.target.checked)} /><span>{settings?.textConsent.enabled ? '已开启' : '关闭'}</span></label></div>
        <label className="field-label consent-scope-field">授权应用 Bundle ID<textarea rows={3} value={textAllowed} onChange={(event) => { setTextAllowed(event.target.value); setTextConfirmed(false); }} placeholder="com.apple.Safari" spellCheck={false} disabled={!settings || !!pending} /></label>
        <p className="subtle-text consent-current-scope">当前采集允许范围：{settings?.allowedBundleIds.filter((id) => !settings.excludedBundleIds.includes(id)).join('、') || '未配置'}</p>
        <label className="consent-confirmation"><input aria-label="确认发送授权范围的提取文字" type="checkbox" checked={textConfirmed} disabled={!settings || !!pending || !textScopeValid} onChange={(event) => setTextConfirmed(event.target.checked)} /><span>确认向所配模型发送以上应用的提取文字</span></label>
        {settings?.textConsent.enabled && <div className="settings-actions"><button className="primary-button" type="button" disabled={!!pending || !textScopeValid || !textScopeChanged || !textConfirmed} onClick={() => updateTextConsent(true)}><Save size={16} />保存文字范围</button></div>}
      </section>
      {snapshot && <ModelSettings api={desktopApi().model} textConsentEnabled={settings?.textConsent.enabled ?? false} disabled={!!pending} onConfigChange={() => void refresh()} />}
      <section className="settings-section"><div className="setting-row"><div><h3>Agent</h3></div><div className="agent-options"><span className="agent-option">Codex <small>尚未接入</small></span><span className="agent-option is-disabled" aria-disabled="true">Claude <small>暂未接入</small></span></div></div></section>
      {message && <p role={message.error ? 'alert' : 'status'} className={`inline-message ${message.error ? 'is-error' : 'is-success'}`}>{message.text}</p>}
    </div>
  );
}
