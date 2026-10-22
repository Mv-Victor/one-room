import type { Period, ReportSnapshot } from '../../shared/schemas';
import { DAY_MS, dateKey, dayBounds } from '../../shared/time';
import { unionDuration } from '../../services/worklog/periodizer';
import { formatDuration, formatTime } from '../lib/time';
import { actionLabels, activityLabels, basisLabels, summaryLabels } from '../timeline/presentation';

type Basis = Period['basis'];
export type StoryPeriod = Omit<Period, 'windowTitle'> & { durationMs: number };
export type ReportAllocation = { key: string; label: string; durationMs: number; share: number; bases: Basis[] };
export type ReportDay = { dateKey: string; observedMs: number; gapMs: number; unknownMs: number; periods: StoryPeriod[] };
export type ReportHighlight = { periodId: string; title: string; detail: string; basis: Basis; startTs: number; endTs: number };
export type ReportMoment = { timestamp: number; title: string; detail: string; basis: Basis };
export type ReportStory = {
  title: string; dateLabel: string; totalPeriods: number;
  totals: { observedMs: number; gapMs: number; unknownMs: number; totalMs: number; coverage: number | null };
  allocations: ReportAllocation[]; apps: ReportAllocation[]; activities: ReportAllocation[];
  rhythm: ReportDay[]; switchCount: number; longestPeriod: StoryPeriod | null;
  first: ReportMoment | null; last: ReportMoment | null; lateMoment: ReportMoment | null;
  highlights: ReportHighlight[]; moments: ReportMoment[];
};
type Interval = { startTs: number; endTs: number };
type Slice = Interval & { appKey: string; activityKey: string; bases: Basis[] };
const basisOrder: Basis[] = ['observed', 'inferred', 'confirmed'];
const ambiguous = 'overlap:unknown';
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const periodKey = (period: StoryPeriod) => JSON.stringify([period.id, period.appBundleId, period.appName, period.activityType, period.action,
  period.objectLabel, period.topic, period.summary, period.summaryStatus, period.basis, period.revision]);
const chronological = (a: StoryPeriod, b: StoryPeriod) => a.startTs - b.startTs || a.endTs - b.endTs || compare(periodKey(a), periodKey(b));
const hour = (timestamp: number) => new Date(timestamp + 8 * 3_600_000).getUTCHours();
const content = (value: string | null | undefined) => value?.trim() || null;

function visiblePeriod(period: Period, startTs: number, endTs: number): StoryPeriod {
  return { id: period.id, startTs, endTs, durationMs: endTs - startTs, appBundleId: period.appBundleId, appName: period.appName,
    activityType: period.activityType, ...(period.action ? { action: period.action } : {}), objectLabel: period.objectLabel, topic: period.topic,
    summary: period.summaryStatus === 'ready' ? period.summary : null, summaryStatus: period.summaryStatus, basis: period.basis, revision: period.revision };
}

function canonicalPeriods(report: ReportSnapshot): StoryPeriod[] {
  const groups = new Map<string, StoryPeriod[]>();
  for (const period of report.periods) {
    const start = Math.max(report.rangeStart, period.startTs), end = Math.min(report.rangeEnd, period.endTs);
    if (end <= start) continue;
    const row = visiblePeriod(period, start, end);
    const key = periodKey(row);
    const entries = groups.get(key) ?? []; entries.push(row); groups.set(key, entries);
  }
  const merged: StoryPeriod[] = [];
  for (const entries of groups.values()) {
    let prior: StoryPeriod | undefined;
    for (const row of entries.sort(chronological)) {
      if (prior && row.startTs <= prior.endTs) { prior.endTs = Math.max(prior.endTs, row.endTs); prior.durationMs = prior.endTs - prior.startTs; }
      else { prior = { ...row }; merged.push(prior); }
    }
  }
  return merged.sort(chronological);
}

