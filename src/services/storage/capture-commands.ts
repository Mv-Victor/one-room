import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActivityReviewSchema, type Activity } from '../../shared/activity-schemas';
import { UpdateTextConsentSchema, type CaptureStatus, type Settings } from '../../shared/schemas';
import { StorageError } from './client';
import { inferLocalActivity } from '../worklog/activity-events';
import type { CaptureTrigger } from '../capture/triggers';
import { ActivityAnalysisSchema } from '../../shared/model-schemas';

export const TextRecordSchema = z.strictObject({
  source: z.enum(['accessibility', 'ocr']), status: z.enum(['ready', 'partial', 'empty', 'failed']),
  completeness: z.enum(['complete', 'thin', 'partial', 'empty', 'unknown']),
  text: z.string().max(100000), fallbackReason: z.string().max(256).nullable(), observedAt: z.number().int(),
});
export type TextRecord = z.infer<typeof TextRecordSchema>;
export type AnalysisJob = {
  id: string; consentRevision: number; consentGeneration: number;
  input: { periodId: string; sources: { sourceRefId: string; revision: number; appBundleId: string; observedAt: number; text: string }[] };
};
type Analysis = { activityAction: string; activityType: string; objectLabel: string | null; topic: string | null; summary: string | null; sourceRefIds: string[] };

