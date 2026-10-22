export const worklogMigration = { version: 3, foreignKeysOff: false, sql: `
CREATE TABLE reports (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('daily','weekly')), dateKey TEXT NOT NULL,
  rangeStart INTEGER NOT NULL, rangeEnd INTEGER NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  status TEXT NOT NULL CHECK(status IN ('ready','invalidated')), snapshot TEXT,
  sourceRevision INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, linkedTargetId TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, CHECK(rangeEnd>rangeStart)
);
CREATE INDEX reports_range ON reports(kind,rangeStart,rangeEnd,createdAt DESC);
CREATE TABLE report_sources (
  reportId TEXT NOT NULL REFERENCES reports(id), sourceRefId TEXT NOT NULL REFERENCES source_refs(id),
  sourceRevision INTEGER NOT NULL, purpose TEXT NOT NULL DEFAULT 'snapshot',
  PRIMARY KEY(reportId,sourceRefId,purpose)
);
CREATE INDEX report_sources_source ON report_sources(sourceRefId,reportId);
CREATE TABLE report_receipts (
  idempotencyKey TEXT PRIMARY KEY, payloadHash TEXT NOT NULL,
  reportId TEXT NOT NULL REFERENCES reports(id), createdAt INTEGER NOT NULL
);
CREATE TABLE history_delete_previews (
  deletionRef TEXT PRIMARY KEY, rangeJson TEXT NOT NULL, dataRevision INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE history_delete_receipts (
  idempotencyKey TEXT PRIMARY KEY, deletionRef TEXT NOT NULL UNIQUE, payloadHash TEXT NOT NULL,
  cleanup TEXT NOT NULL CHECK(cleanup IN ('complete','pending')), dataRevision INTEGER NOT NULL,
  affectedJson TEXT NOT NULL, cleanupBlobsJson TEXT NOT NULL, generationsJson TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
` };
