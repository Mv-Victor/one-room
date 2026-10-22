import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Gap, CursorResult } from '../../shared/schemas';
import type { Activity } from '../../shared/activity-schemas';
import { clip, overlaps, periodize, type ObservationFact } from '../worklog/periodizer';
import type { WorklogSnapshot } from '../worklog/repository';
import { StorageError } from './client';
import { dateKey, dayBounds } from '../../shared/time';
import { summarizePeriods } from '../worklog/summaries';
import { periodSummaryOwner } from './period-summary-state';
import type { Period } from '../../shared/schemas';

type Range = { rangeStart: number; rangeEnd: number; query?: string; asOf?: number };
type EvidenceStatus = NonNullable<CursorResult['evidence']>['status'];
type ObservationRow = ObservationFact & {
  nextObservedAt: number | null; nextSessionId: string | null; nextGeneration: number | null;
  evidenceId: string | null; evidenceObservedAt: number | null;
  evidenceExpiresAt: number | null; evidenceStatus: EvidenceStatus | null; blobState: string | null;
  activityRevision: number | null; activityType: Activity['activityType'] | null;
  objectLabel: string | null; topic: string | null; summary: string | null;
  activityBasis: Activity['basis'] | null; analysisStatus: Activity['analysisStatus'] | null;
  action: Activity['action'] | null;
};
type GapRow = Omit<Gap, 'endTs'> & { endTs: number | null };

