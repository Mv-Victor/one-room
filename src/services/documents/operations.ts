import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DomainError } from '../../shared/errors';
import { LocalMarkdownConnector, markdownHash, sameFileIdentity, targetConflict,
  type ConfirmedMarkdownSection, type FileIdentity, type LocalMarkdownSnapshot, type LocalTargetRecord, type MarkdownCandidate } from './local-markdown';

export type DocumentOperationState = 'applying' | 'verifying' | 'succeeded' | 'no_change' | 'interrupted' | 'conflict' | 'source_invalidated' | 'failed';
export type DocumentOperationStage = 'intent' | 'temporary_synced' | 'renamed' | 'directory_synced' | 'verified';
export type LocalDocumentOperation = {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  targetId: string;
  runId: string;
  generation: number;
  approvalRef: string;
  approvalBindingHash: string;
  target: LocalTargetRecord;
  section: ConfirmedMarkdownSection;
  beforeHash: string;
  afterHash: string;
  beforeBase64: string;
  candidateBase64: string;
  replacementBase64: string;
  temporaryPath: string;
  temporaryIdentity: FileIdentity | null;
  state: DocumentOperationState;
  stage: DocumentOperationStage;
  applied: boolean | null;
  observedHash: string | null;
  detailCode: string | null;
  createdAt: number;
  updatedAt: number;
  targetAfter: LocalTargetRecord | null;
};
// Every resolved mutation must already be durable. createIntent atomically enforces (targetId,key).
export interface DocumentOperationHost {
  findByIdempotencyKey(targetId: string, key: string): Promise<LocalDocumentOperation | null>;
  get(id: string): Promise<LocalDocumentOperation | null>;
  createIntent(operation: LocalDocumentOperation): Promise<LocalDocumentOperation>;
  update(operation: LocalDocumentOperation): Promise<LocalDocumentOperation>;
}
export type DocumentOperationGuard = (operation: Readonly<LocalDocumentOperation>, phase: 'before_intent' | 'before_rename' | 'after_write' | 'recovery') => Promise<boolean>;
export type ApplyMarkdownInput = {
  operationId?: string;
  idempotencyKey: string;
  runId: string;
  generation: number;
  approvalRef: string;
  approvalBindingHash: string;
  target: LocalTargetRecord;
  snapshot: LocalMarkdownSnapshot;
  section: ConfirmedMarkdownSection;
  candidate: MarkdownCandidate;
  exclusive: boolean;
};
export type DocumentOperationReceipt = Pick<LocalDocumentOperation, 'id' | 'targetId' | 'runId' | 'state' | 'stage' | 'applied' | 'beforeHash' | 'afterHash' | 'observedHash' | 'detailCode' | 'targetAfter'>;
const receipt = (operation: LocalDocumentOperation): DocumentOperationReceipt => {
  const { id, targetId, runId, state, stage, applied, beforeHash, afterHash, observedHash, detailCode, targetAfter } = operation;
  return { id, targetId, runId, state, stage, applied, beforeHash, afterHash, observedHash, detailCode, targetAfter };
};
const terminal = (operation: LocalDocumentOperation): boolean => !['applying', 'verifying'].includes(operation.state);
const targetLocks = new Map<string, Promise<unknown>>();
const sourceInvalidated = (): never => { throw new DomainError('SOURCE_INVALIDATED', 'A source was deleted. Prepare and review the update again.', 'SOURCE_DELETED'); };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const prior = targetLocks.get(key) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(action);
  targetLocks.set(key, current);
  try { return await current; }
  finally { if (targetLocks.get(key) === current) targetLocks.delete(key); }
}

export class LocalDocumentOperations {
  constructor(private readonly connector: LocalMarkdownConnector, private readonly host: DocumentOperationHost) {}

  private async save(operation: LocalDocumentOperation, patch: Partial<LocalDocumentOperation>): Promise<LocalDocumentOperation> {
    const updated = { ...operation, ...patch, updatedAt: Date.now() };
    return this.host.update(updated);
  }

  private async current(operation: LocalDocumentOperation, originalIdentity: boolean): Promise<{ bytes: Buffer; target: LocalTargetRecord; mode: number }> {
    return this.connector.readCurrent(operation.target, originalIdentity ? operation.target.identity : null);
  }

  private validateStored(operation: LocalDocumentOperation): MarkdownCandidate {
    const before = Buffer.from(operation.beforeBase64, 'base64');
    const snapshot = this.connector.snapshot(operation.target, before);
    const candidate = this.connector.candidate(snapshot, operation.section, Buffer.from(operation.replacementBase64, 'base64').toString('utf8'));
    if (markdownHash(before) !== operation.beforeHash || candidate.afterHash !== operation.afterHash || candidate.afterBytes.toString('base64') !== operation.candidateBase64) {
      throw new DomainError('INTERNAL', 'The saved document operation cannot be verified.', 'VERIFY_FAILED');
    }
    return candidate;
  }

