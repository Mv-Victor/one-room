import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseClient, StorageError } from '../../src/services/storage/client';
import { migrations } from '../../src/services/storage/migrations';
import { createWorklogRead } from '../../src/services/storage/worklog-read';
import type { AnalysisJob, TextRecord } from '../../src/services/storage/capture-commands';
import type { EvidenceRecord, ObservationInput, StorageDiagnostics } from '../../src/services/storage/protocol';
import { EvidenceStore } from '../../src/services/evidence/store';
import type { Activity } from '../../src/shared/activity-schemas';
import type { CaptureStatus, Settings } from '../../src/shared/schemas';

const bundleId = 'local.one-room.analysis-fixture';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5kAAAAASUVORK5CYII=', 'base64');
type ActivityPage = { items: Activity[]; nextBefore: number | null };
type RawPage = { observations: Record<string, unknown>[]; gaps: Record<string, unknown>[] };
const rejectedWith = (code: string) => (error: unknown) => error instanceof StorageError && error.code === code;

function text(source: TextRecord['source'], value: string, observedAt: number, thin = false): TextRecord {
  return { source, status: thin ? 'partial' : 'ready', completeness: thin ? 'thin' : 'complete', text: value, fallbackReason: source === 'ocr' ? 'accessibility_thin' : null, observedAt };
}

function createV1(path: string, at: number) {
  const ids = { observation: randomUUID(), evidence: randomUUID(), blob: randomUUID(), period: randomUUID(), observationSource: randomUUID(), imageSource: randomUUID(), periodSource: randomUUID() };
  const legacy = new Database(path);
  try {
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,appliedAt INTEGER NOT NULL)');
    legacy.exec(migrations[0].sql);
    legacy.prepare('INSERT INTO schema_migrations VALUES(1,?,?)').run(createHash('sha256').update(migrations[0].sql).digest('hex'), at);
    legacy.prepare('INSERT INTO settings_apps(bundleId,captureAllowed) VALUES(?,1)').run(bundleId);
    legacy.prepare(`INSERT INTO capture_events(id,commitSequence,sessionId,observedAt,endTs,bundleId,appName,pid,windowId,windowTitle,trigger,captureGeneration,pairingStatus,visibilityStatus)
      VALUES(?,1,?,?,?,?,?,1,1,'Legacy report','manual',1,'matched','verified')`).run(ids.observation, randomUUID(), at, at + 1000, bundleId, 'Legacy fixture');
    legacy.prepare(`INSERT INTO evidence_blobs(id,sha256,relativePath,mime,width,height,byteSize,createdAt) VALUES(?,?,?,'image/png',1,1,68,?)`).run(ids.blob, 'a'.repeat(64), `evidence/${'a'.repeat(64)}.png`, at);
    legacy.prepare('INSERT INTO evidence(id,captureEventId,blobId,observedAt,expiresAt) VALUES(?,?,?,?,?)').run(ids.evidence, ids.observation, ids.blob, at, at + 30 * 86400_000);
    legacy.prepare('INSERT INTO periods(id,startTs,endTs,appBundleId,appName) VALUES(?,?,?,?,?)').run(ids.period, at, at + 1000, bundleId, 'Legacy fixture');
    legacy.prepare("INSERT INTO source_refs(id,kind,captureEventId) VALUES(?,'observation',?)").run(ids.observationSource, ids.observation);
    legacy.prepare("INSERT INTO source_refs(id,kind,evidenceId) VALUES(?,'image',?)").run(ids.imageSource, ids.evidence);
    legacy.prepare("INSERT INTO source_refs(id,kind,periodId) VALUES(?,'period',?)").run(ids.periodSource, ids.period);
    legacy.prepare("INSERT INTO period_sources VALUES(?,?,1,'primary')").run(ids.period, ids.observationSource);
    legacy.prepare("INSERT INTO period_sources VALUES(?,?,1,'image')").run(ids.period, ids.imageSource);
    legacy.prepare("INSERT INTO domain_changes(sequence,type,captureEventId,entityRevision,committedAt) VALUES(1,'observation.committed',?,1,?)").run(ids.observation, at);
    legacy.prepare('INSERT INTO capture_search(captureEventId,title) VALUES(?,?)').run(ids.observation, 'Legacy report');
  } finally { legacy.close(); }
  return ids;
}

