import { describe, expect, it } from 'vitest';
import { DAY_MS, dayBounds } from '../../src/shared/time';
import { centeredRange, clampToRecording, fitRecordingSpan, scrubDelta, wheelPixels } from '../../src/renderer/timeline/navigation';

describe('continuous timeline navigation', () => {
  it('fits sparse recordings and stops at recorded bounds rather than midnight', () => {
    const start = Date.parse('2026-10-15T23:59:00+08:00');
    const recording = { rangeStart: start, rangeEnd: start + 180_000 };
    expect(fitRecordingSpan(recording, start + 90_000)).toBeCloseTo(198_000);
    expect(fitRecordingSpan({ rangeStart: start, rangeEnd: start + 1000 }, start)).toBe(10_000);
    expect(fitRecordingSpan({ rangeStart: start, rangeEnd: start + 10 * DAY_MS }, start)).toBe(3_600_000);
    expect(clampToRecording(start + 90_000, recording)).toBe(start + 90_000);
    expect(clampToRecording(start - DAY_MS, recording)).toBe(start);
    expect(clampToRecording(start + DAY_MS, recording)).toBe(recording.rangeEnd - 1);
  });
  it('keeps the selected instant centered at both day boundaries without inventing records', () => {
    const day = dayBounds('2026-10-15');
    for (const cursor of [day.rangeStart, day.rangeStart + 43_200_000, day.rangeEnd - 1]) {
      for (const span of [300_000, 3_600_000, DAY_MS]) {
        const range = centeredRange(cursor, span);
        expect((cursor - range.rangeStart) / (range.rangeEnd - range.rangeStart)).toBe(0.5);
        expect(range.rangeEnd - range.rangeStart).toBe(span);
      }
    }
  });
  it('preserves fractional trackpad input and scales motion with zoom and rail width', () => {
    expect(scrubDelta(0.5, 0, 300_000, 1000)).toBe(150);
    expect(scrubDelta(100, 0, 3_600_000, 1000)).toBe(360_000);
    expect(scrubDelta(-100, 0, 3_600_000, 1000)).toBe(-360_000);
    expect(scrubDelta(100, 0, 300_000, 1000)).toBe(30_000);
    expect(wheelPixels(1, 1)).toBe(16);
    expect(wheelPixels(1, 2)).toBe(800);
    expect(scrubDelta(1, 0, 300_000, 0)).toBe(0);
    expect(scrubDelta(Number.NaN, 0, 300_000, 1000)).toBe(0);
  });
});
