// Versioned schema: add a new migration rather than changing this SQL after release.
export const REUSE_SCHEMA_V1 = `
CREATE TABLE or_candidates (id TEXT PRIMARY KEY, target TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  kind TEXT NOT NULL, instances INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new',
  evidence TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}');
CREATE TABLE or_skills (id TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY(id,version));
CREATE TABLE or_runs (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version INTEGER NOT NULL,
  target TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  log TEXT NOT NULL DEFAULT '', receipt TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX or_runs_target_active ON or_runs(target) WHERE state IN
  ('queued','reading','generating','applying','verifying','needs_verification');
CREATE TABLE or_rules (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL);
`
