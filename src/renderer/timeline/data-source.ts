import type { MethodInput, MethodOutput } from '../../shared/contracts';
import { connectDesktopApi, unwrap } from '../lib/desktop';
import { dayBounds } from '../lib/time';

export type TimelinePage = MethodOutput<'timeline.query'>;

export async function queryTimeline(key: string | { rangeStart: number; rangeEnd: number }, filters: Pick<MethodInput<'timeline.query'>, 'bundleIds' | 'query'> = {}): Promise<TimelinePage> {
  const api = await connectDesktopApi();
  const range = typeof key === 'string' ? dayBounds(key) : key;
  let page = unwrap(await api.timeline.query({ ...range, ...filters, limit: 500 }));
  const result = { ...page, periods: [...page.periods], gaps: [...page.gaps] };
  const seen = new Set<string>();
  while (page.nextCursor) {
    if (seen.has(page.nextCursor)) throw new Error('分页未前进，请刷新。');
    seen.add(page.nextCursor);
    page = unwrap(await api.timeline.query({ ...range, ...filters, limit: 500, cursor: page.nextCursor }));
    if (page.dataRevision !== result.dataRevision) throw new Error('记录已更新，请刷新。');
    result.periods.push(...page.periods); result.gaps.push(...page.gaps);
  }
  return { ...result, nextCursor: null };
}
