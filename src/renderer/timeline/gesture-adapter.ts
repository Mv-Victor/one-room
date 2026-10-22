import type { OneRoomApi } from '../../shared/contracts';

export function isTimelineGestureTarget(surface: HTMLElement | null): boolean {
  if (!surface) return false;
  const focused = surface.ownerDocument.activeElement;
  if (focused && !surface.contains(focused) && focused.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return false;
  return surface.contains(focused) || surface.matches(':hover');
}

export function subscribeTimelineGestures(api: OneRoomApi, onZoom: (units: number) => void): () => void {
  return api.gestures?.subscribe(event => {
    if (event.kind !== 'swipe') return;
    if (event.direction === 'up') onZoom(-1);
    if (event.direction === 'down') onZoom(1);
  }) ?? (() => undefined);
}
