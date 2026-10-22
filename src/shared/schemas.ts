import { z } from 'zod'
import { AppErrorSchema } from './errors'

export const IdSchema = z.uuid()
export const EpochMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const GenerationSchema = RevisionSchema
export const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const BundleIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
export const OpaqueRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
export const MachineIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
export const EmptyInputSchema = z.strictObject({})
export const PermissionKindSchema = z.enum(['screen', 'accessibility', 'inputMonitoring'])
export const PermissionStateSchema = z.enum(['unknown', 'not_determined', 'granted', 'denied', 'restricted', 'not_required'])
export const PermissionDetailSchema = z.strictObject({
  status: PermissionStateSchema,
  responsibleProcess: z.string().min(1).max(128),
  reason: z.string().max(256).nullable()
})
export const PermissionsSchema = z.strictObject({
  screen: PermissionDetailSchema,
  accessibility: PermissionDetailSchema,
  inputMonitoring: PermissionDetailSchema,
  checkedAt: EpochMsSchema
})
export const CaptureStatusSchema = z.strictObject({
  state: z.enum(['paused', 'blocked', 'running', 'stopped', 'error']),
  revision: RevisionSchema,
  generation: GenerationSchema,
  lastSuccessfulAt: EpochMsSchema.nullable(),
  reason: z.string().max(256).nullable()
})
export const CapabilitiesSchema = z.strictObject({
  nativeCapture: z.boolean(), accessibilityText: z.boolean(), visionOcr: z.boolean(),
  backgroundTextAnalysis: z.boolean(), discovery: z.boolean(), codex: z.boolean()
})
export const AppStatusSchema = z.strictObject({
  appVersion: z.string().min(1).max(64),
  schemaVersion: z.number().int().nonnegative(),
  dataRevision: RevisionSchema,
  capture: CaptureStatusSchema,
  storage: z.strictObject({ state: z.enum(['starting', 'ready', 'failed']), journalMode: z.literal('wal').nullable() }),
  capabilities: CapabilitiesSchema
})
export const TextConsentSchema = z.strictObject({
  enabled: z.boolean(), allowedBundleIds: z.array(BundleIdSchema).max(500),
  revision: RevisionSchema, generation: GenerationSchema
})
export const SettingsSchema = z.strictObject({
  revision: RevisionSchema,
  captureEnabled: z.boolean(),
  captureGeneration: GenerationSchema,
  allowedBundleIds: z.array(BundleIdSchema).max(500),
  excludedBundleIds: z.array(BundleIdSchema).max(500),
  textConsent: TextConsentSchema,
  screenshotRetentionDays: z.literal(30),
  timezone: z.literal('Asia/Shanghai'),
  defaultAgent: z.literal('codex')
})

