import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { DatabaseError, DatabaseResponse, DatabaseResult } from './protocol';

export class StorageError extends Error {
  constructor(public readonly code: string, message: string, public readonly detailCode?: string) { super(message); }
}

export class DatabaseClient {
  private worker: Worker;
  private exited: Promise<void>;
  private closeTask: Promise<void> | null = null;
  private failure: Error | null = null;
  private pending = new Map<string, { resolve: (value: DatabaseResult<unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(workerFile: string, databasePath: string) {
    this.worker = new Worker(workerFile, { workerData: { databasePath } });
    this.worker.on('message', (response: DatabaseResponse) => {
      const task = this.pending.get(response.id);
      if (!task) return;
      clearTimeout(task.timer);
      this.pending.delete(response.id);
      if (response.ok) task.resolve(response.result);
      else task.reject(this.asError(response.error));
    });
    this.worker.on('error', () => this.fail(new StorageError('INTERNAL', 'Storage worker failed.')));
    this.exited = new Promise(resolve => this.worker.on('exit', () => {
      this.fail(new StorageError('INTERNAL', 'Storage worker stopped.'));
      resolve();
    }));
  }

  private asError(error: DatabaseError): StorageError { return new StorageError(error.code, error.message, error.detailCode); }
  private fail(error: Error): void {
    this.failure = error;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
  }

  call<T = unknown>(command: string, args: unknown = {}): Promise<DatabaseResult<T>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closeTask) return Promise.reject(new StorageError('INTERNAL', 'Storage worker is closing.'));
    if (this.pending.size >= 256) return Promise.reject(new StorageError('BUSY', 'Storage queue is full.'));
    const id = randomUUID();
    return new Promise<DatabaseResult<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new StorageError('TIMEOUT', 'Storage operation timed out.'));
      }, command === 'reuse.agents' ? 30_000 : 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, command, args });
    }) as Promise<DatabaseResult<T>>;
  }

  close(): Promise<void> {
    this.closeTask ??= this.call('close').then(() => this.exited).catch(async error => {
      await this.worker.terminate();
      throw error;
    });
    return this.closeTask;
  }
}
