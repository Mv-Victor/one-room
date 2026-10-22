import { DomainError } from '../shared/errors';
import { ModelTaskSchema, type ActivityAnalysis, type ActivityAnalysisInput, type ModelTask } from '../shared/model-schemas';

type PendingTask = {
  job: ModelTask; resolve: (result: ActivityAnalysis) => void; reject: (error: unknown) => void;
};

export type ModelWorkerOptions = {
  analyze: (input: ActivityAnalysisInput, signal: AbortSignal) => Promise<ActivityAnalysis>;
  authorize: (job: ModelTask, stage: 'dispatch' | 'commit') => Promise<boolean>;
  // The host must recheck consent/generation/source revisions inside its write transaction.
  commit: (analysis: ActivityAnalysis, job: ModelTask) => Promise<void>;
  maxPending?: number; timeoutMs?: number;
};

export class ModelWorkerQueue {
  private readonly pending: PendingTask[] = [];
  private active: { job: ModelTask; controller: AbortController } | null = null;
  private closed = false;
  private readonly maxPending: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: ModelWorkerOptions) {
    this.maxPending = options.maxPending ?? 16;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 100) throw new Error('Invalid model queue limit.');
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) throw new Error('Invalid model timeout.');
  }

  enqueue(input: ModelTask): Promise<ActivityAnalysis> {
    if (this.closed) return Promise.reject(new DomainError('CANCELED', '模型队列已关闭。', 'MODEL_QUEUE_CLOSED'));
    const job = structuredClone(ModelTaskSchema.parse(input));
    if (this.pending.length >= this.maxPending) return Promise.reject(new DomainError('BUSY', '模型任务队列已满。', 'MODEL_QUEUE_FULL', true));
    if (this.active?.job.id === job.id || this.pending.some((value) => value.job.id === job.id)) {
      return Promise.reject(new DomainError('CONFLICT', '模型任务已在队列中。', 'MODEL_TASK_DUPLICATE'));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ job, resolve, reject });
      void this.drain();
    });
  }

  getStatus(): { runningJobId: string | null; pending: number; closed: boolean } {
    return { runningJobId: this.active?.job.id ?? null, pending: this.pending.length, closed: this.closed };
  }

  cancelAll(): void {
    this.active?.controller.abort();
    for (const task of this.pending.splice(0)) task.reject(new DomainError('CANCELED', '模型任务已取消。', 'MODEL_CANCELED'));
  }

  close(): void { this.closed = true; this.cancelAll(); }

  private async drain(): Promise<void> {
    if (this.active || this.closed) return;
    const task = this.pending.shift();
    if (!task) return;
    const controller = new AbortController();
    this.active = { job: task.job, controller };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const requireActive = () => {
      if (controller.signal.aborted) throw new DomainError(timedOut ? 'TIMEOUT' : 'CANCELED', timedOut ? '模型任务超时。' : '模型任务已取消。', timedOut ? 'MODEL_TIMEOUT' : 'MODEL_CANCELED');
    };
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DomainError(timedOut ? 'TIMEOUT' : 'CANCELED', timedOut ? '模型任务超时。' : '模型任务已取消。', timedOut ? 'MODEL_TIMEOUT' : 'MODEL_CANCELED'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const execute = async () => {
      if (!await this.options.authorize(task.job, 'dispatch')) throw new DomainError('CONSENT_REQUIRED', '当前文字分析未获授权。', 'TEXT_AUTHORIZATION_REQUIRED');
      requireActive();
      const analysis = await this.options.analyze(task.job.input, controller.signal);
      requireActive();
      if (!await this.options.authorize(task.job, 'commit')) throw new DomainError('SOURCE_INVALIDATED', '授权或来源已变化，已丢弃模型结果。', 'TEXT_AUTHORIZATION_CHANGED');
      requireActive();
      await this.options.commit(analysis, task.job);
      return analysis;
    };
    try { task.resolve(await Promise.race([execute(), aborted])); }
    catch (error) { task.reject(error); }
    finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      this.active = null;
      void this.drain();
    }
  }
}
