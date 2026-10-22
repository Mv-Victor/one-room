import type { ActivityAnalysisInput } from '../../shared/model-schemas';
import type { Period } from '../../shared/schemas';

export type SummarySource = ActivityAnalysisInput['sources'][number];
export const SUMMARY_BATCH_CHARS = 64_000;

// Bound both leaf requests and each reduction level without dropping long-period text.
export function summaryBatches(sources: Iterable<SummarySource>, maxSources = 20): SummarySource[][] {
  const batches: SummarySource[][] = [];
  let batch: SummarySource[] = [], characters = 0;
  for (const source of sources) for (let offset = 0; offset < source.text.length; offset += 20_000) {
    const text = source.text.slice(offset, offset + 20_000);
    if (batch.length >= maxSources || characters + text.length > SUMMARY_BATCH_CHARS) {
      batches.push(batch); batch = []; characters = 0;
    }
    batch.push({ ...source, text }); characters += text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function summaryInput(period: Period, sources: SummarySource[], stage: 'leaf' | 'reduce'): ActivityAnalysisInput {
  return { periodId: period.id, sources, periodContext: {
    stage, startTs: period.startTs, endTs: period.endTs, durationMs: period.endTs - period.startTs,
    appName: period.appName, activityType: period.activityType, objectLabel: period.objectLabel, topic: period.topic,
  } };
}
