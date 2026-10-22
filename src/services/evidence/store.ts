import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, readdir, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseClient } from '../storage/client';
import { StorageError } from '../storage/client';
import { observationInputSchema, type ObservationInput, type EvidenceRecord, type BlobInput } from '../storage/protocol';

export class EvidenceStore {
  private locks = new Map<string, Promise<unknown>>();
  private directory: string;

  constructor(private database: DatabaseClient, private root: string, private now = Date.now) {
    this.directory = join(root, 'evidence');
  }

  private async locked<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(hash) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    this.locks.set(hash, task);
    try { return await task; } finally { if (this.locks.get(hash) === task) this.locks.delete(hash); }
  }

  private imagePath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new StorageError('INVALID_ARGUMENT', 'Invalid image identity.');
    return join(this.directory, `${hash}.png`);
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const { data: blobs } = await this.database.call<BlobInput[]>('evidence.blobs');
    const known = new Set(blobs.map(blob => `${blob.sha256}.png`));
    for (const filename of await readdir(this.directory)) {
      if (filename.endsWith('.tmp') || (/^[a-f0-9]{64}\.png$/.test(filename) && !known.has(filename))) await unlink(join(this.directory, filename));
    }
    for (const blob of blobs) {
      try { await access(this.imagePath(blob.sha256)); } catch { await this.database.call('evidence.markMissing', { blobId: blob.id }); }
    }
    await this.cleanup();
  }

  async publish(observation: ObservationInput, png: Buffer): Promise<{ observationId: string; evidenceId: string; commitSequence: number }> {
    observationInputSchema.parse(observation);
    if (png.length < 24 || png.length > 32 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new StorageError('INVALID_ARGUMENT', 'Expected a valid PNG screenshot.');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (!width || !height || width > 16384 || height > 16384) throw new StorageError('INVALID_ARGUMENT', 'Unsupported screenshot dimensions.');
    const sha256 = createHash('sha256').update(png).digest('hex');
    return this.locked(sha256, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = this.imagePath(sha256);
      try { await access(destination); } catch {
        const temporary = join(this.directory, `${randomUUID()}.tmp`);
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(png); await file.sync(); } finally { await file.close(); }
        await rename(temporary, destination);
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      const evidenceId = randomUUID();
      const blob: BlobInput = { id: randomUUID(), sha256, relativePath: `evidence/${sha256}.png`, mime: 'image/png', width, height, byteSize: png.length };
      const result = await this.database.call<{ observationId: string; evidenceId: string; commitSequence: number }>('capture.commitObservation', { observation, blob, evidenceId });
      return result.data;
    });
  }

  async read(evidenceId: string): Promise<{ bytes: Buffer; mime: string } | null> {
    if (!/^[a-f0-9-]{36}$/i.test(evidenceId)) return null;
    const { data: first } = await this.database.call<EvidenceRecord | null>('evidence.get', { evidenceId, now: this.now() });
    if (!first) return null;
    return this.locked(first.sha256, async () => {
      const { data: current } = await this.database.call<EvidenceRecord | null>('evidence.get', { evidenceId, now: this.now() });
      if (!current || current.status !== 'available' || current.expiresAt <= this.now()) return null;
      try {
        const bytes = await readFile(this.imagePath(current.sha256));
        return { bytes, mime: current.mime };
      } catch {
        await this.database.call('evidence.markMissing', { blobId: current.blobId });
        return null;
      }
    });
  }

  async cleanup(): Promise<number> {
    const { data } = await this.database.call<{ expired: number }>('evidence.expire', { now: this.now() });
    const { data: blobs } = await this.database.call<BlobInput[]>('evidence.blobs');
    for (const blob of blobs) await this.locked(blob.sha256, async () => {
      const { data: unreferenced } = await this.database.call<boolean>('evidence.unreferenced', { blobId: blob.id, now: this.now() });
      if (!unreferenced) return;
      try { await unlink(this.imagePath(blob.sha256)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.database.call('evidence.markMissing', { blobId: blob.id });
    });
    return data.expired;
  }
}
