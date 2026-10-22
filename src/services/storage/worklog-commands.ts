import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { inputSchemas, type MethodInput, type MethodOutput } from '../../shared/contracts';
import { IdSchema, ReportSnapshotSchema, type ReportResult } from '../../shared/schemas';
import { dateKey, dayBounds, reportBounds } from '../../shared/time';
import { unionDuration } from '../worklog/periodizer';
import { createWorklogRead } from './worklog-read';
import { StorageError } from './client';
import { scrubPeriodSummaryJobs } from './period-summary-commands';
import { scrubReuseSources } from '../reuse/history-cleanup';
import { scrubExecutionSources } from './execution-commands';

export type WorklogStorageHost = { revision(): number; bump(): void; now?(): number };
export type HistoryDeleteCommit = MethodOutput<'history.delete'> & {
  affected: { observationIds: string[]; activityIds: string[]; evidenceIds: string[]; periodIds: string[]; reportIds: string[]; sourceRefIds: string[]; reuseRunIds?: string[] };
  cleanupBlobs: { id: string; sha256: string }[];
  generations: { source: number; capture: number; consent: number };
};
type ReportRow = { id: string; status: ReportResult['status']; snapshot: string | null };
type ReceiptRow = {
  deletionRef: string; payloadHash: string; cleanup: HistoryDeleteCommit['cleanup']; dataRevision: number;
  affectedJson: string; cleanupBlobsJson: string; generationsJson: string;
};
type Range = MethodInput<'history.previewDelete'>;
const SaveReportSchema = z.strictObject({ report: ReportSnapshotSchema, idempotencyKey: IdSchema });
const CleanupSchema = z.strictObject({ idempotencyKey: IdSchema });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (values: Set<string> | string[]) => JSON.stringify([...values]);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new StorageError('INVALID_ARGUMENT', 'Invalid worklog request.');
  return result.data;
}

