import { z } from 'zod';
import { EmptyInputSchema, EpochMsSchema, GenerationSchema, HashSchema, IdSchema, OpaqueRefSchema, RevisionSchema } from './schemas';

export const ProposalSchema = z.strictObject({
  runId: IdSchema, generation: GenerationSchema, skillVersionId: IdSchema,
  inputSnapshotHash: HashSchema, targetSnapshotHash: HashSchema, sectionRef: OpaqueRefSchema,
  sourceRefs: z.array(z.string().min(1).max(128)).min(1).max(2000),
  replacementMarkdown: z.string().min(1).max(2_097_152),
});
export const DocumentTargetSchema = z.strictObject({
  id: IdSchema, connector: z.literal('local_markdown'), displayName: z.string().min(1).max(512),
  revision: RevisionSchema, exclusiveEditing: z.boolean(),
});
export const TargetInspectionSchema = z.strictObject({
  target: DocumentTargetSchema, targetSnapshotHash: HashSchema,
  bom: z.boolean(), newline: z.enum(['LF', 'CRLF']),
  sections: z.array(z.strictObject({ sectionRef: OpaqueRefSchema, label: z.string().min(1).max(512), text: z.string().max(2_097_152) })).max(2000),
});
export const DocumentSkillDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(256), kind: z.enum(['daily', 'weekly', 'document']),
  targetId: IdSchema, sectionRef: OpaqueRefSchema,
  formatRules: z.string().trim().min(1).max(8192), instructions: z.string().trim().min(1).max(8192),
  deduplication: z.string().trim().min(1).max(4096), candidateId: IdSchema.optional(),
});
export const DocumentSkillSchema = z.strictObject({
  id: IdSchema, draftRevision: RevisionSchema, status: z.enum(['draft', 'ready', 'source_deleted']),
  draft: DocumentSkillDraftSchema, currentVersionId: IdSchema.nullable(),
});
export const DocumentSkillVersionSchema = z.strictObject({
  id: IdSchema, skillId: IdSchema, version: RevisionSchema, draft: DocumentSkillDraftSchema,
  contentHash: HashSchema, createdAt: EpochMsSchema,
});
export const DocumentSkillDetailSchema = z.strictObject({ skill: DocumentSkillSchema, versions: z.array(DocumentSkillVersionSchema).max(1000) });
export const ExecutionSourceSchema = z.strictObject({
  sourceRefId: IdSchema, revision: RevisionSchema, observedAt: EpochMsSchema,
  label: z.string().max(1024), preview: z.string().max(1200),
});
export const RunStateSchema = z.enum(['preparing', 'awaiting_input_confirmation', 'generating', 'awaiting_review',
  'applying', 'verifying', 'succeeded', 'no_change', 'failed', 'canceled', 'conflict', 'interrupted',
  'capability_blocked', 'expired', 'source_invalidated']);
