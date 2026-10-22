// Screenpipe use-frame-loading.ts L466-502, MIT, commit
// 1b3e4186ec5a624b95a581c7187c1d48284bea9a. ResizeObserver/contain/RAF cleanup.
import { useEffect, useRef, useState } from 'react';

export function useContainedImageLayout(dimensions: { width: number; height: number } | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const width = dimensions?.width, height = dimensions?.height;
  useEffect(() => {
    const element = ref.current;
    if (!element || !width || !height) return;
    let raf: number;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const bounds = element.getBoundingClientRect(), scale = Math.min(bounds.width / width, bounds.height / height);
        setSize({ width: width * scale, height: height * scale });
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element); update();
    return () => { observer.disconnect(); cancelAnimationFrame(raf); };
  }, [width, height]);
  return { ref, size };
}
