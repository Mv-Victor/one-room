import { useEffect, useRef, useState } from 'react';

// Paint every input frame while bounding SQLite/image resolution during a scrub.
export function useSampledCursor(timestamp: number, intervalMs = 60): number {
  const [sample, setSample] = useState(timestamp);
  const sampledAt = useRef(0);
  useEffect(() => {
    const update = () => { sampledAt.current = performance.now(); setSample(timestamp); };
    const wait = Math.max(0, intervalMs - (performance.now() - sampledAt.current));
    if (!wait) { update(); return; }
    const timer = setTimeout(update, wait);
    return () => clearTimeout(timer);
  }, [timestamp, intervalMs]);
  return sample;
}
