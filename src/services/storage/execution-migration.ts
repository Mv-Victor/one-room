export const executionMigration = { version: 6, foreignKeysOff: false, sql: `
CREATE TABLE document_targets (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE skills (id TEXT PRIMARY KEY, draftRevision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE skill_versions (id TEXT PRIMARY KEY, skillId TEXT NOT NULL REFERENCES skills(id), version INTEGER NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body)), UNIQUE(skillId,version));
CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, generation INTEGER NOT NULL, skillVersionId TEXT NOT NULL REFERENCES skill_versions(id),
  targetId TEXT NOT NULL REFERENCES document_targets(id), sourceGeneration INTEGER NOT NULL, body TEXT CHECK(body IS NULL OR json_valid(body)),
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE run_sources (runId TEXT NOT NULL REFERENCES runs(id), sourceRefId TEXT NOT NULL REFERENCES source_refs(id),
  sourceRevision INTEGER NOT NULL, PRIMARY KEY(runId,sourceRefId));
CREATE INDEX run_sources_source ON run_sources(sourceRefId);
CREATE TABLE document_operations (id TEXT PRIMARY KEY, runId TEXT NOT NULL UNIQUE REFERENCES runs(id), targetId TEXT NOT NULL REFERENCES document_targets(id),
  idempotencyKey TEXT NOT NULL, payloadHash TEXT NOT NULL, status TEXT NOT NULL, body TEXT CHECK(body IS NULL OR json_valid(body)), UNIQUE(targetId,idempotencyKey));
CREATE TABLE execution_receipts (scope TEXT NOT NULL, idempotencyKey TEXT NOT NULL, payloadHash TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(scope,idempotencyKey));
CREATE TABLE agent_capabilities (provider TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
` };
