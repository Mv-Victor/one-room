import { z } from 'zod';
import { ActivityTypeSchema, BundleIdSchema, EpochMsSchema, GenerationSchema, IdSchema, RevisionSchema } from './schemas';

const BaseUrlSchema = z.string().trim().min(1).max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'A model base URL must be an HTTP(S) URL without embedded credentials.');

export const ModelTestStatusSchema = z.strictObject({
  status: z.enum(['never', 'passed', 'failed']), testedAt: EpochMsSchema,
  latencyMs: z.number().int().nonnegative(), reason: z.string().max(256).nullable(),
});

export const ModelSettingsSchema = z.strictObject({
  revision: RevisionSchema, baseUrl: z.string().max(2048), model: z.string().max(128),
  hasCredential: z.boolean(), encryptionAvailable: z.boolean(), lastTest: ModelTestStatusSchema.nullable(),
});
export const SaveModelSettingsSchema = z.strictObject({
  expectedRevision: RevisionSchema, baseUrl: BaseUrlSchema, model: z.string().trim().min(1).max(128),
  apiKey: z.string().trim().min(1).max(8192).optional(),
});
export const ModelRevisionInputSchema = z.strictObject({ expectedRevision: RevisionSchema });
export const ModelConnectionResultSchema = z.strictObject({
  settings: ModelSettingsSchema, ok: z.boolean(), latencyMs: z.number().int().nonnegative(), message: z.string().max(500),
});

export const ActivityTextSourceSchema = z.strictObject({
  sourceRefId: IdSchema, revision: RevisionSchema, appBundleId: BundleIdSchema,
  observedAt: EpochMsSchema, text: z.string().min(1).max(20_000),
  sourceKind: z.enum(['text', 'summary']).optional(),
});
export const ActivityAnalysisInputSchema = z.strictObject({
  periodId: IdSchema, sources: z.array(ActivityTextSourceSchema).min(1).max(20),
  periodContext: z.strictObject({
    stage: z.enum(['leaf', 'reduce']), startTs: EpochMsSchema, endTs: EpochMsSchema,
    durationMs: EpochMsSchema, appName: z.string().max(256),
    activityType: ActivityTypeSchema, objectLabel: z.string().max(512).nullable(), topic: z.string().max(512).nullable(),
  }).optional(),
}).refine((value) => value.sources.reduce((total, source) => total + source.text.length, 0) <= 64_000,
  'A model task can contain at most 64000 text characters.');
export const ActivityAnalysisSchema = z.strictObject({
  activityAction: z.enum(['view', 'suspected_edit', 'context_switch', 'unknown']),
  activityType: ActivityTypeSchema, objectLabel: z.string().max(512).nullable(),
  topic: z.string().max(512).nullable(), summary: z.string().max(4096).nullable(),
  sourceRefIds: z.array(IdSchema).min(1).max(20),
}).refine((value) => new Set(value.sourceRefIds).size === value.sourceRefIds.length, 'Source citations must be unique.');
export const ModelTaskSchema = z.strictObject({
  id: IdSchema, consentRevision: RevisionSchema, consentGeneration: GenerationSchema,
  kind: z.literal('period_summary').optional(), ownerRevision: RevisionSchema.optional(), sourceGeneration: GenerationSchema.optional(),
  input: ActivityAnalysisInputSchema,
});

export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
export type SaveModelSettings = z.infer<typeof SaveModelSettingsSchema>;
export type ModelRevisionInput = z.infer<typeof ModelRevisionInputSchema>;
export type ModelConnectionResult = z.infer<typeof ModelConnectionResultSchema>;
export type ActivityAnalysisInput = z.infer<typeof ActivityAnalysisInputSchema>;
export type ActivityAnalysis = z.infer<typeof ActivityAnalysisSchema>;
export type ModelTask = z.infer<typeof ModelTaskSchema>;
