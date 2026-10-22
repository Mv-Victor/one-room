import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseClient, StorageError } from '../../src/services/storage/client';
import type { HistoryDeleteCommit } from '../../src/services/storage/worklog-commands';
import type { ObservationInput } from '../../src/services/storage/protocol';
import { EvidenceStore } from '../../src/services/evidence/store';
import { createReports } from '../../src/services/worklog/reports';
import { createHistoryDelete } from '../../src/services/worklog/history-delete';
import { createSnapshotQueries } from '../../src/services/worklog/queries';
import type { WorklogSnapshot } from '../../src/services/worklog/repository';
import type { Activity } from '../../src/shared/activity-schemas';
import type { MethodInput, MethodOutput } from '../../src/shared/contracts';
import type { CaptureStatus, ReportResult, Settings } from '../../src/shared/schemas';
import { dateKey, dayBounds, DAY_MS } from '../../src/shared/time';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5kAAAAASUVORK5CYII=', 'base64');
const rejectedWith = (code: string) => (error: unknown) => error instanceof StorageError && error.code === code;

export async function runWorklogStorageSmoke(workerPath: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'one-room-worklog-storage-')), path = join(root, 'worklog.sqlite');
  let database: DatabaseClient | null = new DatabaseClient(workerPath, path);
  try {
    const call = async <T>(command: string, args: unknown = {}) => (await database!.call<T>(command, args)).data;
    const range = dayBounds(dateKey(Date.now() - DAY_MS)), key = dateKey(range.rangeStart), at = range.rangeStart + 9 * 3_600_000;
    const apps = ['local.one-room.worklog-a', 'local.one-room.worklog-b'];
    let settings = await call<Settings>('settings.get');
    settings = await call<Settings>('settings.updateCaptureScope', { expectedRevision: settings.revision, allowedBundleIds: apps, excludedBundleIds: [] });
    const capture = await call<CaptureStatus>('capture.setEnabled', { expectedRevision: settings.revision, enabled: true });
    let store = new EvidenceStore(database!, root); await store.initialize();
    const sessionId = randomUUID(), observations: ObservationInput[] = [], evidenceIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const bundleId = apps[index === 2 ? 1 : 0];
      const observation: ObservationInput = { id: randomUUID(), sessionId, observedAt: at + index * 60_000,
        bundleId, appName: index === 2 ? 'Retained fixture' : 'Private daily fixture', pid: 1,
        windowId: index === 2 ? 2 : 1, windowTitle: index === 2 ? 'Retained work' : 'Private daily title',
        trigger: 'window_focus', captureGeneration: capture.generation, pairingStatus: 'matched', visibilityStatus: 'verified' };
      observations.push(observation);
      evidenceIds.push((await store.publish(observation, png)).evidenceId);
      await call('text.commit', { observationId: observation.id, generation: capture.generation,
        records: [{ source: 'accessibility', status: 'ready', completeness: 'complete', text: index === 2 ? 'Retained text' : `Private daily text ${index} Quartztask 日报`, fallbackReason: null, observedAt: observation.observedAt }],
        selectedSource: 'accessibility', action: 'unknown' });
    }
    await call('capture.gap', { sessionId, generation: capture.generation, reason: 'paused', at: at + 180_000 });
    settings = await call<Settings>('settings.get');
    await call('capture.pause', { expectedRevision: settings.revision });
    const reports = createReports({
      read: input => call<WorklogSnapshot>('worklog.read', input),
      getReport: input => call<ReportResult>('report.get', input),
      findReportReceipt: input => call<ReportResult | null>('report.receipt', input),
      saveReport: (report, idempotencyKey) => call<ReportResult>('report.save', { report, idempotencyKey }),
    });
    const initial = await call<WorklogSnapshot>('worklog.read', range);
    assert.deepEqual(initial.recordingRange, { rangeStart: at, rangeEnd: at + 180_000 });
    const outside = await call<WorklogSnapshot>('worklog.read', { rangeStart: range.rangeEnd, rangeEnd: range.rangeEnd + DAY_MS });
    assert.deepEqual(outside.recordingRange, initial.recordingRange);
    assert.equal(initial.periods.length, 2); assert.equal(initial.observations.length, 3);
    assert.deepEqual(initial.observations.map(row => row.periodId), [observations[0].id, observations[0].id, observations[2].id]);
    assert.equal(initial.periods[0].endTs - initial.periods[0].startTs, 120_000);
    const queries = createSnapshotQueries({ read: input => call<WorklogSnapshot>('worklog.read', input) });
    for (const query of ['Quartztask', '日报']) {
      const found = await queries.timeline({ ...range, query });
      assert.deepEqual(found.periods.map(period => period.id), [observations[0].id]);
      assert.equal(found.filteredDurationMs, 120_000);
    }
    const request = { kind: 'daily' as const, dateKey: key, expectedDataRevision: initial.dataRevision, idempotencyKey: randomUUID() };
    const generated = await reports.generate(request);
    assert.equal(generated.status, 'ready'); assert.equal(generated.report?.recordedMs, 180_000);
    assert.equal(generated.report?.rangeStart, range.rangeStart); assert.equal(generated.report?.rangeEnd, range.rangeEnd);
    assert.deepEqual(await reports.generate(request), generated);
    await assert.rejects(call('report.save', { report: { ...generated.report!, id: randomUUID() }, idempotencyKey: randomUUID() }), rejectedWith('STALE_REVISION'));
    const activity = (await call<{ items: Activity[] }>('activity.query')).items.find(item => item.observationId === observations[2].id)!;
    await call('activity.review', { id: activity.id, expectedRevision: activity.revision, action: 'view', activityType: 'document', objectLabel: 'Retained document', topic: 'Retained topic', confirmed: true });
    assert.deepEqual(await reports.get({ kind: 'daily', dateKey: key }), { status: 'invalidated', report: null });
    const afterReview = await call<WorklogSnapshot>('worklog.read', range);
    const latest = await reports.generate({ ...request, expectedDataRevision: afterReview.dataRevision, idempotencyKey: randomUUID() });
    assert.equal(latest.status, 'ready');
    const firstPreview = await call<MethodOutput<'history.previewDelete'>>('history.previewDelete', { ...range, bundleIds: [apps[0]] });
    await call('evidence.expire', { now: observations[0].observedAt + 30 * DAY_MS + 1 });
    assert.deepEqual((await queries.timeline(range)).recordingRange, initial.recordingRange);
    assert.equal((await reports.get({ kind: 'daily', dateKey: key })).status, 'ready');
    await assert.rejects(call('history.delete', { deletionRef: firstPreview.deletionRef, expectedRevision: firstPreview.dataRevision, confirmed: true, idempotencyKey: randomUUID() }), rejectedWith('STALE_REVISION'));
    const preview = await call<MethodOutput<'history.previewDelete'>>('history.previewDelete', { ...range, bundleIds: [apps[0]] });
    assert.equal(preview.observationCount, 2); assert.equal(preview.reportCount, 1);
    const deletion: MethodInput<'history.delete'> = { deletionRef: preview.deletionRef, expectedRevision: preview.dataRevision, confirmed: true, idempotencyKey: randomUUID() };
    const deleted = await call<HistoryDeleteCommit>('history.delete', deletion);
    assert.equal(deleted.cleanup, 'pending'); assert.deepEqual(deleted.cleanupBlobs, []);
    assert.deepEqual(new Set(deleted.affected.observationIds), new Set(observations.slice(0, 2).map(row => row.id)));
    assert.equal(deleted.generations.capture, capture.generation + 2);
    assert.deepEqual(await reports.get({ kind: 'daily', dateKey: key }), { status: 'invalidated', report: null });
    assert.deepEqual((await call<WorklogSnapshot>('worklog.read', range)).observations.map(row => row.id), [observations[2].id]);
    assert.deepEqual((await queries.timeline(range)).recordingRange, { rangeStart: at + 120_000, rangeEnd: at + 180_000 });
    for (const query of ['Quartztask', '日报']) assert.deepEqual((await queries.timeline({ ...range, query })).periods, []);
    assert.ok(await store.read(evidenceIds[2]));
    assert.equal(await store.read(evidenceIds[0]), null);
    await assert.rejects(call('text.commit', { observationId: observations[0].id, generation: capture.generation, records: [], selectedSource: null, action: 'unknown' }), rejectedWith('SOURCE_INVALIDATED'));
    await store.cleanup();
    assert.equal((await call<HistoryDeleteCommit>('history.cleanupComplete', { idempotencyKey: deletion.idempotencyKey })).cleanup, 'complete');
    await database.close(); database = new DatabaseClient(workerPath, path);
    const history = createHistoryDelete({ durable: {
      preview: input => call<MethodOutput<'history.previewDelete'>>('history.previewDelete', input),
      delete: input => call<HistoryDeleteCommit>('history.delete', input),
    } });
    const replay = await history.delete(deletion);
    assert.equal(replay.cleanup, 'complete'); assert.equal(replay.dataRevision, deleted.dataRevision);
    assert.deepEqual(await reports.get({ kind: 'daily', dateKey: key }), { status: 'invalidated', report: null });
    await assert.rejects(call('history.delete', { ...deletion, deletionRef: randomUUID() }), rejectedWith('CONFLICT'));
    store = new EvidenceStore(database, root); await store.initialize();
    assert.ok(await store.read(evidenceIds[2]));
    const lastPreview = await history.preview({ ...range, bundleIds: [apps[1]] });
    const lastRequest = { deletionRef: lastPreview.deletionRef, expectedRevision: lastPreview.dataRevision, confirmed: true as const, idempotencyKey: randomUUID() };
    const last = await call<HistoryDeleteCommit>('history.delete', lastRequest);
    assert.equal(last.cleanupBlobs.length, 1);
    await store.cleanup();
    assert.equal((await call<HistoryDeleteCommit>('history.cleanupComplete', { idempotencyKey: lastRequest.idempotencyKey })).cleanup, 'complete');
    assert.equal(await store.read(evidenceIds[2]), null);
    assert.equal((await queries.timeline(range)).recordingRange, null);
    await assert.rejects(access(join(root, 'evidence', `${last.cleanupBlobs[0].sha256}.png`)), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    await database.close(); database = null;
    const inspect = new Database(path, { readonly: true });
    try {
      const count = (sql: string) => (inspect.prepare(sql).get() as { n: number }).n;
      assert.deepEqual(inspect.pragma('foreign_key_check'), []);
      assert.equal(count('SELECT count(*) AS n FROM text_search'), 0);
      assert.equal(count('SELECT count(*) AS n FROM capture_search'), 0);
      assert.equal(count('SELECT count(*) AS n FROM activity_event_revisions'), 0);
      assert.equal(count("SELECT count(*) AS n FROM text_evidence WHERE text!=''"), 0);
      assert.equal(count('SELECT count(*) AS n FROM capture_events WHERE windowTitle IS NOT NULL OR deletedAt IS NULL'), 0);
      assert.equal(count('SELECT count(*) AS n FROM activity_events WHERE objectLabel IS NOT NULL OR topic IS NOT NULL OR summary IS NOT NULL OR deletedAt IS NULL'), 0);
      assert.equal(count("SELECT count(*) AS n FROM reports WHERE snapshot IS NOT NULL OR status!='invalidated'"), 0);
      assert.equal(count("SELECT count(*) AS n FROM source_refs WHERE state!='deleted'"), 0);
      assert.equal(count("SELECT count(*) AS n FROM report_sources rs JOIN source_refs s ON s.id=rs.sourceRefId WHERE s.kind='observation'"), 6);
      const stored = inspect.prepare('SELECT snapshot FROM reports WHERE id=?').get(latest.report!.id) as { snapshot: string | null };
      assert.equal(stored.snapshot, null);
    } finally { inspect.close(); }
    database = new DatabaseClient(workerPath, path);
    const currentSettings = await call<Settings>('settings.get');
    await call('capture.gap', { sessionId: randomUUID(), generation: currentSettings.captureGeneration, reason: 'paused', at: Date.now() - 1000 });
    const currentRange = dayBounds(dateKey(Date.now()));
    const current = await call<WorklogSnapshot>('worklog.read', currentRange);
    const slowReports = createReports({
      read: input => call<WorklogSnapshot>('worklog.read', input),
      getReport: input => call<ReportResult>('report.get', input),
      saveReport: async (report, idempotencyKey) => {
        await new Promise(resolve => setTimeout(resolve, 25));
        return call<ReportResult>('report.save', { report, idempotencyKey });
      },
    });
    const liveReport = await slowReports.generate({ kind: 'daily', dateKey: dateKey(currentRange.rangeStart), expectedDataRevision: current.dataRevision, idempotencyKey: randomUUID() });
    assert.equal(liveReport.status, 'ready');
    assert.equal(liveReport.report!.gaps.at(-1)!.endTs, liveReport.report!.generatedAt);
    console.log(JSON.stringify({ worklogStorage: 'passed', checks: ['aggregated periods retain all observation sources', 'body FTS and short Chinese search', 'persistent full-day report/source joins', 'report idempotency and source revision checks', 'review invalidation', 'image expiry retains reports', 'transactional deletion scrubs copies/FTS', 'shared blob retention/final cleanup', 'deletion receipt across restart', 'open gap frozen across delayed report commit'] }));
  } finally {
    if (database) await database.close();
    await rm(root, { recursive: true, force: true });
  }
}
