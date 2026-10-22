import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyPatch } from 'diff';
import type { MethodInput, MethodOutput } from '../../src/shared/contracts';
import type { DocumentSkillDraft, RunView } from '../../src/shared/execution-schemas';
import type { CaptureStatus, Settings } from '../../src/shared/schemas';
import { DomainError } from '../../src/shared/errors';
import { DocumentRunService, type ExecutionAgent } from '../../src/services/agents/runs';
import { CODEX_VERSION, sha256, validateProposal, type AgentCapabilityStatus, type CapabilityRecord,
  type ProposalBinding, type ValidatedProposal } from '../../src/services/agents/types';
import { EvidenceStore } from '../../src/services/evidence/store';
import { DatabaseClient, StorageError } from '../../src/services/storage/client';
import type { ExecutionRunRecord } from '../../src/services/storage/execution-commands';
import type { LocalDocumentOperation } from '../../src/services/documents/operations';

const app = 'local.one-room.document-run-fixture';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5kAAAAASUVORK5CYII=', 'base64');
const rejected = (code: string, detail?: string) => (error: unknown) => {
  const value = error instanceof DomainError ? error.error : error instanceof StorageError ? error : null;
  return value?.code === code && (detail === undefined || value.detailCode === detail);
};
type AgentInput = Parameters<ExecutionAgent['propose']>[0];
type SentInput = { binding: ProposalBinding; snapshot: string };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

class SyntheticExecutionAgent implements ExecutionAgent {
  enabled = false;
  hold = false;
  beforeDispatch: ((input: AgentInput) => Promise<void>) | null = null;
  replacement = '## 2026-10-16\n- Completed synthetic update.\n\n';
  readonly pending = new Map<string, { input: AgentInput; replacement: string; resolve(value: ValidatedProposal): void }>();
  constructor(readonly sent: SentInput[], readonly canceled: { runId: string; generation: number }[]) {}
  async detect(): Promise<AgentCapabilityStatus[]> {
    return [{ id: 'codex', installed: true, authenticated: true, authState: 'ready', enabled: this.enabled,
      version: CODEX_VERSION, capabilityState: this.enabled ? 'ready' : 'unverified', detail: 'Synthetic test agent; no external process.' },
    { id: 'claude', installed: false, authenticated: false, authState: 'missing', enabled: false,
      version: null, capabilityState: 'disabled', detail: 'Disabled.' }];
  }
  async checkCapability(): Promise<CapabilityRecord> {
    this.enabled = true;
    return { provider: 'codex', state: 'ready', fingerprint: sha256('synthetic-document-agent'), version: CODEX_VERSION, checkedAt: Date.now(),
      checks: { supportedVersion: true, supportedArguments: true, authentication: true, isolatedStartup: true,
        readOnly: true, proposalSchema: true, cancellation: true, timeout: true } };
  }
  async propose(input: AgentInput): Promise<ValidatedProposal> {
    if (this.beforeDispatch) await this.beforeDispatch(input);
    this.sent.push({ binding: structuredClone(input.binding), snapshot: Buffer.from(input.inputSnapshot).toString('utf8') });
    if (!this.hold) return validateProposal({ ...input.binding, replacementMarkdown: this.replacement }, input.binding);
    // Deliberately finish after cancellation to exercise the service generation check.
    return new Promise(resolve => this.pending.set(input.binding.runId, { input, replacement: this.replacement, resolve }));
  }
  release(runId: string): void {
    const pending = this.pending.get(runId); assert.ok(pending, 'synthetic proposal must be pending');
    this.pending.delete(runId);
    pending.resolve(validateProposal({ ...pending.input.binding, replacementMarkdown: pending.replacement }, pending.input.binding));
  }
  cancel(runId: string, generation: number): void { this.canceled.push({ runId, generation }); }
  close(): void { for (const runId of this.pending.keys()) this.release(runId); }
}

