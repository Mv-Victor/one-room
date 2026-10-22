import { useCallback, useEffect, useRef, useState } from 'react';
import { connectDesktopApi, errorMessage, loadDesktopSnapshot, type DesktopSnapshot } from './desktop';

export function useDesktopState() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    try {
      const next = await loadDesktopSnapshot();
      if (requestGeneration !== generation.current) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (requestGeneration === generation.current) setError(errorMessage(cause));
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    let scheduledRefresh: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void connectDesktopApi().then((api) => {
      if (!active) return;
      unsubscribe = api.events.subscribe((event) => {
        if (!['capture.status', 'permissions.changed', 'settings.changed', 'storage.failed'].includes(event.type)) return;
        clearTimeout(scheduledRefresh);
        scheduledRefresh = setTimeout(() => void refresh(), 100);
      });
    }).catch(() => undefined);
    window.addEventListener('focus', onFocus);
    return () => {
      generation.current += 1;
      active = false;
      clearTimeout(scheduledRefresh);
      unsubscribe?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { snapshot, error, loading, refresh };
}