export function createCaptureCommands(db: Database.Database, host: {
  settings(): Settings; expectRevision(revision: number): void; bump(): void; captureStatus(): CaptureStatus;
}): Record<string, (args: never) => unknown> {
  const observation = (id: string) => db.prepare('SELECT * FROM capture_events WHERE id=? AND deletedAt IS NULL').get(id) as { id: string; bundleId: string; captureGeneration: number; observedAt: number } | undefined;
  const allowed = (id: string, generation: number) => {
    const row = observation(id), policy = host.settings();
    if (!row || !policy.captureEnabled || policy.captureGeneration !== generation || !policy.allowedBundleIds.includes(row.bundleId) || policy.excludedBundleIds.includes(row.bundleId)) throw new StorageError('SOURCE_INVALIDATED', 'The observation scope changed.');
    return row;
  };
  const authorize = (job: AnalysisJob): boolean => {
    const policy = host.settings();
    if (!policy.textConsent.enabled || policy.textConsent.revision !== job.consentRevision || policy.textConsent.generation !== job.consentGeneration || !job.input.sources.length) return false;
    return job.input.sources.every(source => {
      const row = db.prepare(`SELECT s.currentRevision,s.state,t.text,c.bundleId,c.deletedAt FROM source_refs s
        JOIN text_evidence t ON t.id=s.textEvidenceId JOIN capture_events c ON c.id=t.captureEventId WHERE s.id=?`).get(source.sourceRefId) as { currentRevision: number; state: string; text: string; bundleId: string; deletedAt: number | null } | undefined;
      return row && row.deletedAt === null && row.state === 'valid' && row.currentRevision === source.revision && row.text.slice(0, 20000) === source.text && row.bundleId === source.appBundleId && policy.allowedBundleIds.includes(row.bundleId) && policy.textConsent.allowedBundleIds.includes(row.bundleId) && !policy.excludedBundleIds.includes(row.bundleId);
    });
  };
  const appendActivityChange = (id: string, revision: number) => db.prepare("INSERT INTO domain_changes(type,activityEventId,entityRevision,committedAt) VALUES('activity.committed',?,?,?)").run(id, revision, Date.now());
  const snapshot = (id: string, changedBy: string) => {
    const row = db.prepare('SELECT * FROM activity_events WHERE id=?').get(id) as { revision: number };
    db.prepare('INSERT INTO activity_event_revisions VALUES(?,?,?,?,?)').run(id, row.revision, Date.now(), changedBy, JSON.stringify(row));
  };
  return {
    'settings.updateTextConsent': (input: unknown) => db.transaction(() => {
      const args = UpdateTextConsentSchema.parse(input);
      host.expectRevision(args.expectedRevision);
      if (args.enabled && !args.confirmed) throw new StorageError('PERMISSION_DENIED', 'Confirm background text analysis first.');
      const policy = host.settings();
      if (args.allowedBundleIds.some(id => !policy.allowedBundleIds.includes(id) || policy.excludedBundleIds.includes(id))) throw new StorageError('INVALID_ARGUMENT', 'Text scope must be inside the capture scope.');
      if (args.enabled && !args.allowedBundleIds.length) throw new StorageError('INVALID_ARGUMENT', 'Choose at least one application.');
      db.prepare('UPDATE settings_apps SET textAnalysisAllowed=0').run();
      for (const id of new Set(args.allowedBundleIds)) db.prepare('UPDATE settings_apps SET textAnalysisAllowed=1 WHERE bundleId=?').run(id);
      db.prepare('UPDATE settings SET backgroundTextEnabled=?,revision=revision+1,consentRevision=consentRevision+1,consentGeneration=consentGeneration+1 WHERE id=1').run(Number(args.enabled));
      host.bump(); return host.settings();
    })(),
    'capture.gap': (args: { sessionId: string; generation: number; reason: string; at: number }) => db.transaction(() => {
      const policy = host.settings();
      if (args.generation !== policy.captureGeneration) return host.captureStatus();
      db.prepare('UPDATE capture_events SET endTs=MAX(observedAt+1,?) WHERE endTs IS NULL').run(args.at);
      const prior = db.prepare('SELECT reason FROM capture_gaps WHERE endTs IS NULL').get() as { reason: string } | undefined;
      if (prior?.reason !== args.reason) {
        db.prepare('UPDATE capture_gaps SET endTs=MAX(startTs+1,?) WHERE endTs IS NULL').run(args.at);
        db.prepare('INSERT INTO capture_gaps(id,sessionId,startTs,reason,captureGeneration) VALUES(?,?,?,?,?)').run(randomUUID(), args.sessionId, args.at, args.reason, args.generation);
      }
      db.prepare("UPDATE app_meta SET value=? WHERE key='captureReason'").run(JSON.stringify(args.reason));
      host.bump(); return host.captureStatus();
    })(),
    'capture.invalidate': (args: { generation: number }) => db.transaction(() => {
      if (host.settings().captureGeneration === args.generation) {
        db.prepare('UPDATE settings SET captureGeneration=captureGeneration+1,revision=revision+1 WHERE id=1').run();
        host.bump();
      }
      return host.settings();
    })(),
    'capture.raw': (args: { since?: number; limit?: number }) => ({
      observations: db.prepare('SELECT * FROM capture_events WHERE deletedAt IS NULL AND observedAt>=? ORDER BY observedAt,id LIMIT ?').all(args.since ?? 0, Math.min(args.limit ?? 500, 1000)),
      gaps: db.prepare('SELECT * FROM capture_gaps WHERE COALESCE(endTs,9223372036854775807)>=? ORDER BY startTs LIMIT 1000').all(args.since ?? 0),
    }),
    'text.authorize': (args: { observationId: string; generation: number; requireImage?: boolean }) => {
      allowed(args.observationId, args.generation);
      if (args.requireImage && !db.prepare("SELECT id FROM evidence WHERE captureEventId=? AND status='available' AND expiresAt>?").get(args.observationId, Date.now())) throw new StorageError('SOURCE_INVALIDATED', 'The screenshot is unavailable.');
      return true;
    },
    'text.fail': (args: { observationId: string }) => { const result = db.prepare("UPDATE capture_events SET textStatus='failed' WHERE id=? AND deletedAt IS NULL AND textStatus='pending'").run(args.observationId); if (result.changes) host.bump(); return null; },
    'text.commit': (args: { observationId: string; generation: number; records: TextRecord[]; selectedSource: 'accessibility' | 'ocr' | null; action: string }) => db.transaction(() => {
      const captured = allowed(args.observationId, args.generation);
      const records = z.array(TextRecordSchema).max(2).parse(args.records);
      if (records.some(r => r.source === 'ocr' && r.text) && !db.prepare("SELECT id FROM evidence WHERE captureEventId=? AND status='available' AND expiresAt>?").get(args.observationId, Date.now())) throw new StorageError('SOURCE_INVALIDATED', 'The OCR screenshot is unavailable.');
      if (new Set(records.map(r => r.source)).size !== records.length) throw new StorageError('INVALID_ARGUMENT', 'Duplicate extraction source.');
      for (const record of records) {
        const id = randomUUID();
        db.prepare('INSERT INTO text_evidence(id,captureEventId,source,status,completeness,text,fallbackReason,observedAt,selected) VALUES(?,?,?,?,?,?,?,?,?)').run(id, args.observationId, record.source, record.status, record.completeness, record.text, record.fallbackReason, record.observedAt, Number(record.source === args.selectedSource));
        db.prepare("INSERT INTO source_refs(id,kind,textEvidenceId) VALUES(?,'text',?)").run(randomUUID(), id);
        db.prepare('INSERT INTO text_search(textEvidenceId,text) VALUES(?,?)').run(id, record.text);
      }
      const selected = records.find(r => r.source === args.selectedSource);
      const current = db.prepare('SELECT bundleId,windowId,trigger FROM capture_events WHERE id=?').get(args.observationId) as { bundleId: string; windowId: number; trigger: CaptureTrigger };
      const previous = db.prepare(`SELECT c.bundleId,c.windowId,t.text FROM capture_events c JOIN text_evidence t ON t.captureEventId=c.id AND t.selected=1
        WHERE c.observedAt<? AND c.deletedAt IS NULL ORDER BY c.observedAt DESC LIMIT 1`).get(captured.observedAt) as { bundleId: string; windowId: number; text: string } | undefined;
      const local = inferLocalActivity({ trigger: current.trigger, current: { authorized: true, objectKey: `${current.bundleId}:${current.windowId}`, text: selected?.text ?? null },
        previous: previous ? { authorized: true, objectKey: `${previous.bundleId}:${previous.windowId}`, text: previous.text } : null });
      db.prepare('UPDATE capture_events SET textStatus=?,revision=revision+1 WHERE id=?').run(selected?.status ?? 'failed', args.observationId);
      const activityId = randomUUID();
      db.prepare('INSERT INTO activity_events(id,captureEventId,action,basis) VALUES(?,?,?,?)').run(activityId, args.observationId, local.action, local.basis);
      db.prepare("INSERT INTO source_refs(id,kind,activityEventId) VALUES(?,'activity',?)").run(randomUUID(), activityId);
      db.prepare(`INSERT INTO activity_event_sources SELECT ?,s.id,s.currentRevision FROM source_refs s
        LEFT JOIN text_evidence t ON t.id=s.textEvidenceId WHERE s.captureEventId=? OR (t.captureEventId=? AND t.selected=1)`).run(activityId, args.observationId, args.observationId);
      appendActivityChange(activityId, 1); snapshot(activityId, 'local'); host.bump();
      return { activityId };
    })(),
    'analysis.prepare': (args: { observationId: string }): AnalysisJob | null => {
      const row = observation(args.observationId), policy = host.settings();
      if (!row || !policy.textConsent.enabled || !policy.textConsent.allowedBundleIds.includes(row.bundleId)) return null;
      const activity = db.prepare('SELECT manuallyLocked FROM activity_events WHERE captureEventId=? AND deletedAt IS NULL').get(args.observationId) as { manuallyLocked: number } | undefined;
      if (!activity || activity.manuallyLocked) return null;
      const sources = db.prepare(`SELECT s.id AS sourceRefId,s.currentRevision AS revision,c.bundleId AS appBundleId,c.observedAt,t.text FROM text_evidence t
        JOIN source_refs s ON s.textEvidenceId=t.id JOIN capture_events c ON c.id=t.captureEventId
        WHERE t.captureEventId=? AND t.selected=1 AND length(t.text)>0 AND s.state='valid'`).all(args.observationId) as AnalysisJob['input']['sources'];
      const job = { id: randomUUID(), consentRevision: policy.textConsent.revision, consentGeneration: policy.textConsent.generation, input: { periodId: args.observationId, sources: sources.map(s => ({ ...s, text: s.text.slice(0, 20000) })) } };
      if (!authorize(job)) return null;
      db.prepare("UPDATE activity_events SET analysisStatus='pending' WHERE captureEventId=? AND manuallyLocked=0").run(args.observationId);
      host.bump();
      return job;
    },
    'analysis.authorize': (args: AnalysisJob) => authorize(args),
    'analysis.commit': (args: { job: AnalysisJob; analysis: Analysis }) => db.transaction(() => {
      if (!authorize(args.job)) throw new StorageError('SOURCE_INVALIDATED', 'Analysis authorization changed.');
      const analysis = ActivityAnalysisSchema.parse(args.analysis);
      if (analysis.sourceRefIds.some(id => !args.job.input.sources.some(s => s.sourceRefId === id))) throw new StorageError('INVALID_ARGUMENT', 'Unknown model source.');
      const row = db.prepare('SELECT id,revision,manuallyLocked,action FROM activity_events WHERE captureEventId=? AND deletedAt IS NULL').get(args.job.input.periodId) as { id: string; revision: number; manuallyLocked: number; action: string } | undefined;
      if (!row || row.manuallyLocked) return null;
      const action = row.action !== 'unknown' ? row.action : analysis.activityAction === 'suspected_edit' || analysis.activityAction === 'context_switch' ? 'unknown' : analysis.activityAction;
      db.prepare("UPDATE activity_events SET action=?,activityType=?,objectLabel=?,topic=?,summary=?,basis='inferred',analysisStatus='ready',revision=revision+1 WHERE id=?").run(action, analysis.activityType, analysis.objectLabel, analysis.topic, analysis.summary, row.id);
      db.prepare('UPDATE source_refs SET currentRevision=currentRevision+1 WHERE activityEventId=?').run(row.id);
      appendActivityChange(row.id, row.revision + 1); snapshot(row.id, 'model'); host.bump(); return row.id;
    })(),
    'analysis.failed': (args: { observationId: string; status?: string }) => { const result = db.prepare("UPDATE activity_events SET analysisStatus=? WHERE captureEventId=? AND manuallyLocked=0 AND analysisStatus='pending' AND deletedAt IS NULL").run(args.status === 'not_configured' ? 'not_configured' : 'failed', args.observationId); if (result.changes) host.bump(); return null; },
    'activity.query': (args: { before?: number; limit?: number }) => {
      const limit = Math.min(args.limit ?? 50, 100);
      const rows = db.prepare(`SELECT a.id,c.id AS observationId,c.observedAt,c.bundleId AS appBundleId,c.appName,c.windowTitle,
        a.action,a.activityType,a.objectLabel,a.topic,a.summary,a.basis,a.revision,c.textStatus,a.analysisStatus,
        t.text,t.source AS extractionSource FROM activity_events a JOIN capture_events c ON c.id=a.captureEventId
        LEFT JOIN text_evidence t ON t.captureEventId=c.id AND t.selected=1
        WHERE a.deletedAt IS NULL AND c.deletedAt IS NULL AND c.observedAt<? ORDER BY c.observedAt DESC LIMIT ?`).all(args.before ?? Number.MAX_SAFE_INTEGER, limit) as Omit<Activity, 'sourceRefIds'>[];
      return { items: rows.map(row => ({ ...row, sourceRefIds: (db.prepare('SELECT sourceRefId FROM activity_event_sources WHERE activityEventId=?').all(row.id) as { sourceRefId: string }[]).map(s => s.sourceRefId) })), nextBefore: rows.length === limit ? rows.at(-1)!.observedAt : null };
    },
    'activity.review': (input: unknown) => db.transaction(() => {
      const args = ActivityReviewSchema.parse(input);
      const row = db.prepare('SELECT revision FROM activity_events WHERE id=? AND deletedAt IS NULL').get(args.id) as { revision: number } | undefined;
      if (!row || row.revision !== args.expectedRevision) throw new StorageError('STALE_REVISION', 'Activity changed. Reload it first.');
      db.prepare("UPDATE activity_events SET action=?,activityType=?,objectLabel=?,topic=?,basis='confirmed',analysisStatus='ready',manuallyLocked=1,revision=revision+1 WHERE id=?").run(args.action, args.activityType, args.objectLabel, args.topic, args.id);
      db.prepare('UPDATE source_refs SET currentRevision=currentRevision+1 WHERE activityEventId=?').run(args.id);
      appendActivityChange(args.id, row.revision + 1); snapshot(args.id, 'user'); host.bump(); return { revised: true };
    })(),
  };
}
