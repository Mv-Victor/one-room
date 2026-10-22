import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DomainEvents } from '../../src/main/events';
import { CaptureCoordinator } from '../../src/services/capture/coordinator';
import { NativeSession } from '../../src/services/capture/native-session';
import { EvidenceStore } from '../../src/services/evidence/store';
import { DatabaseClient } from '../../src/services/storage/client';
import type { BlobInput, StorageDiagnostics } from '../../src/services/storage/protocol';
import type { HistoryDeleteCommit } from '../../src/services/storage/worklog-commands';
import { createSnapshotQueries } from '../../src/services/worklog/queries';
import { createReports } from '../../src/services/worklog/reports';
import type { WorklogSnapshot } from '../../src/services/worklog/repository';
import type { MethodOutput } from '../../src/shared/contracts';
import { ActivityPageSchema } from '../../src/shared/activity-schemas';
import { NativeCapturePayloadSchema, NativeOcrPayloadSchema, NativeTextPayloadSchema, NativeWindowContextSchema,
  type CaptureStatus, type NativeEvent, type ReportResult, type Settings } from '../../src/shared/schemas';
import { dateKey, dayBounds } from '../../src/shared/time';
import { ModelWorkerQueue } from '../../src/workers/model';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '../..');
const binary = join(project, 'resources/native/one-room-helper');
const fixtureBundle = join(project, 'native/.build/One Room Native Fixture.app');
const fixtureExecutable = join(fixtureBundle, 'Contents/MacOS/native-fixture');
const fixtureBundleId = 'local.one-room.native-fixture';
const readySchema = z.object({ pid: z.number().int().positive(), windowId: z.number().int().positive(), bundleId: z.string().startsWith(fixtureBundleId) });
await mkdir(dirname(fixtureExecutable), { recursive: true });
await copyFile(join(project, 'native/fixtures/Info.plist'), join(fixtureBundle, 'Contents/Info.plist'));
assert.equal(spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macos14.0',
  join(project, 'native/fixtures/NativeFixture.swift'), '-o', fixtureExecutable], { stdio: 'inherit' }).status, 0);
assert.equal(spawnSync('codesign', ['--force', '--sign', '-', fixtureBundle], { stdio: 'ignore' }).status, 0);

const temporary = await mkdtemp(join(tmpdir(), 'one-room-real-capture-'));
const root = await realpath(temporary);
const protocolStaging = join(root, 'protocol-staging');
await mkdir(protocolStaging, { mode: 0o700 });
const databasePath = join(root, 'history.sqlite');
const protocolFixture = join(root, 'protocol-fixture.mjs');
await copyFile(join(project, 'native/fixtures/ProtocolFixture.mjs'), protocolFixture);
await chmod(protocolFixture, 0o700);