function slicesFor(periods: readonly StoryPeriod[]): Slice[] {
  const events = new Map<number, { period: StoryPeriod; delta: 1 | -1 }[]>();
  for (const period of periods) for (const [timestamp, delta] of [[period.startTs, 1], [period.endTs, -1]] as const) {
    const entries = events.get(timestamp) ?? []; entries.push({ period, delta }); events.set(timestamp, entries);
  }
  const apps = new Map<string, number>(), activities = new Map<string, number>(), bases = new Map<Basis, number>();
  const add = <T>(counts: Map<T, number>, key: T, delta: number) => {
    const count = (counts.get(key) ?? 0) + delta;
    if (count) counts.set(key, count); else counts.delete(key);
  };
  const times = [...events.keys()].sort((a, b) => a - b), slices: Slice[] = [];
  for (let index = 0; index + 1 < times.length; index++) {
    const startTs = times[index], endTs = times[index + 1];
    for (const { period, delta } of events.get(startTs)!) {
      add(apps, period.appBundleId, delta); add(activities, period.activityType, delta); add(bases, period.basis, delta);
    }
    if (apps.size && endTs > startTs) slices.push({ startTs, endTs,
      appKey: apps.size === 1 ? apps.keys().next().value! : ambiguous,
      activityKey: activities.size === 1 ? activities.keys().next().value! : ambiguous,
      bases: basisOrder.filter(basis => bases.has(basis)) });
  }
  return slices;
}

function allocation(slices: readonly Slice[], field: 'appKey' | 'activityKey', labels: ReadonlyMap<string, string>, observedMs: number): ReportAllocation[] {
  const rows = new Map<string, ReportAllocation>();
  for (const slice of slices) {
    const key = slice[field], row = rows.get(key) ?? { key, label: labels.get(key) ?? '分类待确认', durationMs: 0, share: 0, bases: [] };
    row.durationMs += slice.endTs - slice.startTs;
    row.bases = basisOrder.filter(basis => row.bases.includes(basis) || slice.bases.includes(basis));
    rows.set(key, row);
  }
  return [...rows.values()].map(row => ({ ...row, share: observedMs ? row.durationMs / observedMs : 0 }))
    .sort((a, b) => b.durationMs - a.durationMs || compare(a.key, b.key));
}

function coverage(periods: readonly Interval[], gaps: readonly Interval[], totalMs: number) {
  const observedMs = unionDuration(periods), gapMs = Math.max(0, unionDuration([...periods, ...gaps]) - observedMs);
  return { observedMs, gapMs, unknownMs: Math.max(0, totalMs - observedMs - gapMs), totalMs,
    coverage: totalMs > 0 ? observedMs / totalMs : null };
}