export async function runCaptureAnalysisSmoke(workerPath: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'one-room-capture-analysis-'));
  const path = join(root, 'fresh.sqlite');
  let database: DatabaseClient | null = new DatabaseClient(workerPath, path);
  try {
    const diagnostics = (await database.call<StorageDiagnostics>('bootstrap')).data;
    assert.equal(diagnostics.schemaVersion, migrations.at(-1)!.version);
    let settings = (await database.call<Settings>('settings.get')).data;
    assert.equal(settings.textConsent.enabled, false);
    settings = (await database.call<Settings>('settings.updateCaptureScope', { expectedRevision: settings.revision, allowedBundleIds: [bundleId], excludedBundleIds: [] })).data;
    const running = (await database.call<CaptureStatus>('capture.setEnabled', { expectedRevision: settings.revision, enabled: true })).data;
    let now = Date.now();
    const start = now;
    const store = new EvidenceStore(database, root, () => now);
    await store.initialize();
    const sessionId = randomUUID();
    const observation = (offset: number, trigger: ObservationInput['trigger']): ObservationInput => ({ id: randomUUID(), sessionId, observedAt: start + offset, bundleId, appName: 'Analysis fixture', pid: 1, windowId: 42, windowTitle: 'Original report title', trigger, captureGeneration: running.generation, pairingStatus: 'matched', visibilityStatus: 'verified' });
    const first = observation(0, 'window_focus');
    const evidence = await store.publish(first, png);
    await database.call('text.commit', { observationId: first.id, generation: running.generation, records: [text('accessibility', 'Toolbar', start, true), text('ocr', 'Sprint report draft', start)], selectedSource: 'ocr', action: 'unknown' });
    let activities = (await database.call<ActivityPage>('activity.query')).data;
    assert.equal(activities.items.length, 1);
    assert.equal(activities.items[0].text, 'Sprint report draft');
    assert.equal(activities.items[0].extractionSource, 'ocr');
    assert.equal(activities.items[0].sourceRefIds.length, 2);
    assert.equal((await database.call('analysis.prepare', { observationId: first.id })).data, null);

    settings = (await database.call<Settings>('settings.get')).data;
    settings = (await database.call<Settings>('settings.updateTextConsent', { expectedRevision: settings.revision, enabled: true, allowedBundleIds: [bundleId], confirmed: true })).data;
    const pending = (await database.call<AnalysisJob | null>('analysis.prepare', { observationId: first.id })).data;
    assert.ok(pending);
    assert.equal(pending.input.sources.length, 1);
    assert.equal(pending.input.sources[0].text, 'Sprint report draft');
    assert.equal((await database.call('analysis.authorize', pending)).data, true);
    const analysis = { activityAction: 'suspected_edit', activityType: 'document', objectLabel: 'Sprint report', topic: 'Weekly progress', summary: 'Draft progress report', sourceRefIds: pending.input.sources.map(source => source.sourceRefId) };
    settings = (await database.call<Settings>('settings.updateTextConsent', { expectedRevision: settings.revision, enabled: false, allowedBundleIds: [], confirmed: false })).data;
    assert.equal((await database.call('analysis.authorize', pending)).data, false);
    await assert.rejects(database.call('analysis.commit', { job: pending, analysis }), rejectedWith('SOURCE_INVALIDATED'));
    settings = (await database.call<Settings>('settings.updateTextConsent', { expectedRevision: settings.revision, enabled: true, allowedBundleIds: [bundleId], confirmed: true })).data;
    const currentJob = (await database.call<AnalysisJob | null>('analysis.prepare', { observationId: first.id })).data;
    assert.ok(currentJob);
    await database.call('analysis.commit', { job: currentJob, analysis });

    activities = (await database.call<ActivityPage>('activity.query')).data;
    const initialActivity = activities.items[0];
    assert.equal(initialActivity.basis, 'inferred');
    const captureBeforeReview = (await database.call<RawPage>('capture.raw')).data.observations;
    const review = { id: initialActivity.id, expectedRevision: initialActivity.revision, action: 'view', activityType: 'document', objectLabel: 'Confirmed report', topic: 'Confirmed topic', confirmed: true };
    await database.call('activity.review', review);
    await assert.rejects(database.call('activity.review', review), rejectedWith('STALE_REVISION'));
    const corrected = (await database.call<ActivityPage>('activity.query')).data.items[0];
    assert.equal(corrected.basis, 'confirmed');
    assert.equal(corrected.objectLabel, 'Confirmed report');
    assert.equal(corrected.text, 'Sprint report draft');
    assert.deepEqual((await database.call<RawPage>('capture.raw')).data.observations, captureBeforeReview);

    const second = observation(1000, 'typing_pause');
    const newerEvidence = await store.publish(second, png);
    await database.call('text.commit', { observationId: second.id, generation: running.generation, records: [text('accessibility', 'Sprint report revised', start + 1000)], selectedSource: 'accessibility', action: 'unknown' });
    const localActivity = (await database.call<ActivityPage>('activity.query')).data.items[0];
    assert.equal(localActivity.action, 'suspected_edit');
    assert.equal(localActivity.basis, 'inferred');
    assert.equal(localActivity.extractionSource, 'accessibility');
    assert.ok((await database.call<AnalysisJob | null>('analysis.prepare', { observationId: second.id })).data);
    await database.call('analysis.failed', { observationId: second.id, status: 'not_configured' });

    const interrupted = observation(2000, 'checkpoint');
    await store.publish(interrupted, png);
    const invalidated = (await database.call<Settings>('capture.invalidate', { generation: running.generation })).data;
    await assert.rejects(database.call('text.commit', { observationId: interrupted.id, generation: running.generation, records: [text('accessibility', 'Stale text must not persist', start + 2000)], selectedSource: 'accessibility', action: 'unknown' }), rejectedWith('SOURCE_INVALIDATED'));
    await database.call('capture.gap', { sessionId, generation: invalidated.captureGeneration, reason: 'paused', at: start + 2000 });
    await database.call('capture.gap', { sessionId, generation: invalidated.captureGeneration, reason: 'permission', at: start + 3000 });

    now = start + 30 * 86400_000 + 1;
    assert.equal(await store.read(evidence.evidenceId), null);
    assert.ok(await store.read(newerEvidence.evidenceId));
    const expired = (await database.call<EvidenceRecord>('evidence.get', { evidenceId: evidence.evidenceId, now })).data;
    assert.equal(expired.status, 'expired');
    const retained = (await database.call<ActivityPage>('activity.query')).data.items;
    assert.equal(retained.length, 2);
    assert.equal(retained.find(item => item.id === initialActivity.id)?.text, 'Sprint report draft');
    await database.close(); database = null;

    const inspect = new Database(path, { readonly: true });
    try {
      assert.deepEqual(inspect.pragma('foreign_key_check'), []);
      assert.equal((inspect.prepare('SELECT count(*) AS n FROM text_evidence').get() as { n: number }).n, 3);
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM text_search WHERE text_search MATCH 'Sprint'").get() as { n: number }).n, 2);
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM source_refs WHERE kind='text' AND state='valid'").get() as { n: number }).n, 3);
      assert.equal((inspect.prepare('SELECT count(*) AS n FROM activity_event_revisions WHERE activityEventId=?').get(initialActivity.id) as { n: number }).n, 3);
      assert.equal((inspect.prepare('SELECT count(*) AS n FROM text_evidence WHERE captureEventId=?').get(interrupted.id) as { n: number }).n, 0);
      assert.equal((inspect.prepare("SELECT state FROM source_refs WHERE evidenceId=?").get(evidence.evidenceId) as { state: string }).state, 'expired');
      const revision = () => Number((inspect.prepare("SELECT value FROM app_meta WHERE key='dataRevision'").get() as { value: string }).value);
      const read = createWorklogRead(inspect, revision);
      const snapshot = read({ rangeStart: start, rangeEnd: start + 3000 });
      assert.equal(snapshot.dataRevision, revision());
      assert.deepEqual(snapshot.periods.map(period => [period.id, period.startTs, period.endTs]), [
        [first.id, start, start + 1000], [second.id, start + 1000, start + 2000],
      ]);
      assert.deepEqual(snapshot.gaps.map(gap => [gap.startTs, gap.endTs, gap.reason]), [[start + 2000, start + 3000, 'paused']]);
      assert.equal(snapshot.periods[0].windowTitle, 'Original report title');
      assert.equal(snapshot.periods[0].activityType, 'document');
      assert.equal(snapshot.periods[0].objectLabel, 'Confirmed report');
      assert.equal(snapshot.periods[0].topic, 'Confirmed topic');
      assert.equal(snapshot.periods[0].summary, 'Draft progress report');
      assert.equal(snapshot.periods[0].summaryStatus, 'ready');
      assert.equal(snapshot.periods[0].basis, 'confirmed');
      const captureRevision = (inspect.prepare('SELECT revision FROM capture_events WHERE id=?').get(first.id) as { revision: number }).revision;
      assert.equal(snapshot.periods[0].revision, captureRevision + corrected.revision);
      assert.equal(snapshot.periods[1].summaryStatus, 'not_configured');
      assert.deepEqual(snapshot.observations.map(item => [item.id, item.displayUntil, item.evidence?.status, item.evidence?.displayUntil]), [
        [first.id, start + 1000, 'expired', start + 1000], [second.id, start + 2000, 'available', start + 2000],
      ]);
      const clipped = read({ rangeStart: start + 500, rangeEnd: start + 1500 });
      assert.deepEqual(clipped.periods.map(period => [period.id, period.startTs, period.endTs]), [
        [first.id, start + 500, start + 1000], [second.id, start + 1000, start + 1500],
      ]);
      assert.equal(clipped.observations[1].evidence?.displayUntil, start + 1500);
      assert.throws(() => read({ rangeStart: start, rangeEnd: start + 32 * 86400_000 }), rejectedWith('INVALID_ARGUMENT'));
    } finally { inspect.close(); }

    database = new DatabaseClient(workerPath, path);
    const reopened = (await database.call<Settings>('settings.get')).data;
    assert.equal(reopened.captureEnabled, false);
    assert.equal(reopened.textConsent.enabled, true);
    assert.deepEqual(reopened.textConsent.allowedBundleIds, [bundleId]);
    assert.equal((await database.call<CaptureStatus>('capture.get')).data.state, 'paused');
    await database.close(); database = null;

    const legacyPath = join(root, 'legacy.sqlite');
    const legacyIds = createV1(legacyPath, start - 60_000);
    database = new DatabaseClient(workerPath, legacyPath);
    const upgraded = (await database.call<StorageDiagnostics>('bootstrap')).data;
    assert.equal(upgraded.schemaVersion, migrations.at(-1)!.version);
    assert.equal(upgraded.observationCount, 1);
    assert.equal(upgraded.evidenceCount, 1);
    assert.equal((await database.call<RawPage>('capture.raw')).data.observations[0].id, legacyIds.observation);
    assert.equal((await database.call<ActivityPage>('activity.query')).data.items.length, 0);
    await database.close(); database = null;
    const migrated = new Database(legacyPath, { readonly: true });
    try {
      assert.deepEqual(migrated.pragma('foreign_key_check'), []);
      assert.equal((migrated.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n, migrations.length);
      assert.equal((migrated.prepare('SELECT count(*) AS n FROM source_refs').get() as { n: number }).n, 3);
      assert.equal((migrated.prepare('SELECT count(*) AS n FROM period_sources WHERE periodId=?').get(legacyIds.period) as { n: number }).n, 2);
      assert.equal((migrated.prepare('SELECT captureEventId FROM domain_changes WHERE sequence=1').get() as { captureEventId: string }).captureEventId, legacyIds.observation);
      assert.equal((migrated.prepare('SELECT count(*) AS n FROM capture_search WHERE capture_search MATCH ?').get('Legacy') as { n: number }).n, 1);
      const legacyRead = createWorklogRead(migrated, () => Number((migrated.prepare("SELECT value FROM app_meta WHERE key='dataRevision'").get() as { value: string }).value));
      const legacyPeriod = legacyRead({ rangeStart: start - 60_000, rangeEnd: start }).periods[0];
      assert.equal(legacyPeriod.id, legacyIds.observation);
      assert.equal(legacyPeriod.activityType, 'unknown');
      assert.equal(legacyPeriod.objectLabel, null);
      assert.equal(legacyPeriod.topic, null);
      assert.equal(legacyPeriod.summary, null);
      assert.equal(legacyPeriod.basis, 'observed');
    } finally { migrated.close(); }
    console.log(JSON.stringify({ captureAnalysis: 'passed', checks: ['fresh/v1-upgrade', 'AX/OCR sources and FTS', 'consent dispatch/commit gate', 'versioned review preserves facts', 'screenshot expiry retains text/activity', 'transactional worklog/activity/gaps/evidence', 'stale generation rejected', 'restart consent persists/capture paused'] }));
  } finally {
    if (database) await database.close();
    await rm(root, { recursive: true, force: true });
  }
}
