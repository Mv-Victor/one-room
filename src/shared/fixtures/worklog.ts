import { inputSchemas, type OneRoomApi, type Reply } from '../contracts';
import { toAppError, DomainError } from '../errors';
import type { AppStatus, CaptureStatus, DomainEvent, Gap, Period, Permissions, Settings, ReportResult } from '../schemas';
import { createSnapshotQueries, matchesPeriod } from '../../services/worklog/queries';
import type { WorklogSnapshot } from '../../services/worklog/repository';
import { createReports } from '../../services/worklog/reports';
import { createHistoryDelete } from '../../services/worklog/history-delete';
import { overlaps } from '../../services/worklog/periodizer';

const fixtureId = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
export const FIXTURE_DATE_KEY = '2026-10-15';
export const FIXTURE_START = Date.parse(`${FIXTURE_DATE_KEY}T09:00:00+08:00`);
export const FIXTURE_END = FIXTURE_START + 1_630_000;
const period = (id: number, start: number, end: number, appName: string, appBundleId: string): Period => ({
  id: fixtureId(id), startTs: FIXTURE_START + start, endTs: FIXTURE_START + end,
  appName, appBundleId, windowTitle: null, activityType: 'unknown', objectLabel: null,
  topic: null, summary: null, summaryStatus: 'not_authorized', basis: 'observed', revision: 1
});
export const WORKLOG_FIXTURE = {
  id: 'isolated-worklog-fixture', label: '开发示例数据',
  periods: [period(1, 0, 600_000, 'Visual Studio Code', 'com.microsoft.VSCode'),
    period(2, 600_000, 610_000, 'Kim', 'com.kuaishou.kim'),
    period(3, 610_000, 1_510_000, 'Visual Studio Code', 'com.microsoft.VSCode')],
  gaps: [{ id: fixtureId(4), startTs: FIXTURE_START + 1_510_000, endTs: FIXTURE_END, reason: 'paused', revision: 1 }] satisfies Gap[],
  evidenceCases: { availablePeriodId: fixtureId(1), expiredPeriodId: fixtureId(2), delayedPeriodId: fixtureId(3), imageBytesAvailable: false }
} as const;
export const FIXTURE_SETTINGS: Settings = {
  revision: 1, captureEnabled: false, captureGeneration: 1, allowedBundleIds: [], excludedBundleIds: [],
  textConsent: { enabled: false, allowedBundleIds: [], revision: 1, generation: 1 },
  screenshotRetentionDays: 30, timezone: 'Asia/Shanghai', defaultAgent: 'codex'
};
export const FIXTURE_PERMISSIONS: Permissions = {
  screen: { status: 'unknown', responsibleProcess: 'fixture', reason: 'DEVELOPMENT_FIXTURE' },
  accessibility: { status: 'unknown', responsibleProcess: 'fixture', reason: 'DEVELOPMENT_FIXTURE' },
  inputMonitoring: { status: 'not_required', responsibleProcess: 'fixture', reason: 'DEVELOPMENT_FIXTURE' }, checkedAt: FIXTURE_START
};
export function createFixtureSnapshot(): WorklogSnapshot {
  return { dataRevision: 1, periods: WORKLOG_FIXTURE.periods.map(p => ({ ...p })), gaps: WORKLOG_FIXTURE.gaps.map(g => ({ ...g })),
    observations: WORKLOG_FIXTURE.periods.map((p, index) => ({ id: fixtureId(11 + index), observedAt: p.startTs, revision: 1,
      periodId: p.id, displayUntil: p.endTs, evidence: { evidenceId: fixtureId(21 + index),
        status: index === 1 ? 'expired' : 'missing', observedAt: p.startTs, displayUntil: p.endTs, requestToken: fixtureId(31 + index), url: null } })) };
}

