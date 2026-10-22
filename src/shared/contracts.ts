import { z } from 'zod'
import { reuseInputs, reuseOutputs } from '../services/reuse/contracts'
import type { ReuseAPI } from '../services/reuse/types'
import { executionInputs, executionOutputs } from './execution-schemas'
import type { AppError } from './errors'
import { ActivityPageSchema, ActivityQuerySchema, ActivityReviewSchema } from './activity-schemas'
import { ModelConnectionResultSchema, ModelRevisionInputSchema, ModelSettingsSchema, SaveModelSettingsSchema } from './model-schemas'
import {
  AppStatusSchema, CalendarPageSchema, CalendarQuerySchema, CaptureStatusSchema, CursorResultSchema,
  EmptyInputSchema, ExpectedRevisionSchema, OpenSettingsInputSchema, OpenSettingsResultSchema,
  PermissionsSchema, ResolveCursorInputSchema, SettingsSchema, TimelinePageSchema, TimelineQuerySchema,
  UpdateCaptureScopeSchema, UpdateTextConsentSchema, type DomainEvent,
  ReportInputSchema, GenerateReportInputSchema, ReportResultSchema,
  DeleteRangeSchema, DeletePreviewSchema, DeleteInputSchema, DeleteResultSchema
} from './schemas'

export const RPC_CHANNEL = 'one-room:invoke'
export const EVENT_CHANNEL = 'one-room:event'
export type TimelineGesture = { kind: 'swipe'; direction: 'left' | 'right' | 'up' | 'down' }

export const inputSchemas = {
  ...executionInputs,
  ...reuseInputs,
  'app.getStatus': EmptyInputSchema,
  'permissions.get': EmptyInputSchema,
  'permissions.openSettings': OpenSettingsInputSchema,
  'capture.pause': ExpectedRevisionSchema,
  'capture.resume': ExpectedRevisionSchema,
  'settings.get': EmptyInputSchema,
  'settings.updateCaptureScope': UpdateCaptureScopeSchema,
  'settings.updateTextConsent': UpdateTextConsentSchema,
  'model.getConfig': EmptyInputSchema,
  'model.saveConfig': SaveModelSettingsSchema,
  'model.testConnection': ModelRevisionInputSchema,
  'model.clearCredential': ModelRevisionInputSchema,
  'activity.query': ActivityQuerySchema,
  'activity.review': ActivityReviewSchema,
  'timeline.query': TimelineQuerySchema,
  'timeline.resolveCursor': ResolveCursorInputSchema,
  'calendar.query': CalendarQuerySchema,
  'report.get': ReportInputSchema,
  'report.generate': GenerateReportInputSchema,
  'history.previewDelete': DeleteRangeSchema,
  'history.delete': DeleteInputSchema
} as const

export const outputSchemas = {
  ...executionOutputs,
  ...reuseOutputs,
  'app.getStatus': AppStatusSchema,
  'permissions.get': PermissionsSchema,
  'permissions.openSettings': OpenSettingsResultSchema,
  'capture.pause': CaptureStatusSchema,
  'capture.resume': CaptureStatusSchema,
  'settings.get': SettingsSchema,
  'settings.updateCaptureScope': SettingsSchema,
  'settings.updateTextConsent': SettingsSchema,
  'model.getConfig': ModelSettingsSchema,
  'model.saveConfig': ModelSettingsSchema,
  'model.testConnection': ModelConnectionResultSchema,
  'model.clearCredential': ModelSettingsSchema,
  'activity.query': ActivityPageSchema,
  'activity.review': z.strictObject({ revised: z.literal(true) }),
  'timeline.query': TimelinePageSchema,
  'timeline.resolveCursor': CursorResultSchema,
  'calendar.query': CalendarPageSchema,
  'report.get': ReportResultSchema,
  'report.generate': ReportResultSchema,
  'history.previewDelete': DeletePreviewSchema,
  'history.delete': DeleteResultSchema
} as const

export type DomainMethod = keyof typeof inputSchemas
export type DomainMethods = {
  [M in DomainMethod]: {
    input: z.infer<(typeof inputSchemas)[M]>
    output: z.infer<(typeof outputSchemas)[M]>
  }
}
export type MethodInput<M extends DomainMethod> = DomainMethods[M]['input']
export type MethodOutput<M extends DomainMethod> = DomainMethods[M]['output']
export type Request<T> = { requestId: string; payload: T }
export type Reply<T> =
  | { requestId: string; ok: true; data: T; dataRevision: number }
  | { requestId: string; ok: false; error: AppError }
