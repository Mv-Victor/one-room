import { z } from 'zod';
import { ActivityTypeSchema, BasisSchema, BundleIdSchema, EpochMsSchema, IdSchema, RevisionSchema } from './schemas';

export const ActivityActionSchema = z.enum(['view', 'suspected_edit', 'context_switch', 'unknown']);
export const ActivitySchema = z.strictObject({
  id: IdSchema, observationId: IdSchema, observedAt: EpochMsSchema, appBundleId: BundleIdSchema,
  appName: z.string().max(256), windowTitle: z.string().max(4096).nullable(),
  action: ActivityActionSchema, activityType: ActivityTypeSchema, objectLabel: z.string().max(512).nullable(),
  topic: z.string().max(512).nullable(), summary: z.string().max(8192).nullable(), basis: BasisSchema,
  revision: RevisionSchema, sourceRefIds: z.array(IdSchema).max(100),
  textStatus: z.string().max(64), analysisStatus: z.enum(['not_authorized', 'not_configured', 'pending', 'ready', 'failed', 'insufficient']),
  text: z.string().max(100000).nullable(), extractionSource: z.enum(['accessibility', 'ocr']).nullable(),
});
export const ActivityQuerySchema = z.strictObject({ before: EpochMsSchema.optional(), limit: z.number().int().min(1).max(100).optional() });
export const ActivityReviewSchema = z.strictObject({
  id: IdSchema, expectedRevision: RevisionSchema, action: ActivityActionSchema, activityType: ActivityTypeSchema,
  objectLabel: z.string().trim().max(512).nullable(), topic: z.string().trim().max(512).nullable(), confirmed: z.literal(true),
});
export const ActivityPageSchema = z.strictObject({ items: z.array(ActivitySchema).max(100), nextBefore: EpochMsSchema.nullable() });
export type Activity = z.infer<typeof ActivitySchema>;