export const BasisSchema = z.enum(['observed', 'inferred', 'confirmed'])
export const ActivityActionSchema = z.enum(['view', 'suspected_edit', 'context_switch', 'unknown'])
export const ActivityTypeSchema = z.enum(['direct_chat', 'group_chat', 'meeting', 'document', 'business', 'unknown'])
export const SummaryStatusSchema = z.enum(['not_authorized', 'not_configured', 'pending', 'ready', 'failed', 'insufficient'])
export const SourceStateSchema = z.enum(['valid', 'deleted', 'superseded', 'expired'])
export const SourceRevisionRefSchema = z.strictObject({
  sourceRefId: IdSchema, revision: RevisionSchema, state: SourceStateSchema
})
export const PeriodSchema = z.strictObject({
  id: IdSchema, startTs: EpochMsSchema, endTs: EpochMsSchema,
  appBundleId: BundleIdSchema, appName: z.string().min(1).max(256),
  windowTitle: z.string().max(4096).nullable(), activityType: ActivityTypeSchema,
  action: ActivityActionSchema.optional(),
  objectLabel: z.string().max(512).nullable(), topic: z.string().max(512).nullable(),
  summary: z.string().max(8192).nullable(), summaryStatus: SummaryStatusSchema,
  basis: BasisSchema, revision: RevisionSchema
}).refine((value) => value.endTs > value.startTs, { message: 'A period must have positive duration.' })
export const GapReasonSchema = z.enum([
  'paused', 'locked', 'sleep', 'permission', 'excluded', 'visibility_unknown',
  'queue_overflow', 'capture_error', 'process_interrupted'
])
export const GapSchema = z.strictObject({
  id: IdSchema, startTs: EpochMsSchema, endTs: EpochMsSchema, reason: GapReasonSchema, revision: RevisionSchema
}).refine((value) => value.endTs > value.startTs, { message: 'A gap must have positive duration.' })
export const CoverageSchema = z.strictObject({
  rangeStart: EpochMsSchema, rangeEnd: EpochMsSchema,
  recordedMs: EpochMsSchema, gapMs: EpochMsSchema
})
export const TimelinePageSchema = z.strictObject({
  periods: z.array(PeriodSchema).max(500), gaps: z.array(GapSchema).max(500),
  recordingRange: z.strictObject({ rangeStart: EpochMsSchema, rangeEnd: EpochMsSchema }).nullable().optional(),
  coverage: CoverageSchema, filteredDurationMs: EpochMsSchema,
  nextCursor: z.string().max(2048).nullable(), dataRevision: RevisionSchema
})
export const EvidenceStatusSchema = z.enum(['available', 'expired', 'deleted', 'missing', 'none'])
export const CursorEvidenceSchema = z.strictObject({
  evidenceId: IdSchema, status: EvidenceStatusSchema,
  observedAt: EpochMsSchema, displayUntil: EpochMsSchema,
  requestToken: IdSchema,
  url: z.string().max(2048).refine((value) => value.startsWith('one-room-evidence:')).nullable()
})
export const CursorLabelSchema = z.strictObject({
  appName: z.string().max(256).nullable(), activityType: ActivityTypeSchema,
  action: ActivityActionSchema.optional(),
  objectLabel: z.string().max(512).nullable(), topic: z.string().max(512).nullable(),
  text: z.string().max(2048)
})
export const CursorObservationSchema = z.strictObject({
  id: IdSchema, observedAt: EpochMsSchema, revision: RevisionSchema
})
export const CursorResultSchema = z.strictObject({
  cursorTs: EpochMsSchema, period: PeriodSchema.nullable(),
  observation: CursorObservationSchema.nullable(), evidence: CursorEvidenceSchema.nullable(),
  label: CursorLabelSchema, gap: GapSchema.nullable(), dataRevision: RevisionSchema
})
export const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const MonthKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
export const CalendarDaySchema = z.strictObject({
  dateKey: DateKeySchema, periods: z.array(PeriodSchema).max(500), gaps: z.array(GapSchema).max(500),
  recordedMs: EpochMsSchema,
  report: z.strictObject({ daily: z.enum(['absent', 'ready', 'invalidated']), weekly: z.enum(['absent', 'ready', 'invalidated']) })
})
export const CalendarPageSchema = z.strictObject({
  month: MonthKeySchema, timezone: z.literal('Asia/Shanghai'),
  days: z.array(CalendarDaySchema).max(31), nextCursor: z.string().max(2048).nullable(), dataRevision: RevisionSchema
})

const QueryFilters = {
  bundleIds: z.array(BundleIdSchema).max(500).optional(),
  query: z.string().trim().min(1).max(200).optional()
}
export const TimelineQuerySchema = z.strictObject({
  rangeStart: EpochMsSchema, rangeEnd: EpochMsSchema, ...QueryFilters,
  cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(500).optional()
}).refine((value) => value.rangeEnd > value.rangeStart && value.rangeEnd - value.rangeStart <= 31 * 86400000,
  { message: 'A query must cover at most 31 days.' })
export const ResolveCursorInputSchema = z.strictObject({
  cursorTs: EpochMsSchema, queryRevision: RevisionSchema, ...QueryFilters
})
export const CalendarQuerySchema = z.strictObject({
  month: MonthKeySchema, ...QueryFilters,
  cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(500).optional()
})
export const UpdateCaptureScopeSchema = z.strictObject({
  expectedRevision: RevisionSchema, allowedBundleIds: z.array(BundleIdSchema).max(500),
  excludedBundleIds: z.array(BundleIdSchema).max(500)
})
export const UpdateTextConsentSchema = z.strictObject({
  expectedRevision: RevisionSchema, enabled: z.boolean(),
  allowedBundleIds: z.array(BundleIdSchema).max(500), confirmed: z.boolean()
})
export const ExpectedRevisionSchema = z.strictObject({ expectedRevision: RevisionSchema })
export const OpenSettingsInputSchema = z.strictObject({ kind: PermissionKindSchema })
export const OpenSettingsResultSchema = z.strictObject({ opened: z.boolean(), kind: PermissionKindSchema })

