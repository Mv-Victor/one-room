import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { Period } from '../../shared/schemas';

export type PeriodSummarySource = { id: string; currentRevision: number; kind: string; captureEventId: string | null; activityEventId: string | null };
export function periodSummaryOwner(db: Database.Database, period: Period, observationIds: string[]) {
  const ids = JSON.stringify(observationIds);
  const sources = db.prepare(`SELECT s.id,s.currentRevision,s.kind,s.captureEventId,s.activityEventId FROM source_refs s
    WHERE s.state='valid' AND s.captureEventId IN (SELECT value FROM json_each(@ids))
    UNION ALL SELECT s.id,s.currentRevision,s.kind,s.captureEventId,s.activityEventId FROM text_evidence t
      JOIN source_refs s ON s.textEvidenceId=t.id WHERE s.state='valid' AND t.selected=1 AND t.captureEventId IN (SELECT value FROM json_each(@ids))
    UNION ALL SELECT s.id,s.currentRevision,s.kind,s.captureEventId,s.activityEventId FROM activity_events a
      JOIN source_refs s ON s.activityEventId=a.id WHERE s.state='valid' AND a.deletedAt IS NULL AND a.captureEventId IN (SELECT value FROM json_each(@ids))
    ORDER BY id`).all({ ids }) as PeriodSummarySource[];
  const manuallyLocked = Boolean(db.prepare('SELECT 1 FROM activity_events WHERE captureEventId IN (SELECT value FROM json_each(?)) AND manuallyLocked=1 AND deletedAt IS NULL LIMIT 1').get(ids));
  const fingerprint = createHash('sha256').update(JSON.stringify([period, sources.map(s => [s.id, s.currentRevision]), manuallyLocked])).digest('hex');
  return { period, sources, manuallyLocked, fingerprint };
}