export function createWorklogCommands(db: Database.Database, host: WorklogStorageHost): Record<string, (args: never) => unknown> {
  const now = host.now ?? Date.now, read = createWorklogRead(db, host.revision);
  db.pragma('secure_delete = ON');
  const queryIds = (sql: string, params: Record<string, string | number>) => (db.prepare(sql).all(params) as { id: string }[]).map(row => row.id);
  const add = (set: Set<string>, values: string[]) => { for (const value of values) set.add(value); };
  const reportHash = (input: MethodInput<'report.generate'>) => hash({ kind: input.kind, dateKey: input.dateKey, sourceRevision: input.expectedDataRevision });
  const reportById = (id: string): ReportResult => {
    const row = db.prepare('SELECT id,status,snapshot FROM reports WHERE id=?').get(id) as ReportRow | undefined;
    if (!row) return { status: 'absent', report: null };
    if (row.status !== 'ready' || !row.snapshot) return { status: 'invalidated', report: null };
    const stale = db.prepare(`SELECT 1 FROM report_sources rs JOIN source_refs s ON s.id=rs.sourceRefId
      LEFT JOIN capture_events c ON c.id=s.captureEventId
      LEFT JOIN text_evidence t ON t.id=s.textEvidenceId LEFT JOIN capture_events tc ON tc.id=t.captureEventId
      LEFT JOIN activity_events a ON a.id=s.activityEventId LEFT JOIN capture_events ac ON ac.id=a.captureEventId
      LEFT JOIN periods p ON p.id=s.periodId
      WHERE rs.reportId=? AND (s.state!='valid' OR s.currentRevision!=rs.sourceRevision
        OR c.deletedAt IS NOT NULL OR tc.deletedAt IS NOT NULL OR a.deletedAt IS NOT NULL OR ac.deletedAt IS NOT NULL OR p.deletedAt IS NOT NULL
        OR EXISTS(SELECT 1 FROM period_sources ps JOIN source_refs parent ON parent.id=ps.sourceRefId
          WHERE ps.periodId=p.id AND parent.kind!='image' AND (parent.state!='valid' OR parent.currentRevision!=ps.sourceRevision))) LIMIT 1`).get(id);
    if (stale) {
      db.prepare("UPDATE reports SET status='invalidated',snapshot=NULL,revision=revision+1,updatedAt=? WHERE id=?").run(now(), id);
      host.bump();
      return { status: 'invalidated', report: null };
    }
    return { status: 'ready', report: ReportSnapshotSchema.parse(JSON.parse(row.snapshot)) };
  };
  const reportReceipt = (input: MethodInput<'report.generate'>): ReportResult | null => {
    const receipt = db.prepare('SELECT payloadHash,reportId FROM report_receipts WHERE idempotencyKey=?').get(input.idempotencyKey) as { payloadHash: string; reportId: string } | undefined;
    if (!receipt) return null;
    if (receipt.payloadHash !== reportHash(input)) throw new StorageError('CONFLICT', 'The report request identity was already used.');
    return reportById(receipt.reportId);
  };

  const selection = (range: Range) => {
    const snapshot = read(range), visibleIds = snapshot.observations.map(row => row.id);
    const observationIds = new Set(queryIds(`SELECT id FROM capture_events WHERE deletedAt IS NULL
      AND ((observedAt>=@start AND observedAt<@end) OR id IN (SELECT value FROM json_each(@visible)))
      AND (@apps='[]' OR bundleId IN (SELECT value FROM json_each(@apps)))`, {
      start: range.rangeStart, end: range.rangeEnd, visible: json(visibleIds), apps: json(range.bundleIds ?? []),
    }));
    const textIds = new Set(queryIds('SELECT id FROM text_evidence WHERE captureEventId IN (SELECT value FROM json_each(@ids))', { ids: json(observationIds) }));
    const evidenceIds = new Set(queryIds('SELECT id FROM evidence WHERE captureEventId IN (SELECT value FROM json_each(@ids))', { ids: json(observationIds) }));
    const activityIds = new Set(queryIds('SELECT id FROM activity_events WHERE captureEventId IN (SELECT value FROM json_each(@ids)) AND deletedAt IS NULL', { ids: json(observationIds) }));
    const storedPeriods = new Set(queryIds(`SELECT id FROM periods WHERE deletedAt IS NULL AND startTs<@end AND COALESCE(endTs,startTs+1)>@start
      AND (@apps='[]' OR appBundleId IN (SELECT value FROM json_each(@apps)))`, { start: range.rangeStart, end: range.rangeEnd, apps: json(range.bundleIds ?? []) }));
    const sourceRefIds = new Set<string>();
    let size = -1;
    while (size !== sourceRefIds.size + activityIds.size + storedPeriods.size) {
      size = sourceRefIds.size + activityIds.size + storedPeriods.size;
      add(sourceRefIds, queryIds(`SELECT id FROM source_refs WHERE captureEventId IN (SELECT value FROM json_each(@captures))
        OR textEvidenceId IN (SELECT value FROM json_each(@texts)) OR evidenceId IN (SELECT value FROM json_each(@images))
        OR activityEventId IN (SELECT value FROM json_each(@activities)) OR periodId IN (SELECT value FROM json_each(@periods))`, {
        captures: json(observationIds), texts: json(textIds), images: json(evidenceIds), activities: json(activityIds), periods: json(storedPeriods),
      }));
      add(activityIds, queryIds('SELECT activityEventId AS id FROM activity_event_sources WHERE sourceRefId IN (SELECT value FROM json_each(@ids))', { ids: json(sourceRefIds) }));
      add(storedPeriods, queryIds('SELECT periodId AS id FROM period_sources WHERE sourceRefId IN (SELECT value FROM json_each(@ids))', { ids: json(sourceRefIds) }));
    }
    const reportIds = new Set(queryIds(`SELECT DISTINCT r.id FROM reports r JOIN report_sources rs ON rs.reportId=r.id
      WHERE r.status='ready' AND rs.sourceRefId IN (SELECT value FROM json_each(@ids))`, { ids: json(sourceRefIds) }));
    const periodIds = new Set(snapshot.observations.filter(row => observationIds.has(row.id)).map(row => row.periodId));
    add(periodIds, [...storedPeriods]);
    return { observationIds, textIds, evidenceIds, activityIds, storedPeriods, periodIds, sourceRefIds, reportIds };
  };
  const decodeReceipt = (row: ReceiptRow): HistoryDeleteCommit => ({
    cleanup: row.cleanup, dataRevision: row.dataRevision, affected: JSON.parse(row.affectedJson),
    cleanupBlobs: JSON.parse(row.cleanupBlobsJson), generations: JSON.parse(row.generationsJson),
  });
  const getDeleteReceipt = (idempotencyKey: string) => db.prepare('SELECT * FROM history_delete_receipts WHERE idempotencyKey=?').get(idempotencyKey) as ReceiptRow | undefined;

  return {
    'report.get': (raw: unknown) => db.transaction(() => {
      const input = parse(inputSchemas['report.get'], raw), range = reportBounds(input.kind, input.dateKey);
      const row = db.prepare('SELECT id FROM reports WHERE kind=? AND rangeStart=? AND rangeEnd=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(input.kind, range.rangeStart, range.rangeEnd) as { id: string } | undefined;
      return row ? reportById(row.id) : { status: 'absent', report: null };
    })(),
    'report.receipt': (raw: unknown) => db.transaction(() => reportReceipt(parse(inputSchemas['report.generate'], raw)))(),
    'report.save': (raw: unknown) => db.transaction(() => {
      const { report, idempotencyKey } = parse(SaveReportSchema, raw);
      const prior = reportReceipt({ kind: report.kind, dateKey: report.dateKey, expectedDataRevision: report.sourceRevision, idempotencyKey });
      if (prior) return prior;
      if (report.sourceRevision !== host.revision()) throw new StorageError('STALE_REVISION', 'Worklog sources changed. Generate the report again.');
      const range = reportBounds(report.kind, report.dateKey);
      if (dateKey(dayBounds(report.dateKey).rangeStart) !== report.dateKey || report.rangeStart !== range.rangeStart || report.rangeEnd !== range.rangeEnd) throw new StorageError('INVALID_ARGUMENT', 'Reports must cover a complete Shanghai day or week.');
      const snapshot = read({ ...range, asOf: report.generatedAt });
      const periods = [...snapshot.periods].sort((a, b) => a.startTs - b.startTs || a.id.localeCompare(b.id));
      if (!isDeepStrictEqual(report.periods, periods) || !isDeepStrictEqual(report.gaps, snapshot.gaps) ||
        report.recordedMs !== unionDuration(periods) || report.gapMs !== unionDuration(snapshot.gaps)) throw new StorageError('SOURCE_INVALIDATED', 'The report snapshot no longer matches its sources.');
      const ids = json(snapshot.observations.map(row => row.id)), periodIds = json(snapshot.periods.map(row => row.id));
      const validObservations = queryIds(`SELECT c.id FROM capture_events c JOIN source_refs s ON s.captureEventId=c.id
        WHERE c.id IN (SELECT value FROM json_each(@ids)) AND c.deletedAt IS NULL AND s.state='valid'`, { ids });
      if (validObservations.length !== snapshot.observations.length) throw new StorageError('SOURCE_INVALIDATED', 'A report observation is unavailable.');
      const staleAncestor = db.prepare(`SELECT 1 FROM activity_event_sources aes JOIN activity_events a ON a.id=aes.activityEventId
        JOIN source_refs s ON s.id=aes.sourceRefId WHERE a.captureEventId IN (SELECT value FROM json_each(@ids)) AND s.kind!='image'
        AND (s.state!='valid' OR s.currentRevision!=aes.sourceRevision) LIMIT 1`).get({ ids });
      if (staleAncestor) throw new StorageError('SOURCE_INVALIDATED', 'An activity source changed.');
      const sources = db.prepare(`SELECT DISTINCT s.id,s.currentRevision FROM source_refs s
        LEFT JOIN text_evidence t ON t.id=s.textEvidenceId LEFT JOIN activity_events a ON a.id=s.activityEventId
        WHERE s.state='valid' AND (s.captureEventId IN (SELECT value FROM json_each(@ids))
          OR (t.captureEventId IN (SELECT value FROM json_each(@ids)) AND t.selected=1)
          OR (a.captureEventId IN (SELECT value FROM json_each(@ids)) AND a.deletedAt IS NULL)
          OR s.periodId IN (SELECT value FROM json_each(@periodIds))
          OR (s.kind!='image' AND s.id IN (SELECT aes.sourceRefId FROM activity_event_sources aes
            JOIN activity_events active ON active.id=aes.activityEventId WHERE active.captureEventId IN (SELECT value FROM json_each(@ids)) AND active.deletedAt IS NULL)))`).all({ ids, periodIds }) as { id: string; currentRevision: number }[];
      const at = now();
      db.prepare(`INSERT INTO reports(id,kind,dateKey,rangeStart,rangeEnd,status,snapshot,sourceRevision,linkedTargetId,createdAt,updatedAt)
        VALUES(@id,@kind,@dateKey,@rangeStart,@rangeEnd,'ready',@snapshot,@sourceRevision,@linkedTargetId,@at,@at)`)
        .run({ id: report.id, kind: report.kind, dateKey: report.dateKey, rangeStart: report.rangeStart,
          rangeEnd: report.rangeEnd, sourceRevision: report.sourceRevision, linkedTargetId: report.linkedTargetId,
          snapshot: JSON.stringify(report), at });
      const join = db.prepare('INSERT INTO report_sources(reportId,sourceRefId,sourceRevision) VALUES(?,?,?)');
      for (const source of sources) join.run(report.id, source.id, source.currentRevision);
      db.prepare('INSERT INTO report_receipts VALUES(?,?,?,?)').run(idempotencyKey, reportHash({ kind: report.kind, dateKey: report.dateKey, expectedDataRevision: report.sourceRevision, idempotencyKey }), report.id, at);
      host.bump();
      return { status: 'ready', report } satisfies ReportResult;
    })(),
    'history.previewDelete': (raw: unknown) => db.transaction(() => {
      const range = parse(inputSchemas['history.previewDelete'], raw), selected = selection(range), at = now();
      const preview = { deletionRef: randomUUID(), dataRevision: host.revision(), expiresAt: at + 300_000,
        observationCount: selected.observationIds.size, periodCount: selected.periodIds.size, reportCount: selected.reportIds.size };
      db.prepare('DELETE FROM history_delete_previews WHERE expiresAt<=?').run(at);
      db.prepare('INSERT INTO history_delete_previews VALUES(?,?,?,?,?)').run(preview.deletionRef, JSON.stringify(range), preview.dataRevision, preview.expiresAt, at);
      return preview;
    })(),
    'history.delete': (raw: unknown): HistoryDeleteCommit => db.transaction(() => {
      const input = parse(inputSchemas['history.delete'], raw), payloadHash = hash({ deletionRef: input.deletionRef, expectedRevision: input.expectedRevision });
      const prior = getDeleteReceipt(input.idempotencyKey);
      if (prior) {
        if (prior.deletionRef !== input.deletionRef || prior.payloadHash !== payloadHash) throw new StorageError('CONFLICT', 'The deletion request identity was already used.');
        return decodeReceipt(prior);
      }
      const preview = db.prepare('SELECT rangeJson,dataRevision,expiresAt FROM history_delete_previews WHERE deletionRef=?').get(input.deletionRef) as { rangeJson: string; dataRevision: number; expiresAt: number } | undefined;
      if (!preview || preview.expiresAt <= now()) throw new StorageError('STALE_REVISION', 'The deletion preview expired. Preview the range again.');
      if (preview.dataRevision !== input.expectedRevision || input.expectedRevision !== host.revision()) throw new StorageError('STALE_REVISION', 'Worklog sources changed. Preview the range again.');
      const selected = selection(parse(inputSchemas['history.previewDelete'], JSON.parse(preview.rangeJson))), at = now();
      const reuseRunIds = scrubReuseSources(db, [...selected.observationIds]);
      scrubExecutionSources(db, [...selected.sourceRefIds], at);
      const params = { captures: json(selected.observationIds), texts: json(selected.textIds), images: json(selected.evidenceIds), activities: json(selected.activityIds), periods: json(selected.storedPeriods), sources: json(selected.sourceRefIds), reports: json(selected.reportIds), at };
      db.prepare("UPDATE source_refs SET state='deleted',currentRevision=currentRevision+1,invalidatedAt=@at,reason='manual_delete' WHERE id IN (SELECT value FROM json_each(@sources)) AND state!='deleted'").run({ at, sources: params.sources });
      db.prepare('DELETE FROM text_search WHERE textEvidenceId IN (SELECT value FROM json_each(@texts))').run({ texts: params.texts });
      db.prepare('DELETE FROM capture_search WHERE captureEventId IN (SELECT value FROM json_each(@captures))').run({ captures: params.captures });
      db.prepare("UPDATE text_evidence SET text='',fallbackReason=NULL,status='deleted',completeness='empty',selected=0,revision=revision+1 WHERE id IN (SELECT value FROM json_each(@texts))").run({ texts: params.texts });
      db.prepare('DELETE FROM activity_event_revisions WHERE activityEventId IN (SELECT value FROM json_each(@activities))').run({ activities: params.activities });
      db.prepare("UPDATE activity_events SET action='unknown',activityType='unknown',objectLabel=NULL,topic=NULL,summary=NULL,basis='observed',analysisStatus='insufficient',revision=revision+1,deletedAt=@at WHERE id IN (SELECT value FROM json_each(@activities))").run({ activities: params.activities, at });
      db.prepare("UPDATE capture_events SET bundleId='local.one-room.deleted',appName='Deleted observation',pid=0,windowId=0,windowTitle=NULL,textStatus='deleted',revision=revision+1,deletedAt=@at WHERE id IN (SELECT value FROM json_each(@captures))").run({ captures: params.captures, at });
      db.prepare("UPDATE evidence SET status='deleted',revision=revision+1,unavailableAt=@at,unavailableReason='manual_delete' WHERE id IN (SELECT value FROM json_each(@images))").run({ images: params.images, at });
      db.prepare("UPDATE periods SET appBundleId='local.one-room.deleted',appName='Deleted period',objectLabel=NULL,topic=NULL,summary=NULL,summaryStatus='insufficient',basis='observed',revision=revision+1,deletedAt=@at WHERE id IN (SELECT value FROM json_each(@periods))").run({ periods: params.periods, at });
      scrubPeriodSummaryJobs(db, [...selected.storedPeriods], at);
      db.prepare("UPDATE reports SET status='invalidated',snapshot=NULL,revision=revision+1,updatedAt=@at WHERE id IN (SELECT value FROM json_each(@reports))").run({ reports: params.reports, at });
      db.prepare('UPDATE capture_events SET endTs=MAX(observedAt+1,?) WHERE endTs IS NULL AND deletedAt IS NULL').run(at);
      db.prepare('UPDATE capture_gaps SET endTs=MAX(startTs+1,?) WHERE endTs IS NULL').run(at);
      db.prepare('UPDATE settings SET revision=revision+1,sourceGeneration=sourceGeneration+1,captureGeneration=captureGeneration+1,consentRevision=consentRevision+1,consentGeneration=consentGeneration+1 WHERE id=1').run();
      const generations = db.prepare('SELECT sourceGeneration AS source,captureGeneration AS capture,consentGeneration AS consent FROM settings WHERE id=1').get() as HistoryDeleteCommit['generations'];
      const cleanupBlobs = db.prepare(`SELECT DISTINCT b.id,b.sha256 FROM evidence_blobs b JOIN evidence e ON e.blobId=b.id
        WHERE e.id IN (SELECT value FROM json_each(@images)) AND b.storageState='ready'
        AND NOT EXISTS(SELECT 1 FROM evidence live WHERE live.blobId=b.id AND live.status='available' AND live.expiresAt>@at)`).all({ images: params.images, at }) as HistoryDeleteCommit['cleanupBlobs'];
      host.bump();
      const result: HistoryDeleteCommit = { cleanup: selected.sourceRefIds.size || selected.reportIds.size || cleanupBlobs.length || reuseRunIds.length ? 'pending' : 'complete', dataRevision: host.revision(),
        affected: { observationIds: [...selected.observationIds], activityIds: [...selected.activityIds], evidenceIds: [...selected.evidenceIds], periodIds: [...selected.periodIds], reportIds: [...selected.reportIds], sourceRefIds: [...selected.sourceRefIds], ...(reuseRunIds.length ? { reuseRunIds } : {}) }, cleanupBlobs, generations };
      db.prepare('INSERT INTO history_delete_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(input.idempotencyKey, input.deletionRef, payloadHash, result.cleanup, result.dataRevision, JSON.stringify(result.affected), JSON.stringify(cleanupBlobs), JSON.stringify(generations), at);
      db.prepare('DELETE FROM history_delete_previews WHERE deletionRef=?').run(input.deletionRef);
      return result;
    })(),
    'history.cleanupComplete': (raw: unknown): HistoryDeleteCommit => {
      const input = parse(CleanupSchema, raw), receipt = getDeleteReceipt(input.idempotencyKey);
      if (!receipt) throw new StorageError('NOT_FOUND', 'The deletion receipt does not exist.');
      const result = decodeReceipt(receipt);
      const pending = db.prepare(`SELECT 1 FROM evidence_blobs b WHERE b.id IN (SELECT value FROM json_each(@ids)) AND b.storageState='ready'
        AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.blobId=b.id AND e.status='available' AND e.expiresAt>@at) LIMIT 1`).get({ ids: json(result.cleanupBlobs.map(blob => blob.id)), at: now() });
      if (pending) return result;
      const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
      if (checkpoint[0]?.busy) return result;
      db.prepare("UPDATE history_delete_receipts SET cleanup='complete' WHERE idempotencyKey=?").run(input.idempotencyKey);
      return { ...result, cleanup: 'complete' };
    },
  };
}