export function deriveReportStory(report: ReportSnapshot): ReportStory {
  const periods = canonicalPeriods(report), slices = slicesFor(periods);
  const gaps = report.gaps.map(gap => ({ startTs: Math.max(report.rangeStart, gap.startTs), endTs: Math.min(report.rangeEnd, gap.endTs) })).filter(gap => gap.endTs > gap.startTs);
  const totals = coverage(periods, gaps, Math.max(0, report.rangeEnd - report.rangeStart));
  const appNames = new Map<string, string>([[ambiguous, '重叠记录 · 应用待确认']]);
  for (const period of [...periods].sort((a, b) => compare(a.appName, b.appName))) if (!appNames.has(period.appBundleId)) appNames.set(period.appBundleId, period.appName);
  const activityNames = new Map<string, string>(Object.entries(activityLabels)); activityNames.set(ambiguous, '重叠记录 · 类型待确认');
  const apps = allocation(slices, 'appKey', appNames, totals.observedMs), activities = allocation(slices, 'activityKey', activityNames, totals.observedMs);
  const rhythm: ReportDay[] = [];
  for (let timestamp = dayBounds(dateKey(report.rangeStart)).rangeStart; timestamp < report.rangeEnd; timestamp += DAY_MS) {
    const start = Math.max(timestamp, report.rangeStart), end = Math.min(timestamp + DAY_MS, report.rangeEnd);
    const dayPeriods = periods.filter(period => period.startTs < end && period.endTs > start).map(period => visiblePeriod({ ...period, windowTitle: null }, Math.max(start, period.startTs), Math.min(end, period.endTs)));
    const dayGaps = gaps.filter(gap => gap.startTs < end && gap.endTs > start).map(gap => ({ startTs: Math.max(start, gap.startTs), endTs: Math.min(end, gap.endTs) }));
    const day = coverage(dayPeriods, dayGaps, end - start);
    rhythm.push({ dateKey: dateKey(start), observedMs: day.observedMs, gapMs: day.gapMs, unknownMs: day.unknownMs, periods: dayPeriods });
  }
  const firstPeriod = periods[0], lastPeriod = [...periods].sort((a, b) => b.endTs - a.endTs || chronological(a, b))[0];
  const moment = (period: StoryPeriod, timestamp: number, title: string, detail: string): ReportMoment => ({ timestamp, title, detail, basis: period.basis });
  const first = firstPeriod ? moment(firstPeriod, firstPeriod.startTs, '最早可见区间', `${firstPeriod.appName} · 区间左边界，不代表记录或工作起点`) : null;
  const last = lastPeriod ? moment(lastPeriod, lastPeriod.endTs, '可见记录截至', `${lastPeriod.appName} · 区间右边界，不代表工作结束`) : null;
  // Report snapshots may already be clipped; a range-boundary start cannot prove an actual night record start.
  const originalStarts = new Map<string, number>();
  for (const period of report.periods) originalStarts.set(period.id, Math.min(originalStarts.get(period.id) ?? Infinity, period.startTs));
  const latePeriod = periods.filter(period => period.startTs > report.rangeStart && period.startTs === originalStarts.get(period.id) && (hour(period.startTs) >= 22 || hour(period.startTs) < 6)).at(-1);
  const lateMoment = latePeriod ? moment(latePeriod, latePeriod.startTs,
    '夜间可见记录', `${latePeriod.appName} · 可见记录时间，不代表工作时长或加班`) : null;
  const seen = new Set<string>(), highlights: ReportHighlight[] = [];
  for (const period of periods) {
    const title = content(period.objectLabel) ?? content(period.topic) ?? (content(period.summary) ? period.appName : null);
    const detail = content(period.summary) ?? (content(period.topic) !== title ? content(period.topic) : null) ?? content(period.objectLabel) ?? content(period.topic);
    if (!title || !detail) continue;
    const key = JSON.stringify([title, detail, period.basis]); if (seen.has(key)) continue;
    seen.add(key); highlights.push({ periodId: period.id, title, detail, basis: period.basis, startTs: period.startTs, endTs: period.endTs });
    if (highlights.length === 6) break;
  }
  const longestPeriod = [...periods].sort((a, b) => b.durationMs - a.durationMs || chronological(a, b))[0] ?? null;
  const switchCount = slices.reduce((total, slice, index) => {
    const previous = slices[index - 1];
    return total + Number(!!previous && previous.endTs === slice.startTs && previous.appKey !== ambiguous && slice.appKey !== ambiguous && previous.appKey !== slice.appKey);
  }, 0);
  return { title: `One Room ${report.kind === 'daily' ? '日报' : '周报'}`,
    dateLabel: report.kind === 'daily' ? dateKey(report.rangeStart) : `${dateKey(report.rangeStart)} 至 ${dateKey(Math.max(report.rangeStart, report.rangeEnd - 1))}`,
    totalPeriods: new Set(periods.map(period => period.id)).size, totals, allocations: apps, apps, activities, rhythm,
    switchCount, longestPeriod, first, last, lateMoment, highlights, moments: [first, last, lateMoment].filter((value): value is ReportMoment => value !== null) };
}

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
const atTime = (timestamp: number) => `${dateKey(timestamp)} ${formatTime(timestamp, true)}`;
const basisText = (bases: readonly Basis[]) => bases.map(basis => basisLabels[basis]).join('、');

