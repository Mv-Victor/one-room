// Screenpipe use-scroll-zoom.ts L78-92, MIT, commit
// 1b3e4186ec5a624b95a581c7187c1d48284bea9a. RAF interpolation without frame indexes.
import { useEffect, useRef, useState } from 'react';

export function useSmoothZoom(target: number): number {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { current.current = target; setValue(target); return; }
    let raf: number;
    const animate = () => {
      const diff = target - current.current;
      current.current = Math.abs(diff) < 100 ? target : current.current + diff * 0.15;
      setValue(current.current);
      if (current.current !== target) raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return value;
}
