import { describe, expect, it } from 'vitest';
import { summaryBatches, type SummarySource } from '../../src/services/worklog/period-summary';
import { ActivityAnalysisInputSchema } from '../../src/shared/model-schemas';

describe('bounded period summary batches', () => {
  it('keeps every long-period text character and bounds leaf and reduction requests', () => {
    const sources: SummarySource[] = Array.from({ length: 240 }, (_, index) => ({
      sourceRefId: crypto.randomUUID(), revision: 1, appBundleId: 'local.one-room.test', observedAt: index,
      text: `${index}:` + 'x'.repeat(index === 0 ? 100_000 : 1000),
    }));
    const batches = summaryBatches(sources);
    expect(batches.length).toBeGreaterThan(12);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(20);
      expect(batch.reduce((length, source) => length + source.text.length, 0)).toBeLessThanOrEqual(64_000);
      expect(ActivityAnalysisInputSchema.safeParse({ periodId: crypto.randomUUID(), sources: batch }).success).toBe(true);
    }
    for (const source of sources) expect(batches.flat().filter(value => value.sourceRefId === source.sourceRefId).map(value => value.text).join('')).toBe(source.text);
    expect(summaryBatches(sources.map(source => ({ ...source, text: 'partial summary', sourceKind: 'summary' })), 15).every(batch => batch.length <= 15)).toBe(true);
  });
});
