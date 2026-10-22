import type { NativeEvent } from '../../shared/schemas';

export const CAPTURE_POLICY = { minIntervalMs: 250, typingQuietMs: 500, scrollQuietMs: 300, visualCheckpointMs: 3000, checkpointMs: 30000, maxPending: 8, heartbeatMs: 2000, heartbeatTimeoutMs: 8000 } as const;
export type CaptureTrigger = 'app_switch' | 'window_focus' | 'window_title' | 'content_changed' | 'click' | 'typing_pause' | 'scroll_stop' | 'checkpoint' | 'visual_checkpoint' | 'degraded_checkpoint' | 'manual';
export const ALL_TRIGGERS: CaptureTrigger[] = ['app_switch', 'window_focus', 'window_title', 'content_changed', 'click', 'typing_pause', 'scroll_stop', 'checkpoint', 'visual_checkpoint', 'degraded_checkpoint'];
export function triggerForEvent(event: NativeEvent): CaptureTrigger | null {
  return event.method === 'window.changed' || event.method === 'input.timing' ? event.payload.trigger : null;
}
