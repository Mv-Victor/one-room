export const periodSummaryMigration = { version: 5, foreignKeysOff: false, sql: `
ALTER TABLE periods ADD COLUMN summaryOwnerRevision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE periods ADD COLUMN summaryFingerprint TEXT;
ALTER TABLE periods ADD COLUMN summaryErrorCode TEXT;
CREATE TABLE period_summary_jobs (
  id TEXT PRIMARY KEY, periodId TEXT NOT NULL REFERENCES periods(id), ownerRevision INTEGER NOT NULL,
  level INTEGER NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  inputJson TEXT, resultJson TEXT, payloadHash TEXT NOT NULL, resultRevision INTEGER NOT NULL DEFAULT 1,
  consentRevision INTEGER, consentGeneration INTEGER, sourceGeneration INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, errorCode TEXT,
  UNIQUE(periodId,ownerRevision,level,ordinal)
);
CREATE INDEX period_summary_queue ON period_summary_jobs(status,createdAt,id);
CREATE INDEX period_summary_owner ON period_summary_jobs(periodId,ownerRevision,level,ordinal);
CREATE TABLE period_summary_job_sources (
  jobId TEXT NOT NULL REFERENCES period_summary_jobs(id), sourceRefId TEXT NOT NULL REFERENCES source_refs(id),
  sourceRevision INTEGER NOT NULL, PRIMARY KEY(jobId,sourceRefId)
);
CREATE INDEX period_summary_source ON period_summary_job_sources(sourceRefId,jobId);
CREATE TABLE period_summary_job_inputs (
  jobId TEXT NOT NULL REFERENCES period_summary_jobs(id), inputJobId TEXT NOT NULL REFERENCES period_summary_jobs(id),
  inputRevision INTEGER NOT NULL, PRIMARY KEY(jobId,inputJobId)
);
` };
