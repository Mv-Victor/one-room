import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { migrations } from '../services/storage/migrations';
import { observationInputSchema, type BlobInput, type EvidenceRecord, type StorageDiagnostics } from '../services/storage/protocol';
import { StorageError } from '../services/storage/client';
import type { Settings, CaptureStatus } from '../shared/schemas';
import { createCaptureCommands } from '../services/storage/capture-commands';
import { createWorklogRead } from '../services/storage/worklog-read';
import { createWorklogCommands } from '../services/storage/worklog-commands';
import { createReuseCommands } from '../services/storage/reuse-commands';
import { createPeriodSummaryCommands } from '../services/storage/period-summary-commands';
import { createExecutionCommands } from '../services/storage/execution-commands';

if (!parentPort) throw new Error('Database must run in a worker.');
const { databasePath } = workerData as { databasePath: string };
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const existing = existsSync(databasePath);
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,appliedAt INTEGER NOT NULL)');
for (const migration of migrations) {
  const checksum = createHash('sha256').update(migration.sql).digest('hex');
  const row = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(migration.version) as { checksum: string } | undefined;
  if (row && row.checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
  if (row) continue;
  if (existing) await db.backup(`${databasePath}.before-v${migration.version}.backup`);
  if (migration.foreignKeysOff) db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(migration.sql);
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('MIGRATION_FOREIGN_KEY_FAILURE');
    db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(migration.version, checksum, Date.now());
  })();
  db.pragma('foreign_keys = ON');
}
// A restarted base never silently resumes an unfinished capture session.
const interrupted = db.prepare('UPDATE settings SET captureEnabled=0,revision=revision+1,captureGeneration=captureGeneration+1 WHERE captureEnabled=1').run();
const interruptedAnalysis = db.prepare("UPDATE activity_events SET analysisStatus='failed' WHERE analysisStatus='pending'").run();
const interruptedText = db.prepare("UPDATE capture_events SET textStatus='failed' WHERE textStatus='pending'").run();
db.prepare("UPDATE period_summary_jobs SET status='interrupted',errorCode='PROCESS_INTERRUPTED',updatedAt=? WHERE status='running'").run(Date.now());
if (interruptedAnalysis.changes || interruptedText.changes) db.prepare("UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='dataRevision'").run();
if (interrupted.changes) {
  const checkpoint = Number(JSON.parse((db.prepare("SELECT value FROM app_meta WHERE key='lastSuccessfulAt'").get() as { value: string }).value)) || Date.now();
  db.prepare('UPDATE capture_events SET endTs=MAX(observedAt+1,?) WHERE endTs IS NULL').run(checkpoint);
  db.prepare('UPDATE capture_gaps SET endTs=MAX(startTs+1,?) WHERE endTs IS NULL').run(checkpoint);
  db.prepare('INSERT INTO capture_gaps(id,sessionId,startTs,endTs,reason,captureGeneration) SELECT ?,?,?,?,\'process_interrupted\',captureGeneration FROM settings WHERE id=1').run(randomUUID(), randomUUID(), checkpoint, Math.max(checkpoint + 1, Date.now()));
  db.prepare("UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='dataRevision'").run();
}

type SettingsRow = { revision: number; captureEnabled: number; captureGeneration: number; backgroundTextEnabled: number; consentRevision: number; consentGeneration: number };
type AppRow = { bundleId: string; captureAllowed: number; excluded: number; textAnalysisAllowed: number };
const revision = (): number => Number((db.prepare("SELECT value FROM app_meta WHERE key='dataRevision'").get() as { value: string }).value);
const bump = (): void => { db.prepare("UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='dataRevision'").run(); };
const settingsRow = (): SettingsRow => db.prepare('SELECT * FROM settings WHERE id=1').get() as SettingsRow;
function settings(): Settings {
  const row = settingsRow();
  const apps = db.prepare('SELECT * FROM settings_apps ORDER BY bundleId').all() as AppRow[];
  return {
    revision: row.revision, captureEnabled: Boolean(row.captureEnabled), captureGeneration: row.captureGeneration,
    allowedBundleIds: apps.filter(a => a.captureAllowed).map(a => a.bundleId),
    excludedBundleIds: apps.filter(a => a.excluded).map(a => a.bundleId),
    textConsent: { enabled: Boolean(row.backgroundTextEnabled), allowedBundleIds: apps.filter(a => a.textAnalysisAllowed).map(a => a.bundleId), revision: row.consentRevision, generation: row.consentGeneration },
    screenshotRetentionDays: 30, timezone: 'Asia/Shanghai', defaultAgent: 'codex',
  };
}
function captureStatus(): CaptureStatus {
  const row = settingsRow();
  const reason = JSON.parse((db.prepare("SELECT value FROM app_meta WHERE key='captureReason'").get() as { value: string }).value) as string | null;
  return { state: row.captureEnabled ? (reason ? 'blocked' : 'running') : 'paused', revision: row.revision, generation: row.captureGeneration, lastSuccessfulAt: JSON.parse((db.prepare("SELECT value FROM app_meta WHERE key='lastSuccessfulAt'").get() as { value: string }).value), reason: row.captureEnabled ? reason : 'paused' };
}
function expectRevision(expected: number): void {
  if (expected !== settingsRow().revision) throw new StorageError('STALE_REVISION', 'Settings changed. Reload and try again.');
}
function expire(now: number): number {
  return db.transaction(() => {
    const result = db.prepare("UPDATE evidence SET status='expired',revision=revision+1,unavailableAt=?,unavailableReason='retention' WHERE status='available' AND expiresAt<=?").run(now, now);
    if (result.changes) {
      db.prepare("UPDATE source_refs SET state='expired',currentRevision=currentRevision+1,invalidatedAt=?,reason='retention' WHERE kind='image' AND state='valid' AND evidenceId IN (SELECT id FROM evidence WHERE status='expired')").run(now);
      bump();
    }
    return result.changes;
  })();
}

