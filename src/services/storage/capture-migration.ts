export const captureMigration = { version: 2, foreignKeysOff: true, sql: `
CREATE TABLE text_evidence (
  id TEXT PRIMARY KEY, captureEventId TEXT NOT NULL REFERENCES capture_events(id),
  source TEXT NOT NULL CHECK(source IN ('accessibility','ocr')), status TEXT NOT NULL,
  completeness TEXT NOT NULL, text TEXT NOT NULL, fallbackReason TEXT, observedAt INTEGER NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(captureEventId,source)
);
CREATE TABLE activity_events (
  id TEXT PRIMARY KEY, captureEventId TEXT NOT NULL UNIQUE REFERENCES capture_events(id),
  action TEXT NOT NULL DEFAULT 'unknown', activityType TEXT NOT NULL DEFAULT 'unknown',
  objectLabel TEXT, topic TEXT, summary TEXT, basis TEXT NOT NULL DEFAULT 'observed',
  analysisStatus TEXT NOT NULL DEFAULT 'not_authorized', manuallyLocked INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, deletedAt INTEGER
);
CREATE TABLE source_refs_v2 (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  captureEventId TEXT REFERENCES capture_events(id), evidenceId TEXT REFERENCES evidence(id),
  periodId TEXT REFERENCES periods(id), textEvidenceId TEXT REFERENCES text_evidence(id),
  activityEventId TEXT REFERENCES activity_events(id), currentRevision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'valid', invalidatedAt INTEGER, reason TEXT,
  CHECK((captureEventId IS NOT NULL)+(evidenceId IS NOT NULL)+(periodId IS NOT NULL)+(textEvidenceId IS NOT NULL)+(activityEventId IS NOT NULL)=1),
  CHECK((kind='observation' AND captureEventId IS NOT NULL) OR (kind='image' AND evidenceId IS NOT NULL)
    OR (kind='period' AND periodId IS NOT NULL) OR (kind='text' AND textEvidenceId IS NOT NULL)
    OR (kind='activity' AND activityEventId IS NOT NULL))
);
INSERT INTO source_refs_v2(id,kind,captureEventId,evidenceId,periodId,currentRevision,state,invalidatedAt,reason)
  SELECT id,kind,captureEventId,evidenceId,periodId,currentRevision,state,invalidatedAt,reason FROM source_refs;
DROP TABLE source_refs;
ALTER TABLE source_refs_v2 RENAME TO source_refs;
CREATE UNIQUE INDEX source_observation ON source_refs(captureEventId) WHERE captureEventId IS NOT NULL;
CREATE UNIQUE INDEX source_image ON source_refs(evidenceId) WHERE evidenceId IS NOT NULL;
CREATE UNIQUE INDEX source_period ON source_refs(periodId) WHERE periodId IS NOT NULL;
CREATE UNIQUE INDEX source_text ON source_refs(textEvidenceId) WHERE textEvidenceId IS NOT NULL;
CREATE UNIQUE INDEX source_activity ON source_refs(activityEventId) WHERE activityEventId IS NOT NULL;
CREATE TABLE activity_event_sources (
  activityEventId TEXT NOT NULL REFERENCES activity_events(id), sourceRefId TEXT NOT NULL REFERENCES source_refs(id),
  sourceRevision INTEGER NOT NULL, PRIMARY KEY(activityEventId,sourceRefId)
);
CREATE TABLE activity_event_revisions (
  activityEventId TEXT NOT NULL REFERENCES activity_events(id), revision INTEGER NOT NULL,
  changedAt INTEGER NOT NULL, changedBy TEXT NOT NULL, snapshot TEXT NOT NULL,
  PRIMARY KEY(activityEventId,revision)
);
CREATE TABLE domain_changes_v2 (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
  captureEventId TEXT REFERENCES capture_events(id), periodId TEXT REFERENCES periods(id),
  activityEventId TEXT REFERENCES activity_events(id), entityRevision INTEGER NOT NULL, committedAt INTEGER NOT NULL,
  CHECK((captureEventId IS NOT NULL)+(periodId IS NOT NULL)+(activityEventId IS NOT NULL)=1)
);
INSERT INTO domain_changes_v2(sequence,type,captureEventId,periodId,entityRevision,committedAt)
  SELECT sequence,type,captureEventId,periodId,entityRevision,committedAt FROM domain_changes;
DROP TABLE domain_changes;
ALTER TABLE domain_changes_v2 RENAME TO domain_changes;
CREATE VIRTUAL TABLE text_search USING fts5(textEvidenceId UNINDEXED,text,tokenize='trigram');
INSERT INTO app_meta VALUES ('captureReason','"paused"');
` };
