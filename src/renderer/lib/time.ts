import { dateKey } from '../../shared/time';
export { dateKey, dayBounds, moveDay, monthBounds, reportBounds, DAY_MS } from '../../shared/time';

const timeFormatters = [false, true].map(seconds => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  ...(seconds ? { second: '2-digit' as const } : {}),
  hour12: false,
}));

export function formatTime(timestamp: number | null | undefined, seconds = false): string {
  if (timestamp == null) return '尚无记录';
  return timeFormatters[Number(seconds)].format(timestamp);
}

export function formatDateTime(timestamp: number | null | undefined): string {
  if (timestamp == null) return '尚无成功采集';
  return `${dateKey(timestamp)} ${formatTime(timestamp, true)}`;
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}分钟` : `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}