export function renderReportHtml(report: ReportSnapshot, story = deriveReportStory(report)): string {
  const text = escapeHtml;
  const allocations = (rows: readonly ReportAllocation[]) => rows.length ? `<ul class="allocations">${rows.map(row => `<li><span>${text(row.label)}<small>${text(basisText(row.bases))}</small></span><strong>${text(formatDuration(row.durationMs))} <small>${Math.round(row.share * 100)}%</small></strong><i style="width:${(row.share * 100).toFixed(2)}%"></i></li>`).join('')}</ul>` : '<p class="muted">暂无可见记录</p>';
  const highlights = story.highlights.length ? `<ul class="highlights">${story.highlights.map(item => `<li><small>${text(atTime(item.startTs))} · ${text(basisLabels[item.basis])}</small><h3>${text(item.title)}</h3><p>${text(item.detail)}</p></li>`).join('')}</ul>` : '<p class="muted">没有可用的主题或总结，保留事实时间线。</p>';
  const rhythm = story.rhythm.map(day => `<section class="day"><h3>${text(day.dateKey)}<small>已记录 ${text(formatDuration(day.observedMs))} · 缺口 ${text(formatDuration(day.gapMs))} · 未覆盖 ${text(formatDuration(day.unknownMs))}</small></h3>${day.periods.length ? `<ol>${day.periods.map(period => `<li><time>${text(formatTime(period.startTs))} - ${text(formatTime(period.endTs))}</time><div><strong>${text(period.appName)} · ${text(actionLabels[period.action ?? 'unknown'])} · ${text(activityLabels[period.activityType])}</strong><p>${text(content(period.objectLabel) ?? '对象未知')}${content(period.topic) ? ` · ${text(period.topic!)}` : ''}</p><p>${text(content(period.summary) ?? summaryLabels[period.summaryStatus])}</p><small>${text(basisLabels[period.basis])} · ${text(formatDuration(period.durationMs))}</small></div></li>`).join('')}</ol>` : '<p class="muted">本日无可见记录，未覆盖时间不作推断。</p>'}</section>`).join('');
  const sources = story.rhythm.flatMap(day => day.periods).map(period => `<tr><td>${text(atTime(period.startTs))}<br>${text(atTime(period.endTs))}</td><td>${text(period.appName)}<br>${text(activityLabels[period.activityType])}</td><td>${text(content(period.objectLabel) ?? '对象未知')}${content(period.topic) ? `<br>${text(period.topic!)}` : ''}</td><td>${text(basisLabels[period.basis])}<br>${text(summaryLabels[period.summaryStatus])}</td><td>${text(period.id)}<br>版本 ${period.revision}</td></tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>${text(story.title)} · ${text(story.dateLabel)}</title><style>
*{box-sizing:border-box}body{margin:0;color:#25272c;background:#f5f6f7;font:15px/1.65 system-ui,-apple-system,sans-serif;letter-spacing:0}main{max-width:1080px;margin:auto;background:#fff;padding:40px}header{border-top:6px solid #a43d4d;padding:24px 0;border-bottom:1px solid #d9dce0}h1{font-size:30px;margin:0}h2{font-size:20px;margin:28px 0 14px}h3{font-size:16px;margin:0}p{margin:6px 0;overflow-wrap:anywhere;white-space:pre-wrap}small,.muted{color:#626874}small{font-size:12px}.eyebrow{color:#a43d4d;font-weight:600}.review{margin-top:20px;padding-left:12px;border-left:3px solid #c58e24;color:#5b4c32}.totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;padding:22px 0;border-bottom:1px solid #d9dce0}.totals dt{font-size:12px;color:#626874}.totals dd{margin:4px 0 0;font-size:22px;font-weight:650}.columns{display:grid;grid-template-columns:1fr 1fr;gap:36px}.allocations,.highlights{padding:0;list-style:none}.allocations li{position:relative;display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:3px solid #edf0f1}.allocations li>span{min-width:0;overflow-wrap:anywhere}.allocations small{display:block}.allocations strong{flex-shrink:0;font-size:14px;text-align:right}.allocations i{position:absolute;height:3px;background:#277e79;bottom:-3px;left:0}.highlights{display:grid;grid-template-columns:1fr 1fr;gap:20px}.highlights li{border-top:1px solid #d9dce0;padding-top:12px;min-width:0;overflow-wrap:anywhere}.day{border-top:1px solid #d9dce0;padding:16px 0}.day h3 small{display:block;font-weight:400}.day ol{list-style:none;padding:0;margin:10px 0}.day li{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px;padding:10px 0}.day time{font-size:13px;color:#626874}.moments{display:flex;flex-wrap:wrap;gap:12px 28px;border-top:1px solid #d9dce0;padding:16px 0}.moments p{flex:1;min-width:190px}.moments strong{display:block}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:9px 10px;text-align:left;vertical-align:top;border-bottom:1px solid #d9dce0;overflow-wrap:anywhere}th{background:#f5f6f7;font-weight:600}td:last-child{max-width:180px}footer{margin-top:24px;border-top:1px solid #d9dce0;padding-top:16px;color:#626874;font-size:12px}@media(max-width:620px){main{padding:20px}.totals{grid-template-columns:1fr 1fr}.columns,.highlights{grid-template-columns:1fr}.columns{gap:0}.day li{grid-template-columns:1fr;gap:4px}h1{font-size:26px}}@media print{body{background:#fff}main{padding:16px}.day li,.highlights li{break-inside:avoid}.table-wrap{overflow:visible}thead{display:table-header-group}}
body{color:#415d4c;background:#f6f8f6;font-size:14px}main{padding:32px 40px}header{border-top:0;padding:16px 0 24px;border-color:#d9e2dc}h1{font-size:27px;font-weight:600;color:#273f34;margin-top:12px}h2{font-size:17px;color:#3f5949}small,.muted{color:#85958a}.eyebrow{color:#4c7a6a;font-size:11px}.review{font-size:11px;color:#8a958d;border:0;padding:0;margin:18px 0}.totals{grid-template-columns:repeat(3,minmax(0,1fr));gap:24px 18px}.totals>div:first-child{grid-column:1/-1}.totals dt{color:#7c8d81;font-size:11px}.totals dd{font-size:21px;font-weight:500;overflow-wrap:anywhere}.totals>div:first-child dd{color:#236e59;font-size:44px}.totals>div:nth-child(2) dd{color:#a97454}.totals>div:nth-child(3) dd{color:#7f8c98}.first-record{margin-top:9px;color:#8a998f;font-size:12px}.moments strong{font-size:25px;font-weight:500;color:#46755f}.moments p{font-size:12px}.highlights li{border-color:#d9e2dc}footer{color:#8a958d;font-size:11px}@media(max-width:620px){main{padding:22px 18px}h1{font-size:23px}.totals>div:first-child dd{font-size:38px}.totals{grid-template-columns:1fr 1fr}.moments strong{font-size:23px}}
</style></head><body><main><header><div class="eyebrow">ONE ROOM · ${text(story.dateLabel)} · 上海时间</div><h1>${report.kind === 'weekly' ? '这一周，留下了这些记录' : '这一天，留下了这些记录'}</h1></header>
<p class="review">发布或转发前，请审阅主题、对象和总结中的敏感信息。</p>
<dl class="totals"><div><dt>已记录</dt><dd>${text(formatDuration(story.totals.observedMs))}</dd>${story.first ? `<p class="first-record">最早可见区间：${text(atTime(story.first.timestamp))} · ${text(story.first.detail)}</p>` : ''}</div><div><dt>明确缺口</dt><dd>${text(formatDuration(story.totals.gapMs))}</dd></div><div><dt>未覆盖</dt><dd>${text(formatDuration(story.totals.unknownMs))}</dd></div><div><dt>可见应用切换</dt><dd>${story.switchCount} 次</dd></div></dl>
<div class="columns"><section><h2>应用时间分配</h2>${allocations(story.apps)}</section><section><h2>活动类型</h2>${allocations(story.activities)}</section></div>
<section><h2>回顾片段</h2>${highlights}</section>
<div class="moments">${story.moments.map(item => `<p><small>${text(item.title)} · ${text(basisLabels[item.basis])}</small><strong>${text(atTime(item.timestamp))}</strong>${text(item.detail)}</p>`).join('')}${story.longestPeriod ? `<p><small>最长单段可见记录</small><strong>${text(formatDuration(story.longestPeriod.durationMs))}</strong>${text(story.longestPeriod.appName)} · ${text(basisLabels[story.longestPeriod.basis])}</p>` : ''}</div>
<section><h2>${report.kind === 'weekly' ? '一周节奏' : '当天节奏'}</h2>${rhythm}</section>
<section><h2>来源简表</h2><div class="table-wrap"><table><thead><tr><th>可见区间</th><th>应用与类型</th><th>对象与主题</th><th>依据与总结状态</th><th>记录与版本</th></tr></thead><tbody>${sources || '<tr><td colspan="5">暂无来源记录</td></tr>'}</tbody></table></div></section>
<footer>时长按可见记录区间去重，未覆盖时间不作推断；分类依据随记录保留，不代表业务完成或绩效评价。<br>来源版本 ${report.sourceRevision} · 生成于 ${text(atTime(report.generatedAt))} · 报告 ${text(report.id)}</footer></main></body></html>`;
}