const commands: Record<string, (args: never) => unknown> = {
  ...createReuseCommands(db, dirname(databasePath) + '/agent-runs'),
  ...createCaptureCommands(db, { settings, expectRevision, bump, captureStatus }),
  ...createWorklogCommands(db, { revision, bump }),
  ...createPeriodSummaryCommands(db, { settings, revision, bump }),
  ...createExecutionCommands(db, { settings, revision, bump }),
  'worklog.read': createWorklogRead(db, revision),
  bootstrap: () => {
    const sqliteVersion = (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
    return { schemaVersion: migrations.at(-1)!.version, sqliteVersion, journalMode: db.pragma('journal_mode', { simple: true }), synchronous: db.pragma('synchronous', { simple: true }), foreignKeys: db.pragma('foreign_keys', { simple: true }), fts5: Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='capture_search'").get()), observationCount: (db.prepare('SELECT count(*) AS n FROM capture_events').get() as { n: number }).n, evidenceCount: (db.prepare('SELECT count(*) AS n FROM evidence').get() as { n: number }).n } as StorageDiagnostics;
  },
  'settings.get': settings,
  'capture.get': captureStatus,
  'settings.updateCaptureScope': (args: { expectedRevision: number; allowedBundleIds: string[]; excludedBundleIds: string[] }) => db.transaction(() => {
    expectRevision(args.expectedRevision);
    const previous = settings();
    db.prepare('UPDATE settings_apps SET captureAllowed=0,excluded=0,textAnalysisAllowed=0').run();
    const upsert = db.prepare('INSERT INTO settings_apps(bundleId,captureAllowed,excluded) VALUES(?,?,?) ON CONFLICT(bundleId) DO UPDATE SET captureAllowed=excluded.captureAllowed,excluded=excluded.excluded');
    for (const bundleId of new Set([...args.allowedBundleIds, ...args.excludedBundleIds])) upsert.run(bundleId, Number(args.allowedBundleIds.includes(bundleId)), Number(args.excludedBundleIds.includes(bundleId)));
    for (const bundleId of previous.textConsent.allowedBundleIds.filter(id => args.allowedBundleIds.includes(id) && !args.excludedBundleIds.includes(id))) db.prepare('UPDATE settings_apps SET textAnalysisAllowed=1 WHERE bundleId=?').run(bundleId);
    db.prepare('UPDATE settings SET revision=revision+1,captureGeneration=captureGeneration+1,consentRevision=consentRevision+1,consentGeneration=consentGeneration+1 WHERE id=1').run();
    bump(); return settings();
  })(),
  'capture.pause': (args: { expectedRevision: number }) => db.transaction(() => {
    expectRevision(args.expectedRevision);
    db.prepare('UPDATE settings SET captureEnabled=0,revision=revision+1,captureGeneration=captureGeneration+1 WHERE id=1').run();
    db.prepare("UPDATE app_meta SET value='\"paused\"' WHERE key='captureReason'").run();
    bump(); return captureStatus();
  })(),
  // Internal service command: never registered with renderer IPC.
  'capture.setEnabled': (args: { enabled: boolean; expectedRevision: number }) => db.transaction(() => {
    expectRevision(args.expectedRevision);
    db.prepare('UPDATE settings SET captureEnabled=?,revision=revision+1,captureGeneration=captureGeneration+1 WHERE id=1').run(Number(args.enabled));
    db.prepare("UPDATE app_meta SET value='null' WHERE key='captureReason'").run();
    bump(); return captureStatus();
  })(),
  'capture.commitObservation': (args: { observation: unknown; blob: BlobInput; evidenceId: string }) => db.transaction(() => {
    const observation = observationInputSchema.parse(args.observation);
    const policy = settings();
    if (!policy.captureEnabled || policy.captureGeneration !== observation.captureGeneration || !policy.allowedBundleIds.includes(observation.bundleId) || policy.excludedBundleIds.includes(observation.bundleId)) throw new StorageError('PERMISSION_DENIED', 'Capture scope or generation changed.');
    const prior = db.prepare('SELECT id FROM capture_events WHERE id=?').get(observation.id);
    if (prior) throw new StorageError('CONFLICT', 'Observation already exists.');
    db.prepare('UPDATE capture_events SET endTs=MAX(observedAt+1,?) WHERE endTs IS NULL').run(observation.observedAt);
    db.prepare('UPDATE capture_gaps SET endTs=MAX(startTs+1,?) WHERE endTs IS NULL').run(observation.observedAt);
    db.prepare("INSERT INTO evidence_blobs(id,sha256,relativePath,mime,width,height,byteSize,storageState,createdAt) VALUES(@id,@sha256,@relativePath,@mime,@width,@height,@byteSize,'ready',?) ON CONFLICT(sha256) DO UPDATE SET storageState='ready'").run(args.blob, observation.observedAt);
    const blob = db.prepare('SELECT id FROM evidence_blobs WHERE sha256=?').get(args.blob.sha256) as { id: string };
    db.prepare('INSERT INTO capture_events(id,sessionId,observedAt,bundleId,appName,pid,windowId,windowTitle,trigger,captureGeneration,pairingStatus,visibilityStatus) VALUES(@id,@sessionId,@observedAt,@bundleId,@appName,@pid,@windowId,@windowTitle,@trigger,@captureGeneration,@pairingStatus,@visibilityStatus)').run(observation);
    db.prepare("INSERT INTO evidence(id,captureEventId,blobId,observedAt,expiresAt) VALUES(?,?,?,?,?)").run(args.evidenceId, observation.id, blob.id, observation.observedAt, observation.observedAt + 30 * 86400_000);
    db.prepare("INSERT INTO source_refs(id,kind,captureEventId) VALUES(?,'observation',?)").run(randomUUID(), observation.id);
    db.prepare("INSERT INTO source_refs(id,kind,evidenceId) VALUES(?,'image',?)").run(randomUUID(), args.evidenceId);
    const change = db.prepare("INSERT INTO domain_changes(type,captureEventId,entityRevision,committedAt) VALUES('observation.committed',?,1,?)").run(observation.id, Date.now());
    db.prepare('UPDATE capture_events SET commitSequence=? WHERE id=?').run(change.lastInsertRowid, observation.id);
    db.prepare('INSERT INTO capture_search(captureEventId,title) VALUES(?,?)').run(observation.id, observation.windowTitle ?? '');
    db.prepare("UPDATE app_meta SET value='null' WHERE key='captureReason'").run();
    db.prepare("UPDATE app_meta SET value=? WHERE key='lastSuccessfulAt'").run(JSON.stringify(observation.observedAt));
    bump(); return { observationId: observation.id, evidenceId: args.evidenceId, commitSequence: Number(change.lastInsertRowid) };
  })(),
  'evidence.get': (args: { evidenceId: string; now: number }) => {
    expire(args.now);
    return db.prepare('SELECT e.id AS evidenceId,e.captureEventId,e.blobId,b.relativePath,b.sha256,b.mime,e.observedAt,e.expiresAt,e.status FROM evidence e JOIN evidence_blobs b ON e.blobId=b.id WHERE e.id=?').get(args.evidenceId) as EvidenceRecord | undefined ?? null;
  },
  'evidence.expire': (args: { now: number }) => ({ expired: expire(args.now) }),
  'evidence.blobs': () => db.prepare('SELECT * FROM evidence_blobs').all(),
  'evidence.unreferenced': (args: { blobId: string; now: number }) => !db.prepare("SELECT id FROM evidence WHERE blobId=? AND status='available' AND expiresAt>? LIMIT 1").get(args.blobId, args.now),
  'evidence.markMissing': (args: { blobId: string }) => db.transaction(() => {
    db.prepare("UPDATE evidence_blobs SET storageState='missing' WHERE id=?").run(args.blobId);
    const changes = db.prepare("UPDATE evidence SET status='missing',revision=revision+1 WHERE blobId=? AND status='available'").run(args.blobId);
    if (changes.changes) bump(); return null;
  })(),
  close: () => { db.close(); return null; },
};

parentPort.on('message', async ({ id, command, args }: { id: string; command: string; args: never }) => {
  try {
    const handler = commands[command];
    if (!handler) throw new StorageError('INVALID_ARGUMENT', 'Unknown storage command.');
    const data = await handler(args);
    if (command === 'history.delete') await commands['reuse.candidates']({} as never);
    parentPort!.postMessage({ id, ok: true, result: { data, dataRevision: command === 'close' ? 0 : revision() } });
    // Let native addon cleanup finish naturally instead of terminating its isolate after the ACK.
    if (command === 'close') parentPort!.close();
  } catch (error) {
    const known = error instanceof StorageError;
    parentPort!.postMessage({ id, ok: false, error: { code: known ? error.code : 'INTERNAL', ...(known && error.detailCode ? { detailCode: error.detailCode } : {}), message: known ? error.message : 'Storage operation failed.', retryable: false } });
  }
});
