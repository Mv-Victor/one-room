import { DomainError, toAppError } from '../../shared/errors';
import {
  ActivityAnalysisInputSchema, ModelRevisionInputSchema, SaveModelSettingsSchema,
  type ActivityAnalysis, type ActivityAnalysisInput, type ModelConnectionResult,
  type ModelRevisionInput, type ModelSettings, type SaveModelSettings,
} from '../../shared/model-schemas';
import { ModelConfigStore, type CredentialEncryption, type StoredModelConfig } from './config-store';
import { analyzeWithOpenAICompatible } from './openai-compatible';

const CONNECTION_TEST_INPUT: ActivityAnalysisInput = {
  periodId: '00000000-0000-4000-8000-000000000080',
  sources: [{
    sourceRefId: '00000000-0000-4000-8000-000000000081', revision: 1,
    appBundleId: 'one.room.connection-test', observedAt: 0,
    text: '这是 One Room 的合成连接测试，不包含用户工作内容。当前仅查看测试说明，主题为连接测试。',
  }],
};

export class ModelService {
  private readonly store: ModelConfigStore;
  private readonly active = new Set<AbortController>();
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { directory: string; encryption: CredentialEncryption; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.store = new ModelConfigStore(options.directory, options.encryption);
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async getConfig(): Promise<ModelSettings> {
    return this.store.publicSettings(await this.store.read());
  }

  async saveConfig(input: SaveModelSettings): Promise<ModelSettings> {
    const parsed = SaveModelSettingsSchema.parse(input);
    const next = await this.store.update(parsed.expectedRevision, (current) => ({
      revision: current.revision + 1, baseUrl: parsed.baseUrl.replace(/\/+$/, ''), model: parsed.model,
      encryptedApiKey: parsed.apiKey ? this.store.encrypt(parsed.apiKey) : current.encryptedApiKey, lastTest: null,
    }));
    this.cancelActive();
    return this.store.publicSettings(next);
  }

  async clearCredential(input: ModelRevisionInput): Promise<ModelSettings> {
    const parsed = ModelRevisionInputSchema.parse(input);
    const next = await this.store.update(parsed.expectedRevision, (current) => ({
      ...current, revision: current.revision + 1, encryptedApiKey: null, lastTest: null,
    }));
    this.cancelActive();
    return this.store.publicSettings(next);
  }

  async testConnection(input: ModelRevisionInput): Promise<ModelConnectionResult> {
    const parsed = ModelRevisionInputSchema.parse(input);
    const config = await this.store.read();
    if (config.revision !== parsed.expectedRevision) throw new DomainError('STALE_REVISION', '模型配置已变化，请刷新后重试。', 'MODEL_CONFIG_CHANGED');
    this.requireConfigured(config);
    const startedAt = Date.now();
    let ok = true;
    let reason: string | null = null;
    let message = '合成文字连接测试通过。';
    try { await this.request(config, CONNECTION_TEST_INPUT); }
    catch (error) {
      const failure = toAppError(error);
      ok = false;
      reason = failure.detailCode ?? failure.code;
      message = failure.message;
    }
    const latencyMs = Date.now() - startedAt;
    const next = await this.store.update(parsed.expectedRevision, (current) => ({
      ...current, revision: current.revision + 1,
      lastTest: { status: ok ? 'passed' : 'failed', testedAt: Date.now(), latencyMs, reason },
    }));
    return { settings: this.store.publicSettings(next), ok, latencyMs, message };
  }

  // Callers must use the authorization-aware queue for captured work text.
  async analyzeText(input: ActivityAnalysisInput, signal?: AbortSignal): Promise<ActivityAnalysis> {
    const parsed = ActivityAnalysisInputSchema.parse(input);
    const config = await this.store.read();
    this.requireConfigured(config);
    return this.request(config, parsed, signal);
  }

  cancelActive(): void {
    for (const controller of this.active) controller.abort();
  }

  close(): void { this.cancelActive(); }

  private requireConfigured(config: StoredModelConfig): void {
    if (!config.baseUrl || !config.model) throw new DomainError('CAPABILITY_BLOCKED', '请先保存模型地址和名称。', 'MODEL_NOT_CONFIGURED');
    this.store.credential(config);
  }

  private async request(config: StoredModelConfig, input: ActivityAnalysisInput, signal?: AbortSignal): Promise<ActivityAnalysis> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    this.active.add(controller);
    try {
      const result = await analyzeWithOpenAICompatible({
        baseUrl: config.baseUrl, model: config.model, apiKey: this.store.credential(config), input,
        fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, signal: controller.signal,
      });
      if ((await this.store.read()).revision !== config.revision) {
        throw new DomainError('SOURCE_INVALIDATED', '模型配置已变化，已丢弃旧结果。', 'MODEL_CONFIG_CHANGED');
      }
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.active.delete(controller);
    }
  }
}

export type { CredentialEncryption } from './config-store';
