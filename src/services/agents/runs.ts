import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { MethodInput, MethodOutput } from '../../shared/contracts';
import type { AgentCapabilityView, DocumentSkill, DocumentSkillVersion, DocumentTarget, RunView } from '../../shared/execution-schemas';
import { DomainError, toAppError } from '../../shared/errors';
import type { DomainEvents } from '../../main/events';
import type { DatabaseClient } from '../storage/client';
import { StorageError } from '../storage/client';
import type { ExecutionRunRecord, ExecutionSource } from '../storage/execution-commands';
import { LocalMarkdownConnector, markdownHash, type LocalMarkdownSnapshot, type LocalTargetRecord } from '../documents/local-markdown';
import { LocalDocumentOperations, type LocalDocumentOperation, type DocumentOperationHost, type DocumentOperationReceipt } from '../documents/operations';
import type { AgentCapabilityStatus, CapabilityRecord, ProposalBinding, ValidatedProposal } from './types';
import { validateProposal } from './types';

type StoredTarget = { record: LocalTargetRecord; revision: number; exclusiveEditing: boolean; exclusiveHash: string | null };
type StoredSnapshot = { target: LocalTargetRecord; bytes: string };
export interface ExecutionAgent {
  detect(): Promise<AgentCapabilityStatus[]>;
  checkCapability(): Promise<CapabilityRecord>;
  propose(input: { binding: ProposalBinding; inputSnapshot: Uint8Array; signal?: AbortSignal; isCurrent?: () => boolean | Promise<boolean> }): Promise<ValidatedProposal>;
  cancel(runId: string, generation: number): void;
  close(): void | Promise<void>;
  getCapability?(): CapabilityRecord | undefined;
}
export type ExecutionDialogs = {
  pickMarkdown(): Promise<string | null>;
  savePatch(displayName: string): Promise<string | null>;
};
const lifetime = 15 * 60_000;
const terminal = new Set(['succeeded', 'no_change', 'failed', 'canceled', 'conflict', 'interrupted', 'capability_blocked', 'expired', 'source_invalidated']);
const publicTarget = (target: StoredTarget): DocumentTarget => ({ id: target.record.id, connector: 'local_markdown', displayName: target.record.displayName,
  revision: target.revision, exclusiveEditing: target.exclusiveEditing });
const publicSkill = (skill: DocumentSkill): DocumentSkill => ({ id: skill.id, draftRevision: skill.draftRevision, status: skill.status, draft: skill.draft, currentVersionId: skill.currentVersionId });
const errorInfo = (error: unknown) => error instanceof StorageError ? { code: error.code, detailCode: error.detailCode ?? null, message: error.message } : (() => {
  const safe = toAppError(error); return { code: safe.code, detailCode: safe.detailCode ?? null, message: safe.message };
})();

export class DocumentRunService {
  private readonly connector = new LocalMarkdownConnector();
  private readonly operations: LocalDocumentOperations;
  private readonly generations = new Map<string, AbortController>();
  private readonly background = new Set<Promise<void>>();
  private readonly writes = new Set<Promise<void>>();
  private readonly commands = new Map<string, { hash: string; promise: Promise<unknown> }>();
  private capability: CapabilityRecord | null = null;
  private codexReady = false;
  private closed = false;

