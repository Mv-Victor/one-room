import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { ActivityAnalysisInputSchema, ActivityAnalysisSchema, ModelTaskSchema, type ActivityAnalysis, type ModelTask } from '../../shared/model-schemas';
import type { Period, Settings } from '../../shared/schemas';
import { dateKey, dayBounds } from '../../shared/time';
import { summaryBatches, summaryInput, type SummarySource } from '../worklog/period-summary';
import { createWorklogRead } from './worklog-read';
import { StorageError } from './client';
import { periodSummaryOwner } from './period-summary-state';

type Owner = ReturnType<typeof periodSummaryOwner>;
type StoredPeriod = { id: string; startTs: number; endTs: number; appBundleId: string; summaryOwnerRevision: number; summaryFingerprint: string; manuallyLocked: number; deletedAt: number | null; summaryStatus: string };
type JobRow = { id: string; periodId: string; ownerRevision: number; level: number; ordinal: number; status: string; inputJson: string | null; resultJson: string | null; payloadHash: string; resultRevision: number; consentRevision: number; consentGeneration: number; sourceGeneration: number };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jsonIds = (ids: string[]) => JSON.stringify(ids);

export function scrubPeriodSummaryJobs(db: Database.Database, periodIds: string[], at: number): void {
  db.prepare("UPDATE period_summary_jobs SET status='canceled',inputJson=NULL,resultJson=NULL,errorCode='SOURCE_INVALIDATED',updatedAt=? WHERE periodId IN (SELECT value FROM json_each(?))")
    .run(at, jsonIds(periodIds));
}