export const ReportInputSchema = z.strictObject({ kind: z.enum(['daily', 'weekly']), dateKey: DateKeySchema })
export const GenerateReportInputSchema = ReportInputSchema.extend({ expectedDataRevision: RevisionSchema, idempotencyKey: IdSchema })
export const ReportSnapshotSchema = z.strictObject({
  id: IdSchema, kind: z.enum(['daily', 'weekly']), dateKey: DateKeySchema,
  rangeStart: EpochMsSchema, rangeEnd: EpochMsSchema, sourceRevision: RevisionSchema,
  generatedAt: EpochMsSchema, periods: z.array(PeriodSchema), gaps: z.array(GapSchema),
  recordedMs: EpochMsSchema, gapMs: EpochMsSchema, linkedTargetId: IdSchema.nullable()
})
export const ReportResultSchema = z.strictObject({
  status: z.enum(['absent', 'ready', 'invalidated']), report: ReportSnapshotSchema.nullable()
})
export const DeleteRangeSchema = z.strictObject({ rangeStart: EpochMsSchema, rangeEnd: EpochMsSchema,
  bundleIds: z.array(BundleIdSchema).max(500).optional()
}).refine(value => value.rangeEnd > value.rangeStart && value.rangeEnd - value.rangeStart <= 31 * 86400_000)
export const DeletePreviewSchema = z.strictObject({
  deletionRef: IdSchema, dataRevision: RevisionSchema, expiresAt: EpochMsSchema,
  observationCount: z.number().int().nonnegative(), periodCount: z.number().int().nonnegative(), reportCount: z.number().int().nonnegative()
})
export const DeleteInputSchema = z.strictObject({ deletionRef: IdSchema, expectedRevision: RevisionSchema,
  confirmed: z.literal(true), idempotencyKey: IdSchema })
export const DeleteResultSchema = z.strictObject({ cleanup: z.enum(['complete', 'pending']), dataRevision: RevisionSchema })
export type ReportSnapshot = z.infer<typeof ReportSnapshotSchema>
export type ReportResult = z.infer<typeof ReportResultSchema>

export const DomainEventTypeSchema = z.enum([
  'capture.status', 'permissions.changed', 'settings.changed', 'timeline.changed',
  'source.invalidated', 'evidence.expired', 'discovery.changed', 'worker.changed',
  'skill.changed', 'run.changed', 'report.changed', 'storage.failed'
])
export const DomainEventSchema = z.strictObject({
  streamId: IdSchema, sequence: RevisionSchema, type: DomainEventTypeSchema,
  entityId: z.string().min(1).max(128), revision: RevisionSchema,
  runId: IdSchema.optional(), generation: GenerationSchema.optional()
})
export const RequestSchema = <T extends z.ZodType>(payload: T) => z.strictObject({ requestId: IdSchema, payload })
export const ReplySchema = <T extends z.ZodType>(data: T) => z.discriminatedUnion('ok', [
  z.strictObject({ requestId: IdSchema, ok: z.literal(true), data, dataRevision: RevisionSchema }),
  z.strictObject({ requestId: IdSchema, ok: z.literal(false), error: AppErrorSchema })
])

