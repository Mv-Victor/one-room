import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelService, type CredentialEncryption } from '../../src/services/model';
import { ModelWorkerQueue } from '../../src/workers/model';
import type { ActivityAnalysis, ActivityAnalysisInput, ModelTask } from '../../src/shared/model-schemas';

const sourceId = '00000000-0000-4000-8000-000000000011';
const input: ActivityAnalysisInput = {
  periodId: '00000000-0000-4000-8000-000000000012',
  sources: [{ sourceRefId: sourceId, revision: 1, appBundleId: 'one.room.test', observedAt: 1000, text: '查看合成日报测试文档。' }],
};
const result: ActivityAnalysis = {
  activityAction: 'view', activityType: 'document', objectLabel: '测试文档', topic: '合成测试',
  summary: '查看合成测试文档。', sourceRefIds: [sourceId],
};

function encryption(): CredentialEncryption {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: (value) => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function localProvider(reply: (body: Record<string, unknown>) => unknown): Promise<{ baseUrl: string; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push(body);
      const completion = reply(body);
      if (completion === undefined) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(completion) } }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local test provider unavailable.');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'one-room-model-test-'));
  directories.push(value);
  return value;
}

const job = (overrides: Partial<ModelTask> = {}): ModelTask => ({ id: randomUUID(), consentRevision: 1, consentGeneration: 1, input: structuredClone(input), ...overrides });

describe('local model configuration and authorized text queue', () => {
  it('persists encrypted credentials, tests only synthetic text, and runs a structured request', async () => {
    const provider = await localProvider((body) => {
      const messages = body.messages as { content: string }[];
      const sent = JSON.parse(messages[1].content) as ActivityAnalysisInput;
      return { ...result, sourceRefIds: sent.sources.map((source) => source.sourceRefId) };
    });
    const storage = await directory();
    const secureStorage = encryption();
    const service = new ModelService({ directory: storage, encryption: secureStorage });
    expect((await service.getConfig()).hasCredential).toBe(false);
    let config = await service.saveConfig({ expectedRevision: 1, baseUrl: provider.baseUrl, model: 'local-test-model', apiKey: 'local-test-key' });
    expect(JSON.stringify(config)).not.toContain('local-test-key');
    expect(await readFile(join(storage, 'model-settings.json'), 'utf8')).not.toContain('local-test-key');
    expect((await stat(join(storage, 'model-settings.json'))).mode & 0o777).toBe(0o600);
    const restarted = new ModelService({ directory: storage, encryption: secureStorage });
    expect((await restarted.getConfig()).hasCredential).toBe(true);
    const tested = await restarted.testConnection({ expectedRevision: config.revision });
    expect(tested.ok).toBe(true);
    expect(JSON.stringify(provider.requests[0])).toContain('不包含用户工作内容');
    expect(await restarted.analyzeText(input)).toEqual(result);
    config = await restarted.clearCredential({ expectedRevision: tested.settings.revision });
    expect(config.hasCredential).toBe(false);
    await expect(restarted.analyzeText(input)).rejects.toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    expect(provider.requests).toHaveLength(2);
  });

  it('rejects invented citations and stops a stalled HTTP request at its deadline', async () => {
    let stalled = false;
    const provider = await localProvider(() => stalled ? undefined : { ...result, sourceRefIds: [randomUUID()] });
    const service = new ModelService({ directory: await directory(), encryption: encryption(), timeoutMs: 100 });
    await service.saveConfig({ expectedRevision: 1, baseUrl: provider.baseUrl, model: 'local-test', apiKey: 'local-test-key' });
    await expect(service.analyzeText(input)).rejects.toMatchObject({ error: { detailCode: 'MODEL_UNKNOWN_SOURCE' } });
    stalled = true;
    await expect(service.analyzeText(input)).rejects.toMatchObject({ error: { code: 'TIMEOUT' } });
    service.close();
  });

  it('executes serially and discards a result after authorization is revoked', async () => {
    let running = 0;
    let maximumRunning = 0;
    let commits = 0;
    let authorized = true;
    const stages: string[] = [];
    const queue = new ModelWorkerQueue({
      analyze: async () => {
        maximumRunning = Math.max(maximumRunning, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return result;
      },
      authorize: async (_job, stage) => { stages.push(stage); return authorized; },
      commit: async () => { commits += 1; },
    });
    await Promise.all([queue.enqueue(job()), queue.enqueue(job()), queue.enqueue(job())]);
    expect(maximumRunning).toBe(1);
    expect(commits).toBe(3);
    expect(stages).toEqual(['dispatch', 'commit', 'dispatch', 'commit', 'dispatch', 'commit']);
    queue.close();
    const revoked = new ModelWorkerQueue({
      analyze: async () => { authorized = false; return result; },
      authorize: async () => authorized,
      commit: async () => { commits += 1; },
    });
    await expect(revoked.enqueue(job())).rejects.toMatchObject({ error: { code: 'SOURCE_INVALIDATED' } });
    expect(commits).toBe(3);
    revoked.close();
  });

  it('bounds pending work and cancels queued and active requests', async () => {
    const queue = new ModelWorkerQueue({
      maxPending: 1,
      analyze: async (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      authorize: async () => true, commit: async () => undefined,
    });
    const first = queue.enqueue(job()).catch((error: unknown) => error);
    const second = queue.enqueue(job()).catch((error: unknown) => error);
    await expect(queue.enqueue(job())).rejects.toMatchObject({ error: { code: 'BUSY' } });
    queue.cancelAll();
    expect(await first).toMatchObject({ error: { code: 'CANCELED' } });
    expect(await second).toMatchObject({ error: { code: 'CANCELED' } });
    queue.close();
  });
});
