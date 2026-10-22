import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DatabaseClient } from '../../src/services/storage/client';
import { EvidenceStore } from '../../src/services/evidence/store';
import type { StorageDiagnostics, ObservationInput } from '../../src/services/storage/protocol';
import type { Settings, CaptureStatus } from '../../src/shared/schemas';
import { runCaptureAnalysisSmoke } from './capture-analysis-smoke';
import { runWorklogStorageSmoke } from './worklog-storage-smoke';
import { draftSkill, type Candidate, type SkillVersion, type StrategyRule } from '../../src/services/reuse/types';
import { reuseOutputs } from '../../src/services/reuse/contracts';
import type { Activity } from '../../src/shared/activity-schemas';
import { runPeriodSummarySmoke } from './period-summary-smoke';
import { cleanupReuseRunFiles } from '../../src/services/reuse/history-cleanup';
import type { HistoryDeleteCommit } from '../../src/services/storage/worklog-commands';
import type { MethodOutput } from '../../src/shared/contracts';
import { runDocumentOperationsSmoke } from './document-operations-smoke';
import { runDocumentRunsSmoke } from './document-runs-smoke';

const root = await mkdtemp(join(tmpdir(), 'one-room-foundation-'));
const worker = join(dirname(fileURLToPath(import.meta.url)), 'database.js');
const databasePath = join(root, 'history.sqlite');
let database = new DatabaseClient(worker, databasePath);
try {
  const diagnostics = (await database.call<StorageDiagnostics>('bootstrap')).data;
  assert.equal(diagnostics.journalMode, 'wal');
  assert.equal(diagnostics.synchronous, 2);
  assert.equal(diagnostics.foreignKeys, 1);
  assert.equal(diagnostics.fts5, true);
  const initial = (await database.call<Settings>('settings.get')).data;
  assert.equal(initial.textConsent.enabled, false);
  assert.equal(initial.captureEnabled, false);
  const scoped = (await database.call<Settings>('settings.updateCaptureScope', { expectedRevision: initial.revision, allowedBundleIds: ['local.one-room.fixture'], excludedBundleIds: [] })).data;
  const running = (await database.call<CaptureStatus>('capture.setEnabled', { expectedRevision: scoped.revision, enabled: true })).data;
  let now = Date.now();
  const freshAt = now;
  const store = new EvidenceStore(database, root, () => now);
  await store.initialize();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5kAAAAASUVORK5CYII=', 'base64');
  function observation(observedAt: number): ObservationInput {
    return { id: randomUUID(), sessionId: randomUUID(), observedAt, bundleId: 'local.one-room.fixture', appName: 'Isolated fixture', pid: 1, windowId: 1, windowTitle: '团队日报 https://docs.corp.kuaishou.com/d/home/reuse-fixture', trigger: 'manual', captureGeneration: running.generation, pairingStatus: 'matched', visibilityStatus: 'verified' };
  }
  const old = await store.publish(observation(now - 30 * 86400_000 + 60_000), png);
  const fresh = await store.publish(observation(now), png);
  for (const item of [old, fresh]) {
    await database.call('text.commit', { observationId: item.observationId, generation: running.generation,
      records: [{ source: 'accessibility', status: 'ready', completeness: 'complete', text: '日报正文', fallbackReason: null, observedAt: now }],
      selectedSource: 'accessibility', action: 'unknown' });
    const activity = (await database.call<{ items: Activity[] }>('activity.query')).data.items.find(row => row.observationId === item.observationId)!;
    await database.call('activity.review', { id: activity.id, expectedRevision: activity.revision, action: 'suspected_edit',
      activityType: 'document', objectLabel: '团队日报', topic: '更新日报', confirmed: true });
  }
  const candidates = reuseOutputs['reuse.candidates'].parse((await database.call('reuse.candidates')).data);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].instances, 2);
  await database.call('reuse.candidateStatus', { id: candidates[0].id, status: 'later' });
  const saved = (await database.call<SkillVersion>('reuse.saveSkill', { ...draftSkill(candidates[0]), scope: '今天', sources: '用户指定来源' })).data;
  const manualSkill = (await database.call<SkillVersion>('reuse.saveSkill', { ...draftSkill(candidates[0]), candidateId: undefined,
    target: 'https://docs.corp.kuaishou.com/d/home/manual-fixture', scope: '手工规则', sources: '手工指定来源' })).data;
  const rule = (await database.call<StrategyRule>('reuse.saveRule', { title: '策略预览', steps: '选择目标；保存草稿', variables: '目标', prerequisites: '已登录', approvals: '人工验收' })).data;
  const derivedRule = (await database.call<StrategyRule>('reuse.saveRule', { title: '候选规则', steps: '候选派生副本', variables: '目标',
    prerequisites: '已登录', approvals: '人工验收', candidateId: candidates[0].id })).data;
  const expectedSources = [old.observationId, fresh.observationId].sort();
  assert.deepEqual((saved as SkillVersion & { sourceObservationIds: string[] }).sourceObservationIds, expectedSources);
  assert.deepEqual((derivedRule as StrategyRule & { sourceObservationIds: string[] }).sourceObservationIds, expectedSources);
  assert.equal(Object.hasOwn(reuseOutputs['reuse.saveSkill'].parse(saved), 'sourceObservationIds'), false);
  assert.equal(Object.hasOwn(reuseOutputs['reuse.saveRule'].parse(derivedRule), 'sourceObservationIds'), false);
  for (const command of ['reuse.run', 'reuse.verify']) await assert.rejects(database.call(command, command === 'reuse.run'
    ? { skillId: saved.id, version: saved.version } : { id: randomUUID() }), { code: 'CAPABILITY_BLOCKED', detailCode: 'EXECUTION_CONTRACT_PENDING' });
  const agents = reuseOutputs['reuse.agents'].parse((await database.call('reuse.agents')).data);
  assert.ok(agents.filter(agent => agent.id !== 'openadapt').every(agent => !agent.enabled));
  assert.ok(agents.some(agent => agent.id === 'openadapt'));
  assert.match(agents.find(agent => agent.id === 'codex')!.detail, /合成能力验证.*冻结输入审核.*精确差异审核/);
  assert.equal((await database.call<unknown[]>('reuse.runs')).data.length, 0);
  assert.ok(await store.read(old.evidenceId));
  assert.ok(await store.read(fresh.evidenceId));
  now += 61_000;
  assert.equal(await store.read(old.evidenceId), null);
  await store.cleanup(); await store.cleanup();
  assert.ok(await store.read(fresh.evidenceId));
  const counts = (await database.call<StorageDiagnostics>('bootstrap')).data;
  assert.equal(counts.observationCount, 2);
  assert.equal(counts.evidenceCount, 2);
  await database.close();
  const legacyRunId = randomUUID(), unrelatedRunId = randomUUID(), agentDirectory = join(root, 'agent-runs');
  const legacy = new Database(databasePath);
  try {
    legacy.prepare(`INSERT INTO or_runs(id,skill_id,version,target,state,created_at,updated_at,log,receipt,error)
      VALUES(?,?,?,?,'succeeded',?,?,'deleted-reuse-token','deleted-reuse-token','')`).run(legacyRunId, saved.id, saved.version, saved.target, now, now);
  } finally { legacy.close(); }
  for (const id of [legacyRunId, unrelatedRunId]) {
    await mkdir(join(agentDirectory, id), { recursive: true });
    await writeFile(join(agentDirectory, id, 'trace.jsonl'), id === legacyRunId ? 'deleted-reuse-token' : 'unrelated fixture');
  }
  database = new DatabaseClient(worker, databasePath);
  const reopened = (await database.call<Settings>('settings.get')).data;
  assert.deepEqual(reopened.allowedBundleIds, ['local.one-room.fixture']);
  assert.equal(reopened.captureEnabled, false);
  assert.equal(reopened.textConsent.enabled, false);
  assert.equal((await database.call<Candidate[]>('reuse.candidates')).data[0].status, 'accepted');
  assert.ok((await database.call<SkillVersion[]>('reuse.skills')).data.some(skill => skill.id === saved.id));
  assert.ok((await database.call<StrategyRule[]>('reuse.rules')).data.some(item => item.id === rule.id));
  const corrected = (await database.call<{ items: Activity[] }>('activity.query')).data.items.find(item => item.observationId === fresh.observationId)!;
  await database.call('activity.review', { id: corrected.id, expectedRevision: corrected.revision, action: 'view',
    activityType: 'document', objectLabel: '团队日报', topic: '查看日报', confirmed: true });
  assert.equal((await database.call<Candidate[]>('reuse.candidates')).data.length, 0);
  assert.ok((await database.call<SkillVersion[]>('reuse.skills')).data.some(skill => skill.id === saved.id));
  const preview = (await database.call<MethodOutput<'history.previewDelete'>>('history.previewDelete', { rangeStart: freshAt, rangeEnd: freshAt + 1 })).data;
  assert.equal(preview.observationCount, 1);
  const deletion = { deletionRef: preview.deletionRef, expectedRevision: preview.dataRevision, confirmed: true, idempotencyKey: randomUUID() };
  const deleted = (await database.call<HistoryDeleteCommit>('history.delete', deletion)).data;
  assert.equal(deleted.cleanup, 'pending');
  assert.deepEqual(deleted.affected.reuseRunIds, [legacyRunId]);
  assert.equal((await database.call<Candidate[]>('reuse.candidates')).data.length, 0);
  assert.deepEqual((await database.call<SkillVersion[]>('reuse.skills')).data.map(skill => skill.id), [manualSkill.id]);
  const remainingRules = (await database.call<StrategyRule[]>('reuse.rules')).data;
  assert.ok(!remainingRules.some(item => item.id === derivedRule.id));
  assert.ok(remainingRules.some(item => item.id === rule.id));
  assert.equal((await database.call<unknown[]>('reuse.runs')).data.length, 0);
  await database.close();
  database = new DatabaseClient(worker, databasePath);
  const recovered = (await database.call<HistoryDeleteCommit>('history.delete', deletion)).data;
  assert.deepEqual(recovered.affected.reuseRunIds, [legacyRunId]);
  await assert.rejects(cleanupReuseRunFiles(agentDirectory, ['../outside']), { code: 'INVALID_ARGUMENT' });
  await cleanupReuseRunFiles(agentDirectory, recovered.affected.reuseRunIds ?? []);
  await cleanupReuseRunFiles(agentDirectory, recovered.affected.reuseRunIds ?? []);
  await assert.rejects(access(join(agentDirectory, legacyRunId)), { code: 'ENOENT' });
  assert.equal(await readFile(join(agentDirectory, unrelatedRunId, 'trace.jsonl'), 'utf8'), 'unrelated fixture');
  await new EvidenceStore(database, root, () => now).cleanup();
  assert.equal((await database.call<HistoryDeleteCommit>('history.cleanupComplete', { idempotencyKey: deletion.idempotencyKey })).data.cleanup, 'complete');
  console.log(JSON.stringify({ reuseStorage: 'passed', checks: ['real worker candidate contract', 'independent document updates', 'candidate status', 'immutable skill persistence', 'strategy preview persistence', 'production run/verify blocked', 'agent detection remains disabled', 'internal frozen provenance is absent from public schema', 'manual delete scrubs copies after candidate pruning', 'task directory cleanup survives restart', 'unrelated authored rules remain'] }));
  console.log(JSON.stringify({ status: 'passed', electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules, sqlite: diagnostics.sqliteVersion, wal: true, full: true, foreignKeys: true, fts5: true, observations: counts.observationCount, checks: ['settings persisted', 'atomic observation/evidence/source/change', 'same image retains two observations', '30-day references expire independently', 'cleanup idempotent', 'restart paused'] }, null, 2));
} finally {
  const closing = database.close();
  assert.equal(database.close(), closing);
  await closing;
  await database.close();
  await assert.rejects(database.call('bootstrap'), /Storage worker stopped/);
  await rm(root, { recursive: true, force: true });
}
await runCaptureAnalysisSmoke(worker);
await runWorklogStorageSmoke(worker);
await runPeriodSummarySmoke(worker);
await runDocumentOperationsSmoke();
await runDocumentRunsSmoke(worker);
