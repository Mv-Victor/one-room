import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { reuseInputs } from '../services/reuse/contracts';
import type { AgentStatus } from '../services/reuse/types';
import { z } from 'zod';
import { inputSchemas, outputSchemas, RPC_CHANNEL, type DomainMethod, type MethodInput, type MethodOutput } from '../shared/contracts';
import { DomainError, ErrorCodeSchema, toAppError } from '../shared/errors';
import type { AppStatus, CaptureStatus, Permissions, Settings } from '../shared/schemas';
import { DatabaseClient, StorageError } from '../services/storage/client';
import type { DatabaseResult, StorageDiagnostics } from '../services/storage/protocol';
import { registerWorklogServices } from '../services/worklog/register';
import type { WorklogSnapshot } from '../services/worklog/repository';
import { inspectNativeHelper, requestNativePermission, type NativeHelperInspection } from '../services/capture/helper-client';
import type { DomainEvents } from './events';
import type { CaptureCoordinator } from '../services/capture/coordinator';
import type { ModelService } from '../services/model';
import type { ModelWorkerQueue } from '../workers/model';
import type { Activity } from '../shared/activity-schemas';
import type { EvidenceStore } from '../services/evidence/store';
import type { HistoryDeleteCommit } from '../services/storage/worklog-commands';
import { createCachedWorklogReader } from '../services/worklog/cached-reader';
import { cleanupReuseRunFiles } from '../services/reuse/history-cleanup';
import type { DocumentRunService } from '../services/agents/runs';

export type DomainHandler<M extends DomainMethod> = (payload: MethodInput<M>) => Promise<DatabaseResult<MethodOutput<M>>>;
type AnyHandler = (payload: never) => Promise<DatabaseResult<unknown>>;

export class DomainRouter {
  private handlers = new Map<DomainMethod, AnyHandler>();
  register<M extends DomainMethod>(method: M, handler: DomainHandler<M>): void {
    if (this.handlers.has(method)) throw new Error(`Duplicate domain method: ${method}`);
    this.handlers.set(method, handler as AnyHandler);
  }
  async dispatch(method: unknown, request: unknown) {
    let requestId: string = randomUUID();
    try {
      if (typeof method !== 'string' || !Object.hasOwn(inputSchemas, method)) throw new DomainError('INVALID_ARGUMENT', 'Unknown method.');
      const name = method as DomainMethod;
      const envelope = z.strictObject({ requestId: z.uuid(), payload: inputSchemas[name] }).parse(request);
      requestId = envelope.requestId;
      const handler = this.handlers.get(name);
      if (!handler) throw new DomainError('CAPABILITY_BLOCKED', 'This module is not connected.', 'NOT_IMPLEMENTED');
      const result = await handler(envelope.payload as never);
      const data = outputSchemas[name].parse(result.data);
      return { requestId, ok: true as const, data, dataRevision: result.dataRevision };
    } catch (error) {
      if (error instanceof StorageError) {
        return { requestId, ok: false as const, error: { code: ErrorCodeSchema.catch('INTERNAL').parse(error.code), message: error.message, retryable: false, ...(error.detailCode ? { detailCode: error.detailCode } : {}) } };
      }
      return { requestId, ok: false as const, error: toAppError(error) };
    }
  }
}

