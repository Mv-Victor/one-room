// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../shared/errors';
import { ModelTestStatusSchema, type ModelSettings } from '../../shared/model-schemas';

// Adapted safeStorage injection/base64 credential pattern from MemoryLane (GPL-3.0-or-later).
// f3157d54524e647d32f7decd186ee00cac9f72d5, src/main/settings/vendor-credentials-manager.ts.
// Retains one endpoint; omits vendor migration, environment keys, plaintext cache, and logging.
export interface CredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const StoredConfigSchema = z.strictObject({
  revision: z.number().int().positive(), baseUrl: z.string().max(2048), model: z.string().max(128),
  encryptedApiKey: z.string().max(32_768).nullable(), lastTest: ModelTestStatusSchema.nullable(),
});
export type StoredModelConfig = z.infer<typeof StoredConfigSchema>;

export class ModelConfigStore {
  private readonly path: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string, private readonly encryption: CredentialEncryption) {
    this.path = join(directory, 'model-settings.json');
  }

  async read(): Promise<StoredModelConfig> {
    try {
      return StoredConfigSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { revision: 1, baseUrl: '', model: '', encryptedApiKey: null, lastTest: null };
      }
      throw new DomainError('INTERNAL', '无法读取模型配置。', 'MODEL_CONFIG_UNREADABLE');
    }
  }

  publicSettings(value: StoredModelConfig): ModelSettings {
    return {
      revision: value.revision, baseUrl: value.baseUrl, model: value.model,
      hasCredential: value.encryptedApiKey !== null,
      encryptionAvailable: this.encryption.isEncryptionAvailable(), lastTest: value.lastTest,
    };
  }

  encrypt(apiKey: string): string {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new DomainError('CAPABILITY_BLOCKED', '系统安全凭证存储不可用。', 'CREDENTIAL_ENCRYPTION_UNAVAILABLE');
    }
    try { return this.encryption.encryptString(apiKey).toString('base64'); }
    catch { throw new DomainError('CAPABILITY_BLOCKED', '无法安全保存模型凭证。', 'CREDENTIAL_ENCRYPTION_FAILED'); }
  }

  credential(value: StoredModelConfig): string {
    if (!value.encryptedApiKey) throw new DomainError('AUTH_REQUIRED', '请先保存 API Key。', 'MODEL_CREDENTIAL_MISSING');
    if (!this.encryption.isEncryptionAvailable()) {
      throw new DomainError('CAPABILITY_BLOCKED', '系统安全凭证存储不可用。', 'CREDENTIAL_ENCRYPTION_UNAVAILABLE');
    }
    try { return this.encryption.decryptString(Buffer.from(value.encryptedApiKey, 'base64')); }
    catch { throw new DomainError('AUTH_REQUIRED', '无法读取模型凭证，请重新保存 API Key。', 'MODEL_CREDENTIAL_UNREADABLE'); }
  }

  update(expectedRevision: number, mutate: (current: StoredModelConfig) => StoredModelConfig): Promise<StoredModelConfig> {
    const operation = this.tail.then(async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) throw new DomainError('STALE_REVISION', '模型配置已变化，请刷新后重试。', 'MODEL_CONFIG_CHANGED');
      const next = StoredConfigSchema.parse(mutate(current));
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const temporaryPath = join(this.directory, `.model-settings-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        await rename(temporaryPath, this.path);
      } catch {
        await unlink(temporaryPath).catch(() => undefined);
        throw new DomainError('INTERNAL', '无法保存模型配置。', 'MODEL_CONFIG_WRITE_FAILED');
      }
      return next;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