async function checkProtocolBudgets(): Promise<void> {
  const accepted = new NativeSession(protocolFixture, 1);
  try { await assert.rejects(accepted.request('status'), /FIXTURE_TERMINAL/, 'accepted must wait for the terminal result'); }
  finally { accepted.stop(); }
  const timeout = new NativeSession(protocolFixture, 1);
  const started = Date.now();
  try { await assert.rejects(timeout.request('frontmost', {}, {}, 150), /stopped or timed out/); }
  finally { timeout.stop(); }
  assert.ok(Date.now() - started < 1500, 'native deadline must terminate the stalled process');
  const bounded = new NativeSession(protocolFixture, 1);
  const pending = Array.from({ length: 16 }, () => bounded.request('frontmost'));
  const settled = Promise.allSettled(pending);
  try { await assert.rejects(bounded.request('frontmost'), /pending request budget/); }
  finally { bounded.stop(); }
  assert.ok((await settled).every(result => result.status === 'rejected'));
  const mismatched = new NativeSession(protocolFixture, 1);
  try { await assert.rejects(mismatched.request('capture.preflight', {}, { pid: 1, windowId: 1 }), /stopped or timed out/); }
  finally { mismatched.stop(); }
}
function launchFixture(bundle: string, args: string[] = []) {
  const child = spawn(join(bundle, 'Contents/MacOS/native-fixture'), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  const pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const ready = new Promise<z.infer<typeof readySchema>>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native fixture startup timed out.')), 10_000);
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const value = z.record(z.string(), z.unknown()).parse(JSON.parse(line));
          if (typeof value.fixtureAck === 'string') {
            const request = pending.get(value.fixtureAck);
            if (request) { clearTimeout(request.timer); pending.delete(value.fixtureAck); request.resolve(value); }
          } else { clearTimeout(timeout); resolveReady(readySchema.parse(value)); }
        } catch (error) { clearTimeout(timeout); reject(error); }
      }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  return { bundle, ready, control(command: string) {
    const requestId = randomUUID();
    return new Promise<Record<string, unknown>>((resolveControl, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Fixture ${command} timed out.`)); }, 5000);
      pending.set(requestId, { resolve: resolveControl, reject, timer });
      child.stdin.write(`${JSON.stringify({ requestId, command })}\n`);
    });
  }, stop() {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Fixture stopped.')); }
    pending.clear(); child.kill('SIGTERM');
  } };
}
const fixture = launchFixture(fixtureBundle);
const fixtures = [fixture];
const executor = new NativeSession(binary, 1);
const listener = new NativeSession(binary, 1);
let database: DatabaseClient | undefined;
let coordinator: CaptureCoordinator | undefined;
let modelCalls = 0;
const modelQueue = new ModelWorkerQueue({
  authorize: async () => false,
  analyze: async () => { modelCalls += 1; throw new Error('Model sends are disabled in the native fixture test.'); },
  commit: async () => { throw new Error('Model commits are disabled in the native fixture test.'); },
});

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let result = await read();
  while (!matches(result) && Date.now() < deadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
    result = await read();
  }
  assert.ok(matches(result), `${label}: ${JSON.stringify(result)}`);
  return result;
}

async function focusFixture(session: NativeSession, ready: z.infer<typeof readySchema>, bundle = fixtureBundle) {
  assert.equal(spawnSync('open', ['-a', bundle], { stdio: 'ignore', timeout: 5000 }).status, 0, 'activate existing fixture');
  return eventually(async () => NativeWindowContextSchema.parse((await session.request('frontmost')).payload),
    context => context.frontmost && context.bundleId === ready.bundleId && context.pid === ready.pid && context.windowId === ready.windowId,
    'fixture must be frontmost before capture', 6000);
}

let phase = 'protocol budgets';
try {
  await checkProtocolBudgets();
  phase = 'primary fixture capture and extraction';
  const ready = await fixture.ready;
  assert.equal(ready.bundleId, fixtureBundleId);
  const hello = await executor.hello('executor', protocolStaging);
  assert.equal(hello.permissions.screen, 'granted');
  assert.equal(hello.permissions.accessibility, 'granted');
  assert.equal(hello.captureStarted, false);
  const frontmost = await focusFixture(executor, ready);
  assert.equal(frontmost.bundleId, fixtureBundleId);
  assert.equal(frontmost.pid, ready.pid);
  assert.equal(frontmost.windowId, ready.windowId);
  assert.equal(frontmost.windowTitle ?? null, null);
  await executor.request('capture.preflight', {}, { pid: ready.pid, windowId: ready.windowId });
  const identity = { pid: ready.pid, windowId: ready.windowId, observationId: randomUUID() };
  const token = randomUUID();
  const image = NativeCapturePayloadSchema.parse((await executor.request('capture',
    { policyRevision: 1, contextRevision: 1, trigger: 'manual', outputToken: token }, identity, 8000)).payload);
  const bytes = await readFile(join(protocolStaging, `${token}.png`));
  assert.equal(bytes.length, image.byteSize);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
  const ax = NativeTextPayloadSchema.parse((await executor.request('extract',
    { policyRevision: 1, contextRevision: 1 }, identity)).payload);
  assert.ok(ax.text.includes('ONE ROOM NATIVE FIXTURE'));
  const ocr = NativeOcrPayloadSchema.parse((await executor.request('ocr',
    { inputToken: token, languages: ['zh-Hans', 'en-US'] }, identity, 8000)).payload);
  assert.match(ocr.text, /ONE ROOM NATIVE FIXTURE/i);
  assert.ok(ocr.text.includes('\u5de5\u4f5c\u65e5\u62a5'));
  const nativeEvents: NativeEvent[] = [];
  listener.onEvent = event => nativeEvents.push(event);
  phase = 'listener initial signal';
  await listener.hello('listener', protocolStaging);
  await focusFixture(executor, ready);
  await listener.request('observe', { policyRevision: 1, heartbeatMs: 250,
    allowedBundleIds: [fixtureBundleId], excludedBundleIds: [], triggers: ['app_switch', 'window_focus', 'window_title', 'content_changed', 'click', 'typing_pause', 'scroll_stop'] });
  await eventually(async () => nativeEvents, events => events.some(event => event.method === 'heartbeat') &&
    events.some(event => event.method === 'window.changed' && event.pid === ready.pid), 'validated native listener events');

  phase = 'input timing';
  await focusFixture(executor, ready);
  const posted = await fixture.control('input');
  const hasInputTiming = () => ['click', 'typing_pause', 'scroll_stop'].every(trigger =>
    nativeEvents.some(event => event.method === 'input.timing' && event.pid === ready.pid && event.payload.trigger === trigger));
  if (hello.permissions.inputMonitoring === 'granted' && posted.posted === true) {
    const deadline = Date.now() + 1500;
    while (!hasInputTiming() && Date.now() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  const inputTiming = hasInputTiming();

  async function assertCaptureBlocked(label: string) {
    const rejectedToken = randomUUID();
    await assert.rejects(executor.request('capture', { policyRevision: 1, contextRevision: 1, trigger: 'manual', outputToken: rejectedToken },
      identity, 8000), /VISIBILITY_UNVERIFIED|CONTEXT_CHANGED|WINDOW_AMBIGUOUS/, label);
    await assert.rejects(readFile(join(protocolStaging, `${rejectedToken}.png`)), /ENOENT/, `${label} must not leave an image`);
  }
  phase = 'visibility rejection';
  for (const mode of ['overlay-opaque', 'overlay-clear']) {
    await fixture.control(mode);
    await assertCaptureBlocked(mode);
    await fixture.control('overlay-hide');
  }
  await fixture.control('overlay-zero');
  await executor.request('capture.preflight', {}, { pid: ready.pid, windowId: ready.windowId });
  await fixture.control('overlay-hide');
  await fixture.control('offscreen');
  await assertCaptureBlocked('offscreen');
  await fixture.control('restore');
  await focusFixture(executor, ready);
  await fixture.control('minimize');
  await assertCaptureBlocked('minimized');
  await fixture.control('restore');
  await focusFixture(executor, ready);
  await fixture.control('normal');
  await focusFixture(executor, ready);
  let normalVisibility = 'verified candidate';
  try { await executor.request('capture.preflight', {}, { pid: ready.pid, windowId: ready.windowId }); }
  catch (error) {
    assert.match(String(error), /VISIBILITY_UNVERIFIED|CONTEXT_CHANGED|WINDOW_AMBIGUOUS/);
    normalVisibility = `blocked in current desktop environment: ${String(error)}`;
  }
  await fixture.control('elevated');
  await focusFixture(executor, ready);

  const appExtraction: { bundleId: string; completeness: string; ocr: boolean }[] = [
    { bundleId: fixtureBundleId, completeness: ax.completeness, ocr: true },
  ];
  for (const mode of ['ocr-only', 'thin-ax']) {
    phase = `${mode} fixture extraction`;
    const bundleId = `${fixtureBundleId}.${mode}`;
    const bundle = join(root, `${mode}.app`);
    await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
    const plist = join(bundle, 'Contents/Info.plist');
    await copyFile(join(fixtureBundle, 'Contents/Info.plist'), plist);
    await copyFile(fixtureExecutable, join(bundle, 'Contents/MacOS/native-fixture'));
    assert.equal(spawnSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, plist], { stdio: 'ignore' }).status, 0);
    assert.equal(spawnSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'ignore' }).status, 0);
    const switchedAt = Date.now();
    const alternate = launchFixture(bundle, [`--${mode}`]); fixtures.push(alternate);
    const alternateReady = await alternate.ready;
    assert.equal(alternateReady.bundleId, bundleId);
    await focusFixture(executor, alternateReady, bundle);
    await eventually(async () => nativeEvents, events => events.some(event => event.method === 'window.changed' &&
      event.state === 'blocked' && event.pid === null && event.observedAt >= switchedAt), 'unallowed fixture emits identity-free stop signal');
    await assertCaptureBlocked('stale identity after application switch');
    const alternateIdentity = { pid: alternateReady.pid, windowId: alternateReady.windowId, observationId: randomUUID() };
    const alternateToken = randomUUID();
    await executor.request('capture', { policyRevision: 1, contextRevision: 1, trigger: 'manual', outputToken: alternateToken }, alternateIdentity, 8000);
    const alternateAX = NativeTextPayloadSchema.parse((await executor.request('extract', { policyRevision: 1, contextRevision: 1 }, alternateIdentity)).payload);
    assert.equal(alternateAX.completeness, mode === 'ocr-only' ? 'empty' : 'thin',
      `${mode} AX must match its fixture: ${JSON.stringify({ text: alternateAX.text, nodes: alternateAX.nodeCount })}`);
    if (mode === 'ocr-only') assert.equal(alternateAX.text, '');
    const alternateOCR = NativeOcrPayloadSchema.parse((await executor.request('ocr', { inputToken: alternateToken, languages: ['zh-Hans', 'en-US'] }, alternateIdentity, 8000)).payload);
    assert.match(alternateOCR.text, /ONE ROOM NATIVE FIXTURE/i);
    assert.ok(alternateOCR.text.includes('\u5de5\u4f5c\u65e5\u62a5'));
    appExtraction.push({ bundleId, completeness: alternateAX.completeness, ocr: true });
    alternate.stop();
    await focusFixture(executor, ready);
  }

  await listener.request('shutdown');
  listener.stop();

  phase = 'coordinator capture persistence';
  database = new DatabaseClient(join(here, 'database.js'), databasePath);
  const initial = (await database.call<Settings>('settings.get')).data;
  assert.equal(initial.captureEnabled, false);
  assert.equal(initial.textConsent.enabled, false);
  const scoped = (await database.call<Settings>('settings.updateCaptureScope', {
    expectedRevision: initial.revision, allowedBundleIds: [fixtureBundleId], excludedBundleIds: [],
  })).data;
  const evidence = new EvidenceStore(database, root);
  await evidence.initialize();
  coordinator = new CaptureCoordinator({ binary, root, database, evidence, events: new DomainEvents(), modelQueue });
  await coordinator.initialize();
  await focusFixture(executor, ready);
  executor.stop();
  await coordinator.resume(scoped.revision);
  const page = await eventually(async () => ActivityPageSchema.parse((await database!.call('activity.query', { limit: 100 })).data),
    value => value.items.some(activity => activity.text?.includes('ONE ROOM NATIVE FIXTURE') && activity.sourceRefIds.length > 0),
    'real capture/text/activity persistence');
  assert.ok(page.items.every(activity => activity.appBundleId === fixtureBundleId));
  assert.ok(page.items.some(activity => activity.extractionSource === 'accessibility'));
  assert.ok(page.items.every(activity => activity.analysisStatus === 'not_authorized'));
  const raw = (await database.call<{ observations: { id: string; bundleId: string; pid: number; windowId: number; visibilityStatus: string }[] }>('capture.raw')).data;
  assert.ok(raw.observations.length > 0);
  assert.ok(raw.observations.every(observation => observation.bundleId === fixtureBundleId && observation.pid === ready.pid &&
    observation.windowId === ready.windowId && observation.visibilityStatus === 'verified'));
  const blobs = (await database.call<BlobInput[]>('evidence.blobs')).data;
  assert.ok(blobs.length > 0);
  for (const blob of blobs) assert.equal(createHash('sha256').update(await readFile(join(root, blob.relativePath))).digest('hex'), blob.sha256);
  assert.equal(modelCalls, 0);

  phase = 'worklog reports restart and deletion';
  const current = (await database.call<Settings>('settings.get')).data;
  assert.equal((await coordinator.pause(current.revision)).state, 'paused');
  await coordinator.close(); coordinator = undefined;
  const call = async <T>(command: string, args: unknown = {}) => (await database!.call<T>(command, args)).data;
  const key = dateKey(page.items[0]!.observedAt), range = dayBounds(key);
  const reader = { read: (input: { rangeStart: number; rangeEnd: number }) => call<WorklogSnapshot>('worklog.read', input) };
  const queries = createSnapshotQueries(reader);
  const timeline = await queries.timeline(range);
  assert.ok(timeline.periods.some(period => period.appBundleId === fixtureBundleId));
  const cursor = await queries.cursor({ cursorTs: page.items[0]!.observedAt, queryRevision: timeline.dataRevision });
  assert.equal(cursor.evidence?.status, 'available');
  assert.equal(cursor.period?.appBundleId, fixtureBundleId);
  const reports = createReports({ ...reader,
    getReport: input => call<ReportResult>('report.get', input),
    findReportReceipt: input => call<ReportResult | null>('report.receipt', input),
    saveReport: (report, idempotencyKey) => call<ReportResult>('report.save', { report, idempotencyKey }),
  });
  const daily = await reports.generate({ kind: 'daily', dateKey: key, expectedDataRevision: timeline.dataRevision, idempotencyKey: randomUUID() });
  assert.equal(daily.status, 'ready');
  assert.ok(daily.report!.periods.some(period => period.appBundleId === fixtureBundleId));
  const beforeRestart = (await database.call<StorageDiagnostics>('bootstrap')).data;
  await database.close(); database = undefined;
  database = new DatabaseClient(join(here, 'database.js'), databasePath);
  const reopened = (await database.call<Settings>('settings.get')).data;
  assert.equal(reopened.captureEnabled, false);
  assert.equal(reopened.textConsent.enabled, false);
  assert.deepEqual(reopened.allowedBundleIds, [fixtureBundleId]);
  assert.equal((await database.call<CaptureStatus>('capture.get')).data.state, 'paused');
  const afterRestart = (await database.call<StorageDiagnostics>('bootstrap')).data;
  assert.equal(afterRestart.observationCount, beforeRestart.observationCount);
  assert.equal(afterRestart.evidenceCount, beforeRestart.evidenceCount);
  assert.equal((await reports.get({ kind: 'daily', dateKey: key })).status, 'ready');
  const preview = await call<MethodOutput<'history.previewDelete'>>('history.previewDelete', { ...range, bundleIds: [fixtureBundleId] });
  assert.ok(preview.observationCount > 0 && preview.reportCount > 0);
  const idempotencyKey = randomUUID();
  const deleted = await call<HistoryDeleteCommit>('history.delete', { deletionRef: preview.deletionRef,
    expectedRevision: preview.dataRevision, confirmed: true, idempotencyKey });
  assert.equal(deleted.affected.observationIds.length, raw.observations.length);
  assert.equal((await reports.get({ kind: 'daily', dateKey: key })).status, 'invalidated');
  assert.equal((await queries.timeline(range)).periods.length, 0);
  assert.equal(ActivityPageSchema.parse(await call('activity.query')).items.length, 0);
  const reopenedEvidence = new EvidenceStore(database, root);
  assert.equal(await reopenedEvidence.read(cursor.evidence!.evidenceId), null);
  await reopenedEvidence.cleanup();
  assert.equal((await call<HistoryDeleteCommit>('history.cleanupComplete', { idempotencyKey })).cleanup, 'complete');
  for (const blob of blobs) await assert.rejects(readFile(join(root, blob.relativePath)), /ENOENT/);
  console.log(JSON.stringify({ status: 'passed', scope: 'isolated Cocoa fixture only; one Mac',
    nativeSession: { schemaValidation: true, frontmost: true, screenshotHash: true, accessibility: ax.completeness, ocrChineseEnglish: true, listenerEvents: true },
    protocolBudgets: { acceptedWaitsForTerminal: true, deadlineTerminates: true, pendingLimit: 16, wrongGenerationRejected: true },
    visibility: { normalWindow: normalVisibility, opaqueOverlayRejected: true, perPixelClearOverlayRejected: true,
      zeroAlphaOverlayAllowed: true, offscreenRejected: true, minimizedRejected: true, staleWindowRejected: true },
    appExtraction, inputTiming: { monitorObserved: inputTiming, directedPostPermitted: posted.postingPermitted === true, physicalHardware: false },
    coordinator: { observations: beforeRestart.observationCount, evidence: beforeRestart.evidenceCount, activityRecords: page.items.length,
      accessibilityPreferred: true, modelCalls, paused: true, restartPreserved: true },
    worklog: { timeline: true, cursorEvidence: true, dailyReport: true, reportPersisted: true, deletionInvalidatesReport: true, evidenceRemoved: true },
    limitation: 'Fixture uses screenSaver window level. Ordinary desktop windows remain blocked by overlapping overlay tools.',
    pending: ['second Mac', 'Developer ID / TCC identity', 'physical input timing', 'lock/sleep/permission revocation', 'three-finger gestures'] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase }));
  throw error;
} finally {
  executor.stop(); listener.stop();
  await coordinator?.close();
  modelQueue.close();
  await database?.close();
  for (const app of fixtures) app.stop();
  await rm(temporary, { recursive: true, force: true });
}