export function createWorklogRead(db: Database.Database, revision: () => number, includePeriodSummaries = true, canonical = false): (range: Range) => WorklogSnapshot {
  const observations = db.prepare(`SELECT c.id,c.sessionId,c.captureGeneration,c.observedAt,c.endTs,
      c.bundleId,c.appName,c.windowId,c.windowTitle,c.revision,
      n.observedAt AS nextObservedAt,n.sessionId AS nextSessionId,n.captureGeneration AS nextGeneration,
      e.id AS evidenceId,e.observedAt AS evidenceObservedAt,e.expiresAt AS evidenceExpiresAt,
      e.status AS evidenceStatus,b.storageState AS blobState,
      a.revision AS activityRevision,a.activityType,a.action,a.objectLabel,a.topic,a.summary,
      a.basis AS activityBasis,a.analysisStatus
    FROM capture_events c
    LEFT JOIN capture_events n ON n.id=(SELECT next.id FROM capture_events next
      WHERE (next.observedAt,next.id)>(c.observedAt,c.id) ORDER BY next.observedAt,next.id LIMIT 1)
    LEFT JOIN evidence e ON e.captureEventId=c.id
    LEFT JOIN evidence_blobs b ON b.id=e.blobId
    LEFT JOIN activity_events a ON a.captureEventId=c.id AND a.deletedAt IS NULL
    WHERE c.deletedAt IS NULL AND c.observedAt<? AND (c.endTs IS NULL OR c.endTs>?)
    ORDER BY c.observedAt,c.id`);
  const readGaps = db.prepare(`SELECT id,startTs,endTs,reason,revision FROM capture_gaps
    WHERE startTs<? AND (endTs IS NULL OR endTs>?) ORDER BY startTs,id`);
  const firstCapture = db.prepare('SELECT observedAt FROM capture_events WHERE deletedAt IS NULL ORDER BY observedAt,id LIMIT 1');
  const lastCapture = db.prepare('SELECT observedAt,endTs FROM capture_events WHERE deletedAt IS NULL ORDER BY observedAt DESC,id DESC LIMIT 1');

  const read = db.transaction((range: Range): WorklogSnapshot => {
    const dataRevision = revision(), now = range.asOf ?? Date.now();
    const first = firstCapture.get() as { observedAt: number } | undefined;
    const last = lastCapture.get() as { observedAt: number; endTs: number | null } | undefined;
    // An open observation has no known duration beyond its captured instant.
    const recordingRange = first && last ? { rangeStart: first.observedAt, rangeEnd: Math.max(first.observedAt + 1, last.endTs ?? last.observedAt) } : null;
    // Build whole days so zooming/paging cannot change a semantic period's ID.
    const expanded = { rangeStart: dayBounds(dateKey(range.rangeStart)).rangeStart, rangeEnd: dayBounds(dateKey(range.rangeEnd - 1)).rangeEnd };
    const preceding = db.prepare(`SELECT min(observedAt) AS observedAt FROM capture_events WHERE deletedAt IS NULL
      AND observedAt<? AND endTs>?`).get(expanded.rangeStart, expanded.rangeStart) as { observedAt: number | null };
    if (preceding.observedAt !== null) expanded.rangeStart = dayBounds(dateKey(preceding.observedAt)).rangeStart;
    const rows = observations.all(expanded.rangeEnd, expanded.rangeStart) as ObservationRow[];
    const facts: ObservationFact[] = [];
    for (const row of rows) {
      const sameSession = row.nextSessionId === row.sessionId && row.nextGeneration === row.captureGeneration;
      let endTs = row.endTs ?? (sameSession ? row.nextObservedAt! : row.observedAt);
      if (row.nextObservedAt !== null) endTs = Math.min(endTs, row.nextObservedAt);
      if (endTs > expanded.rangeStart) facts.push({ ...row, endTs });
    }
    // A preceding observation may meet a gap before the requested range starts.
    const gapStart = facts.reduce((start, fact) => Math.min(start, fact.observedAt), expanded.rangeStart);
    const gaps = (readGaps.all(expanded.rangeEnd, gapStart) as GapRow[]).flatMap(row => {
      const endTs = row.endTs ?? Math.min(now, expanded.rangeEnd);
      return endTs > row.startTs ? [{ ...row, endTs }] : [];
    });
    const byId = new Map(rows.map(row => [row.id, row]));
    const slices = periodize(facts, gaps)
      .filter(period => overlaps(period, expanded.rangeStart, expanded.rangeEnd))
      .map(period => {
        const row = byId.get(period.id)!;
        const semantic = row.activityRevision === null ? period : {
          ...period, action: row.action!, activityType: row.activityType!, objectLabel: row.objectLabel,
          topic: row.topic, summary: row.summary, summaryStatus: row.analysisStatus!,
          basis: row.activityBasis!, revision: row.revision + row.activityRevision,
        };
        return semantic;
      });
    const grouped = summarizePeriods(slices.map(period => {
      const row = byId.get(period.id)!;
      return { period, sessionId: row.sessionId, generation: row.captureGeneration, windowId: row.windowId };
    }));
    const summaryRows = includePeriodSummaries ? db.prepare(`SELECT id,startTs,endTs,activityType,objectLabel,topic,summary,basis,summaryStatus,revision,summaryFingerprint
      FROM periods WHERE deletedAt IS NULL AND summaryFingerprint IS NOT NULL AND startTs<? AND endTs>?`).all(expanded.rangeEnd, expanded.rangeStart) as (Period & { summaryFingerprint: string })[] : [];
    const summaries = new Map(summaryRows.map(row => [row.id, row]));
    const members = new Map<string, string[]>();
    if (summaryRows.length) for (const [id, periodId] of grouped.assignments) {
      const list = members.get(periodId) ?? [];
      list.push(id); members.set(periodId, list);
    }
    const project = (period: Period) => canonical ? period : clip(period, range.rangeStart, range.rangeEnd);
    const periods = grouped.periods.filter(p => overlaps(p, range.rangeStart, range.rangeEnd)).map(period => {
      const summary = summaries.get(period.id);
      if (!summary || summary.startTs !== period.startTs || summary.endTs !== period.endTs) return project(period);
      const owner = periodSummaryOwner(db, period, members.get(period.id) ?? []);
      if (owner.fingerprint !== summary.summaryFingerprint) return project(period);
      return project({ ...period, activityType: summary.activityType, objectLabel: summary.objectLabel, topic: summary.topic,
        summary: summary.summary, basis: summary.basis, summaryStatus: summary.summaryStatus, revision: period.revision + summary.revision });
    });
    const selectedPeriodIds = new Set(periods.map(period => period.id));
    const matchingPeriodIds = range.query ? searchObservations(range.query, expanded).flatMap(id => grouped.assignments.get(id) ?? []) : undefined;
    return {
      dataRevision, periods, recordingRange,
      ...(matchingPeriodIds ? { matchingPeriodIds } : {}),
      reports: reportStatuses(range),
      gaps: gaps.filter(gap => overlaps(gap, range.rangeStart, range.rangeEnd))
        .map(gap => clip(gap, range.rangeStart, range.rangeEnd)),
      observations: slices.filter(p => canonical ? selectedPeriodIds.has(grouped.assignments.get(p.id)!) : overlaps(p, range.rangeStart, range.rangeEnd)).map(slice => {
        const period = project(slice);
        const row = byId.get(period.id)!;
        let status = row.evidenceStatus;
        if (status === 'available') {
          if (row.evidenceExpiresAt! <= now) status = 'expired';
          else if (row.blobState !== 'ready') status = 'missing';
        }
        return {
          id: row.id, observedAt: row.observedAt, revision: row.revision,
          periodId: grouped.assignments.get(period.id)!, displayUntil: period.endTs,
          evidence: row.evidenceId && status ? {
            evidenceId: row.evidenceId, status, observedAt: row.evidenceObservedAt!,
            displayUntil: period.endTs, requestToken: randomUUID(), url: null,
          } : null,
        };
      }),
    };
  });
  function searchObservations(query: string, range: Range): string[] {
    const literal = `"${query.replaceAll('"', '""')}"`;
    const sql = [...query].length >= 3 ? `SELECT c.id FROM capture_events c WHERE c.deletedAt IS NULL AND c.observedAt<? AND (c.endTs IS NULL OR c.endTs>?) AND
      (c.id IN (SELECT captureEventId FROM capture_search WHERE capture_search MATCH @query)
      OR c.id IN (SELECT t.captureEventId FROM text_evidence t JOIN text_search s ON s.textEvidenceId=t.id
        WHERE text_search MATCH @query AND t.selected=1))` :
      `SELECT c.id FROM capture_events c WHERE c.deletedAt IS NULL AND c.observedAt<? AND (c.endTs IS NULL OR c.endTs>?) AND
      (instr(lower(COALESCE(c.windowTitle,'')),lower(@query))>0 OR EXISTS(SELECT 1 FROM text_evidence t
        WHERE t.captureEventId=c.id AND t.selected=1 AND instr(lower(t.text),lower(@query))>0))`;
    return (db.prepare(sql).all({ query: [...query].length >= 3 ? literal : query }, range.rangeEnd, range.rangeStart) as { id: string }[]).map(row => row.id);
  }
  function reportStatuses(range: Range): NonNullable<WorklogSnapshot['reports']> {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reports'").get()) return {};
    const reports = db.prepare(`SELECT kind,rangeStart,rangeEnd,
      CASE WHEN status='invalidated' OR EXISTS(SELECT 1 FROM report_sources rs JOIN source_refs s ON s.id=rs.sourceRefId
        WHERE rs.reportId=r.id AND (s.state!='valid' OR s.currentRevision!=rs.sourceRevision)) THEN 'invalidated' ELSE status END AS status
      FROM reports r WHERE rangeStart<? AND rangeEnd>? ORDER BY createdAt,rowid`).all(range.rangeEnd, range.rangeStart) as { kind: 'daily' | 'weekly'; rangeStart: number; rangeEnd: number; status: 'ready' | 'invalidated' }[];
    const result: NonNullable<WorklogSnapshot['reports']> = {};
    for (const report of reports) for (let at = Math.max(report.rangeStart, range.rangeStart); at < Math.min(report.rangeEnd, range.rangeEnd); at = dayBounds(dateKey(at)).rangeEnd) {
      const key = dateKey(at);
      result[key] ??= { daily: 'absent', weekly: 'absent' };
      result[key][report.kind] = report.status;
    }
    return result;
  }
  return range => {
    if (!range || !Number.isSafeInteger(range.rangeStart) || range.rangeStart < 0 ||
      !Number.isSafeInteger(range.rangeEnd) || range.rangeEnd <= range.rangeStart ||
      range.rangeEnd - range.rangeStart > 31 * 86400_000 ||
      (range.asOf !== undefined && (!Number.isSafeInteger(range.asOf) || range.asOf < 0 || range.asOf > Date.now() + 1000))) {
      throw new StorageError('INVALID_ARGUMENT', 'A worklog query must cover at most 31 days.');
    }
    return read(range);
  };
}
