import { mkdir, readFile, realpath, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NativeCapturePayloadSchema, NativeWindowContextSchema, type CaptureStatus, type Settings } from '../../shared/schemas';
import { DomainError } from '../../shared/errors';
import type { DatabaseClient } from '../storage/client';
import type { EvidenceStore } from '../evidence/store';
import type { AnalysisJob } from '../storage/capture-commands';
import type { DomainEvents } from '../../main/events';
import type { ModelWorkerQueue } from '../../workers/model';
import { NativeSession } from './native-session';
import { ALL_TRIGGERS, CAPTURE_POLICY, triggerForEvent, type CaptureTrigger } from './triggers';
import { extractObservationText } from './text-pipeline';
import type { ModelTask } from '../../shared/model-schemas';

export class CaptureCoordinator {
  private listener?: NativeSession;
  private executors = new Set<NativeSession>();
  private policy?: Settings;
  private stagingRoot = '';
  private sessionId = randomUUID();
  private queue: { trigger: CaptureTrigger; contextRevision: number; pid?: number }[] = [];
  private draining = false;
  private lastCapture = 0;
  private heartbeat = 0;
  private contextRevision = 1;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private active: Promise<void> = Promise.resolve();
  private suspended = false;
  private transition: Promise<void> = Promise.resolve();
  private textQueue: { path: string; observationId: string; run(): Promise<void> }[] = [];
  private textActive: Promise<void> = Promise.resolve();
  private textDraining = false;
  private analysisGeneration = 1;
  private analysisActive = new Set<Promise<void>>();
  private summaryRefresh: Promise<void> = Promise.resolve();
  private summaryActive?: Promise<void>;
  private summaryPaused = false;

  constructor(private options: { binary: string; root: string; database: DatabaseClient; evidence: EvidenceStore; events: DomainEvents; modelQueue: ModelWorkerQueue; modelReady?: () => Promise<boolean> }) {}

  async initialize(): Promise<void> {
    const directory = join(this.options.root, 'native-staging');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.stagingRoot = await realpath(directory);
    for (const name of await readdir(this.stagingRoot)) if (/^[0-9a-f-]{36}\.png$/.test(name)) await unlink(join(this.stagingRoot, name));
    void this.summarize().catch(() => undefined);
  }

  async resume(expectedRevision: number): Promise<CaptureStatus> {
    const { data: policy } = await this.options.database.call<Settings>('settings.get');
    if (policy.revision !== expectedRevision) throw new DomainError('STALE_REVISION', 'Settings changed. Reload first.');
    if (!policy.allowedBundleIds.some(id => !policy.excludedBundleIds.includes(id))) throw new DomainError('PERMISSION_DENIED', '请先保存允许采集的应用范围。');
    const probe = new NativeSession(this.options.binary, policy.captureGeneration);
    try {
      const hello = await probe.hello('executor', this.stagingRoot);
      if (!hello.capabilities.windowCapture.supported || hello.permissions.screen !== 'granted' || hello.permissions.accessibility !== 'granted') throw new DomainError('PERMISSION_DENIED', '请在系统设置中授予屏幕录制和辅助功能权限，然后重新检查。', 'SCREEN_PERMISSION_REQUIRED');
    } finally { probe.stop(); }
    const result = await this.options.database.call<CaptureStatus>('capture.setEnabled', { enabled: true, expectedRevision });
    await this.restart();
    return (await this.options.database.call<CaptureStatus>('capture.get')).data ?? result.data;
  }

  async pause(expectedRevision: number): Promise<CaptureStatus> {
    const result = await this.options.database.call<CaptureStatus>('capture.pause', { expectedRevision });
    this.stopNative();
    await this.gap('paused', result.data.generation);
    this.options.events.publish('capture.status', 'capture', result.data.revision);
    return result.data;
  }