export function createPeriodSummaryCommands(db: Database.Database, host: { settings(): Settings; revision(): number; bump(): void }): Record<string, (args: never) => unknown> {
  const read = createWorklogRead(db, host.revision, false, true);
  const stored = (id: string, includeDeleted = false) => db.prepare(`SELECT * FROM periods WHERE id=?${includeDeleted ? '' : ' AND deletedAt IS NULL'}`).get(id) as StoredPeriod | undefined;
  const sourceGeneration = () => (db.prepare('SELECT sourceGeneration FROM settings WHERE id=1').get() as { sourceGeneration: number }).sourceGeneration;
  const getOwner = (period: Period, observationIds: string[]): Owner => periodSummaryOwner(db, period, observationIds);
  const currentOwner = (row: StoredPeriod): Owner | null => {
    const snapshot = read({ rangeStart: dayBounds(dateKey(row.startTs)).rangeStart, rangeEnd: dayBounds(dateKey(row.endTs - 1)).rangeEnd });
    const period = snapshot.periods.find(p => p.id === row.id && p.startTs === row.startTs && p.endTs === row.endTs);
    return period ? getOwner(period, snapshot.observations.filter(o => o.periodId === row.id).map(o => o.id)) : null;
  };
  const policyAllows = (period: StoredPeriod | Period) => {
    const policy = host.settings(), bundleId = 'appBundleId' in period ? period.appBundleId : '';
    return policy.textConsent.enabled && policy.allowedBundleIds.includes(bundleId) && policy.textConsent.allowedBundleIds.includes(bundleId) && !policy.excludedBundleIds.includes(bundleId);
  };
  const touch = (id: string) => {
    db.prepare('UPDATE periods SET revision=revision+1 WHERE id=?').run(id);
    db.prepare('UPDATE source_refs SET currentRevision=(SELECT revision FROM periods WHERE id=?) WHERE periodId=?').run(id, id);
    db.prepare("INSERT INTO domain_changes(type,periodId,entityRevision,committedAt) SELECT 'period.revised',id,revision,? FROM periods WHERE id=?").run(Date.now(), id);
    // A fact-only report may predate this period's first persistent source ref.
    db.prepare(`UPDATE reports SET status='invalidated',snapshot=NULL,revision=revision+1,updatedAt=?
      WHERE status='ready' AND id IN (SELECT rs.reportId FROM report_sources rs JOIN period_sources ps ON ps.sourceRefId=rs.sourceRefId WHERE ps.periodId=?)`).run(Date.now(), id);
    host.bump();
  };
  const putJobs = (owner: StoredPeriod, period: Period, sources: SummarySource[], level: number) => {
    const batches = summaryBatches(sources, level ? 15 : 20), at = Date.now();
    for (let ordinal = 0; ordinal < batches.length; ordinal++) {
      const id = randomUUID(), input = ActivityAnalysisInputSchema.parse(summaryInput(period, batches[ordinal], level ? 'reduce' : 'leaf'));
      db.prepare(`INSERT INTO period_summary_jobs(id,periodId,ownerRevision,level,ordinal,inputJson,payloadHash,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, owner.id, owner.summaryOwnerRevision, level, ordinal, JSON.stringify(input), hash(input), at, at);
      if (level) {
        for (const source of batches[ordinal]) {
          db.prepare('INSERT INTO period_summary_job_inputs VALUES(?,?,?)').run(id, source.sourceRefId, source.revision);
          db.prepare(`INSERT OR IGNORE INTO period_summary_job_sources SELECT ?,sourceRefId,sourceRevision FROM period_summary_job_sources WHERE jobId=?`).run(id, source.sourceRefId);
        }
      } else for (const source of batches[ordinal]) db.prepare('INSERT OR IGNORE INTO period_summary_job_sources VALUES(?,?,?)').run(id, source.sourceRefId, source.revision);
    }
    return batches.length;
  };
  const finishLevel = (row: JobRow) => {
    const jobs = db.prepare('SELECT * FROM period_summary_jobs WHERE periodId=? AND ownerRevision=? AND level=? ORDER BY ordinal').all(row.periodId, row.ownerRevision, row.level) as JobRow[];
    if (!jobs.length || jobs.some(job => job.status !== 'succeeded')) return;
    const owner = stored(row.periodId);
    if (!owner || owner.summaryOwnerRevision !== row.ownerRevision) return;
    const current = currentOwner(owner);
    if (!current || current.fingerprint !== owner.summaryFingerprint || current.manuallyLocked) return;
    if (jobs.length === 1) {
      const result = ActivityAnalysisSchema.parse(JSON.parse(jobs[0].resultJson!));
      db.prepare(`UPDATE periods SET summary=?,summaryStatus=?,summaryErrorCode=NULL,basis='inferred',
        activityType=?,objectLabel=?,topic=? WHERE id=? AND manuallyLocked=0`).run(result.summary, result.summary?.trim() ? 'ready' : 'insufficient',
        current.period.activityType === 'unknown' ? result.activityType : current.period.activityType,
        current.period.objectLabel ?? result.objectLabel, current.period.topic ?? result.topic, owner.id);
      touch(owner.id); return;
    }
    if (db.prepare('SELECT 1 FROM period_summary_jobs WHERE periodId=? AND ownerRevision=? AND level=? LIMIT 1').get(owner.id, owner.summaryOwnerRevision, row.level + 1)) return;
    const sources = jobs.map(job => {
      const result = ActivityAnalysisSchema.parse(JSON.parse(job.resultJson!));
      return { sourceRefId: job.id, revision: job.resultRevision, appBundleId: owner.appBundleId,
        observedAt: current.period.startTs, sourceKind: 'summary' as const,
        text: JSON.stringify({ activityType: result.activityType, objectLabel: result.objectLabel, topic: result.topic, summary: result.summary, insufficient: !result.summary }) };
    });
    putJobs(owner, current.period, sources, row.level + 1);
  };
  const seedOwner = (owner: StoredPeriod, current: Owner) => {
    const texts = db.prepare(`SELECT s.id AS sourceRefId,s.currentRevision AS revision,c.bundleId AS appBundleId,c.observedAt,t.text
      FROM period_sources ps JOIN source_refs s ON s.id=ps.sourceRefId JOIN text_evidence t ON t.id=s.textEvidenceId
      JOIN capture_events c ON c.id=t.captureEventId WHERE ps.periodId=? AND s.state='valid' AND t.selected=1 AND length(trim(t.text))>0
      ORDER BY c.observedAt,c.id`).all(owner.id) as SummarySource[];
    if (!texts.length) {
      db.prepare("UPDATE periods SET summaryStatus='insufficient',summary=NULL,summaryErrorCode='NO_VISIBLE_TEXT' WHERE id=?").run(owner.id);
      touch(owner.id); return;
    }
    putJobs(owner, current.period, texts, 0);
  };
  const authorize = (input: unknown): boolean => {
    const parsed = ModelTaskSchema.safeParse(input);
    if (!parsed.success || parsed.data.kind !== 'period_summary') return false;
    const job = parsed.data, policy = host.settings();
    const row = db.prepare('SELECT * FROM period_summary_jobs WHERE id=?').get(job.id) as JobRow | undefined;
    const owner = row && stored(row.periodId);
    if (!row || !owner || row.status !== 'running' || owner.manuallyLocked || row.ownerRevision !== job.ownerRevision || owner.summaryOwnerRevision !== job.ownerRevision ||
      row.consentRevision !== job.consentRevision || row.consentGeneration !== job.consentGeneration || row.sourceGeneration !== job.sourceGeneration ||
      policy.textConsent.revision !== job.consentRevision || policy.textConsent.generation !== job.consentGeneration || sourceGeneration() !== job.sourceGeneration ||
      !policyAllows(owner) || row.payloadHash !== hash(job.input) || row.inputJson !== JSON.stringify(job.input)) return false;
    const stale = db.prepare(`SELECT 1 FROM period_sources ps JOIN source_refs s ON s.id=ps.sourceRefId
      WHERE ps.periodId=? AND (s.state!='valid' OR s.currentRevision!=ps.sourceRevision) LIMIT 1`).get(owner.id);
    if (stale) return false;
    const staleJob = db.prepare(`SELECT 1 FROM period_summary_job_sources js JOIN source_refs s ON s.id=js.sourceRefId
      WHERE js.jobId=? AND (s.state!='valid' OR s.currentRevision!=js.sourceRevision) LIMIT 1`).get(row.id);
    if (staleJob) return false;
    const staleInput = db.prepare(`SELECT 1 FROM period_summary_job_inputs i JOIN period_summary_jobs j ON j.id=i.inputJobId
      WHERE i.jobId=? AND (j.status!='succeeded' OR j.resultRevision!=i.inputRevision OR j.ownerRevision!=?) LIMIT 1`).get(row.id, row.ownerRevision);
    if (staleInput) return false;
    const current = currentOwner(owner);
    return Boolean(current && !current.manuallyLocked && current.fingerprint === owner.summaryFingerprint);
  };
  return {
    'periodSummary.refresh': (args: { observationId?: string; activityId?: string; at?: number } = {}) => db.transaction(() => {
      const observationId = args.observationId ?? (args.activityId ? (db.prepare('SELECT captureEventId FROM activity_events WHERE id=?').get(args.activityId) as { captureEventId: string } | undefined)?.captureEventId : undefined);
      const observation = observationId ? db.prepare('SELECT observedAt FROM capture_events WHERE id=? AND deletedAt IS NULL').get(observationId) as { observedAt: number } | undefined : undefined;
      const at = observation?.observedAt ?? args.at ?? Date.now(), day = dayBounds(dateKey(at));
      const range = { rangeStart: Math.max(0, day.rangeStart - 86_400_000), rangeEnd: day.rangeEnd };
      const snapshot = read(range), ids = new Set<string>();
      for (const period of snapshot.periods) {
        const first = db.prepare('SELECT observedAt FROM capture_events WHERE id=?').get(period.id) as { observedAt: number };
        if (first.observedAt !== period.startTs) continue;
        const next = db.prepare(`SELECT c.bundleId,c.windowId,c.windowTitle,c.sessionId,c.captureGeneration,a.activityType,a.objectLabel,a.topic
          FROM capture_events c LEFT JOIN activity_events a ON a.captureEventId=c.id AND a.deletedAt IS NULL
          WHERE c.deletedAt IS NULL AND c.observedAt>=? ORDER BY c.observedAt,c.id LIMIT 1`).get(period.endTs) as { bundleId: string; windowId: number; windowTitle: string | null; sessionId: string; captureGeneration: number; activityType: string | null; objectLabel: string | null; topic: string | null } | undefined;
        const last = db.prepare('SELECT windowId,sessionId,captureGeneration FROM capture_events WHERE id=?').get(snapshot.observations.filter(o => o.periodId === period.id).at(-1)!.id) as { windowId: number; sessionId: string; captureGeneration: number };
        const closed = snapshot.periods.some(p => p.startTs >= period.endTs && p.id !== period.id) || snapshot.gaps.some(g => g.startTs === period.endTs) ||
          (next && (next.bundleId !== period.appBundleId || next.windowId !== last.windowId || next.windowTitle !== period.windowTitle || next.sessionId !== last.sessionId || next.captureGeneration !== last.captureGeneration ||
            (next.activityType !== null && (next.activityType !== period.activityType || next.objectLabel !== period.objectLabel || next.topic !== period.topic))));
        if (!closed) continue;
        ids.add(period.id);
        const current = getOwner(period, snapshot.observations.filter(o => o.periodId === period.id).map(o => o.id)), previous = stored(period.id, true);
        if (previous?.deletedAt === null && previous.summaryFingerprint === current.fingerprint) continue;
        if (previous) scrubPeriodSummaryJobs(db, [previous.id], Date.now());
        const ownerRevision = (previous?.summaryOwnerRevision ?? 0) + 1;
        db.prepare(`INSERT INTO periods(id,startTs,endTs,appBundleId,appName,activityType,objectLabel,topic,summary,basis,summaryStatus,manuallyLocked,summaryOwnerRevision,summaryFingerprint)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET startTs=excluded.startTs,endTs=excluded.endTs,appBundleId=excluded.appBundleId,appName=excluded.appName,
          activityType=excluded.activityType,objectLabel=excluded.objectLabel,topic=excluded.topic,summary=excluded.summary,basis=excluded.basis,
          summaryStatus=excluded.summaryStatus,manuallyLocked=excluded.manuallyLocked,summaryOwnerRevision=excluded.summaryOwnerRevision,summaryFingerprint=excluded.summaryFingerprint,summaryErrorCode=NULL,deletedAt=NULL`)
          .run(period.id, period.startTs, period.endTs, period.appBundleId, period.appName, period.activityType, period.objectLabel, period.topic,
            current.manuallyLocked ? period.summary : null, current.manuallyLocked ? 'confirmed' : period.basis,
            current.manuallyLocked ? 'ready' : policyAllows(period) ? 'pending' : 'not_authorized', Number(current.manuallyLocked), ownerRevision, current.fingerprint);
        db.prepare("INSERT OR IGNORE INTO source_refs(id,kind,periodId) VALUES(?,'period',?)").run(randomUUID(), period.id);
        db.prepare("UPDATE source_refs SET state='valid',invalidatedAt=NULL,reason=NULL WHERE periodId=?").run(period.id);
        db.prepare('DELETE FROM period_sources WHERE periodId=?').run(period.id);
        for (const source of current.sources) db.prepare('INSERT INTO period_sources VALUES(?,?,?,?)').run(period.id, source.id, source.currentRevision, source.kind === 'text' ? 'content' : 'boundary');
        const owner = stored(period.id)!;
        if (!current.manuallyLocked && policyAllows(owner)) seedOwner(owner, current);
        touch(period.id);
      }
      // A changed partition must not leave an old, larger period's derived copy visible.
      const obsolete = db.prepare('SELECT id FROM periods WHERE summaryFingerprint IS NOT NULL AND deletedAt IS NULL AND startTs>=? AND startTs<?').all(range.rangeStart, range.rangeEnd) as { id: string }[];
      for (const old of obsolete) if (!ids.has(old.id)) {
        scrubPeriodSummaryJobs(db, [old.id], Date.now());
        db.prepare("UPDATE periods SET summary=NULL,summaryStatus='insufficient',summaryFingerprint=NULL,summaryOwnerRevision=summaryOwnerRevision+1,summaryErrorCode='PARTITION_CHANGED' WHERE id=?").run(old.id);
        touch(old.id);
      }
      return { refreshed: ids.size };
    })(),
    'periodSummary.policyChanged': () => db.transaction(() => {
      const policy = host.settings();
      db.prepare(`UPDATE period_summary_jobs SET status='interrupted',errorCode='TEXT_AUTHORIZATION_CHANGED',updatedAt=?
        WHERE status='running' AND (consentRevision!=? OR consentGeneration!=? OR sourceGeneration!=?)`)
        .run(Date.now(), policy.textConsent.revision, policy.textConsent.generation, sourceGeneration());
      const owners = db.prepare("SELECT * FROM periods WHERE deletedAt IS NULL AND summaryFingerprint IS NOT NULL AND summaryStatus='pending'").all() as StoredPeriod[];
      for (const owner of owners) if (!policyAllows(owner)) {
        db.prepare("UPDATE periods SET summaryStatus='not_authorized',summaryErrorCode='TEXT_AUTHORIZATION_REQUIRED' WHERE id=?").run(owner.id);
        db.prepare("UPDATE period_summary_jobs SET status='interrupted',errorCode='TEXT_AUTHORIZATION_REQUIRED' WHERE periodId=? AND ownerRevision=? AND status='running'").run(owner.id, owner.summaryOwnerRevision);
        touch(owner.id);
      }
      return null;
    })(),
    'periodSummary.interrupt': () => {
      db.prepare("UPDATE period_summary_jobs SET status='interrupted',errorCode='MODEL_CONFIGURATION_CHANGED',updatedAt=? WHERE status='running'").run(Date.now());
      return null;
    },
    'periodSummary.retry': () => db.transaction(() => {
      const owners = db.prepare("SELECT * FROM periods WHERE deletedAt IS NULL AND summaryFingerprint IS NOT NULL AND manuallyLocked=0 AND summaryStatus IN ('not_authorized','not_configured','failed','pending')").all() as StoredPeriod[];
      for (const owner of owners) {
        const current = currentOwner(owner);
        if (!current || current.fingerprint !== owner.summaryFingerprint || current.manuallyLocked || !policyAllows(owner)) continue;
        if (!db.prepare('SELECT 1 FROM period_summary_jobs WHERE periodId=? AND ownerRevision=? LIMIT 1').get(owner.id, owner.summaryOwnerRevision)) seedOwner(owner, current);
        else db.prepare("UPDATE period_summary_jobs SET status='queued',errorCode=NULL WHERE periodId=? AND ownerRevision=? AND status IN ('failed','interrupted') AND inputJson IS NOT NULL").run(owner.id, owner.summaryOwnerRevision);
        db.prepare("UPDATE periods SET summaryStatus=CASE WHEN summaryStatus='insufficient' THEN summaryStatus ELSE 'pending' END,summaryErrorCode=NULL WHERE id=?").run(owner.id);
        touch(owner.id);
      }
      return null;
    })(),
    'periodSummary.prepare': (args: { limit?: number } = {}): ModelTask[] => db.transaction(() => {
      const limit = Math.min(2, Math.max(1, args.limit ?? 1)), policy = host.settings(), tasks: ModelTask[] = [];
      if (!policy.textConsent.enabled) return tasks;
      const rows = db.prepare(`SELECT j.* FROM period_summary_jobs j JOIN periods p ON p.id=j.periodId
        WHERE j.status IN ('queued','interrupted') AND j.inputJson IS NOT NULL AND p.deletedAt IS NULL AND p.manuallyLocked=0
        AND p.summaryStatus='pending' AND p.summaryOwnerRevision=j.ownerRevision ORDER BY j.createdAt,j.level,j.ordinal LIMIT ?`).all(limit) as JobRow[];
      for (const row of rows) {
        db.prepare("UPDATE period_summary_jobs SET status='running',consentRevision=?,consentGeneration=?,sourceGeneration=?,attempt=attempt+1,updatedAt=? WHERE id=?")
          .run(policy.textConsent.revision, policy.textConsent.generation, sourceGeneration(), Date.now(), row.id);
        const task: ModelTask = { id: row.id, kind: 'period_summary', ownerRevision: row.ownerRevision, sourceGeneration: sourceGeneration(),
          consentRevision: policy.textConsent.revision, consentGeneration: policy.textConsent.generation, input: JSON.parse(row.inputJson!) };
        if (authorize(task)) tasks.push(task);
        else {
          scrubPeriodSummaryJobs(db, [row.periodId], Date.now());
          db.prepare("UPDATE periods SET summary=NULL,summaryStatus='insufficient',summaryErrorCode='SOURCE_INVALIDATED' WHERE id=?").run(row.periodId);
          touch(row.periodId);
        }
      }
      return tasks;
    })(),
    'periodSummary.authorize': (input: unknown) => db.transaction(() => authorize(input))(),
    'periodSummary.commit': (args: { job: ModelTask; analysis: ActivityAnalysis }) => db.transaction(() => {
      if (!authorize(args.job)) throw new StorageError('SOURCE_INVALIDATED', 'Period summary sources, owner or authorization changed.');
      const result = ActivityAnalysisSchema.parse(args.analysis);
      if (result.sourceRefIds.some(id => !args.job.input.sources.some(source => source.sourceRefId === id))) throw new StorageError('INVALID_ARGUMENT', 'Unknown period-summary source.');
      db.prepare("UPDATE period_summary_jobs SET status='succeeded',resultJson=?,updatedAt=?,errorCode=NULL WHERE id=?").run(JSON.stringify(result), Date.now(), args.job.id);
      finishLevel(db.prepare('SELECT * FROM period_summary_jobs WHERE id=?').get(args.job.id) as JobRow);
      return { periodId: args.job.input.periodId };
    })(),
    'periodSummary.failed': (args: { id: string; status?: string }) => db.transaction(() => {
      const row = db.prepare('SELECT * FROM period_summary_jobs WHERE id=?').get(args.id) as JobRow | undefined;
      if (!row || row.status !== 'running') return null;
      const status = args.status === 'not_configured' ? 'not_configured' : args.status === 'not_authorized' ? 'not_authorized' : 'failed';
      db.prepare("UPDATE period_summary_jobs SET status='failed',errorCode=?,updatedAt=? WHERE id=?").run(status.toUpperCase(), Date.now(), row.id);
      const owner = stored(row.periodId);
      if (owner?.summaryOwnerRevision === row.ownerRevision) {
        db.prepare('UPDATE periods SET summaryStatus=?,summaryErrorCode=? WHERE id=?').run(status, status.toUpperCase(), owner.id); touch(owner.id);
      }
      return null;
    })(),
  };
}
