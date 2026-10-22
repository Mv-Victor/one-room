import type { WorklogReader, WorklogSnapshot } from './repository';

// Reuse one revision-checked snapshot while a month is paged through main/preload.
export function createCachedWorklogReader(reader: WorklogReader, currentRevision: () => Promise<number>, now = Date.now): WorklogReader {
  const cache = new Map<string, { revision: number; loadedAt: number; snapshot: Promise<WorklogSnapshot> }>();
  return {
    async read(range) {
      if (range.asOf !== undefined) return reader.read(range);
      const revision = await currentRevision(), started = now();
      const key = JSON.stringify([range.rangeStart, range.rangeEnd, range.query ?? '']);
      const existing = cache.get(key);
      if (existing && existing.revision === revision && started - existing.loadedAt < 30_000) {
        cache.delete(key); cache.set(key, existing);
        return existing.snapshot;
      }
      const entry = { revision, loadedAt: started, snapshot: reader.read(range) };
      cache.delete(key); cache.set(key, entry);
      while (cache.size > 2) cache.delete(cache.keys().next().value!);
      try {
        const snapshot = await entry.snapshot;
        // Open gaps depend on wall time even when no database row has changed.
        const liveGap = range.rangeEnd > started && snapshot.gaps.some(gap => gap.endTs >= started);
        if (snapshot.dataRevision !== revision || liveGap || snapshot.observations.length > 120_000) {
          if (cache.get(key) === entry) cache.delete(key);
        }
        return snapshot;
      } catch (error) {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      }
    },
  };
}