export function registerFoundationServices(router: DomainRouter, database: DatabaseClient, events: DomainEvents, helperPath: string, appVersion: string, runtime: { capture: CaptureCoordinator; model: ModelService; queue: ModelWorkerQueue; evidence: EvidenceStore; documentRuns?: DocumentRunService }): void {
  let codexReady = false;
  for (const method of Object.keys(reuseInputs) as (keyof typeof reuseInputs)[]) {
    router.register(method, async input => {
      const result = await database.call<MethodOutput<typeof method>>(method, input);
      if (method === 'reuse.agents') codexReady = (result.data as AgentStatus[]).some(agent => agent.id === 'codex' && agent.enabled);
      return result;
    });
  }
  const reader = createCachedWorklogReader({ read: async (range: { rangeStart: number; rangeEnd: number; query?: string; asOf?: number }) => (await database.call<WorklogSnapshot>('worklog.read', range)).data }, async () => (await database.call('bootstrap')).dataRevision);
  const wrap = async <T>(data: T): Promise<DatabaseResult<T>> => ({ data, dataRevision: (await database.call('bootstrap')).dataRevision });
  let inspection: { at: number; result: Promise<NativeHelperInspection | null> } | undefined;
  const permissionOwner = app.isPackaged ? app.getName() : 'Electron (One Room)';
  const inspect = () => {
    if (!inspection || Date.now() - inspection.at > 2000) inspection = { at: Date.now(), result: inspectNativeHelper(helperPath, permissionOwner).catch(() => null) };
    return inspection.result;
  };
  router.register('app.getStatus', async () => {
    const diagnostic = await database.call<StorageDiagnostics>('bootstrap');
    const capture = await database.call<CaptureStatus>('capture.get');
    const model = await runtime.model.getConfig();
    const native = await inspect();
    const data: AppStatus = { appVersion, schemaVersion: diagnostic.data.schemaVersion, dataRevision: diagnostic.dataRevision, capture: capture.data, storage: { state: 'ready', journalMode: 'wal' }, capabilities: { nativeCapture: native?.capabilities.windowCapture.state === 'ready', accessibilityText: native?.capabilities.accessibilityText.state === 'ready', visionOcr: native?.capabilities.visionOcr.state === 'ready', backgroundTextAnalysis: Boolean(model.hasCredential && model.baseUrl && model.model), discovery: true, codex: runtime.documentRuns?.codexEnabled ?? codexReady } };
    return { data, dataRevision: capture.dataRevision };
  });
  router.register('settings.get', () => database.call<Settings>('settings.get'));
  router.register('settings.updateCaptureScope', async input => {
    const result = await database.call<Settings>('settings.updateCaptureScope', input);
    await runtime.documentRuns?.cancelGenerating();
    runtime.queue.cancelAll(); runtime.model.cancelActive();
    await database.call('periodSummary.policyChanged');
    await runtime.capture.restart();
    void runtime.capture.summarize({ retry: true }).catch(() => undefined);
    events.publish('settings.changed', 'settings', result.data.revision);
    events.publish('capture.status', 'capture', result.data.revision);
    return result;
  });
  router.register('settings.updateTextConsent', async input => {
    const result = await database.call<Settings>('settings.updateTextConsent', input);
    runtime.queue.cancelAll(); runtime.model.cancelActive();
    await database.call('periodSummary.policyChanged');
    events.publish('settings.changed', 'settings', result.data.revision);
    if (result.data.textConsent.enabled) {
      void runtime.capture.summarize({ retry: true }).catch(() => undefined);
      const recent = await database.call<{ items: Activity[] }>('activity.query', { limit: 16 });
      for (const activity of recent.data.items) if (activity.analysisStatus !== 'ready') void runtime.capture.analyze(activity.observationId).catch(() => undefined);
    }
    return result;
  });
  router.register('capture.pause', async input => {
    return wrap(await runtime.capture.pause(input.expectedRevision));
  });
  router.register('capture.resume', async input => {
    return wrap(await runtime.capture.resume(input.expectedRevision));
  });
  router.register('model.getConfig', async () => wrap(await runtime.model.getConfig()));
  router.register('model.saveConfig', async input => {
    runtime.queue.cancelAll(); runtime.model.cancelActive();
    await database.call('periodSummary.interrupt');
    const config = await runtime.model.saveConfig(input);
    void runtime.capture.summarize({ retry: true }).catch(() => undefined);
    events.publish('settings.changed', 'model', config.revision); return wrap(config);
  });
  router.register('model.clearCredential', async input => {
    runtime.queue.cancelAll(); runtime.model.cancelActive();
    await database.call('periodSummary.interrupt');
    const config = await runtime.model.clearCredential(input);
    events.publish('settings.changed', 'model', config.revision); return wrap(config);
  });
  router.register('model.testConnection', async input => wrap(await runtime.model.testConnection(input)));
  router.register('activity.query', input => database.call('activity.query', input));
  router.register('activity.review', async input => {
    const result = await database.call<{ revised: true }>('activity.review', input);
    await runtime.capture.summarize({ activityId: input.id });
    events.publish('timeline.changed', input.id, input.expectedRevision + 1); return result;
  });
  router.register('permissions.get', async () => {
    let permissions: Permissions;
    const native = await inspect();
    if (native) permissions = native.permissions;
    else {
      const detail = { status: 'unknown' as const, responsibleProcess: permissionOwner, reason: 'helper_unavailable' };
      permissions = { screen: detail, accessibility: detail, inputMonitoring: detail, checkedAt: Date.now() };
    }
    return wrap(permissions);
  });
  router.register('permissions.openSettings', async ({ kind }) => {
    await requestNativePermission(helperPath, kind);
    inspection = undefined;
    const anchors = { screen: 'Privacy_ScreenCapture', accessibility: 'Privacy_Accessibility', inputMonitoring: 'Privacy_ListenEvent' };
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchors[kind]}`);
    events.publish('permissions.changed', kind, 1);
    return wrap({ opened: true, kind });
  });
  registerWorklogServices(router, {
    reader, events, currentRevision: async () => (await database.call('bootstrap')).dataRevision,
    reports: {
      ...reader,
      getReport: async input => (await database.call<MethodOutput<'report.get'>>('report.get', input)).data,
      findReportReceipt: async input => (await database.call<MethodOutput<'report.get'> | null>('report.receipt', input)).data,
      saveReport: async (report, idempotencyKey) => (await database.call<MethodOutput<'report.generate'>>('report.save', { report, idempotencyKey })).data,
    },
    history: { durable: {
      preview: async input => {
        await runtime.documentRuns?.quiesce();
        runtime.queue.cancelAll(); runtime.model.cancelActive();
        const policy = (await database.call<Settings>('settings.get')).data;
        if (policy.captureEnabled) await runtime.capture.pause(policy.revision);
        await runtime.capture.quiesce();
        return (await database.call<MethodOutput<'history.previewDelete'>>('history.previewDelete', input)).data;
      },
      delete: async input => {
        await runtime.documentRuns?.quiesce();
        runtime.queue.cancelAll(); runtime.model.cancelActive();
        await runtime.capture.quiesce();
        try {
          let result = (await database.call<HistoryDeleteCommit>('history.delete', input)).data;
          if (result.cleanup === 'pending') {
            try {
              await runtime.evidence.cleanup();
              await cleanupReuseRunFiles(join(app.getPath('userData'), 'agent-runs'), result.affected.reuseRunIds ?? []);
              result = (await database.call<HistoryDeleteCommit>('history.cleanupComplete', { idempotencyKey: input.idempotencyKey })).data;
            } catch { /* The persisted receipt keeps cleanup retryable. */ }
          }
          return { cleanup: result.cleanup, dataRevision: result.dataRevision };
        } finally { await runtime.capture.restart(); }
      },
    } },
  });
}

export function installIpc(router: DomainRouter, window: BrowserWindow, allowedUrl: string, events: DomainEvents): () => void {
  const webContents = window.webContents;
  function trusted(event: IpcMainInvokeEvent): boolean {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try {
      const actual = new URL(event.senderFrame.url), expected = new URL(allowedUrl);
      return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname;
    } catch { return false; }
  }
  ipcMain.handle(RPC_CHANNEL, (event, method: unknown, request: unknown) => {
    if (!trusted(event)) return { requestId: randomUUID(), ok: false, error: { code: 'PERMISSION_DENIED', message: 'Untrusted caller.', retryable: false } };
    return router.dispatch(method, request);
  });
  const subscribe = (event: Electron.IpcMainEvent): void => {
    if (trusted(event as IpcMainInvokeEvent)) events.subscribe(event.sender);
  };
  ipcMain.on('one-room:subscribe', subscribe);
  return () => { ipcMain.removeHandler(RPC_CHANNEL); ipcMain.removeListener('one-room:subscribe', subscribe); events.unsubscribe(webContents); };
}