// These are serialization boundaries for later modules, not implemented services.
export const WorkInstanceSchema = z.strictObject({
  id: IdSchema, kind: z.enum(['daily', 'weekly', 'document', 'coupon_strategy', 'other']),
  observedObjectKey: OpaqueRefSchema.nullable(), goalKey: OpaqueRefSchema.nullable(), targetId: IdSchema.nullable(),
  status: z.enum(['active', 'suspended', 'completed']),
  confirmationStatus: z.enum(['pending', 'confirmed', 'rejected']),
  identityBasis: BasisSchema, completionBasis: BasisSchema.nullable(),
  firstSeenAt: EpochMsSchema, lastSeenAt: EpochMsSchema, revision: RevisionSchema
})
export const WorkerCursorSchema = z.strictObject({ sequence: SequenceSchema })
export const WorkerRuleSchema = z.strictObject({
  ruleId: MachineIdSchema, configurationRevision: RevisionSchema,
  analysisPolicy: z.enum(['local_only', 'authorized_text']),
  outputKinds: z.array(MachineIdSchema).min(1).max(50)
})
export const CommittedInputRefSchema = z.strictObject({
  type: z.enum(['activity.committed', 'instance.revised']),
  entityId: IdSchema, revision: RevisionSchema, commitSequence: RevisionSchema
})
export const FindingDraftSchema = z.strictObject({
  kind: MachineIdSchema, ruleId: MachineIdSchema, findingKey: OpaqueRefSchema, subjectKey: OpaqueRefSchema,
  targetId: IdSchema.optional(), sourceEventRefs: z.array(IdSchema).min(1).max(2000),
  instanceRefs: z.array(IdSchema).max(1000), basis: BasisSchema,
  reason: z.string().min(1).max(4096), pendingConfirmations: z.array(z.string().max(512)).max(50),
  actions: z.array(z.enum(['review', 'review_skill', 'dismiss', 'snooze'])).min(1).max(4)
})
export const DetectionInputSchema = z.strictObject({
  evaluationId: IdSchema, workerId: MachineIdSchema, workerVersion: RevisionSchema,
  ruleId: MachineIdSchema, ruleConfigurationRevision: RevisionSchema, generation: GenerationSchema,
  inputs: z.array(CommittedInputRefSchema).max(1000), cursor: WorkerCursorSchema,
  stateRevision: RevisionSchema, state: z.json(), sourceSnapshot: z.array(SourceRevisionRefSchema).max(2000),
  consentRevision: RevisionSchema, associationRevision: RevisionSchema
})
export const DetectionResultSchema = z.strictObject({
  nextCursor: WorkerCursorSchema, nextState: z.json(), findings: z.array(FindingDraftSchema).max(100)
})
export const RunStateSchema = z.enum([
  'preparing', 'awaiting_input_confirmation', 'generating', 'awaiting_review', 'applying', 'verifying',
  'succeeded', 'no_change', 'failed', 'canceled', 'conflict', 'interrupted', 'capability_blocked', 'expired', 'source_invalidated'
])
export const ProposalSchema = z.strictObject({
  runId: IdSchema, generation: GenerationSchema, skillVersionId: IdSchema,
  inputSnapshotHash: HashSchema, targetSnapshotHash: HashSchema, sectionRef: OpaqueRefSchema,
  sourceRefs: z.array(IdSchema).min(1).max(2000), replacementMarkdown: z.string().min(1).max(2097152)
}).refine((value) => new Set(value.sourceRefs).size === value.sourceRefs.length, { message: 'Duplicate sources.' })
export const RunPrepareInputSchema = z.strictObject({
  provider: z.literal('codex'), skillVersionId: IdSchema, targetId: IdSchema, sectionRef: OpaqueRefSchema,
  sourceRefs: z.array(IdSchema).min(1).max(2000), idempotencyKey: IdSchema
})
export const RunProposeInputSchema = z.strictObject({
  preparedRunId: IdSchema, expectedInputHash: HashSchema, confirmed: z.literal(true), idempotencyKey: IdSchema
})
export const RunCancelInputSchema = z.strictObject({ runId: IdSchema, expectedGeneration: GenerationSchema })
export const RunApplyInputSchema = z.strictObject({
  runId: IdSchema, expectedGeneration: GenerationSchema, proposalHash: HashSchema,
  expectedTargetHash: HashSchema, inputSnapshotHash: HashSchema, skillVersionId: IdSchema,
  sourceRefs: z.array(IdSchema).min(1).max(2000), approvalRef: IdSchema,
  confirmed: z.literal(true), idempotencyKey: IdSchema
})

