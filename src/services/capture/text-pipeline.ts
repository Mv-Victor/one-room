import { NativeOcrPayloadSchema, NativeTextPayloadSchema, type Settings } from '../../shared/schemas';
import type { DatabaseClient } from '../storage/client';
import type { TextRecord } from '../storage/capture-commands';
import type { NativeSession } from './native-session';

export async function extractObservationText(options: {
  createExecutor: () => Promise<NativeSession>; database: DatabaseClient; observationId: string; generation: number;
  pid: number; windowId: number; contextRevision: number; policy: Settings; token: string;
  windowTitle?: string | null;
}): Promise<void> {
  const { database, observationId, generation, policy } = options;
  const identity = { pid: options.pid, windowId: options.windowId, observationId };
  const records: TextRecord[] = [];
  await database.call('text.authorize', { observationId, generation });
  let axExecutor: NativeSession | undefined;
  try {
    axExecutor = await options.createExecutor();
    const result = await axExecutor.request('extract', { contextRevision: options.contextRevision, policyRevision: policy.revision }, identity, 4000);
    const ax = NativeTextPayloadSchema.parse(result.payload);
    if (ax.contextBefore.pid !== options.pid || ax.contextAfter.pid !== options.pid || ax.contextBefore.windowId !== options.windowId || ax.contextAfter.windowId !== options.windowId) throw new Error('AX_CONTEXT_MISMATCH');
    if (options.windowTitle !== undefined && (ax.contextBefore.windowTitle !== options.windowTitle || ax.contextAfter.windowTitle !== options.windowTitle)) throw new Error('AX_CONTEXT_MISMATCH');
    records.push({ source: ax.source, status: ax.status, completeness: ax.completeness, text: ax.text, observedAt: ax.observedAt, fallbackReason: ax.fallbackReason });
  } catch (error) {
    if (/CONTEXT_CHANGED|VISIBILITY_UNVERIFIED|WINDOW_AMBIGUOUS|SCREEN_LOCKED|SYSTEM_SLEEPING|PERMISSION_/.test(String(error))) {
      await database.call('text.fail', { observationId });
      return;
    }
    records.push({ source: 'accessibility', status: 'failed', completeness: 'unknown', text: '', observedAt: Date.now(), fallbackReason: 'ax_unavailable' });
  } finally { axExecutor?.stop(); }
  const ax = records[0]!;
  if (ax.completeness !== 'complete' || !ax.text.trim()) {
    await database.call('text.authorize', { observationId, generation, requireImage: true });
    // OCR reads the exact staged PNG that was committed for this observation.
    let ocrExecutor: NativeSession | undefined;
    try {
      ocrExecutor = await options.createExecutor();
      const result = await ocrExecutor.request('ocr', { inputToken: options.token, languages: ['zh-Hans', 'en-US'] }, identity, 8000);
      const ocr = NativeOcrPayloadSchema.parse(result.payload);
      if (ocr.inputToken !== options.token) throw new Error('OCR_IMAGE_MISMATCH');
      records.push({ source: ocr.source, status: ocr.status, completeness: ocr.completeness, text: ocr.text, observedAt: ocr.observedAt, fallbackReason: ocr.fallbackReason });
    } catch {
      records.push({ source: 'ocr', status: 'failed', completeness: 'unknown', text: '', observedAt: Date.now(), fallbackReason: 'ocr_unavailable' });
    } finally { ocrExecutor?.stop(); }
  }
  const ocr = records.find(r => r.source === 'ocr');
  const selectedSource = ax.completeness === 'complete' && ax.text.trim() ? 'accessibility' : ocr?.text.trim() ? 'ocr' : ax.text.trim() ? 'accessibility' : null;
  await database.call('text.commit', { observationId, generation, records, selectedSource, action: 'unknown' });
}
