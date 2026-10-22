import { inputSchemas, type MethodInput, type MethodOutput } from '../../shared/contracts';
import { DomainError } from '../../shared/errors';

type Preview = MethodOutput<'history.previewDelete'>;
export interface HistoryRepository {
  preview(input: MethodInput<'history.previewDelete'>): Promise<Omit<Preview, 'deletionRef' | 'expiresAt'>>;
  // A atomically checks revision, bumps source/capture generations, invalidates
  // source joins, scrubs derived copies/FTS/reports, then schedules blob cleanup.
  delete(input: MethodInput<'history.previewDelete'>, expectedRevision: number, idempotencyKey: string): Promise<MethodOutput<'history.delete'>>;
}
export interface DurableHistoryRepository {
  durable: {
    preview(input: MethodInput<'history.previewDelete'>): Promise<Preview>;
    delete(input: MethodInput<'history.delete'>): Promise<MethodOutput<'history.delete'>>;
  };
}
export function createHistoryDelete(repository: HistoryRepository | DurableHistoryRepository, now = Date.now) {
  if ('durable' in repository) return {
    preview: (raw: MethodInput<'history.previewDelete'>) => repository.durable.preview(inputSchemas['history.previewDelete'].parse(raw)),
    delete: (raw: MethodInput<'history.delete'>) => repository.durable.delete(inputSchemas['history.delete'].parse(raw)),
  };
  const previews = new Map<string, { range: MethodInput<'history.previewDelete'>; preview: Preview }>();
  const receipts = new Map<string, { ref: string; result: MethodOutput<'history.delete'> }>();
  return {
    async preview(raw: MethodInput<'history.previewDelete'>): Promise<Preview> {
      const range = inputSchemas['history.previewDelete'].parse(raw), counts = await repository.preview(range);
      const preview = { ...counts, deletionRef: crypto.randomUUID(), expiresAt: now() + 300_000 };
      previews.set(preview.deletionRef, { range, preview });
      if (previews.size > 64) previews.delete(previews.keys().next().value!);
      return preview;
    },
    async delete(raw: MethodInput<'history.delete'>) {
      const input = inputSchemas['history.delete'].parse(raw), prior = receipts.get(input.idempotencyKey);
      if (prior) {
        if (prior.ref !== input.deletionRef) throw new DomainError('CONFLICT', '删除请求标识已被使用。');
        return prior.result;
      }
      const entry = previews.get(input.deletionRef);
      if (!entry || entry.preview.expiresAt <= now()) throw new DomainError('STALE_REVISION', '删除预览已到期，请重新预览。');
      if (entry.preview.dataRevision !== input.expectedRevision) throw new DomainError('STALE_REVISION', '删除范围已变化，请重新预览。');
      const result = await repository.delete(entry.range, input.expectedRevision, input.idempotencyKey);
      receipts.set(input.idempotencyKey, { ref: input.deletionRef, result });
      if (receipts.size > 128) receipts.delete(receipts.keys().next().value!);
      previews.delete(input.deletionRef);
      return result;
    }
  };
}
