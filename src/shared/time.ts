export const DAY_MS = 86_400_000;
export function dateKey(timestamp = Date.now()): string {
  return new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function dayBounds(key: string): { rangeStart: number; rangeEnd: number } {
  const rangeStart = Date.parse(`${key}T00:00:00+08:00`);
  return { rangeStart, rangeEnd: rangeStart + DAY_MS };
}
export function moveDay(key: string, days: number): string {
  return dateKey(dayBounds(key).rangeStart + days * DAY_MS);
}
export function monthBounds(month: string): { rangeStart: number; rangeEnd: number } {
  const rangeStart = dayBounds(`${month}-01`).rangeStart;
  const next = new Date(`${month}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { rangeStart, rangeEnd: dayBounds(next.toISOString().slice(0, 10)).rangeStart };
}
export function reportBounds(kind: 'daily' | 'weekly', key: string) {
  const day = dayBounds(key);
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  const rangeStart = kind === 'daily' ? day.rangeStart : day.rangeStart - ((weekday + 6) % 7) * DAY_MS;
  return { rangeStart, rangeEnd: rangeStart + (kind === 'daily' ? 1 : 7) * DAY_MS };
}