  async apply(input: ApplyMarkdownInput, guard: DocumentOperationGuard): Promise<DocumentOperationReceipt> {
    if (!input.exclusive) throw new DomainError('CAPABILITY_BLOCKED', 'Confirm exclusive editing or export a patch.', 'EXCLUSIVE_EDIT_REQUIRED');
    if ((input.operationId && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(input.operationId)) ||
      !Number.isSafeInteger(input.generation) || input.generation < 1 || !/^[\da-f]{64}$/.test(input.approvalBindingHash)) {
      throw new DomainError('INVALID_ARGUMENT', 'The document operation binding is invalid.');
    }
    return serialized(input.target.canonicalPath, async () => {
      const candidate = this.connector.candidate(input.snapshot, input.section, input.candidate.replacementBytes.toString('utf8'));
      if (input.target.id !== input.snapshot.target.id || candidate.targetId !== input.target.id || input.candidate.afterHash !== candidate.afterHash ||
        input.candidate.beforeHash !== candidate.beforeHash || !input.candidate.afterBytes.equals(candidate.afterBytes) ||
        input.target.canonicalPath !== input.snapshot.target.canonicalPath || input.target.selectedPath !== input.snapshot.target.selectedPath ||
        !sameFileIdentity(input.target.identity, input.snapshot.target.identity)) return targetConflict();
      const requestHash = hash({ targetId: input.target.id, runId: input.runId, generation: input.generation, approvalRef: input.approvalRef,
        approvalBindingHash: input.approvalBindingHash, beforeHash: candidate.beforeHash, afterHash: candidate.afterHash, section: input.section });
      const existing = await this.host.findByIdempotencyKey(input.target.id, input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new DomainError('CONFLICT', 'This request key already belongs to another update.', 'IDEMPOTENCY_CONFLICT');
        return terminal(existing) ? receipt(existing) : this.recoverLocked(existing, guard);
      }
      const current = await this.connector.readCurrent(input.target);
      if (markdownHash(current.bytes) !== candidate.beforeHash) return targetConflict();
      const now = Date.now(), id = input.operationId ?? randomUUID();
      let operation: LocalDocumentOperation = { id, idempotencyKey: input.idempotencyKey, requestHash, targetId: input.target.id, runId: input.runId,
        generation: input.generation, approvalRef: input.approvalRef, approvalBindingHash: input.approvalBindingHash, target: current.target, section: input.section,
        beforeHash: candidate.beforeHash, afterHash: candidate.afterHash, beforeBase64: current.bytes.toString('base64'), candidateBase64: candidate.afterBytes.toString('base64'),
        replacementBase64: candidate.replacementBytes.toString('base64'), temporaryPath: join(dirname(input.target.canonicalPath), `.one-room-${id}.tmp`), temporaryIdentity: null,
        state: candidate.beforeHash === candidate.afterHash ? 'no_change' : 'applying', stage: 'intent', applied: false, observedHash: candidate.beforeHash,
        detailCode: null, createdAt: now, updatedAt: now, targetAfter: current.target };
      if (!await guard(operation, 'before_intent')) return sourceInvalidated();
      const stored = await this.host.createIntent(operation);
      if (stored.requestHash !== requestHash) throw new DomainError('CONFLICT', 'This request key already belongs to another update.', 'IDEMPOTENCY_CONFLICT');
      if (stored.id !== operation.id) return terminal(stored) ? receipt(stored) : this.recoverLocked(stored, guard);
      operation = stored;
      if (terminal(operation)) return receipt(operation);
      let renamed = false;
      try {
        const temporary = await open(operation.temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, current.mode);
        try {
          const stat = await temporary.stat({ bigint: true });
          operation = { ...operation, temporaryIdentity: { dev: String(stat.dev), ino: String(stat.ino) } };
          operation = await this.save(operation, {});
          await temporary.writeFile(candidate.afterBytes); await temporary.chmod(current.mode); await temporary.sync();
        }
        finally { await temporary.close(); }
        operation = await this.save(operation, { stage: 'temporary_synced' });
        if (!await guard(operation, 'before_rename')) return sourceInvalidated();
        const beforeRename = await this.current(operation, true);
        if (markdownHash(beforeRename.bytes) !== operation.beforeHash) return targetConflict();
        const temporaryStat = await lstat(operation.temporaryPath, { bigint: true });
        if (!temporaryStat.isFile() || !operation.temporaryIdentity || !sameFileIdentity({ dev: String(temporaryStat.dev), ino: String(temporaryStat.ino) }, operation.temporaryIdentity)) return targetConflict();
        await rename(operation.temporaryPath, operation.target.canonicalPath); renamed = true;
        operation = await this.save(operation, { state: 'verifying', stage: 'renamed', applied: true });
        const directory = await open(dirname(operation.target.canonicalPath), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
        operation = await this.save(operation, { stage: 'directory_synced' });
        return await this.verifyAfter(operation, guard, 'after_write');
      } catch (error) {
        if (!renamed) {
          await this.cleanupTemporary(operation);
          const domain = error instanceof DomainError ? error.error : null;
          operation = await this.save(operation, { state: domain?.code === 'SOURCE_INVALIDATED' ? 'source_invalidated' : domain?.code === 'CONFLICT' ? 'conflict' : 'failed',
            detailCode: domain?.detailCode ?? 'WRITE_FAILED' });
          if (domain) throw error;
          throw new DomainError('INTERNAL', 'The document update could not be written.', 'WRITE_FAILED');
        }
        // Rename may already be visible. Preserve the intent for hash-based recovery; never roll back.
        await this.save(operation, { state: 'verifying', applied: true, detailCode: 'VERIFY_FAILED' });
        throw new DomainError('INTERNAL', 'The write needs verification before another update.', 'VERIFY_FAILED');
      }
    });
  }

  async recover(operationId: string, guard: DocumentOperationGuard): Promise<DocumentOperationReceipt> {
    const operation = await this.host.get(operationId);
    if (!operation) throw new DomainError('NOT_FOUND', 'The document operation is unavailable.', 'OPERATION_NOT_FOUND');
    return serialized(operation.target.canonicalPath, async () => {
      const latest = await this.host.get(operationId);
      if (!latest) throw new DomainError('NOT_FOUND', 'The document operation is unavailable.', 'OPERATION_NOT_FOUND');
      return terminal(latest) ? receipt(latest) : this.recoverLocked(latest, guard);
    });
  }

  private async recoverLocked(operation: LocalDocumentOperation, guard: DocumentOperationGuard): Promise<DocumentOperationReceipt> {
    this.validateStored(operation);
    let current: Awaited<ReturnType<LocalMarkdownConnector['readCurrent']>>;
    try { current = await this.current(operation, false); }
    catch {
      await this.cleanupTemporary(operation);
      return receipt(await this.save(operation, { state: 'conflict', applied: operation.applied || null, detailCode: 'TARGET_CONFLICT' }));
    }
    const observedHash = markdownHash(current.bytes);
    if (observedHash === operation.afterHash) {
      await this.cleanupTemporary(operation);
      const directory = await open(dirname(operation.target.canonicalPath), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      return this.verifyAfter(operation, guard, 'recovery');
    }
    await this.cleanupTemporary(operation);
    return receipt(await this.save(operation, { state: observedHash === operation.beforeHash ? 'interrupted' : 'conflict',
      observedHash, applied: observedHash === operation.beforeHash ? false : operation.applied || null,
      detailCode: observedHash === operation.beforeHash ? 'WRITE_INTERRUPTED' : 'TARGET_CONFLICT', targetAfter: current.target }));
  }

  private async verifyAfter(operation: LocalDocumentOperation, guard: DocumentOperationGuard, phase: 'after_write' | 'recovery'): Promise<DocumentOperationReceipt> {
    const candidate = this.validateStored(operation), current = await this.connector.readCurrent(operation.target, operation.temporaryIdentity), observedHash = markdownHash(current.bytes);
    if (observedHash !== operation.afterHash || !current.bytes.equals(candidate.afterBytes)) {
      return receipt(await this.save(operation, { state: 'conflict', observedHash, applied: true, detailCode: 'TARGET_CONFLICT', targetAfter: current.target }));
    }
    const sourcesValid = await guard(operation, phase);
    return receipt(await this.save(operation, { state: sourcesValid ? 'succeeded' : 'source_invalidated', stage: 'verified', applied: true, observedHash,
      detailCode: sourcesValid ? null : 'SOURCE_DELETED', targetAfter: current.target }));
  }

  private async cleanupTemporary(operation: LocalDocumentOperation): Promise<void> {
    // Only a persisted intent's application-owned exact filename may be removed.
    const expected = join(dirname(operation.target.canonicalPath), `.one-room-${operation.id}.tmp`);
    if (operation.temporaryPath !== expected || basename(operation.temporaryPath) !== `.one-room-${operation.id}.tmp` || !operation.temporaryIdentity) return;
    try {
      const stat = await lstat(operation.temporaryPath, { bigint: true });
      if (stat.isFile() && sameFileIdentity({ dev: String(stat.dev), ino: String(stat.ino) }, operation.temporaryIdentity)) await unlink(operation.temporaryPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