async function waitRun(service: DocumentRunService, runId: string, state: RunView['state']): Promise<RunView> {
  const deadline = Date.now() + 5000;
  let run = await service.getRun(runId);
  while (run.state !== state && Date.now() < deadline) {
    if (['failed', 'conflict', 'source_invalidated', 'capability_blocked'].includes(run.state)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
    run = await service.getRun(runId);
  }
  assert.equal(run.state, state, JSON.stringify(run.error));
  return run;
}

export async function runDocumentRunsSmoke(workerPath: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'one-room-document-runs-'));
  const databasePath = join(root, 'history.sqlite'), targetPath = join(root, 'synthetic-journal.md'), patchPath = join(root, 'reviewed.patch');
  const prefix = Buffer.from('\ufeff# Work journal\r\nUNRELATED_PREFIX must stay byte exact.\r\n\r\n');
  const currentSection = Buffer.from('## 2026-10-16\r\n- Existing synthetic item.\r\n\r\n');
  const suffix = Buffer.from('## Other section\r\nUNRELATED_SUFFIX must stay byte exact.\r\n');
  const original = Buffer.concat([prefix, currentSection, suffix]);
  const expectedSection = Buffer.from('## 2026-10-16\r\n- Completed synthetic update.\r\n\r\n');
  const expected = Buffer.concat([prefix, expectedSection, suffix]);
  await writeFile(targetPath, original, { mode: 0o600 });
  let database = new DatabaseClient(workerPath, databasePath);
  const call = async <T>(method: string, input: unknown = {}) => (await database.call<T>(method, input)).data;
  const sent: SentInput[] = [], canceled: { runId: string; generation: number }[] = [];
  let agent = new SyntheticExecutionAgent(sent, canceled);
  const changes: string[] = [];
  let patchDialogs = 0;
  const createService = () => new DocumentRunService({ database, agent,
    dialogs: { pickMarkdown: async () => targetPath, savePatch: async () => { patchDialogs++; return patchPath; } },
    events: { publish: (type, id) => { changes.push(`${type}:${id}`); } },
  });
  let service = createService();
  try {
    let policy = await call<Settings>('settings.get');
    policy = await call<Settings>('settings.updateCaptureScope', { expectedRevision: policy.revision, allowedBundleIds: [app], excludedBundleIds: [] });
    const capture = await call<CaptureStatus>('capture.setEnabled', { expectedRevision: policy.revision, enabled: true });
    const evidence = new EvidenceStore(database, root); await evidence.initialize();
    const start = Date.now() - 120_000, sessionId = randomUUID(), observationIds: string[] = [];
    const texts = ['SOURCE_ALPHA_FULL_TEXT ' + 'synthetic alpha fact; '.repeat(90), 'SOURCE_BETA_FULL_TEXT synthetic beta result.'];
    for (const [index, text] of texts.entries()) {
      const id = randomUUID(), observedAt = start + index * 5000; observationIds.push(id);
      await evidence.publish({ id, sessionId, observedAt, bundleId: app, appName: 'Synthetic editor', pid: 1, windowId: 42,
        windowTitle: 'Synthetic report', trigger: 'checkpoint', captureGeneration: capture.generation,
        pairingStatus: 'matched', visibilityStatus: 'verified' }, png);
      await call('text.commit', { observationId: id, generation: capture.generation, selectedSource: 'accessibility', action: 'unknown',
        records: [{ source: 'accessibility', status: 'ready', completeness: 'complete', text, fallbackReason: null, observedAt }] });
    }
    policy = await call<Settings>('settings.get');
    await call('capture.pause', { expectedRevision: policy.revision });
    assert.equal((await call<Settings>('settings.get')).textConsent.enabled, false);
    await service.initialize();
    const selected = await service.pickTarget(); assert.ok(selected.selected);
    const targetId = selected.target.id;
    assert.ok(!JSON.stringify(selected).includes(root), 'public target must not expose paths');
    const inspection = await service.inspectTarget(targetId);
    assert.equal(inspection.bom, true); assert.equal(inspection.newline, 'CRLF');
    const section = inspection.sections.find(item => item.label === '2026-10-16'); assert.ok(section);
    const draft: DocumentSkillDraft = { title: 'Synthetic daily report', kind: 'daily', targetId, sectionRef: section.sectionRef,
      formatRules: 'Keep the existing dated heading and bullet format.', instructions: 'Summarize only the selected synthetic sources.',
      deduplication: 'Do not repeat an existing result.' };
    const skill = await service.saveDraft({ draft, idempotencyKey: randomUUID() });
    const publish = { skillId: skill.id, expectedRevision: skill.draftRevision,
      confirmations: { target: true, section: true, rules: true }, idempotencyKey: randomUUID() } satisfies MethodInput<'skill.publishVersion'>;
    const version = await service.publish(publish);
    assert.match(version.id, /^[0-9a-f-]{36}$/); assert.equal(version.version, 1);
    assert.deepEqual(await service.publish(publish), version, 'publishing retries return the same immutable UUID');
    const latest = await service.getSkill(skill.id);
    const amended = await service.saveDraft({ skillId: skill.id, expectedRevision: latest.skill.draftRevision,
      draft: { ...draft, instructions: 'A second independently published instruction.' }, idempotencyKey: randomUUID() });
    const second = await service.publish({ ...publish, expectedRevision: amended.draftRevision, idempotencyKey: randomUUID() });
    assert.notEqual(second.id, version.id); assert.equal(second.version, 2);
    assert.deepEqual((await service.getSkill(skill.id)).versions.find(item => item.id === version.id), version);

    const sources = await service.listSources(); assert.equal(sources.length, 2);
    const prepareInput = { provider: 'codex', skillVersionId: version.id, targetId, sectionRef: section.sectionRef,
      sourceRefs: sources.map(source => source.sourceRefId), idempotencyKey: randomUUID() } satisfies MethodInput<'run.prepare'>;
    const prepared = await service.prepare(prepareInput);
    assert.equal(prepared.state, 'awaiting_input_confirmation'); assert.equal(sent.length, 0);
    assert.deepEqual(await service.prepare(prepareInput), prepared, 'preparing retries must not create another run');
    assert.equal((await service.listRuns()).length, 1);
    const frozen = JSON.parse(prepared.inputPreview) as { skill: { skillVersionId: string }; target: { currentSection: string }; sources: { sourceRefId: string; revision: number; text: string }[] };
    assert.equal(frozen.skill.skillVersionId, version.id); assert.equal(frozen.target.currentSection, currentSection.toString('utf8'));
    assert.deepEqual(frozen.sources.map(source => source.text).sort(), [...texts].sort(), 'input preview contains every selected text byte');
    assert.ok(texts[0].length > sources.find(source => source.preview.startsWith('SOURCE_ALPHA'))!.preview.length);
    assert.ok(frozen.sources.every(source => source.revision === 1));
    assert.equal(sha256(prepared.inputPreview), prepared.inputSnapshotHash);
    for (const privateValue of [root, 'selectedPath', 'canonicalPath', 'UNRELATED_PREFIX', 'UNRELATED_SUFFIX']) assert.ok(!prepared.inputPreview.includes(privateValue));
    const stored = await call<ExecutionRunRecord>('execution.run', { id: prepared.runId });
    assert.deepEqual([...stored.sourceRevisions].sort((a, b) => a.sourceRefId.localeCompare(b.sourceRefId)), frozen.sources.map(({ sourceRefId, revision }) => ({ sourceRefId, revision })));
    const proposeInput = { preparedRunId: prepared.runId, expectedInputHash: prepared.inputSnapshotHash,
      confirmed: true, idempotencyKey: randomUUID() } satisfies MethodInput<'run.propose'>;
    assert.equal((await service.agents()).find(status => status.provider === 'codex')!.enabled, false);
    await assert.rejects(service.propose(proposeInput), rejected('CAPABILITY_BLOCKED'));
    assert.equal(sent.length, 0); assert.deepEqual(await readFile(targetPath), original);
    assert.equal((await service.testCapability()).find(status => status.provider === 'codex')!.enabled, true);
    assert.equal((await service.agents()).find(status => status.provider === 'claude')!.enabled, false);
    assert.equal(sent.length, 0, 'the capability check does not dispatch the reviewed document input');
    const proposals = await Promise.all([service.propose(proposeInput), service.propose(proposeInput), service.propose(proposeInput)]);
    assert.deepEqual(proposals[1], proposals[0]); assert.deepEqual(proposals[2], proposals[0]);
    const reviewed = await waitRun(service, prepared.runId, 'awaiting_review');
    assert.equal(sent.length, 1, 'same-key concurrent propose calls dispatch one Agent request'); assert.equal(sent[0].snapshot, prepared.inputPreview);
    assert.equal(sent[0].binding.inputSnapshotHash, prepared.inputSnapshotHash);
    assert.ok(reviewed.proposal && reviewed.proposalHash && reviewed.diff && reviewed.approvalRef);
    assert.deepEqual(Object.keys(reviewed.proposal).sort(), ['runId', 'generation', 'skillVersionId', 'inputSnapshotHash', 'targetSnapshotHash', 'sectionRef', 'sourceRefs', 'replacementMarkdown'].sort());
    assert.equal(applyPatch(original.toString('utf8'), reviewed.diff), expected.toString('utf8'), 'reviewed diff must produce the exact candidate');
    assert.deepEqual(await readFile(targetPath), original, 'generating a proposal never writes the target');
    const applyInput = { runId: reviewed.runId, expectedGeneration: reviewed.generation, proposalHash: reviewed.proposalHash,
      expectedTargetHash: reviewed.targetSnapshotHash, inputSnapshotHash: reviewed.inputSnapshotHash, skillVersionId: reviewed.skillVersionId,
      sourceRefs: reviewed.sourceRefs, approvalRef: reviewed.approvalRef, confirmed: true, idempotencyKey: randomUUID() } satisfies MethodInput<'run.apply'>;
    await assert.rejects(service.apply(applyInput), rejected('CAPABILITY_BLOCKED', 'EXCLUSIVE_EDIT_REQUIRED'));
    const patchInput = { runId: reviewed.runId, expectedGeneration: reviewed.generation,
      proposalHash: reviewed.proposalHash, idempotencyKey: randomUUID() } satisfies MethodInput<'run.exportPatch'>;
    const patches = await Promise.all([service.exportPatch(patchInput), service.exportPatch(patchInput), service.exportPatch(patchInput)]);
    const patch = patches[0]; assert.equal(patch.exported, true);
    assert.deepEqual(patches[1], patch); assert.deepEqual(patches[2], patch);
    assert.equal(patchDialogs, 1, 'same-key concurrent export calls open one save dialog');
    assert.deepEqual(await service.exportPatch(patchInput), patch);
    assert.equal(await readFile(patchPath, 'utf8'), reviewed.diff); assert.equal((await stat(patchPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(targetPath), original);
    await service.confirmExclusive({ targetId, expectedRevision: selected.target.revision, confirmed: true });
    await assert.rejects(service.apply({ ...applyInput, proposalHash: '0'.repeat(64) }), rejected('CONFLICT', 'APPROVAL_MISMATCH'));
    assert.deepEqual(await readFile(targetPath), original);
    const operations = await Promise.all([service.apply(applyInput), service.apply(applyInput), service.apply(applyInput)]);
    const operation = operations[0];
    assert.deepEqual(operations[1], operation); assert.deepEqual(operations[2], operation);
    const succeeded = await waitRun(service, prepared.runId, 'succeeded');
    assert.equal(succeeded.operationId, operation.operationId);
    assert.equal(succeeded.operationResult?.applied, true);
    assert.equal(succeeded.operationResult?.stage, 'verified');
    assert.equal((await service.verify(prepared.runId)).operationResult?.observedHash, sha256(expected));
    assert.deepEqual(await readFile(targetPath), expected);
    assert.ok(expected.subarray(0, prefix.length).equals(prefix)); assert.ok(expected.subarray(expected.length - suffix.length).equals(suffix));
    const persistedOperation = await call<LocalDocumentOperation>('execution.operation', { id: operation.operationId });
    assert.equal(persistedOperation.state, 'succeeded'); assert.equal(persistedOperation.stage, 'verified');
    assert.equal(persistedOperation.observedHash, sha256(expected));
    const operationDb = new Database(databasePath, { readonly: true });
    try {
      assert.equal((operationDb.prepare('SELECT count(*) AS n FROM document_operations WHERE runId=?').get(prepared.runId) as { n: number }).n, 1,
        'same-key concurrent apply calls persist one document operation');
    } finally { operationDb.close(); }
    const targetAfterApply = (await service.listTargets())[0];
    await service.close(); await database.close();
    database = new DatabaseClient(workerPath, databasePath); agent = new SyntheticExecutionAgent(sent, canceled); agent.enabled = true;
    service = createService(); await service.initialize();
    assert.equal((await service.getRun(prepared.runId)).state, 'succeeded');
    assert.deepEqual(await call('execution.operation', { id: operation.operationId }), persistedOperation);
    assert.deepEqual((await service.listTargets())[0], targetAfterApply, 'restart must not replay a terminal write');
    assert.deepEqual(await service.apply(applyInput), operation); assert.deepEqual(await readFile(targetPath), expected);

    agent.hold = true;
    const late = await service.prepare({ ...prepareInput, idempotencyKey: randomUUID() });
    await service.propose({ ...proposeInput, preparedRunId: late.runId, expectedInputHash: late.inputSnapshotHash, idempotencyKey: randomUUID() });
    assert.ok(agent.pending.has(late.runId));
    const canceledRun = await service.cancel({ runId: late.runId, expectedGeneration: late.generation });
    assert.equal(canceledRun.state, 'canceled'); assert.equal(canceledRun.generation, late.generation + 1);
    assert.ok(canceled.some(value => value.runId === late.runId && value.generation === late.generation));
    agent.release(late.runId); await service.close();
    agent = new SyntheticExecutionAgent(sent, canceled); agent.enabled = true; service = createService(); await service.initialize();
    const afterLate = await service.getRun(late.runId);
    assert.equal(afterLate.state, 'canceled'); assert.equal(afterLate.generation, canceledRun.generation);
    assert.equal(afterLate.proposal, null); assert.equal(afterLate.diff, null); assert.deepEqual(await readFile(targetPath), expected);

    const conflict = await service.prepare({ ...prepareInput, idempotencyKey: randomUUID() });
    agent.replacement = '## 2026-10-16\n- A second synthetic update.\n\n';
    await service.propose({ ...proposeInput, preparedRunId: conflict.runId, expectedInputHash: conflict.inputSnapshotHash, idempotencyKey: randomUUID() });
    const conflictReview = await waitRun(service, conflict.runId, 'awaiting_review');
    const targetNow = (await service.listTargets())[0];
    await service.confirmExclusive({ targetId, expectedRevision: targetNow.revision, confirmed: true });
    const outsideEdit = Buffer.concat([expected, Buffer.from('Outside editor change.\r\n')]); await writeFile(targetPath, outsideEdit);
    await assert.rejects(service.apply({ ...applyInput, runId: conflict.runId, proposalHash: conflictReview.proposalHash!,
      expectedGeneration: conflictReview.generation, inputSnapshotHash: conflictReview.inputSnapshotHash,
      expectedTargetHash: conflictReview.targetSnapshotHash, approvalRef: conflictReview.approvalRef!, idempotencyKey: randomUUID() }), rejected('CONFLICT', 'TARGET_CONFLICT'));
    assert.deepEqual(await readFile(targetPath), outsideEdit, 'a target edit must never be overwritten');
    await writeFile(targetPath, expected);

    const stale = await service.prepare({ ...prepareInput, idempotencyKey: randomUUID() });
    const fixtureDb = new Database(databasePath);
    try { fixtureDb.prepare('UPDATE source_refs SET currentRevision=currentRevision+1 WHERE id=?').run(sources[0].sourceRefId); }
    finally { fixtureDb.close(); }
    const dispatchesBeforeStale = sent.length;
    assert.equal(await call('execution.authorize', { id: stale.runId }), false);
    await assert.rejects(service.propose({ ...proposeInput, preparedRunId: stale.runId, expectedInputHash: stale.inputSnapshotHash,
      idempotencyKey: randomUUID() }), rejected('SOURCE_INVALIDATED'));
    assert.equal(sent.length, dispatchesBeforeStale);
    const refreshed = await service.prepare({ ...prepareInput, idempotencyKey: randomUUID() });
    const revised = JSON.parse(refreshed.inputPreview) as typeof frozen;
    assert.equal(revised.sources.find(source => source.sourceRefId === sources[0].sourceRefId)!.revision, 2);

    const scopeRun = await service.prepare({ ...prepareInput, idempotencyKey: randomUUID() });
    const reachedDispatch = deferred<void>(), resumeDispatch = deferred<void>(), checkedDispatch = deferred<boolean>();
    const dispatchesBeforeScope = sent.length;
    agent.beforeDispatch = async input => {
      reachedDispatch.resolve(); await resumeDispatch.promise;
      const current = !!await input.isCurrent?.(); checkedDispatch.resolve(current);
      if (!current) throw new DomainError('SOURCE_INVALIDATED', 'Synthetic dispatch source scope changed.', 'SOURCE_DELETED');
    };
    try {
      await service.propose({ ...proposeInput, preparedRunId: scopeRun.runId, expectedInputHash: scopeRun.inputSnapshotHash, idempotencyKey: randomUUID() });
      await reachedDispatch.promise;
      policy = await call<Settings>('settings.get');
      await call('settings.updateCaptureScope', { expectedRevision: policy.revision, allowedBundleIds: [], excludedBundleIds: [app] });
    } finally { resumeDispatch.resolve(); }
    assert.equal(await checkedDispatch.promise, false, 'dispatch guard must reject a source excluded during asynchronous Agent startup');
    await waitRun(service, scopeRun.runId, 'source_invalidated');
    assert.equal(sent.length, dispatchesBeforeScope, 'scope revocation before dispatch sends no business input');
    assert.deepEqual(await readFile(targetPath), expected, 'scope revocation cannot write the target');
    agent.beforeDispatch = null;
    policy = await call<Settings>('settings.get');
    await call('settings.updateCaptureScope', { expectedRevision: policy.revision, allowedBundleIds: [app], excludedBundleIds: [] });

    await service.quiesce();
    policy = await call<Settings>('settings.get');
    assert.equal(policy.captureEnabled, false, 'history deletion is performed with capture paused');
    const preview = await call<MethodOutput<'history.previewDelete'>>('history.previewDelete', { rangeStart: start, rangeEnd: start + 10_000, bundleIds: [app] });
    assert.equal(preview.observationCount, observationIds.length);
    await call('history.delete', { deletionRef: preview.deletionRef, expectedRevision: preview.dataRevision, confirmed: true, idempotencyKey: randomUUID() });
    for (const run of await service.listRuns()) {
      assert.equal(run.state, 'source_invalidated'); assert.equal(run.inputPreview, null); assert.equal(run.proposal, null); assert.equal(run.diff, null);
      const saved = await call<ExecutionRunRecord>('execution.run', { id: run.runId });
      assert.equal(saved.frozenInput, null); assert.equal(saved.snapshot, null); assert.equal(saved.proposalBytes, null); assert.equal(saved.candidate, null);
    }
    assert.equal(await call('execution.operation', { id: operation.operationId }), null);
    assert.equal((await service.listSources()).length, 0); assert.deepEqual(await readFile(targetPath), expected);
    await service.close(); await database.close();
    const inspect = new Database(databasePath, { readonly: true });
    try {
      assert.equal((inspect.prepare('SELECT count(*) AS n FROM document_operations WHERE body IS NOT NULL').get() as { n: number }).n, 0);
      assert.equal((inspect.prepare("SELECT count(*) AS n FROM execution_receipts WHERE result LIKE '%SOURCE_ALPHA_FULL_TEXT%' OR result LIKE '%SOURCE_BETA_FULL_TEXT%'").get() as { n: number }).n, 0);
      assert.deepEqual(inspect.pragma('foreign_key_check'), []);
    } finally { inspect.close(); }
    assert.ok(changes.some(event => event.startsWith('run.changed:')));
    console.log(JSON.stringify({ status: 'passed', suite: 'document-runs', observations: observationIds.length, syntheticAgentDispatches: sent.length,
      checks: ['immutable version UUIDs', 'frozen full text and revisions without target paths', 'capability gate and input confirmation',
        'replacement-only bound proposal', 'exact diff and second review', 'exclusive edit or patch export', 'BOM CRLF and outside bytes',
        'same-key concurrent propose/apply/export receipts and single execution', 'scope revocation before asynchronous Agent dispatch',
        'persisted terminal receipt without replay', 'canceled generation rejects late output', 'target edit conflict', 'source revision authorization',
        'manual delete scrubs run and operation copies'] }));
  } finally {
    await service.close().catch(() => undefined); await database.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