export const OperationResultSchema = z.strictObject({
  stage: z.string().max(64), state: z.string().max(64), applied: z.boolean().nullable(),
  beforeHash: HashSchema, afterHash: HashSchema, observedHash: HashSchema.nullable(), detailCode: z.string().max(128).nullable(),
});
export const RunViewSchema = z.strictObject({
  runId: IdSchema, generation: GenerationSchema, state: RunStateSchema,
  skillVersionId: IdSchema, targetId: IdSchema, sourceRefs: z.array(IdSchema).min(1).max(2000),
  inputSnapshotHash: HashSchema, targetSnapshotHash: HashSchema, expiresAt: EpochMsSchema,
  inputPreview: z.string().max(2_097_152).nullable(), proposal: ProposalSchema.nullable(),
  proposalHash: HashSchema.nullable(), diff: z.string().max(8_388_608).nullable(),
  approvalRef: IdSchema.nullable(), operationId: IdSchema.nullable(),
  operationResult: OperationResultSchema.optional(),
  error: z.strictObject({ code: z.string().max(64), detailCode: z.string().max(128).nullable(), message: z.string().max(512) }).nullable(),
  createdAt: EpochMsSchema, updatedAt: EpochMsSchema,
});
export const AgentCapabilityViewSchema = z.strictObject({
  provider: z.enum(['codex', 'claude']), installed: z.boolean(), version: z.string().max(128).nullable(),
  authState: z.enum(['ready', 'missing', 'unknown']),
  capability: z.enum(['not_checked', 'checking', 'passed', 'blocked']), enabled: z.boolean(),
  reason: z.string().max(1024), checkedAt: EpochMsSchema.nullable(),
});
const Identity = z.strictObject({ targetId: IdSchema });
const RunIdentity = z.strictObject({ runId: IdSchema });
export const executionInputs = {
  'target.pickLocalMarkdown': EmptyInputSchema,
  'target.list': EmptyInputSchema,
  'target.inspect': Identity,
  'target.confirmExclusiveEditing': Identity.extend({ expectedRevision: RevisionSchema, confirmed: z.literal(true) }),
  'skill.list': EmptyInputSchema,
  'skill.get': z.strictObject({ skillId: IdSchema }),
  'skill.saveDraft': z.strictObject({ skillId: IdSchema.optional(), expectedRevision: RevisionSchema.optional(), draft: DocumentSkillDraftSchema, idempotencyKey: IdSchema }),
  'skill.publishVersion': z.strictObject({ skillId: IdSchema, expectedRevision: RevisionSchema,
    confirmations: z.strictObject({ target: z.literal(true), section: z.literal(true), rules: z.literal(true) }), idempotencyKey: IdSchema }),
  'source.list': z.strictObject({ limit: z.number().int().min(1).max(100).optional() }),
  'agent.getStatus': EmptyInputSchema,
  'agent.check': z.strictObject({ provider: z.literal('codex') }),
  'agent.testCapability': z.strictObject({ provider: z.literal('codex'), confirmed: z.literal(true) }),
  'run.list': EmptyInputSchema,
  'run.prepare': z.strictObject({ provider: z.literal('codex'), skillVersionId: IdSchema, targetId: IdSchema, sectionRef: OpaqueRefSchema,
    sourceRefs: z.array(IdSchema).min(1).max(2000), idempotencyKey: IdSchema }),
  'run.propose': z.strictObject({ preparedRunId: IdSchema, expectedInputHash: HashSchema, confirmed: z.literal(true), idempotencyKey: IdSchema }),
  'run.get': RunIdentity,
  'run.cancel': RunIdentity.extend({ expectedGeneration: GenerationSchema }),
  'run.apply': RunIdentity.extend({ expectedGeneration: GenerationSchema, proposalHash: HashSchema, expectedTargetHash: HashSchema,
    inputSnapshotHash: HashSchema, skillVersionId: IdSchema, sourceRefs: z.array(IdSchema).min(1).max(2000), approvalRef: IdSchema,
    confirmed: z.literal(true), idempotencyKey: IdSchema }),
  'run.exportPatch': RunIdentity.extend({ expectedGeneration: GenerationSchema, proposalHash: HashSchema, idempotencyKey: IdSchema }),
  'run.verify': RunIdentity,
} as const;
export const executionOutputs = {
  'target.pickLocalMarkdown': z.discriminatedUnion('selected', [z.strictObject({ selected: z.literal(false) }), z.strictObject({ selected: z.literal(true), target: DocumentTargetSchema })]),
  'target.list': z.array(DocumentTargetSchema).max(1000),
  'target.inspect': TargetInspectionSchema,
  'target.confirmExclusiveEditing': DocumentTargetSchema,
  'skill.list': z.array(DocumentSkillSchema).max(1000),
  'skill.get': DocumentSkillDetailSchema,
  'skill.saveDraft': DocumentSkillSchema,
  'skill.publishVersion': DocumentSkillVersionSchema,
  'source.list': z.array(ExecutionSourceSchema).max(100),
  'agent.getStatus': z.array(AgentCapabilityViewSchema).max(2),
  'agent.check': z.array(AgentCapabilityViewSchema).max(2),
  'agent.testCapability': z.array(AgentCapabilityViewSchema).max(2),
  'run.list': z.array(RunViewSchema).max(100),
  'run.prepare': z.strictObject({ preparedRunId: IdSchema, runId: IdSchema, generation: GenerationSchema, inputSnapshotHash: HashSchema,
    targetSnapshotHash: HashSchema, inputPreview: z.string().max(2_097_152), expiresAt: EpochMsSchema, state: z.literal('awaiting_input_confirmation') }),
  'run.propose': z.strictObject({ runId: IdSchema, generation: GenerationSchema, state: z.literal('generating') }),
  'run.get': RunViewSchema,
  'run.cancel': RunViewSchema,
  'run.verify': RunViewSchema,
  'run.apply': z.strictObject({ operationId: IdSchema, runId: IdSchema, state: z.literal('applying') }),
  'run.exportPatch': z.strictObject({ exported: z.boolean(), receiptId: IdSchema.optional() }),
} as const;
export type DocumentTarget = z.infer<typeof DocumentTargetSchema>;
export type DocumentSkillDraft = z.infer<typeof DocumentSkillDraftSchema>;
export type DocumentSkill = z.infer<typeof DocumentSkillSchema>;
export type DocumentSkillVersion = z.infer<typeof DocumentSkillVersionSchema>;
export type RunView = z.infer<typeof RunViewSchema>;
export type AgentCapabilityView = z.infer<typeof AgentCapabilityViewSchema>;