// In-memory only. The production renderer never imports this module.
export function createFixtureApi(options: { delayEvidenceMs?: number } = {}): OneRoomApi {
  let settings = structuredClone(FIXTURE_SETTINGS), snapshot = createFixtureSnapshot();
  const listeners = new Set<(event: DomainEvent) => void>();
  const reports = new Map<string, ReportResult>(), reportReceipts = new Map<string, ReportResult>();
  let sequence = 0;
  const emit = (type: DomainEvent['type']) => {
    for (const listener of listeners) listener({ streamId: fixtureId(90), sequence: ++sequence, type, entityId: 'fixture', revision: snapshot.dataRevision });
  };
  const capture = (): CaptureStatus => ({ state: 'paused', revision: settings.revision, generation: settings.captureGeneration, lastSuccessfulAt: null, reason: 'DEVELOPMENT_FIXTURE' });
  const ok = <T>(data: T): Reply<T> => ({ requestId: crypto.randomUUID(), ok: true, data, dataRevision: snapshot.dataRevision });
  const invoke = async <T>(action: () => T | Promise<T>): Promise<Reply<T>> => {
    try { return ok(await action()); } catch (error) { return { requestId: crypto.randomUUID(), ok: false, error: toAppError(error) }; }
  };
  const expectRevision = (revision: number, current = settings.revision) => {
    if (revision !== current) throw new DomainError('STALE_REVISION', '记录已变化，请刷新。');
  };
  const reader = { read: async () => structuredClone(snapshot) };
  const queries = createSnapshotQueries(reader);
  const reportService = createReports({ ...reader,
    getReport: async input => structuredClone(reports.get(`${input.kind}:${input.dateKey}`) ?? { status: 'absent', report: null }),
    saveReport: async (report, key) => {
      const prior = reportReceipts.get(key);
      if (prior) return structuredClone(prior);
      expectRevision(report.sourceRevision, snapshot.dataRevision);
      const result: ReportResult = { status: 'ready', report };
      reports.set(`${report.kind}:${report.dateKey}`, result); reportReceipts.set(key, result); emit('report.changed');
      return structuredClone(result);
    }
  });
  const select = (input: { rangeStart: number; rangeEnd: number; bundleIds?: string[] }) => snapshot.periods.filter(p => overlaps(p, input.rangeStart, input.rangeEnd) && matchesPeriod(p, input));
  const history = createHistoryDelete({
    preview: async input => {
      const ids = new Set(select(input).map(p => p.id));
      return { dataRevision: snapshot.dataRevision, observationCount: snapshot.observations.filter(o => ids.has(o.periodId)).length,
        periodCount: ids.size, reportCount: [...reports.values()].filter(r => r.report?.periods.some(p => ids.has(p.id))).length };
    },
    delete: async (input, revision) => {
      expectRevision(revision, snapshot.dataRevision);
      const ids = new Set(select(input).map(p => p.id));
      snapshot = { ...snapshot, dataRevision: snapshot.dataRevision + 1,
        periods: snapshot.periods.filter(p => !ids.has(p.id)), observations: snapshot.observations.filter(o => !ids.has(o.periodId)) };
      for (const [key, value] of reports) if (value.report?.periods.some(p => ids.has(p.id))) reports.set(key, { status: 'invalidated', report: null });
      reportReceipts.clear(); emit('source.invalidated'); emit('timeline.changed');
      return { cleanup: 'complete', dataRevision: snapshot.dataRevision };
    }
  });
  return {
    app: { getStatus: input => invoke(() => {
      inputSchemas['app.getStatus'].parse(input);
      return { appVersion: '0.1.0-fixture', schemaVersion: 1, dataRevision: snapshot.dataRevision, capture: capture(), storage: { state: 'ready', journalMode: 'wal' },
        capabilities: { nativeCapture: false, accessibilityText: false, visionOcr: false, backgroundTextAnalysis: false, discovery: false, codex: false } } satisfies AppStatus;
    }) },
    permissions: {
      get: input => invoke(() => { inputSchemas['permissions.get'].parse(input); return structuredClone(FIXTURE_PERMISSIONS); }),
      openSettings: input => invoke(() => ({ opened: false, kind: inputSchemas['permissions.openSettings'].parse(input).kind }))
    },
    capture: {
      pause: input => invoke(() => { inputSchemas['capture.pause'].parse(input); expectRevision(input.expectedRevision); return capture(); }),
      resume: input => invoke(() => { inputSchemas['capture.resume'].parse(input); throw new DomainError('CAPABILITY_BLOCKED', '示例数据不采集屏幕。', 'FIXTURE_ONLY'); })
    },
    settings: {
      get: input => invoke(() => { inputSchemas['settings.get'].parse(input); return structuredClone(settings); }),
      updateCaptureScope: input => invoke(() => {
        const parsed = inputSchemas['settings.updateCaptureScope'].parse(input); expectRevision(parsed.expectedRevision);
        settings = { ...settings, revision: settings.revision + 1, captureGeneration: settings.captureGeneration + 1,
          allowedBundleIds: [...new Set(parsed.allowedBundleIds)], excludedBundleIds: [...new Set(parsed.excludedBundleIds)] };
        emit('settings.changed'); return structuredClone(settings);
      }),
      updateTextConsent: input => invoke(() => {
        const parsed = inputSchemas['settings.updateTextConsent'].parse(input); expectRevision(parsed.expectedRevision);
        if (parsed.enabled) throw new DomainError('CAPABILITY_BLOCKED', '示例数据不发送模型材料。');
        settings = { ...settings, revision: settings.revision + 1, textConsent: { enabled: false, allowedBundleIds: [], revision: settings.textConsent.revision + 1, generation: settings.textConsent.generation + 1 } };
        emit('settings.changed'); return structuredClone(settings);
      })
    },
    model: {
      getConfig: input => invoke(() => { inputSchemas['model.getConfig'].parse(input); throw new DomainError('CAPABILITY_BLOCKED', '示例数据不配置模型或凭证。', 'FIXTURE_ONLY'); }),
      saveConfig: input => invoke(() => { inputSchemas['model.saveConfig'].parse(input); throw new DomainError('CAPABILITY_BLOCKED', '示例数据不配置模型或凭证。', 'FIXTURE_ONLY'); }),
      testConnection: input => invoke(() => { inputSchemas['model.testConnection'].parse(input); throw new DomainError('CAPABILITY_BLOCKED', '示例数据不调用模型服务。', 'FIXTURE_ONLY'); }),
      clearCredential: input => invoke(() => { inputSchemas['model.clearCredential'].parse(input); throw new DomainError('CAPABILITY_BLOCKED', '示例数据不配置模型或凭证。', 'FIXTURE_ONLY'); }),
    },
    activity: {
      query: input => invoke(() => { inputSchemas['activity.query'].parse(input); throw new DomainError('CAPABILITY_BLOCKED', '示例数据未接入活动修订。', 'FIXTURE_ONLY'); }),
      review: input => invoke(() => { inputSchemas['activity.review'].parse(input); throw new DomainError('CAPABILITY_BLOCKED', '示例数据未接入活动修订。', 'FIXTURE_ONLY'); }),
    },
    timeline: {
      query: input => invoke(() => queries.timeline(input)),
      resolveCursor: input => invoke(async () => {
        // Freeze before the delay to exercise late responses after selection/deletion.
        const result = await queries.cursor(input);
        if (result.period?.id === WORKLOG_FIXTURE.evidenceCases.delayedPeriodId && options.delayEvidenceMs) await new Promise(resolve => setTimeout(resolve, options.delayEvidenceMs));
        return result;
      })
    },
    calendar: { query: input => invoke(async () => {
      const page = await queries.calendar(input);
      return { ...page, days: page.days.map(day => ({ ...day, report: {
        daily: reports.get(`daily:${day.dateKey}`)?.status ?? 'absent', weekly: reports.get(`weekly:${day.dateKey}`)?.status ?? 'absent'
      } })) };
    }) },
    report: { get: input => invoke(() => reportService.get(input)), generate: input => invoke(() => reportService.generate(input)) },
    history: { previewDelete: input => invoke(() => history.preview(input)), delete: input => invoke(() => history.delete(input)) },
    events: { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } }
  };
}
