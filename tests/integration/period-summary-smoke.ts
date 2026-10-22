import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseClient, StorageError } from '../../src/services/storage/client';
import { EvidenceStore } from '../../src/services/evidence/store';
import { ModelWorkerQueue } from '../../src/workers/model';
import { analyzeWithOpenAICompatible } from '../../src/services/model/openai-compatible';
import type { ActivityAnalysisInput, ModelTask } from '../../src/shared/model-schemas';
import type { Activity } from '../../src/shared/activity-schemas';
import type { Settings, CaptureStatus, ReportResult } from '../../src/shared/schemas';
import type { WorklogSnapshot } from '../../src/services/worklog/repository';
import { dayBounds, dateKey } from '../../src/shared/time';
import { createReports } from '../../src/services/worklog/reports';

const app = 'local.one-room.period-summary', STEP = 5_000;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5kAAAAASUVORK5CYII=', 'base64');
const rejected = (code: string) => (error: unknown) => error instanceof StorageError && error.code === code;

export async function runPeriodSummarySmoke(workerPath: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'one-room-period-summary-')), path = join(root, 'history.sqlite');
  let database = new DatabaseClient(workerPath, path);
  const call = async <T>(name: string, input: unknown = {}) => (await database.call<T>(name, input)).data;
  const seen: ActivityAnalysisInput[] = [];
  const queue = new ModelWorkerQueue({
    analyze: (input, signal) => analyzeWithOpenAICompatible({ baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic-summary-test', apiKey: 'synthetic', input, signal,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(String(options!.body)) as { messages: { content: string }[] };
        const sent = JSON.parse(body.messages[1].content) as ActivityAnalysisInput;
        assert.ok(sent.periodContext); assert.ok(sent.sources.length <= 20);
        assert.ok(sent.sources.reduce((sum, source) => sum + source.text.length, 0) <= 64_000);
        assert.ok(!JSON.stringify(sent).includes('data:image'));
        seen.push(sent);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ activityAction: 'view', activityType: 'document',
          objectLabel: 'Synthetic report', topic: 'Synthetic work', summary: sent.periodContext.stage === 'reduce' ? 'Combined synthetic work across all chunks.' : 'Grounded synthetic work chunk.',
          sourceRefIds: [...new Set(sent.sources.map(source => source.sourceRefId))] }) } }] }), { status: 200 });
      },
    }),
    authorize: job => call<boolean>('periodSummary.authorize', job),
    commit: async (analysis, job) => { await call('periodSummary.commit', { job, analysis }); },
  });
  try {
    let policy = await call<Settings>('settings.get');
    policy = await call<Settings>('settings.updateCaptureScope', { expectedRevision: policy.revision, allowedBundleIds: [app], excludedBundleIds: [] });
    let capture = await call<CaptureStatus>('capture.setEnabled', { expectedRevision: policy.revision, enabled: true });
    const start = dayBounds(dateKey()).rangeStart + 10 * 3_600_000, sessionId = randomUUID(), ids: string[] = [];
    let store = new EvidenceStore(database, root); await store.initialize();
    const captureText = async (index: number, title: string) => {
      const id = randomUUID(); ids.push(id);
      await store.publish({ id, sessionId, observedAt: start + index * STEP, bundleId: app, appName: 'Synthetic editor', pid: 1, windowId: 42, windowTitle: title,
        trigger: 'checkpoint', captureGeneration: capture.generation, pairingStatus: 'matched', visibilityStatus: 'verified' }, png);
      await call('text.commit', { observationId: id, generation: capture.generation, selectedSource: 'accessibility', action: 'unknown',
        records: [{ source: 'accessibility', status: 'ready', completeness: 'complete', text: `Synthetic visible work ${index}`, fallbackReason: null, observedAt: start + index * STEP }] });
      return id;
    };
    for (let index = 0; index < 240; index++) await captureText(index, 'Document A');
    const b = await captureText(240, 'Document B');
    const back = await captureText(241, 'Document A');
    const c = await captureText(242, 'Document C');
    const reports = createReports({ read: input => call<WorklogSnapshot>('worklog.read', input), getReport: input => call<ReportResult>('report.get', input),
      findReportReceipt: input => call<ReportResult | null>('report.receipt', input), saveReport: (report, idempotencyKey) => call<ReportResult>('report.save', { report, idempotencyKey }) });
    const beforeSummaryRevision = (await database.call('bootstrap')).dataRevision;
    assert.equal((await reports.generate({ kind: 'daily', dateKey: dateKey(start), expectedDataRevision: beforeSummaryRevision, idempotencyKey: randomUUID() })).status, 'ready');
    await call('periodSummary.refresh', { observationId: c });
    assert.equal((await reports.get({ kind: 'daily', dateKey: dateKey(start) })).status, 'invalidated');
    let snapshot = await call<WorklogSnapshot>('worklog.read', dayBounds(dateKey(start)));
    assert.equal(snapshot.periods.length, 3); assert.equal(snapshot.periods[0].endTs - snapshot.periods[0].startTs, 240 * STEP);
    assert.equal(snapshot.periods[1].endTs - snapshot.periods[1].startTs, STEP); // A short B is never merged into A.
    assert.equal(snapshot.periods[2].id, back);
    assert.equal(snapshot.periods[0].summaryStatus, 'not_authorized');
    assert.deepEqual(await call('periodSummary.prepare'), []);
    policy = await call<Settings>('settings.get');
    policy = await call<Settings>('settings.updateTextConsent', { expectedRevision: policy.revision, enabled: true, allowedBundleIds: [app], confirmed: true });
    await call('periodSummary.retry');
    const stale = (await call<ModelTask[]>('periodSummary.prepare'))[0]; assert.ok(stale);
    policy = await call<Settings>('settings.updateTextConsent', { expectedRevision: policy.revision, enabled: false, allowedBundleIds: [], confirmed: false });
    await assert.rejects(queue.enqueue(stale)); assert.equal(seen.length, 0);
    await call('periodSummary.failed', { id: stale.id, status: 'not_authorized' });
    policy = await call<Settings>('settings.updateTextConsent', { expectedRevision: policy.revision, enabled: true, allowedBundleIds: [app], confirmed: true });
    await call('periodSummary.retry');
    // A persisted in-flight leaf is recovered after restart and authorized under current generations.
    assert.ok((await call<ModelTask[]>('periodSummary.prepare'))[0]);
    await database.close(); database = new DatabaseClient(workerPath, path);
    let manualLockChecked = false;
    for (let iteration = 0; iteration < 40; iteration++) {
      const jobs = await call<ModelTask[]>('periodSummary.prepare', { limit: 1 });
      if (!jobs.length) break;
      if (jobs[0].input.periodId === b) {
        const activity = (await call<{ items: Activity[] }>('activity.query', { limit: 100 })).items.find(item => item.observationId === b)!;
        await call('activity.review', { id: activity.id, expectedRevision: activity.revision, action: 'view', activityType: 'document', objectLabel: 'Confirmed B', topic: 'Confirmed topic', confirmed: true });
        assert.equal(await call('periodSummary.authorize', jobs[0]), false);
        await assert.rejects(call('periodSummary.commit', { job: jobs[0], analysis: { activityAction: 'view', activityType: 'document', objectLabel: 'Old', topic: null,
          summary: 'Late old result', sourceRefIds: jobs[0].input.sources.map(source => source.sourceRefId) } }), rejected('SOURCE_INVALIDATED'));
        await call('periodSummary.refresh', { activityId: activity.id }); manualLockChecked = true;
        continue;
      }
      await queue.enqueue(jobs[0]);
    }
    assert.ok(manualLockChecked);
    snapshot = await call<WorklogSnapshot>('worklog.read', dayBounds(dateKey(start)));
    const summarized = snapshot.periods.find(period => period.id === ids[0])!;
    assert.equal(summarized.summaryStatus, 'ready'); assert.equal(summarized.summary, 'Combined synthetic work across all chunks.');
    const leafTexts = seen.filter(input => input.periodId === ids[0] && input.periodContext?.stage === 'leaf').flatMap(input => input.sources.map(source => source.text));
    assert.equal(leafTexts.length, 240); assert.equal(new Set(leafTexts).size, 240);
    assert.equal(seen.filter(input => input.periodId === ids[0] && input.periodContext?.stage === 'reduce').length, 1);
    const reportRevision = (await database.call('bootstrap')).dataRevision;
    assert.equal((await database.call('bootstrap')).dataRevision, reportRevision); // Reads never bump revision.
    await call('evidence.expire', { now: start + 31 * 86_400_000 });
    assert.equal((await call<WorklogSnapshot>('worklog.read', dayBounds(dateKey(start)))).periods[0].summary, summarized.summary);

    const jobsBefore = new Database(path, { readonly: true });
    try {
      assert.equal((jobsBefore.prepare('SELECT count(*) AS n FROM period_sources WHERE periodId=?').get(ids[0]) as { n: number }).n, 720);
      assert.equal((jobsBefore.prepare('SELECT count(*) AS n FROM period_summary_jobs WHERE periodId=? AND level=0 AND status=\'succeeded\'').get(ids[0]) as { n: number }).n, 12);
    } finally { jobsBefore.close(); }
    assert.equal((await call<WorklogSnapshot>('worklog.read', dayBounds(dateKey(start)))).periods.find(period => period.id === b)!.basis, 'confirmed');
    assert.equal(await call('periodSummary.authorize', stale), false);
    await assert.rejects(call('periodSummary.commit', { job: stale, analysis: { activityAction: 'view', activityType: 'document', objectLabel: 'Old', topic: null, summary: 'Late old result', sourceRefIds: stale.input.sources.map(source => source.sourceRefId) } }), rejected('SOURCE_INVALIDATED'));

    // A canonical period crossing midnight keeps the same summary in both day projections.
    policy = await call<Settings>('settings.get');
    capture = await call<CaptureStatus>('capture.setEnabled', { expectedRevision: policy.revision, enabled: true });
    store = new EvidenceStore(database, root); await store.initialize();
    const midnight = dayBounds(dateKey(start)).rangeEnd;
    const crossing = await captureText((midnight - 60_000 - start) / STEP, 'Cross midnight');
    const nextDay = await captureText((midnight + 60_000 - start) / STEP, 'Next day');
    await captureText((midnight + 65_000 - start) / STEP, 'Next boundary');
    await call('periodSummary.refresh', { observationId: nextDay });
    for (let iteration = 0; iteration < 20; iteration++) {
      const jobs = await call<ModelTask[]>('periodSummary.prepare'); if (!jobs.length) break;
      await queue.enqueue(jobs[0]);
    }
    const firstDay = (await call<WorklogSnapshot>('worklog.read', dayBounds(dateKey(start)))).periods.find(period => period.id === crossing)!;
    const secondDay = (await call<WorklogSnapshot>('worklog.read', dayBounds(dateKey(midnight)))).periods.find(period => period.id === crossing)!;
    const bothDays = (await call<WorklogSnapshot>('worklog.read', { rangeStart: dayBounds(dateKey(start)).rangeStart, rangeEnd: midnight + 86_400_000 })).periods.find(period => period.id === crossing)!;
    assert.equal(firstDay.summaryStatus, 'ready'); assert.equal(secondDay.summaryStatus, 'ready');
    assert.equal(firstDay.summary, bothDays.summary); assert.equal(secondDay.summary, bothDays.summary);
    assert.equal(firstDay.endTs, midnight); assert.equal(secondDay.startTs, midnight);
    // Refreshing from day one ends its query at midnight, before the canonical owner ends.
    await call('periodSummary.refresh', { observationId: ids[0] });
    const afterRightEdgeRefresh = (await call<WorklogSnapshot>('worklog.read', dayBounds(dateKey(midnight)))).periods.find(period => period.id === crossing)!;
    assert.equal(afterRightEdgeRefresh.summaryStatus, 'ready'); assert.equal(afterRightEdgeRefresh.summary, bothDays.summary);

    // Delete one middle child, then rebuild the derived period from its retained first observation.
    const partial = await call<{ deletionRef: string; dataRevision: number }>('history.previewDelete', { rangeStart: start + 100 * STEP, rangeEnd: start + 101 * STEP });
    await call('history.delete', { deletionRef: partial.deletionRef, expectedRevision: partial.dataRevision, idempotencyKey: randomUUID(), confirmed: true });
    await call('periodSummary.refresh', { observationId: ids[0] });
    const restored = (await call<WorklogSnapshot>('worklog.read', dayBounds(dateKey(start)))).periods.find(period => period.id === ids[0])!;
    assert.equal(restored.summaryStatus, 'pending'); assert.equal(restored.endTs, start + 100 * STEP);
    assert.equal((await reports.get({ kind: 'daily', dateKey: dateKey(start) })).status, 'invalidated');

    const preview = await call<{ deletionRef: string; dataRevision: number }>('history.previewDelete', { rangeStart: start, rangeEnd: start + 240 * STEP });
    await call('history.delete', { deletionRef: preview.deletionRef, expectedRevision: preview.dataRevision, idempotencyKey: randomUUID(), confirmed: true });
    await database.close();
    const inspect = new Database(path, { readonly: true });
    try {
      assert.equal((inspect.prepare('SELECT count(*) AS n FROM period_summary_jobs WHERE periodId=? AND (inputJson IS NOT NULL OR resultJson IS NOT NULL)').get(ids[0]) as { n: number }).n, 0);
      assert.equal((inspect.prepare('SELECT summary FROM periods WHERE id=?').get(ids[0]) as { summary: string | null }).summary, null);
      assert.deepEqual(inspect.pragma('foreign_key_check'), []);
    } finally { inspect.close(); }
    console.log(JSON.stringify({ status: 'passed', suite: 'period-summary', observations: ids.length, longPeriodSources: 240, modelRequests: seen.length,
      checks: ['closed A-B-A boundaries', '240-text bounded leaf/reduce pipeline', 'HTTP schema and no images', 'dispatch and commit authorization', 'restart interrupted leaf', 'manual lock', 'expiry keeps summary', 'cross-midnight day/month summary', 'middle-child deletion and retained-fact rebuild', 'manual delete scrubs all job copies'] }));
  } finally { queue.close(); await database.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
}