export type AppStatus = z.infer<typeof AppStatusSchema>
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>
export type Settings = z.infer<typeof SettingsSchema>
export type Permissions = z.infer<typeof PermissionsSchema>
export type PermissionKind = z.infer<typeof PermissionKindSchema>
export type Period = z.infer<typeof PeriodSchema>
export type Gap = z.infer<typeof GapSchema>
export type TimelinePage = z.infer<typeof TimelinePageSchema>
export type CursorResult = z.infer<typeof CursorResultSchema>
export type CalendarPage = z.infer<typeof CalendarPageSchema>
export type DomainEvent = z.infer<typeof DomainEventSchema>
export type SourceRevisionRef = z.infer<typeof SourceRevisionRefSchema>
export type WorkInstance = z.infer<typeof WorkInstanceSchema>
export type DetectionInput = z.infer<typeof DetectionInputSchema>
export type DetectionResult = z.infer<typeof DetectionResultSchema>
export type FindingDraft = z.infer<typeof FindingDraftSchema>
export type WorkerRule = z.infer<typeof WorkerRuleSchema>
export type RunState = z.infer<typeof RunStateSchema>
export type Proposal = z.infer<typeof ProposalSchema>

export const CaptureTriggerSchema = z.enum([
  'app_switch', 'window_focus', 'window_title', 'content_changed', 'click',
  'typing_pause', 'scroll_stop', 'checkpoint', 'visual_checkpoint', 'degraded_checkpoint', 'manual'
])
export const NativeMethodSchema = z.enum([
  'hello', 'status', 'permissions.request', 'frontmost', 'capture.preflight', 'observe', 'capture', 'extract', 'ocr', 'cancel', 'shutdown'
])
const NativeIdentity = {
  protocolVersion: z.literal(1), helperSessionId: IdSchema, requestId: IdSchema,
  generation: GenerationSchema, observationId: IdSchema.nullable(),
  pid: z.number().int().positive().nullable(), windowId: z.number().int().positive().nullable()
}
const NativeCommandBase = {
  ...NativeIdentity, kind: z.literal('command'), issuedAt: EpochMsSchema, deadlineAt: EpochMsSchema
}
const nativeCommand = <M extends string, P extends z.ZodType>(method: M, payload: P) =>
  z.strictObject({ ...NativeCommandBase, method: z.literal(method), payload })
export const NativeCommandSchema = z.discriminatedUnion('method', [
  nativeCommand('hello', z.strictObject({ role: z.enum(['executor', 'listener']), stagingRoot: z.string().max(4096).optional() })),
  nativeCommand('status', EmptyInputSchema), nativeCommand('frontmost', EmptyInputSchema),
  nativeCommand('permissions.request', z.strictObject({ kind: PermissionKindSchema })),
  nativeCommand('capture.preflight', EmptyInputSchema), nativeCommand('shutdown', EmptyInputSchema),
  nativeCommand('observe', z.strictObject({
    policyRevision: RevisionSchema, triggers: z.array(CaptureTriggerSchema).max(20),
    heartbeatMs: z.number().int().min(100).max(60000),
    allowedBundleIds: z.array(BundleIdSchema).max(500), excludedBundleIds: z.array(BundleIdSchema).max(500)
  })),
  nativeCommand('capture', z.strictObject({
    policyRevision: RevisionSchema, contextRevision: RevisionSchema, trigger: CaptureTriggerSchema,
    outputToken: IdSchema
  })),
  nativeCommand('extract', z.strictObject({ contextRevision: RevisionSchema, policyRevision: RevisionSchema })),
  nativeCommand('ocr', z.strictObject({ inputToken: IdSchema, languages: z.array(z.string().max(32)).max(10) })),
  nativeCommand('cancel', z.strictObject({ targetRequestId: IdSchema }))
]).refine((value) => value.deadlineAt >= value.issuedAt, { message: 'Invalid native deadline.' })
  .refine((value) => !['capture', 'extract', 'ocr', 'capture.preflight'].includes(value.method) ||
    (value.pid !== null && value.windowId !== null && (value.method === 'capture.preflight' || value.observationId !== null)),
  { message: 'An observation command requires a window identity.' })

