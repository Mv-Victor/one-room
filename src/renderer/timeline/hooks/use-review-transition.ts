import { useLayoutEffect, useRef, useState } from 'react';

export type ReviewMode = 'day' | 'month';
export function useReviewTransition(mode: ReviewMode) {
  const previous = useRef(mode);
  const [transition, setTransition] = useState<{ from: ReviewMode; to: ReviewMode } | null>(null);
  useLayoutEffect(() => {
    if (previous.current === mode) return;
    const from = previous.current;
    previous.current = mode;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setTransition(null); return; }
    setTransition({ from, to: mode });
    const timer = setTimeout(() => setTransition(null), 340);
    return () => clearTimeout(timer);
  }, [mode]);
  return transition;
}
