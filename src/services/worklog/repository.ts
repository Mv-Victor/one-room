import type { CursorResult, Gap, Period } from '../../shared/schemas';

export type WorklogObservation = NonNullable<CursorResult['observation']> & {
  periodId: string; displayUntil: number; evidence: CursorResult['evidence'];
};
export type WorklogSnapshot = {
  dataRevision: number; periods: Period[]; gaps: Gap[]; observations: WorklogObservation[];
  recordingRange?: { rangeStart: number; rangeEnd: number } | null;
  matchingPeriodIds?: string[];
  reports?: Record<string, { daily: 'absent' | 'ready' | 'invalidated'; weekly: 'absent' | 'ready' | 'invalidated' }>;
};
// A supplies this from the existing worker, using one read transaction before filters.
export interface WorklogReader {
  read(range: { rangeStart: number; rangeEnd: number; query?: string; asOf?: number }): Promise<WorklogSnapshot>;
}