  private stopNative(): void {
    this.policy = undefined; this.queue = [];
    for (const task of this.textQueue.splice(0)) {
      void unlink(task.path).catch(() => undefined);
      void this.options.database.call('text.fail', { observationId: task.observationId }).catch(() => undefined);
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const listener = this.listener; this.listener = undefined;
    if (listener) { listener.onFailure = undefined; listener.stop(); }
    for (const executor of this.executors) executor.stop();
    this.executors.clear();
  }

  async quiesce(): Promise<void> {
    this.summaryPaused = true;
    this.analysisGeneration++;
    this.stopNative();
    await Promise.allSettled([this.active, this.textActive, this.transition, this.summaryRefresh]);
    this.analysisGeneration++;
    this.options.modelQueue.cancelAll();
    await Promise.allSettled([...this.analysisActive, ...(this.summaryActive ? [this.summaryActive] : [])]);
  }

  async restart(preserveSuspended = false): Promise<void> {
    this.stopNative();
    const { data: policy } = await this.options.database.call<Settings>('settings.get');
    this.summaryPaused = false;
    if (this.closed || !policy.captureEnabled) return;
    this.policy = policy; this.sessionId = randomUUID(); if (!preserveSuspended) this.suspended = false;
    const listener = new NativeSession(this.options.binary, policy.captureGeneration);
    this.listener = listener; this.heartbeat = Date.now(); this.contextRevision = 1;
    listener.onFailure = () => { if (this.listener === listener) { this.suspend('process_interrupted'); this.listener = undefined; } };
    listener.onEvent = event => {
      if (this.listener !== listener || !this.policy) return;
      if (event.method === 'heartbeat') {
        this.heartbeat = Date.now(); this.contextRevision = event.payload.contextRevision;
        if (event.payload.screenLocked || event.payload.sleeping) this.suspend(event.payload.screenLocked ? 'locked' : 'sleep');
        return;
      }
      if (event.method === 'system.state') {
        if (event.payload.reason === 'locked' || event.payload.reason === 'sleep') this.suspend(event.payload.reason === 'locked' ? 'locked' : 'sleep');
        else void this.transition.then(() => { this.suspended = false; this.enqueue('checkpoint'); });
        return;
      }
      this.contextRevision = event.payload.contextRevision ?? this.contextRevision;
      if (event.state === 'blocked') { this.suspend('excluded'); return; }
      const trigger = triggerForEvent(event);
      const eventContext = this.contextRevision;
      if (trigger) void this.transition.then(() => {
        if (eventContext !== this.contextRevision) return;
        this.suspended = false; this.enqueue(trigger, event.pid ?? undefined);
      });
    };
    try {
      const hello = await listener.hello('listener', this.stagingRoot);
      if (hello.permissions.screen !== 'granted' || hello.permissions.accessibility !== 'granted') throw new Error('SCREEN_PERMISSION_REQUIRED');
      await listener.request('observe', { policyRevision: policy.revision, triggers: ALL_TRIGGERS, heartbeatMs: CAPTURE_POLICY.heartbeatMs, allowedBundleIds: policy.allowedBundleIds, excludedBundleIds: policy.excludedBundleIds });
      this.timer = setInterval(() => {
        if (Date.now() - this.heartbeat > CAPTURE_POLICY.heartbeatTimeoutMs) { this.suspend('process_interrupted'); return; }
        this.enqueue(hello.capabilities.inputTiming.permission === 'granted' ? 'visual_checkpoint' : 'degraded_checkpoint');
      }, CAPTURE_POLICY.visualCheckpointMs);
      this.enqueue('checkpoint');
    } catch {
      this.stopNative(); await this.gap('permission', policy.captureGeneration);
    }
    this.options.events.publish('capture.status', 'capture', policy.revision);
  }

  private enqueue(trigger: CaptureTrigger, pid?: number): void {
    if (!this.policy || this.closed || this.suspended) return;
    if (this.queue.length >= CAPTURE_POLICY.maxPending) { void this.gap('queue_overflow', this.policy.captureGeneration); return; }
    if ((trigger === 'visual_checkpoint' || trigger === 'degraded_checkpoint') && this.queue.some(item => item.trigger === trigger)) return;
    this.queue.push({ trigger, contextRevision: this.contextRevision, ...(pid ? { pid } : {}) });
    if (!this.draining) { this.active = this.drain(); void this.active; }
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.policy && this.queue.length && !this.closed) {
        const job = this.queue.shift()!, policy = this.policy;
        const delay = CAPTURE_POLICY.minIntervalMs - (Date.now() - this.lastCapture);
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (this.policy !== policy) continue;
        await this.capture(job, policy).catch(async error => {
          if (this.policy !== policy) return;
          const code = error instanceof Error ? error.message : '';
          if (/PERMISSION|SCREEN_LOCKED|SYSTEM_SLEEPING/.test(code)) { this.suspend(code === 'SCREEN_LOCKED' ? 'locked' : code === 'SYSTEM_SLEEPING' ? 'sleep' : 'permission'); return; }
          await this.gap(/VISIBILITY|CONTEXT_CHANGED|WINDOW_AMBIGUOUS/.test(code) ? 'visibility_unknown' : 'capture_error', policy.captureGeneration);
        });
      }
    } finally { this.draining = false; }
  }

  private executor(generation: number): NativeSession {
    const executor = new NativeSession(this.options.binary, generation); this.executors.add(executor); return executor;
  }

  private async capture(job: { trigger: CaptureTrigger; contextRevision: number; pid?: number }, policy: Settings): Promise<void> {
    const executor = this.executor(policy.captureGeneration), token = randomUUID(), path = join(this.stagingRoot, `${token}.png`);
    let handedOff = false;
    try {
      await executor.hello('executor', this.stagingRoot);
      const context = NativeWindowContextSchema.parse((await executor.request('frontmost')).payload);
      if (this.policy !== policy || job.contextRevision !== this.contextRevision || (job.pid !== undefined && job.pid !== context.pid)) return;
      if (!context.bundleId || !policy.allowedBundleIds.includes(context.bundleId) || policy.excludedBundleIds.includes(context.bundleId)) { await this.gap('excluded', policy.captureGeneration); return; }
      if (!context.windowId) { await this.gap('visibility_unknown', policy.captureGeneration); return; }
      const windowId = context.windowId;
      const observationId = randomUUID(), identity = { pid: context.pid, windowId, observationId };
      const image = NativeCapturePayloadSchema.parse((await executor.request('capture', { policyRevision: policy.revision, contextRevision: job.contextRevision, trigger: job.trigger, outputToken: token }, identity, 8000)).payload);
      const sameContext = [image.contextBefore, image.contextAfter].every(c => c.pid === context.pid && c.windowId === context.windowId && c.bundleId === context.bundleId && c.frontmost);
      if (!sameContext || image.outputToken !== token) throw new Error('CAPTURE_CONTEXT_MISMATCH');
      const bytes = await readFile(path);
      if (bytes.length !== image.byteSize || createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('CAPTURE_HASH_MISMATCH');
      if (this.policy !== policy || job.contextRevision !== this.contextRevision) return;
      this.lastCapture = Date.now();
      await this.options.evidence.publish({ id: observationId, sessionId: this.sessionId, observedAt: image.observedAt, bundleId: context.bundleId, appName: context.appName ?? context.bundleId, pid: context.pid, windowId: context.windowId, windowTitle: image.contextBefore.windowTitle ?? null, trigger: job.trigger, captureGeneration: policy.captureGeneration, pairingStatus: 'matched', visibilityStatus: 'verified' }, bytes);
      void this.summarize({ observationId }).catch(() => undefined);
      this.options.events.publish('timeline.changed', observationId, 1);
      this.options.events.publish('capture.status', 'capture', policy.revision);
      executor.stop(); this.executors.delete(executor);
      if (this.textQueue.length < CAPTURE_POLICY.maxPending) {
        handedOff = true;
        this.textQueue.push({ path, observationId, run: async () => {
          const textExecutors: NativeSession[] = [];
          try {
            await extractObservationText({ createExecutor: async () => {
              const next = this.executor(policy.captureGeneration); textExecutors.push(next);
              await next.hello('executor', this.stagingRoot); return next;
            }, database: this.options.database, observationId, generation: policy.captureGeneration, pid: context.pid, windowId, windowTitle: image.contextBefore.windowTitle ?? null, contextRevision: job.contextRevision, policy, token });
            this.options.events.publish('timeline.changed', observationId, 1);
            void this.analyze(observationId).catch(() => undefined);
          } finally { for (const next of textExecutors) { next.stop(); this.executors.delete(next); } }
        } });
        if (!this.textDraining) { this.textActive = this.drainText(); void this.textActive; }
      } else await this.options.database.call('text.fail', { observationId });
    } finally { executor.stop(); this.executors.delete(executor); if (!handedOff) await unlink(path).catch(() => undefined); }
  }

  private async drainText(): Promise<void> {
    this.textDraining = true;
    try {
      while (this.textQueue.length && !this.closed) {
        const task = this.textQueue.shift()!;
        try { await task.run(); }
        catch { await this.options.database.call('text.fail', { observationId: task.observationId }).catch(() => undefined); }
        finally { await unlink(task.path).catch(() => undefined); }
      }
    } finally { this.textDraining = false; }
  }

  analyze(observationId: string): Promise<void> {
    const task = this.analyzeObservation(observationId, this.analysisGeneration);
    this.analysisActive.add(task);
    return task.finally(() => this.analysisActive.delete(task));
  }

  private async analyzeObservation(observationId: string, generation: number): Promise<void> {
    const { data: job } = await this.options.database.call<AnalysisJob | null>('analysis.prepare', { observationId });
    if (!job) { await this.summarize({ observationId }); return; }
    if (generation !== this.analysisGeneration) { await this.options.database.call('analysis.failed', { observationId }); return; }
    if (this.options.modelReady && !await this.options.modelReady()) {
      await this.options.database.call('analysis.failed', { observationId, status: 'not_configured' }); await this.summarize({ observationId }); return;
    }
    if (generation !== this.analysisGeneration) { await this.options.database.call('analysis.failed', { observationId }); return; }
    try { await this.options.modelQueue.enqueue(job); }
    catch { await this.options.database.call('analysis.failed', { observationId }); }
    this.options.events.publish('timeline.changed', observationId, 1);
    await this.summarize({ observationId });
  }

  summarize(input: { observationId?: string; activityId?: string; at?: number; retry?: boolean } = {}): Promise<void> {
    this.summaryRefresh = this.summaryRefresh.catch(() => undefined).then(async () => {
      if (this.closed || this.summaryPaused) return;
      await this.options.database.call('periodSummary.refresh', { observationId: input.observationId, activityId: input.activityId, at: input.at });
      if (input.retry) await this.options.database.call('periodSummary.retry');
      if (!this.summaryActive) {
        const task = this.drainSummaries();
        this.summaryActive = task;
        void task.finally(() => { if (this.summaryActive === task) this.summaryActive = undefined; }).catch(() => undefined);
      }
    });
    return this.summaryRefresh;
  }

  private async drainSummaries(): Promise<void> {
    const generation = this.analysisGeneration;
    while (!this.closed && !this.summaryPaused && generation === this.analysisGeneration) {
      const jobs = (await this.options.database.call<ModelTask[]>('periodSummary.prepare', { limit: 1 })).data;
      if (!jobs.length) return;
      const job = jobs[0];
      if (this.options.modelReady && !await this.options.modelReady()) {
        await this.options.database.call('periodSummary.failed', { id: job.id, status: 'not_configured' }); return;
      }
      if (this.summaryPaused || generation !== this.analysisGeneration) {
        await this.options.database.call('periodSummary.failed', { id: job.id }); return;
      }
      try { await this.options.modelQueue.enqueue(job); }
      catch {
        const policy = (await this.options.database.call<Settings>('settings.get')).data;
        await this.options.database.call('periodSummary.failed', { id: job.id, status: policy.textConsent.enabled ? 'failed' : 'not_authorized' });
      }
      this.options.events.publish('timeline.changed', job.input.periodId, 1);
    }
  }

  private async gap(reason: string, generation: number): Promise<void> {
    if (this.closed) return;
    const result = await this.options.database.call<CaptureStatus>('capture.gap', { sessionId: this.sessionId, generation, reason, at: Date.now() });
    await this.summarize();
    this.options.events.publish('capture.status', 'capture', result.data.revision);
    this.options.events.publish('timeline.changed', 'capture', result.data.revision);
  }

  private suspend(reason: string): void {
    if (this.suspended || !this.policy) return;
    this.suspended = true; this.queue = [];
    for (const executor of this.executors) executor.stop();
    const generation = this.policy.captureGeneration;
    this.transition = this.transition.then(async () => {
      const { data: policy } = await this.options.database.call<Settings>('capture.invalidate', { generation });
      if (!this.policy) return;
      this.policy = policy; await this.gap(reason, policy.captureGeneration);
      await this.restart(true);
    }).catch(() => { this.stopNative(); });
  }

  async close(): Promise<void> { this.closed = true; this.stopNative(); await this.transition; await this.active; await this.textActive; await this.summaryRefresh; await this.summaryActive; }
}
