import { inputSchemas, type MethodInput } from '../../shared/contracts';
import { DomainError } from '../../shared/errors';
import type { ReportResult, ReportSnapshot } from '../../shared/schemas';
import { reportBounds } from '../../shared/time';
import { clip, overlaps, unionDuration } from './periodizer';
import type { WorklogReader } from './repository';

export interface ReportRepository extends WorklogReader {
  getReport(input: MethodInput<'report.get'>): Promise<ReportResult>;
  findReportReceipt?(input: MethodInput<'report.generate'>): Promise<ReportResult | null>;
  // Commit checks sourceRevision in the same transaction as report/source joins.
  saveReport(report: ReportSnapshot, idempotencyKey: string): Promise<ReportResult>;
}
export function createReports(repository: ReportRepository, now = Date.now) {
  return {
    get: (input: MethodInput<'report.get'>) => repository.getReport(inputSchemas['report.get'].parse(input)),
    async generate(raw: MethodInput<'report.generate'>): Promise<ReportResult> {
      const input = inputSchemas['report.generate'].parse(raw);
      const prior = await repository.findReportReceipt?.(input);
      if (prior) return prior;
      const range = reportBounds(input.kind, input.dateKey), generatedAt = now();
      const snapshot = await repository.read({ ...range, asOf: generatedAt });
      if (snapshot.dataRevision !== input.expectedDataRevision) throw new DomainError('STALE_REVISION', '记录已更新，请重新生成。');
      const periods = snapshot.periods.filter(p => overlaps(p, range.rangeStart, range.rangeEnd)).map(p => clip(p, range.rangeStart, range.rangeEnd))
        .sort((a, b) => a.startTs - b.startTs || a.id.localeCompare(b.id));
      const gaps = snapshot.gaps.filter(g => overlaps(g, range.rangeStart, range.rangeEnd)).map(g => clip(g, range.rangeStart, range.rangeEnd));
      return repository.saveReport({
        id: crypto.randomUUID(), ...range, kind: input.kind, dateKey: input.dateKey,
        sourceRevision: snapshot.dataRevision, generatedAt, periods, gaps,
        recordedMs: unionDuration(periods), gapMs: unionDuration(gaps), linkedTargetId: null
      }, input.idempotencyKey);
    }
  };
}
