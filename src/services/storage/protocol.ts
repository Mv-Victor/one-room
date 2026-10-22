import { z } from 'zod';

export const observationInputSchema = z.strictObject({
  id: z.uuid(), sessionId: z.uuid(), observedAt: z.number().int().nonnegative(),
  bundleId: z.string().min(1).max(255), appName: z.string().min(1).max(255),
  pid: z.number().int().positive(), windowId: z.number().int().positive(),
  windowTitle: z.string().max(4096).nullable(),
  trigger: z.enum(['app_switch', 'window_focus', 'window_title', 'content_changed', 'click', 'typing_pause', 'scroll_stop', 'checkpoint', 'visual_checkpoint', 'degraded_checkpoint', 'manual']),
  captureGeneration: z.number().int().positive(),
  pairingStatus: z.literal('matched'), visibilityStatus: z.literal('verified'),
});

export type ObservationInput = z.infer<typeof observationInputSchema>;
export type BlobInput = {
  id: string; sha256: string; relativePath: string; mime: 'image/png';
  width: number; height: number; byteSize: number;
};
export type EvidenceRecord = {
  evidenceId: string; captureEventId: string; blobId: string;
  relativePath: string; sha256: string; mime: 'image/png';
  observedAt: number; expiresAt: number;
  status: 'available' | 'expired' | 'deleted' | 'missing';
};
export type StorageDiagnostics = {
  schemaVersion: number; sqliteVersion: string; journalMode: 'wal';
  synchronous: number; foreignKeys: number; fts5: boolean;
  observationCount: number; evidenceCount: number;
};
export type DatabaseResult<T> = { data: T; dataRevision: number };
export type DatabaseError = { code: string; detailCode?: string; message: string; retryable: boolean };
export type DatabaseResponse = { id: string } & (
  | { ok: true; result: DatabaseResult<unknown> }
  | { ok: false; error: DatabaseError }
);
