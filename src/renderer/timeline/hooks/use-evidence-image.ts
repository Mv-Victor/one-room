// Screenpipe use-frame-loading.ts L314-351, MIT, commit
// 1b3e4186ec5a624b95a581c7187c1d48284bea9a. Preload/cancel only; no HTTP fallback.
import { useEffect, useState } from 'react';
import type { CursorResult } from '../../../shared/schemas';

export function useEvidenceImage(evidence: CursorResult['evidence'], selectionKey: string, retainPrevious = false, cursorTs = Infinity) {
  const [retentionTick, setRetentionTick] = useState(0);
  const expiresAt = evidence ? evidence.observedAt + 30 * 86400_000 : 0;
  const expired = evidence?.status === 'available' && expiresAt <= Date.now();
  const key = evidence?.status === 'available' && !expired && evidence.url ? `${selectionKey}:${evidence.evidenceId}:${evidence.observedAt}:${evidence.url}` : null;
  const [loaded, setLoaded] = useState<{ key: string; scope: string; observedAt: number; url: string; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (evidence?.status !== 'available' || expiresAt <= Date.now()) return;
    const nextExpiry = loaded && loaded.scope === selectionKey && loaded.observedAt + 30 * 86400_000 > Date.now()
      ? Math.min(expiresAt, loaded.observedAt + 30 * 86400_000) : expiresAt;
    const timer = setTimeout(() => setRetentionTick(value => value + 1), Math.min(2_147_483_647, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [evidence?.status, expiresAt, loaded, selectionKey, retentionTick]);
  useEffect(() => {
    if (!retainPrevious) setLoaded(null);
    setFailed(null);
    if (!key || !evidence?.url) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled && img.naturalWidth && img.naturalHeight) setLoaded({ key, scope: selectionKey, observedAt: evidence.observedAt, url: evidence.url!, width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => { if (!cancelled) setFailed(key); };
    img.src = evidence.url;
    return () => { cancelled = true; img.onload = null; img.onerror = null; img.src = ''; };
  }, [key, evidence?.url, evidence?.observedAt, selectionKey, retainPrevious]);
  const sameScope = !!key && loaded?.scope === selectionKey && loaded.observedAt + 30 * 86400_000 > Date.now();
  const visible = !!loaded && loaded.observedAt <= cursorTs && (loaded.key === key || (retainPrevious && sameScope && failed !== key));
  return { image: visible ? loaded : null, expired, failed: !!key && failed === key, loading: !!key && loaded?.key !== key && failed !== key };
}
