import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, LoaderCircle, PlugZap, Save, Trash2 } from 'lucide-react';
import type { Reply } from '../../shared/contracts';
import type {
  ModelConnectionResult, ModelRevisionInput, ModelSettings as ModelSettingsValue, SaveModelSettings,
} from '../../shared/model-schemas';
import { errorMessage, unwrap } from '../lib/desktop';

export interface ModelSettingsApi {
  getConfig(input: Record<string, never>): Promise<Reply<ModelSettingsValue>>;
  saveConfig(input: SaveModelSettings): Promise<Reply<ModelSettingsValue>>;
  clearCredential(input: ModelRevisionInput): Promise<Reply<ModelSettingsValue>>;
  testConnection(input: ModelRevisionInput): Promise<Reply<ModelConnectionResult>>;
}

export type ModelSettingsProps = {
  api: ModelSettingsApi;
  textConsentEnabled: boolean;
  disabled?: boolean;
  onConfigChange?: (config: ModelSettingsValue) => void;
};

export function ModelSettings({ api, textConsentEnabled, disabled = false, onConfigChange }: ModelSettingsProps) {
  const [config, setConfig] = useState<ModelSettingsValue | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState<'load' | 'save' | 'clear' | 'test' | null>('load');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const acceptConfig = useCallback((value: ModelSettingsValue) => {
    setConfig(value);
    setBaseUrl(value.baseUrl);
    setModel(value.model);
  }, []);

  useEffect(() => {
    let active = true;
    setPending('load');
    void api.getConfig({}).then((reply) => {
      if (active) acceptConfig(unwrap(reply));
    }).catch((error) => {
      if (active) setMessage({ text: errorMessage(error), error: true });
    }).finally(() => { if (active) setPending(null); });
    return () => { active = false; };
  }, [api, acceptConfig]);

  const changed = !!config && (baseUrl.trim() !== config.baseUrl || model.trim() !== config.model || !!apiKey.trim());
  const busy = disabled || pending !== null;

  const perform = async (kind: 'save' | 'clear' | 'test') => {
    if (!config) return;
    setPending(kind);
    setMessage(null);
    try {
      if (kind === 'test') {
        const result = unwrap(await api.testConnection({ expectedRevision: config.revision }));
        acceptConfig(result.settings);
        onConfigChange?.(result.settings);
        setMessage({ text: `${result.message}${result.ok ? ` ${result.latencyMs} ms` : ''}`, error: !result.ok });
      } else {
        const value = kind === 'save'
          ? unwrap(await api.saveConfig({ expectedRevision: config.revision, baseUrl: baseUrl.trim(), model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }))
          : unwrap(await api.clearCredential({ expectedRevision: config.revision }));
        acceptConfig(value);
        setApiKey('');
        onConfigChange?.(value);
        setMessage({ text: kind === 'save' ? '模型配置已保存。' : 'API Key 已清除。', error: false });
      }
    } catch (error) { setMessage({ text: errorMessage(error), error: true }); }
    finally { setPending(null); }
  };

  return (
    <section className="settings-section model-settings">
      <div className="section-heading"><h3>模型服务</h3><span className="subtle-text">OpenAI 兼容</span></div>
      <div className="scope-fields">
        <label className="field-label">Base URL<input className="model-field-input" type="url" value={baseUrl} placeholder="https://api.openai.com/v1" spellCheck={false} autoComplete="off" disabled={busy || !config} onChange={(event) => setBaseUrl(event.target.value)} /></label>
        <label className="field-label">模型名称<input className="model-field-input" value={model} placeholder="model-name" spellCheck={false} autoComplete="off" disabled={busy || !config} onChange={(event) => setModel(event.target.value)} /></label>
      </div>
      <div className="scope-fields">
        <label className="field-label">API Key<input className="model-field-input" type="password" value={apiKey} placeholder={config?.hasCredential ? '已保存，留空保留现有凭证' : '尚未保存'} autoComplete="off" disabled={busy || !config || !config.encryptionAvailable} onChange={(event) => setApiKey(event.target.value)} /></label>
        <div className="field-label"><span>状态</span><span className="status-line">{config?.hasCredential ? <CheckCircle2 size={14} /> : <KeyRound size={14} />}{config?.hasCredential ? '凭证已保存' : '未配置凭证'}</span><span className="subtle-text">后台文字授权：{textConsentEnabled ? '已开启' : '关闭'}</span></div>
      </div>
      {config && !config.encryptionAvailable && <p className="subtle-text">系统安全凭证存储不可用。</p>}
      <div className="settings-actions model-settings-actions">
        <button type="button" className="text-button" disabled={busy || !config?.hasCredential} onClick={() => void perform('clear')}><Trash2 size={15} />清除凭证</button>
        <button type="button" className="secondary-button" title={changed ? '配置尚未保存' : '仅发送合成测试文字'} disabled={busy || !config?.hasCredential || !config.baseUrl || !config.model || changed} onClick={() => void perform('test')}>{pending === 'test' ? <LoaderCircle size={15} className="is-spinning" /> : <PlugZap size={15} />}测试连接</button>
        <button type="button" className="primary-button" disabled={busy || !config || !changed || !baseUrl.trim() || !model.trim()} onClick={() => void perform('save')}>{pending === 'save' ? <LoaderCircle size={15} className="is-spinning" /> : <Save size={15} />}保存模型</button>
      </div>
      {config?.lastTest && <p className="subtle-text">最近连接测试：{config.lastTest.status === 'passed' ? '通过' : config.lastTest.status === 'failed' ? '失败' : '未测试'}{config.lastTest.status === 'passed' ? ` · ${config.lastTest.latencyMs} ms` : ''}</p>}
      {message && <p className={`inline-message ${message.error ? 'is-error' : 'is-success'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  );
}
