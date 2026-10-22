import { captureMigration } from './capture-migration';
import { worklogMigration } from './worklog-migration';
import { reuseMigration } from './reuse-migration';
import { periodSummaryMigration } from './period-summary-migration';
import { executionMigration } from './execution-migration';

export const migrations = [{ version: 1, foreignKeysOff: false, sql: `
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO app_meta VALUES ('dataRevision','1'), ('lastSuccessfulAt','null');
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
  captureEnabled INTEGER NOT NULL DEFAULT 0, captureGeneration INTEGER NOT NULL DEFAULT 1,
  backgroundTextEnabled INTEGER NOT NULL DEFAULT 0, consentRevision INTEGER NOT NULL DEFAULT 1,
  consentGeneration INTEGER NOT NULL DEFAULT 1, sourceGeneration INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', screenshotRetentionDays INTEGER NOT NULL DEFAULT 30 CHECK(screenshotRetentionDays=30),
  defaultAgent TEXT NOT NULL DEFAULT 'codex'
);
INSERT INTO settings(id,revision) VALUES(1,1);
CREATE TABLE settings_apps (
  bundleId TEXT PRIMARY KEY, captureAllowed INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0, textAnalysisAllowed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE capture_events (
  id TEXT PRIMARY KEY, commitSequence INTEGER UNIQUE, sessionId TEXT NOT NULL,
  observedAt INTEGER NOT NULL, endTs INTEGER, bundleId TEXT NOT NULL, appName TEXT NOT NULL,
  pid INTEGER NOT NULL, windowId INTEGER NOT NULL, windowTitle TEXT,
  trigger TEXT NOT NULL, captureGeneration INTEGER NOT NULL,
  pairingStatus TEXT NOT NULL CHECK(pairingStatus='matched'),
  visibilityStatus TEXT NOT NULL CHECK(visibilityStatus='verified'),
  textStatus TEXT NOT NULL DEFAULT 'pending', revision INTEGER NOT NULL DEFAULT 1, deletedAt INTEGER
);
CREATE INDEX capture_events_time ON capture_events(observedAt,id);
CREATE INDEX capture_events_app_time ON capture_events(bundleId,observedAt);
CREATE TABLE evidence_blobs (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, relativePath TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, byteSize INTEGER NOT NULL,
  storageState TEXT NOT NULL DEFAULT 'ready', createdAt INTEGER NOT NULL
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, captureEventId TEXT NOT NULL UNIQUE REFERENCES capture_events(id),
  blobId TEXT NOT NULL REFERENCES evidence_blobs(id), observedAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'available',
  revision INTEGER NOT NULL DEFAULT 1, unavailableAt INTEGER, unavailableReason TEXT
);
CREATE INDEX evidence_expiry ON evidence(status,expiresAt);
CREATE INDEX evidence_blob_validity ON evidence(blobId,status,expiresAt);
CREATE TABLE capture_gaps (
  id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, startTs INTEGER NOT NULL, endTs INTEGER,
  reason TEXT NOT NULL, captureGeneration INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  CHECK(endTs IS NULL OR endTs>startTs)
);
CREATE INDEX gaps_time ON capture_gaps(startTs,endTs);
CREATE TABLE periods (
  id TEXT PRIMARY KEY, startTs INTEGER NOT NULL, endTs INTEGER, appBundleId TEXT NOT NULL,
  appName TEXT NOT NULL, activityType TEXT NOT NULL DEFAULT 'unknown',
  objectLabel TEXT, topic TEXT, summary TEXT, basis TEXT NOT NULL DEFAULT 'observed',
  summaryStatus TEXT NOT NULL DEFAULT 'not_authorized', manuallyLocked INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, deletedAt INTEGER,
  CHECK(endTs IS NULL OR endTs>startTs)
);
CREATE INDEX periods_time ON periods(startTs,id);
CREATE TABLE source_refs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  captureEventId TEXT REFERENCES capture_events(id), evidenceId TEXT REFERENCES evidence(id),
  periodId TEXT REFERENCES periods(id), currentRevision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'valid', invalidatedAt INTEGER, reason TEXT,
  CHECK((kind='observation' AND captureEventId IS NOT NULL AND evidenceId IS NULL AND periodId IS NULL)
    OR (kind='image' AND evidenceId IS NOT NULL AND captureEventId IS NULL AND periodId IS NULL)
    OR (kind='period' AND periodId IS NOT NULL AND captureEventId IS NULL AND evidenceId IS NULL))
);
CREATE UNIQUE INDEX source_observation ON source_refs(captureEventId) WHERE captureEventId IS NOT NULL;
CREATE UNIQUE INDEX source_image ON source_refs(evidenceId) WHERE evidenceId IS NOT NULL;
CREATE UNIQUE INDEX source_period ON source_refs(periodId) WHERE periodId IS NOT NULL;
CREATE TABLE period_sources (
  periodId TEXT NOT NULL REFERENCES periods(id), sourceRefId TEXT NOT NULL REFERENCES source_refs(id),
  sourceRevision INTEGER NOT NULL, role TEXT NOT NULL, PRIMARY KEY(periodId,sourceRefId,role)
);
CREATE TABLE domain_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
  captureEventId TEXT REFERENCES capture_events(id), periodId TEXT REFERENCES periods(id),
  entityRevision INTEGER NOT NULL, committedAt INTEGER NOT NULL,
  CHECK((captureEventId IS NOT NULL)+(periodId IS NOT NULL)=1)
);
CREATE VIRTUAL TABLE capture_search USING fts5(captureEventId UNINDEXED,title,tokenize='trigram');
` }, captureMigration, worklogMigration, reuseMigration, periodSummaryMigration, executionMigration];