export type RpcMethod<M extends DomainMethod> = (input: MethodInput<M>) => Promise<Reply<MethodOutput<M>>>
export type DomainInvoker = <M extends DomainMethod>(method: M, request: Request<MethodInput<M>>) => Promise<Reply<MethodOutput<M>>>

export interface OneRoomApi {
  target?: { pickLocalMarkdown: RpcMethod<'target.pickLocalMarkdown'>; list: RpcMethod<'target.list'>; inspect: RpcMethod<'target.inspect'>; confirmExclusiveEditing: RpcMethod<'target.confirmExclusiveEditing'> }
  skill?: { list: RpcMethod<'skill.list'>; get: RpcMethod<'skill.get'>; saveDraft: RpcMethod<'skill.saveDraft'>; publishVersion: RpcMethod<'skill.publishVersion'> }
  source?: { list: RpcMethod<'source.list'> }
  agent?: { getStatus: RpcMethod<'agent.getStatus'>; check: RpcMethod<'agent.check'>; testCapability: RpcMethod<'agent.testCapability'> }
  run?: { list: RpcMethod<'run.list'>; prepare: RpcMethod<'run.prepare'>; propose: RpcMethod<'run.propose'>; get: RpcMethod<'run.get'>; cancel: RpcMethod<'run.cancel'>; apply: RpcMethod<'run.apply'>; exportPatch: RpcMethod<'run.exportPatch'>; verify: RpcMethod<'run.verify'> }
  reuse?: ReuseAPI
  app: { getStatus: RpcMethod<'app.getStatus'> }
  permissions: { get: RpcMethod<'permissions.get'>; openSettings: RpcMethod<'permissions.openSettings'> }
  capture: { pause: RpcMethod<'capture.pause'>; resume: RpcMethod<'capture.resume'> }
  settings: {
    get: RpcMethod<'settings.get'>
    updateCaptureScope: RpcMethod<'settings.updateCaptureScope'>
    updateTextConsent: RpcMethod<'settings.updateTextConsent'>
  }
  model: {
    getConfig: RpcMethod<'model.getConfig'>; saveConfig: RpcMethod<'model.saveConfig'>
    testConnection: RpcMethod<'model.testConnection'>; clearCredential: RpcMethod<'model.clearCredential'>
  }
  activity: { query: RpcMethod<'activity.query'>; review: RpcMethod<'activity.review'> }
  timeline: { query: RpcMethod<'timeline.query'>; resolveCursor: RpcMethod<'timeline.resolveCursor'> }
  calendar: { query: RpcMethod<'calendar.query'> }
  // A exposes these after worker commands and main registrations are connected.
  report?: { get: RpcMethod<'report.get'>; generate: RpcMethod<'report.generate'> }
  history?: { previewDelete: RpcMethod<'history.previewDelete'>; delete: RpcMethod<'history.delete'> }
  gestures?: { subscribe: (listener: (event: TimelineGesture) => void) => () => void }
  events: { subscribe: (listener: (event: DomainEvent) => void) => () => void }
}

export interface DetectionBudget {
  deadlineAt: number
  maxQueries: number
  maxInputBytes: number
  maxOutputBytes: number
}

export interface WorkerRegistration {
  workerId: string
  version: number
  definitionHash: string
  inputs: readonly ('activity.committed' | 'instance.revised')[]
  rules: readonly import('./schemas').WorkerRule[]
  evaluate(input: import('./schemas').DetectionInput, context: DetectionContext): Promise<import('./schemas').DetectionResult>
}

export interface DetectionContext {
  readonly signal: AbortSignal
  readonly budget: DetectionBudget
  readInstances(ids: readonly string[]): Promise<readonly import('./schemas').WorkInstance[]>
  readPeriods(ids: readonly string[]): Promise<readonly import('./schemas').Period[]>
  analyzeText(input: { sourceRefs: readonly string[]; purpose: string }): Promise<{ text: string; sourceRefs: readonly import('./schemas').SourceRevisionRef[] }>
}