  constructor(private readonly host: { database: DatabaseClient; agent: ExecutionAgent; dialogs: ExecutionDialogs; events: Pick<DomainEvents, 'publish'>; now?: () => number }) {
    const operationHost: DocumentOperationHost = {
      findByIdempotencyKey: async (targetId, key) => {
        const operation = await this.call<LocalDocumentOperation | null>('execution.operation', { targetId, key });
        return operation?.targetId === targetId ? operation : null;
      },
      get: id => this.call('execution.operation', { id }),
      createIntent: operation => this.call('execution.saveOperation', operation),
      update: operation => this.call('execution.saveOperation', operation),
    };
    this.operations = new LocalDocumentOperations(this.connector, operationHost);
  }
  private get now() { return this.host.now ?? Date.now; }
  get codexEnabled(): boolean { return this.codexReady; }
  private async call<T>(method: string, input: unknown = {}): Promise<T> { return (await this.host.database.call<T>(method, input)).data; }
  private event(run: RunView) { this.host.events.publish('run.changed', run.runId, run.generation); }
  private async target(id: string): Promise<StoredTarget> { return this.call('execution.target', { id }); }
  private async load(id: string): Promise<ExecutionRunRecord> { return this.call('execution.run', { id }); }
  private snapshot(run: ExecutionRunRecord): LocalMarkdownSnapshot {
    if (!run.snapshot) throw new DomainError('SOURCE_INVALIDATED', '任务输入已失效，请重新准备。', 'SOURCE_DELETED');
    const saved = run.snapshot as StoredSnapshot;
    return this.connector.snapshot(saved.target, Buffer.from(saved.bytes, 'base64'));
  }
  private async current(run: ExecutionRunRecord, review = true): Promise<void> {
    if (review && run.view.expiresAt <= this.now()) throw new DomainError('STALE_REVISION', '审核已过期，请重新准备。', 'INPUT_EXPIRED');
    if (!await this.call<boolean>('execution.authorize', { id: run.view.runId })) throw new DomainError('SOURCE_INVALIDATED', '所选正文来源已变化。', 'SOURCE_DELETED');
    await this.call('execution.version', { id: run.view.skillVersionId });
    const snapshot = this.snapshot(run), current = await this.connector.inspect((await this.target(run.view.targetId)).record);
    if (current.hash !== snapshot.hash) throw new DomainError('CONFLICT', '文档已变化，请重新读取并审核。', 'TARGET_CONFLICT');
  }
  private binding(run: ExecutionRunRecord): ProposalBinding {
    return { runId: run.view.runId, generation: run.view.generation, skillVersionId: run.view.skillVersionId,
      inputSnapshotHash: run.view.inputSnapshotHash, targetSnapshotHash: run.view.targetSnapshotHash,
      sectionRef: (JSON.parse(run.frozenInput!) as { target: { sectionRef: string } }).target.sectionRef,
      sourceRefs: [...run.view.sourceRefs] };
  }
  private async update(record: ExecutionRunRecord, expectedStates: string[], options: { authorize?: boolean; expectedGeneration?: number;
    command?: { scope: string; key: string; payload: unknown; result: unknown } } = {}) {
    record.view.updatedAt = this.now();
    const result = await this.call('execution.updateRun', { record, expectedGeneration: options.expectedGeneration ?? record.view.generation,
      expectedStates, authorize: options.authorize, command: options.command });
    this.event(record.view); return result;
  }
  private track(task: Promise<void>, writing = false): void {
    this.background.add(task); if (writing) this.writes.add(task);
    void task.finally(() => { this.background.delete(task); this.writes.delete(task); }).catch(() => undefined);
  }
  private command<T>(scope: string, key: string, input: unknown, execute: () => Promise<T>): Promise<T> {
    const identity = `${scope}:${key}`, hash = markdownHash(Buffer.from(JSON.stringify(input))), prior = this.commands.get(identity);
    if (prior) {
      if (prior.hash !== hash) return Promise.reject(new DomainError('CONFLICT', '此请求标识已用于其他操作。', 'IDEMPOTENCY_CONFLICT'));
      return prior.promise as Promise<T>;
    }
    const promise = Promise.resolve().then(execute);
    this.commands.set(identity, { hash, promise });
    void promise.finally(() => { if (this.commands.get(identity)?.promise === promise) this.commands.delete(identity); }).catch(() => undefined);
    return promise;
  }
  async initialize(): Promise<void> {
    this.capability = await this.call('execution.capability');
    for (const operation of await this.call<LocalDocumentOperation[]>('execution.pendingOperations')) {
      try {
        const result = await this.operations.recover(operation.id, async () => this.call('execution.authorize', { id: operation.runId }));
        await this.finishOperation(operation.runId, result);
      } catch { /* Keep unresolved persisted intent for the next explicit verification. */ }
    }
    for (const run of await this.call<ExecutionRunRecord[]>('execution.runs')) {
      if (!['preparing', 'generating', 'applying', 'verifying'].includes(run.view.state)) continue;
      const operation = run.view.operationId ? await this.call<LocalDocumentOperation | null>('execution.operation', { id: run.view.operationId }) : null;
      if (operation && ['applying', 'verifying'].includes(operation.state)) continue;
      if (operation && ['applying', 'verifying'].includes(run.view.state)) {
        await this.finishOperation(run.view.runId, operation); continue;
      }
      const old = run.view.state; run.view.state = 'interrupted'; run.view.approvalRef = null;
      run.view.error = { code: 'INTERNAL', detailCode: 'PROCESS_INTERRUPTED', message: '上次任务已中断，请重新准备并确认。' };
      await this.update(run, [old]);
    }
  }
  async listTargets(): Promise<DocumentTarget[]> { return (await this.call<StoredTarget[]>('execution.targets')).map(publicTarget); }
  async pickTarget() {
    const path = await this.host.dialogs.pickMarkdown();
    if (!path) return { selected: false as const };
    const record = await this.connector.register(path);
    const target: StoredTarget = { record, revision: 1, exclusiveEditing: false, exclusiveHash: null };
    await this.call('execution.saveTarget', { id: record.id, revision: 1, body: target });
    return { selected: true as const, target: publicTarget(target) };
  }
  async inspectTarget(targetId: string): Promise<MethodOutput<'target.inspect'>> {
    const target = await this.target(targetId), snapshot = await this.connector.inspect(target.record);
    return { target: publicTarget(target), targetSnapshotHash: snapshot.hash, bom: snapshot.bom, newline: snapshot.newline === '\r\n' ? 'CRLF' : 'LF',
      sections: snapshot.sections.map(section => ({ sectionRef: section.sectionRef, label: section.title.slice(0, 512), text: snapshot.bytes.subarray(section.startByte, section.endByte).toString('utf8') })) };
  }
  async confirmExclusive(input: MethodInput<'target.confirmExclusiveEditing'>): Promise<DocumentTarget> {
    const target = await this.target(input.targetId);
    if (target.revision !== input.expectedRevision) throw new DomainError('STALE_REVISION', '文档选择已变化，请重新读取。');
    const snapshot = await this.connector.inspect(target.record);
    const updated = { ...target, revision: target.revision + 1, exclusiveEditing: true, exclusiveHash: snapshot.hash };
    await this.call('execution.saveTarget', { id: target.record.id, revision: updated.revision, body: updated, expectedRevision: target.revision });
    return publicTarget(updated);
  }
  async listSkills(): Promise<DocumentSkill[]> { return (await this.call<DocumentSkill[]>('execution.skills')).map(publicSkill); }
  async getSkill(skillId: string): Promise<MethodOutput<'skill.get'>> {
    const result = await this.call<MethodOutput<'skill.get'>>('execution.skill', { id: skillId });
    return { skill: publicSkill(result.skill), versions: result.versions.map(({ id, skillId, version, draft, contentHash, createdAt }) => ({ id, skillId, version, draft, contentHash, createdAt })) };
  }
  async saveDraft(input: MethodInput<'skill.saveDraft'>): Promise<DocumentSkill> {
    const target = await this.target(input.draft.targetId), snapshot = await this.connector.inspect(target.record);
    this.connector.confirm(snapshot, input.draft.sectionRef);
    return publicSkill(await this.call('execution.saveDraft', input));
  }
  async publish(input: MethodInput<'skill.publishVersion'>): Promise<DocumentSkillVersion> {
    const detail = await this.getSkill(input.skillId), snapshot = await this.connector.inspect((await this.target(detail.skill.draft.targetId)).record);
    this.connector.confirm(snapshot, detail.skill.draft.sectionRef);
    return this.call('execution.publish', input);
  }
  async listSources(limit = 100): Promise<MethodOutput<'source.list'>> {
    const result = await this.call<{ sources: ExecutionSource[] }>('execution.sources', { limit });
    return result.sources.map(({ text, ...source }) => ({ ...source, preview: text.slice(0, 1200) }));
  }
  async agents(check = false): Promise<AgentCapabilityView[]> {
    if (check) this.capability = await this.call('execution.capability');
    const statuses = await this.host.agent.detect();
    this.codexReady = statuses.some(status => status.id === 'codex' && status.enabled);
    return statuses.map(status => ({ provider: status.id, installed: status.installed, version: status.version, authState: status.authState,
      capability: status.capabilityState === 'ready' ? 'passed' : status.capabilityState === 'unverified' ? 'not_checked' : 'blocked',
      enabled: status.id === 'codex' && status.enabled, reason: status.detail.slice(0, 1024), checkedAt: this.capability?.checkedAt ?? null }));
  }
  async testCapability(): Promise<AgentCapabilityView[]> {
    this.capability = await this.host.agent.checkCapability();
    await this.call('execution.capability', { body: this.capability });
    return this.agents();
  }
  private async operationView(view: RunView): Promise<RunView> {
    const operation = view.operationId ? await this.call<LocalDocumentOperation | null>('execution.operation', { id: view.operationId }) : null;
    if (!operation) return view;
    const { stage, state, applied, beforeHash, afterHash, observedHash, detailCode } = operation;
    return { ...view, operationResult: { stage, state, applied, beforeHash, afterHash, observedHash, detailCode } };
  }
  async listRuns(): Promise<RunView[]> { return Promise.all((await this.call<ExecutionRunRecord[]>('execution.runs')).map(run => this.getRun(run.view.runId))); }
  async getRun(runId: string): Promise<RunView> {
    const run = await this.load(runId);
    if (!terminal.has(run.view.state) && !['applying', 'verifying'].includes(run.view.state) && run.view.expiresAt <= this.now()) {
      const old = run.view.state; run.view.state = 'expired'; run.view.approvalRef = null;
      this.generations.get(runId)?.abort(); await this.update(run, [old]);
    }
    return this.operationView(run.view);
  }
  async verify(runId: string): Promise<RunView> {
    if (this.writes.size) throw new DomainError('BUSY', '文档事务仍在运行，请稍后核验。');
    const run = await this.load(runId);
    if (run.view.operationId && ['applying', 'verifying'].includes(run.view.state)) {
      const result = await this.operations.recover(run.view.operationId, async () => this.call('execution.authorize', { id: runId }));
      await this.finishOperation(runId, result);
    }
    return this.getRun(runId);
  }
  async prepare(input: MethodInput<'run.prepare'>): Promise<MethodOutput<'run.prepare'>> {
    const cached = await this.call<MethodOutput<'run.prepare'> | null>('execution.receipt', { scope: 'run.prepare', key: input.idempotencyKey, payload: input });
    if (cached) return cached;
    if (new Set(input.sourceRefs).size !== input.sourceRefs.length) throw new DomainError('INVALID_ARGUMENT', '请勿重复选择来源。');
    const version = await this.call<DocumentSkillVersion>('execution.version', { id: input.skillVersionId });
    if (version.draft.targetId !== input.targetId || version.draft.sectionRef !== input.sectionRef) throw new DomainError('CONFLICT', '规则与文档范围不匹配。', 'APPROVAL_MISMATCH');
    const target = await this.target(input.targetId), snapshot = await this.connector.inspect(target.record), section = this.connector.confirm(snapshot, input.sectionRef);
    const selected = await this.call<{ sources: ExecutionSource[]; sourceGeneration: number }>('execution.sources', { ids: input.sourceRefs });
    const runId = randomUUID(), generation = 1, at = this.now();
    const inputSnapshot = JSON.stringify({ protocol: 'one-room-document:1', runId, generation,
      skill: { skillVersionId: version.id, title: version.draft.title, kind: version.draft.kind, formatRules: version.draft.formatRules,
        instructions: version.draft.instructions, deduplication: version.draft.deduplication },
      target: { displayName: target.record.displayName, sectionRef: section.sectionRef, heading: section.heading,
        currentSection: snapshot.bytes.subarray(section.startByte, section.endByte).toString('utf8') },
      sources: selected.sources.sort((a, b) => a.sourceRefId.localeCompare(b.sourceRefId)).map(({ sourceRefId, revision, observedAt, text }) => ({ sourceRefId, revision, observedAt, text })) });
    if (Buffer.byteLength(inputSnapshot) > 2_097_152) throw new DomainError('INVALID_ARGUMENT', '输入超过 2 MiB，请缩小来源范围。', 'INPUT_TOO_LARGE');
    const inputHash = markdownHash(Buffer.from(inputSnapshot));
    const result: MethodOutput<'run.prepare'> = { preparedRunId: runId, runId, generation, inputSnapshotHash: inputHash,
      targetSnapshotHash: snapshot.hash, inputPreview: inputSnapshot, expiresAt: at + lifetime, state: 'awaiting_input_confirmation' };
    const record: ExecutionRunRecord = { view: { runId, generation, state: result.state, skillVersionId: version.id, targetId: input.targetId,
      sourceRefs: [...input.sourceRefs].sort(), inputSnapshotHash: inputHash, targetSnapshotHash: snapshot.hash, expiresAt: result.expiresAt,
      inputPreview: inputSnapshot, proposal: null, proposalHash: null, diff: null, approvalRef: null, operationId: null, error: null, createdAt: at, updatedAt: at },
      frozenInput: inputSnapshot, sourceGeneration: selected.sourceGeneration, sourceRevisions: selected.sources.map(source => ({ sourceRefId: source.sourceRefId, revision: source.revision })),
      snapshot: { target: snapshot.target, bytes: snapshot.bytes.toString('base64') } satisfies StoredSnapshot, proposalBytes: null, candidate: null };
    const saved = await this.call<MethodOutput<'run.prepare'>>('execution.createRun', { record, key: input.idempotencyKey, payload: input, result });
    this.event(record.view); return saved;
  }
  propose(input: MethodInput<'run.propose'>): Promise<MethodOutput<'run.propose'>> {
    return this.command('run.propose', input.idempotencyKey, input, () => this.startProposal(input));
  }
  private async startProposal(input: MethodInput<'run.propose'>): Promise<MethodOutput<'run.propose'>> {
    const cached = await this.call<MethodOutput<'run.propose'> | null>('execution.receipt', { scope: 'run.propose', key: input.idempotencyKey, payload: input }); if (cached) return cached;
    const run = await this.load(input.preparedRunId);
    if (run.view.state !== 'awaiting_input_confirmation' || run.view.inputSnapshotHash !== input.expectedInputHash) throw new DomainError('STALE_REVISION', '输入已变化，请重新审核。', 'INPUT_CHANGED');
    await this.current(run);
    if (!(await this.agents()).some(agent => agent.provider === 'codex' && agent.enabled)) throw new DomainError('CAPABILITY_BLOCKED', 'Codex 能力验证尚未通过。', 'SCHEMA_UNSUPPORTED');
    const old = run.view.state; run.view.state = 'generating';
    const result = { runId: run.view.runId, generation: run.view.generation, state: 'generating' as const };
    await this.update(run, [old], { authorize: true, command: { scope: 'run.propose', key: input.idempotencyKey, payload: input, result } });
    const controller = new AbortController(); this.generations.set(run.view.runId, controller);
    this.track(this.generate(run, controller)); return result;
  }
  private async generate(run: ExecutionRunRecord, controller: AbortController): Promise<void> {
    try {
      const binding = this.binding(run);
      const response = await this.host.agent.propose({ binding, inputSnapshot: Buffer.from(run.frozenInput!), signal: controller.signal,
        isCurrent: async () => {
          if (this.closed || controller.signal.aborted) return false;
          const active = await this.load(run.view.runId);
          return active.view.state === 'generating' && active.view.generation === run.view.generation && active.view.expiresAt > this.now()
            && await this.call<boolean>('execution.authorize', { id: run.view.runId });
        } });
      if (controller.signal.aborted) return;
      const output = validateProposal(response.proposal, binding);
      if (!output.canonicalBytes.equals(response.canonicalBytes) || output.proposalHash !== response.proposalHash) throw new DomainError('INTERNAL', '提案校验未通过。', 'INVALID_AGENT_OUTPUT');
      await this.current(run);
      const snapshot = this.snapshot(run), section = this.connector.confirm(snapshot, output.proposal.sectionRef);
      const candidate = this.connector.candidate(snapshot, section, output.proposal.replacementMarkdown);
      run.view = { ...run.view, state: 'awaiting_review', proposal: output.proposal, proposalHash: output.proposalHash,
        diff: candidate.diff, approvalRef: randomUUID(), expiresAt: this.now() + lifetime };
      run.proposalBytes = output.canonicalBytes.toString('base64');
      await this.update(run, ['generating'], { authorize: true });
    } catch (error) { await this.failRun(run, error, ['generating']); }
    finally { if (this.generations.get(run.view.runId) === controller) this.generations.delete(run.view.runId); }
  }
  private async failRun(run: ExecutionRunRecord, error: unknown, expectedStates: string[]): Promise<void> {
    const info = errorInfo(error), detail = info.detailCode;
    const capability = this.host.agent.getCapability?.();
    if (capability?.state === 'capability_blocked') {
      this.codexReady = false;
      this.capability = capability; await this.call('execution.capability', { body: capability });
    }
    run.view = { ...run.view, state: info.code === 'SOURCE_INVALIDATED' ? 'source_invalidated' : info.code === 'CONFLICT' ? 'conflict' : info.code === 'CAPABILITY_BLOCKED' ? 'capability_blocked' :
      info.code === 'CANCELED' ? 'canceled' : detail === 'INPUT_EXPIRED' ? 'expired' : 'failed', error: info, approvalRef: null };
    try { await this.update(run, expectedStates); } catch { /* A newer generation or deletion owns the persisted state. */ }
  }
  async cancel(input: MethodInput<'run.cancel'>): Promise<RunView> {
    const run = await this.load(input.runId);
    if (run.view.state === 'canceled' && run.view.generation === input.expectedGeneration + 1) return run.view;
    if (run.view.generation !== input.expectedGeneration) throw new DomainError('STALE_REVISION', '任务版本已变化。', 'GENERATION_MISMATCH');
    if (['applying', 'verifying'].includes(run.view.state)) throw new DomainError('BUSY', '文档事务正在核验，完成后可查看结果。', 'CANCEL_NOT_ALLOWED');
    if (terminal.has(run.view.state)) return run.view;
    const old = run.view.state; run.view = { ...run.view, state: 'canceled', generation: run.view.generation + 1, approvalRef: null };
    await this.update(run, [old], { expectedGeneration: input.expectedGeneration });
    this.generations.get(input.runId)?.abort(); this.host.agent.cancel(input.runId, input.expectedGeneration); return run.view;
  }
  private validateApproval(run: ExecutionRunRecord, input: MethodInput<'run.apply'>): void {
    if (run.view.state !== 'awaiting_review' || run.view.generation !== input.expectedGeneration || run.view.proposalHash !== input.proposalHash ||
      run.view.targetSnapshotHash !== input.expectedTargetHash || run.view.inputSnapshotHash !== input.inputSnapshotHash || run.view.skillVersionId !== input.skillVersionId ||
      run.view.approvalRef !== input.approvalRef || new Set(input.sourceRefs).size !== input.sourceRefs.length || JSON.stringify([...input.sourceRefs].sort()) !== JSON.stringify(run.view.sourceRefs)) {
      throw new DomainError('CONFLICT', '差异审核绑定已变化，请重新审核。', 'APPROVAL_MISMATCH');
    }
    if (!run.proposalBytes || markdownHash(Buffer.from(run.proposalBytes, 'base64')) !== run.view.proposalHash) throw new DomainError('CONFLICT', '提案已变化，请重新准备。', 'APPROVAL_MISMATCH');
  }
  apply(input: MethodInput<'run.apply'>): Promise<MethodOutput<'run.apply'>> {
    return this.command('run.apply', input.idempotencyKey, input, () => this.startApply(input));
  }
  private async startApply(input: MethodInput<'run.apply'>): Promise<MethodOutput<'run.apply'>> {
    const cached = await this.call<MethodOutput<'run.apply'> | null>('execution.receipt', { scope: 'run.apply', key: input.idempotencyKey, payload: input }); if (cached) return cached;
    const run = await this.load(input.runId); this.validateApproval(run, input); await this.current(run);
    const target = await this.target(run.view.targetId);
    if (!target.exclusiveEditing || target.exclusiveHash !== run.view.targetSnapshotHash) throw new DomainError('CAPABILITY_BLOCKED', '请确认独占编辑，或导出补丁。', 'EXCLUSIVE_EDIT_REQUIRED');
    const operationId = randomUUID(); run.view = { ...run.view, state: 'applying', operationId };
    const result = { operationId, runId: input.runId, state: 'applying' as const };
    await this.update(run, ['awaiting_review'], { authorize: true, command: { scope: 'run.apply', key: input.idempotencyKey, payload: input, result } });
    this.track(this.performApply(run, input, target), true); return result;
  }
  private async performApply(run: ExecutionRunRecord, input: MethodInput<'run.apply'>, target: StoredTarget): Promise<void> {
    try {
      const snapshot = this.snapshot(run), section = this.connector.confirm(snapshot, run.view.proposal!.sectionRef);
      const candidate = this.connector.candidate(snapshot, section, run.view.proposal!.replacementMarkdown);
      const result = await this.operations.apply({ operationId: run.view.operationId!, idempotencyKey: input.idempotencyKey, runId: run.view.runId,
        generation: run.view.generation, approvalRef: input.approvalRef, approvalBindingHash: markdownHash(Buffer.from(JSON.stringify(input))),
        target: target.record, snapshot, section, candidate, exclusive: true }, async (_operation, phase) => {
          const active = await this.load(run.view.runId);
          if (!['applying', 'verifying'].includes(active.view.state) || active.view.generation !== run.view.generation) return false;
          if (phase === 'after_write') { active.view.state = 'verifying'; await this.update(active, ['applying', 'verifying']); }
          return this.call<boolean>('execution.authorize', { id: run.view.runId });
        });
      await this.finishOperation(run.view.runId, result);
    } catch (error) {
      const operation = await this.call<LocalDocumentOperation | null>('execution.operation', { id: run.view.operationId });
      if (operation && ['applying', 'verifying'].includes(operation.state)) {
        run.view.state = 'verifying'; run.view.error = errorInfo(error);
        try { await this.update(run, ['applying', 'verifying']); } catch { /* Preserve a newer state. */ }
      } else await this.failRun(run, error, ['applying', 'verifying']);
    }
  }
  private async finishOperation(runId: string, receipt: DocumentOperationReceipt): Promise<void> {
    const run = await this.load(runId);
    if (receipt.targetAfter) {
      const target = await this.target(run.view.targetId), updated: StoredTarget = { ...target, record: receipt.targetAfter,
        revision: target.revision + 1, exclusiveEditing: false, exclusiveHash: null };
      await this.call('execution.saveTarget', { id: target.record.id, revision: updated.revision, body: updated, expectedRevision: target.revision });
    }
    run.view.state = receipt.state; run.view.approvalRef = null;
    run.view.error = receipt.detailCode ? { code: receipt.state === 'source_invalidated' ? 'SOURCE_INVALIDATED' : receipt.state === 'conflict' ? 'CONFLICT' : 'INTERNAL', detailCode: receipt.detailCode, message: '请查看文档操作结果；不会自动重放写入。' } : null;
    await this.update(run, ['applying', 'verifying']);
  }
  exportPatch(input: MethodInput<'run.exportPatch'>): Promise<MethodOutput<'run.exportPatch'>> {
    return this.command('run.exportPatch', input.idempotencyKey, input, () => this.writePatch(input));
  }
  private async writePatch(input: MethodInput<'run.exportPatch'>): Promise<MethodOutput<'run.exportPatch'>> {
    const cached = await this.call<MethodOutput<'run.exportPatch'> | null>('execution.receipt', { scope: 'run.exportPatch', key: input.idempotencyKey, payload: input }); if (cached) return cached;
    const run = await this.load(input.runId);
    if (run.view.state !== 'awaiting_review' || run.view.generation !== input.expectedGeneration || run.view.proposalHash !== input.proposalHash) throw new DomainError('CONFLICT', '提案已变化，请重新审核。', 'APPROVAL_MISMATCH');
    await this.current(run);
    const path = await this.host.dialogs.savePatch((await this.target(run.view.targetId)).record.displayName);
    if (!path) return { exported: false };
    await this.current(run);
    await writeFile(path, run.view.diff!, { flag: 'wx', mode: 0o600 });
    return this.call('execution.saveReceipt', { scope: 'run.exportPatch', key: input.idempotencyKey, payload: input, result: { exported: true, receiptId: randomUUID() } });
  }
  async cancelGenerating(): Promise<void> {
    for (const [runId] of this.generations) {
      const view = await this.getRun(runId);
      if (view.state === 'generating') await this.cancel({ runId, expectedGeneration: view.generation });
    }
  }
  async quiesce(): Promise<void> {
    await this.cancelGenerating();
    await Promise.allSettled([...this.writes]);
    const pending = await this.call<LocalDocumentOperation[]>('execution.pendingOperations');
    if (pending.length) throw new DomainError('BUSY', '存在待核验的文档事务，恢复后再删除记录。', 'CANCEL_NOT_ALLOWED');
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.generations.values()) controller.abort();
    await this.host.agent.close(); await Promise.allSettled([...this.background]);
  }
}
