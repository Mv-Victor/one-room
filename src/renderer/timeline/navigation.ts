import { DAY_MS, dayBounds } from '../../shared/time';

export const MIN_SPAN_MS = 10_000;
export type Navigation = { mode: 'day' | 'month'; spanMs: number; extraOut: number; gestureId: number; crossed: boolean };
export type NavigationAction = { type: 'zoom'; units: number; gestureId: number } | { type: 'mode'; mode: 'day' | 'month' } | { type: 'span'; spanMs: number };
export const initialNavigation: Navigation = { mode: 'day', spanMs: 1_800_000, extraOut: 0, gestureId: 0, crossed: false };

export function fitRecordingSpan(range: { rangeStart: number; rangeEnd: number }, cursorTs: number): number {
  const radius = Math.max(cursorTs - range.rangeStart, range.rangeEnd - cursorTs);
  return Math.max(MIN_SPAN_MS, Math.min(3_600_000, radius * 2.2));
}
export function clampToRecording(timestamp: number, range: { rangeStart: number; rangeEnd: number }): number {
  return Math.round(Math.max(range.rangeStart, Math.min(range.rangeEnd - 1, timestamp)));
}

export function navigate(state: Navigation, action: NavigationAction): Navigation {
  if (action.type === 'mode') return { ...state, mode: action.mode, extraOut: 0, crossed: false };
  if (action.type === 'span') return { ...state, mode: 'day', spanMs: Math.min(DAY_MS, Math.max(MIN_SPAN_MS, action.spanMs)), extraOut: 0 };
  const current = action.gestureId === state.gestureId ? state : { ...state, gestureId: action.gestureId, extraOut: 0, crossed: false };
  if (!Number.isFinite(action.units) || !action.units || current.crossed) return current;
  if (current.mode === 'month') return action.units < 0 ? { ...current, mode: 'day', extraOut: 0, crossed: true } : current;
  if (action.units > 0 && current.spanMs >= DAY_MS) {
    const extraOut = current.extraOut + action.units;
    return extraOut >= 1 ? { ...current, mode: 'month', extraOut: 0, crossed: true } : { ...current, extraOut };
  }
  return { ...current, extraOut: 0, spanMs: Math.min(DAY_MS, Math.max(MIN_SPAN_MS, current.spanMs * 2 ** action.units)) };
}
export function visibleRange(selectedDate: string, cursorTs: number, spanMs: number) {
  const day = dayBounds(selectedDate), span = Math.round(Math.min(DAY_MS, Math.max(MIN_SPAN_MS, spanMs)));
  const rangeStart = Math.round(Math.max(day.rangeStart, Math.min(day.rangeEnd - span, cursorTs - span / 2)));
  return { rangeStart, rangeEnd: rangeStart + span };
}
export function centeredRange(cursorTs: number, spanMs: number) {
  const span = Math.min(DAY_MS, Math.max(MIN_SPAN_MS, spanMs));
  return { rangeStart: cursorTs - span / 2, rangeEnd: cursorTs + span / 2 };
}
export function wheelPixels(delta: number, deltaMode: number): number {
  return Number.isFinite(delta) ? delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1) : 0;
}
export function scrubDelta(delta: number, deltaMode: number, spanMs: number, width: number): number {
  return width > 0 && Number.isFinite(width) ? wheelPixels(delta, deltaMode) * spanMs / width : 0;
}
// One step doubles/halves the span; a full extra step at 24h enters month.
export function wheelUnits(deltaY: number, deltaMode: number): number {
  return Math.max(-1, Math.min(1, wheelPixels(deltaY, deltaMode) / 240));
}
