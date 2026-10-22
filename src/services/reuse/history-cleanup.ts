import type Database from 'better-sqlite3';
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { StorageError } from '../storage/client';

// Run inside the history deletion transaction, before discovery replaces its source links.
export function scrubReuseSources(db: Database.Database, observationIds: readonly string[]): string[] {
  if (!observationIds.length) return [];
  const candidates = (db.prepare(`SELECT DISTINCT c.id FROM or_candidates c, json_each(c.evidence) e
    WHERE e.value IN (SELECT value FROM json_each(?))`).all(JSON.stringify(observationIds)) as { id: string }[]).map(row => row.id);
  const params = { candidates: JSON.stringify(candidates), observations: JSON.stringify(observationIds) };
  const affectedBody = `(json_extract(body,'$.candidateId') IN (SELECT value FROM json_each(@candidates))
    OR EXISTS(SELECT 1 FROM json_each(body,'$.sourceObservationIds') source
      WHERE source.value IN (SELECT value FROM json_each(@observations))))`;
  const runIds = (db.prepare(`SELECT r.id FROM or_runs r WHERE EXISTS(SELECT 1 FROM or_skills
    WHERE id=r.skill_id AND version=r.version AND ${affectedBody})`).all(params) as { id: string }[]).map(row => row.id);
  const active = db.prepare(`SELECT 1 FROM or_runs WHERE id IN (SELECT value FROM json_each(?))
    AND state IN ('queued','reading','generating','applying','verifying') LIMIT 1`).get(JSON.stringify(runIds));
  if (active) throw new StorageError('CAPABILITY_BLOCKED', '相关流程仍在执行，请先停止并等待执行结束后再删除历史。');
  db.prepare('DELETE FROM or_runs WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(runIds));
  db.prepare(`DELETE FROM or_skills WHERE ${affectedBody}`).run(params);
  db.prepare(`DELETE FROM or_rules WHERE ${affectedBody}`).run(params);
  db.prepare('DELETE FROM or_candidates WHERE id IN (SELECT value FROM json_each(?))').run(params.candidates);
  return runIds;
}

export async function cleanupReuseRunFiles(directory: string, runIds: readonly string[]): Promise<void> {
  const parsed = z.array(z.uuid()).safeParse(runIds);
  if (!parsed.success) throw new StorageError('INVALID_ARGUMENT', 'Invalid agent run cleanup identity.');
  if (!parsed.data.length) return;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StorageError('INTERNAL', 'Invalid agent run storage directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const id of new Set(parsed.data)) {
    await rm(join(directory, id), { recursive: true, force: true });
    await rm(join(directory, 'workflows', 'runs', id), { recursive: true, force: true });
  }
}
