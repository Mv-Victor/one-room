import { app, BrowserWindow, dialog, protocol, session, safeStorage } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { DatabaseClient } from '../services/storage/client';
import { EvidenceStore } from '../services/evidence/store';
import { DomainEvents } from './events';
import { DomainRouter, installIpc, registerFoundationServices } from './ipc';
import { ModelService } from '../services/model';
import { ModelWorkerQueue } from '../workers/model';
import { CaptureCoordinator } from '../services/capture/coordinator';
import { registerExecutionServices } from './execution';
import type { DocumentRunService } from '../services/agents/runs';

const here = dirname(fileURLToPath(import.meta.url));
if (process.env.ONE_ROOM_USER_DATA) app.setPath('userData', process.env.ONE_ROOM_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'one-room-evidence', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let database: DatabaseClient | undefined;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;
let closing = false;
let capture: CaptureCoordinator | undefined;
let models: ModelService | undefined;
let modelQueue: ModelWorkerQueue | undefined;
let documentRuns: DocumentRunService | undefined;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
    app.setName('One Room');
    const root = app.getPath('userData');
    await mkdir(root, { recursive: true, mode: 0o700 });
    database = new DatabaseClient(join(here, 'database.js'), join(root, 'one-room.sqlite'));
    await database.call('bootstrap');
    const evidence = new EvidenceStore(database, root);
    await evidence.initialize();
    cleanupTimer = setInterval(() => { void evidence.cleanup().then(expired => { if (expired) events.publish('evidence.expired', 'evidence', expired); }).catch(() => events.publish('storage.failed', 'evidence', 1)); }, 3600_000);
    const events = new DomainEvents();
    const router = new DomainRouter();
    const helper = app.isPackaged ? join(process.resourcesPath, 'native', 'one-room-helper') : join(app.getAppPath(), 'resources', 'native', 'one-room-helper');
    const storage = database;
    models = new ModelService({ directory: root, encryption: safeStorage });
    const model = models;
    modelQueue = new ModelWorkerQueue({
      analyze: (input, signal) => model.analyzeText(input, signal),
      authorize: async job => (await storage.call<boolean>(job.kind === 'period_summary' ? 'periodSummary.authorize' : 'analysis.authorize', job)).data,
      commit: async (analysis, job) => { await storage.call(job.kind === 'period_summary' ? 'periodSummary.commit' : 'analysis.commit', { job, analysis }); events.publish('timeline.changed', job.input.periodId, 1); },
    });
    capture = new CaptureCoordinator({ binary: helper, root, database, evidence, events, modelQueue, modelReady: async () => {
      const config = await model.getConfig(); return Boolean(config.baseUrl && config.model && config.hasCredential);
    } });
    await capture.initialize();
    documentRuns = await registerExecutionServices(router, database, events);
    registerFoundationServices(router, database, events, helper, app.getVersion(), { capture, model, queue: modelQueue, evidence, documentRuns });

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await protocol.handle('one-room-evidence', async request => {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.hostname !== 'image' || url.search || url.hash) return new Response(null, { status: 400 });
      const result = await evidence.read(url.pathname.slice(1));
      if (!result) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      return new Response(Uint8Array.from(result.bytes), { headers: { 'Content-Type': result.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    });

    const createWindow = async (): Promise<void> => {
      const window = new BrowserWindow({ width: 1280, height: 860, minWidth: 390, minHeight: 600, title: 'One Room', backgroundColor: '#f6f7f8', show: false, webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
      const url = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(here, '../renderer/index.html')).href;
      const dispose = installIpc(router, window, url, events);
      window.on('swipe', (_event, direction) => {
        if (window.isFocused() && !window.webContents.isDestroyed()) window.webContents.send('one-room:gesture', { kind: 'swipe', direction });
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault(); });
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.once('ready-to-show', () => window.show());
      window.once('closed', dispose);
      await window.loadURL(url);
    };
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
    app.on('second-instance', () => { const window = BrowserWindow.getAllWindows()[0]; window?.show(); window?.focus(); });
  }).catch(() => {
    dialog.showErrorBox('One Room', 'The local application could not start. Your data has been preserved.');
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (closing || !database) return;
  event.preventDefault(); closing = true;
  if (cleanupTimer) clearInterval(cleanupTimer);
  modelQueue?.close(); models?.close();
  void (async () => { await capture?.close(); await documentRuns?.close(); await database?.call('reuse.stop'); await database?.close(); })().finally(() => app.quit());
});