export const NativeCapabilitySchema = z.strictObject({
  supported: z.boolean(), permission: PermissionStateSchema,
  state: z.enum(['not_implemented', 'ready', 'permission_required', 'unavailable']),
  reason: z.string().max(256).nullable()
})
const NativePermissionStatesSchema = z.strictObject({
  screen: PermissionStateSchema, accessibility: PermissionStateSchema, inputMonitoring: PermissionStateSchema
})
export const NativeHelloPayloadSchema = z.strictObject({
  helperVersion: z.string().min(1).max(64), minimumMacOS: z.string().max(32), architecture: z.literal('arm64'),
  role: z.enum(['executor', 'listener']).optional(), permissions: NativePermissionStatesSchema,
  permissionReasons: z.strictObject({
    screen: z.string().max(256).nullable(), accessibility: z.string().max(256).nullable(), inputMonitoring: z.string().max(256).nullable()
  }),
  capabilities: z.strictObject({
    windowEvents: NativeCapabilitySchema, windowCapture: NativeCapabilitySchema,
    accessibilityText: NativeCapabilitySchema, visionOcr: NativeCapabilitySchema, inputTiming: NativeCapabilitySchema
  }),
  foundationMethods: z.array(NativeMethodSchema).max(11), captureStarted: z.boolean()
})
export const NativeWindowContextSchema = z.strictObject({
  pid: z.number().int().positive(), bundleId: BundleIdSchema.nullable(), appName: z.string().max(256).nullable(),
  frontmost: z.boolean(), windowId: z.number().int().positive().nullable(),
  visibility: z.enum(['unverified', 'preflight_candidate', 'verified']), observedAt: EpochMsSchema,
  windowTitle: z.string().max(4096).nullable().optional(),
  reason: z.string().max(256).optional(),
  bounds: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional(),
  minimized: z.boolean().optional(), onScreen: z.boolean().optional(), captureImplemented: z.boolean().optional()
})
export const NativeCapturePayloadSchema = z.strictObject({
  outputToken: IdSchema, sha256: HashSchema, mime: z.literal('image/png'), width: z.number().int().positive(),
  height: z.number().int().positive(), byteSize: z.number().int().positive().max(33554432), observedAt: EpochMsSchema,
  contextBefore: NativeWindowContextSchema, contextAfter: NativeWindowContextSchema, visibilityStatus: z.literal('verified')
})
export const NativeTextPayloadSchema = z.strictObject({
  source: z.literal('accessibility'), status: z.enum(['ready', 'partial', 'empty']),
  completeness: z.enum(['complete', 'thin', 'partial', 'empty']), text: z.string().max(100000),
  fallbackReason: z.string().max(256).nullable(), observedAt: EpochMsSchema,
  contextBefore: NativeWindowContextSchema, contextAfter: NativeWindowContextSchema, nodeCount: z.number().int().nonnegative()
})
export const NativeOcrPayloadSchema = z.strictObject({
  source: z.literal('ocr'), status: z.enum(['ready', 'partial', 'empty']),
  completeness: z.enum(['complete', 'partial', 'empty']), text: z.string().max(100000),
  fallbackReason: z.string().max(256).nullable(), observedAt: EpochMsSchema,
  languages: z.array(z.string().max(32)).max(10), inputToken: IdSchema
})
const NativeObservePayloadSchema = z.strictObject({ observing: z.literal(true), contextRevision: RevisionSchema, heartbeatMs: z.number().int().positive() })
export const NativePermissionRequestPayloadSchema = z.strictObject({ kind: PermissionKindSchema, requested: z.literal(true), granted: z.boolean() })
export const NativeFailureSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/), stage: z.string().min(1).max(128), retryable: z.boolean(),
  requestId: IdSchema.nullable(), generation: GenerationSchema.nullable()
})
export const NativeResultSchema = z.strictObject({
  protocolVersion: z.literal(1), helperSessionId: IdSchema.nullable(), kind: z.literal('result'),
  method: z.union([NativeMethodSchema, z.literal('invalid')]), requestId: IdSchema.nullable(),
  generation: GenerationSchema.nullable(), observationId: IdSchema.nullable(),
  pid: z.number().int().positive().nullable(), windowId: z.number().int().positive().nullable(),
  startedAt: EpochMsSchema, finishedAt: EpochMsSchema,
  status: z.enum(['accepted', 'ok', 'partial', 'failed', 'canceled', 'timeout', 'discarded']),
  payload: z.union([NativeHelloPayloadSchema, NativePermissionRequestPayloadSchema, NativeWindowContextSchema, NativeCapturePayloadSchema, NativeTextPayloadSchema, NativeOcrPayloadSchema, NativeObservePayloadSchema, z.strictObject({ canceled: z.literal(true), targetRequestId: IdSchema }), z.strictObject({ shutdown: z.literal(true) }), EmptyInputSchema]),
  error: NativeFailureSchema.optional()
}).refine((value) => {
  if (value.status === 'ok' || value.status === 'partial' || value.status === 'accepted') {
    return value.helperSessionId !== null && value.requestId !== null && value.generation !== null && !value.error
  }
  return value.error !== undefined
}, { message: 'Native status and identity do not agree.' }).superRefine((value, context) => {
  if (value.status !== 'ok' && value.status !== 'partial') return
  const schema = value.method === 'hello' || value.method === 'status' ? NativeHelloPayloadSchema :
    value.method === 'permissions.request' ? NativePermissionRequestPayloadSchema :
    value.method === 'frontmost' || value.method === 'capture.preflight' ? NativeWindowContextSchema :
      value.method === 'capture' ? NativeCapturePayloadSchema : value.method === 'extract' ? NativeTextPayloadSchema :
        value.method === 'ocr' ? NativeOcrPayloadSchema : value.method === 'observe' ? NativeObservePayloadSchema :
          value.method === 'cancel' ? z.strictObject({ canceled: z.literal(true), targetRequestId: IdSchema }) :
            value.method === 'shutdown' ? z.strictObject({ shutdown: z.literal(true) }) : undefined
  if (!schema || !schema.safeParse(value.payload).success) context.addIssue({
    code: 'custom', path: ['payload'], message: 'This native method has no implemented successful result schema.'
  })
})
const NativeEventBase = {
  ...NativeIdentity, kind: z.literal('event'), observedAt: EpochMsSchema,
  sequence: RevisionSchema, state: z.enum(['ready', 'degraded', 'blocked'])
}
export const InputTimingPayloadSchema = z.strictObject({
  trigger: z.enum(['click', 'typing_pause', 'scroll_stop']), contextRevision: RevisionSchema.nullable(),
  activityStartedAt: EpochMsSchema, activityEndedAt: EpochMsSchema, quietDurationMs: EpochMsSchema
}).refine((value) => value.activityEndedAt >= value.activityStartedAt &&
  (value.trigger !== 'click' || (value.activityStartedAt === value.activityEndedAt && value.quietDurationMs === 0)),
{ message: 'Invalid input timing.' })
export const NativeEventSchema = z.discriminatedUnion('method', [
  z.strictObject({ ...NativeEventBase, method: z.literal('input.timing'), payload: InputTimingPayloadSchema }),
  z.strictObject({ ...NativeEventBase, method: z.literal('window.changed'), payload: z.strictObject({
    trigger: z.enum(['app_switch', 'window_focus', 'window_title', 'content_changed']), contextRevision: RevisionSchema.nullable()
  }) }),
  z.strictObject({ ...NativeEventBase, method: z.literal('heartbeat'), payload: z.strictObject({
    contextRevision: RevisionSchema, screenLocked: z.boolean(), sleeping: z.boolean()
  }) }),
  z.strictObject({ ...NativeEventBase, method: z.literal('system.state'), payload: z.strictObject({
    reason: z.enum(['locked', 'unlocked', 'sleep', 'wake'])
  }) })
])
export const NativeMessageSchema = z.union([NativeCommandSchema, NativeResultSchema, NativeEventSchema])
export type NativeCommand = z.infer<typeof NativeCommandSchema>
export type NativeResult = z.infer<typeof NativeResultSchema>
export type NativeEvent = z.infer<typeof NativeEventSchema>
export type NativeHelloPayload = z.infer<typeof NativeHelloPayloadSchema>
