import { z } from 'zod'
const text = z.string().trim().min(1).max(20000)
const status = z.enum(['new', 'accepted', 'ignored', 'later'])
const parameters = z
  .record(z.string().min(1).max(200), z.string().max(10000))
  .refine((value) => Object.keys(value).length <= 100)
const workflow = z.object({
  engine: z.literal('openadapt'),
  recordingId: z.string().uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  parameters,
  verification: z
    .object({
      url: text,
      checks: z
        .array(z.object({ pointer: text, parameter: text }))
        .min(1)
        .max(100),
    })
    .optional(),
})
const recordingInput = z.object({
  title: text,
  url: text,
  parameterFields: z.array(z.string().min(1).max(200)).max(100),
  secretFields: z.array(z.string().min(1).max(200)).max(100),
})
const recording = recordingInput.extend({
  id: z.string().uuid(),
  createdAt: z.number(),
  state: z.enum(['starting', 'browser_ready', 'recording', 'compiling', 'ready', 'failed']),
  digest: z.string(),
  parameters,
  steps: z.number().int().nonnegative(),
  error: z.string(),
})
const occurrence = z.object({
  id: text,
  object: text,
  start: z.number(),
  end: z.number(),
  evidence: z.array(z.string()),
})
const pattern = z.object({
  key: text,
  title: text,
  kind: z.enum(['document', 'strategy', 'workflow']),
  target: z.string(),
  instances: z.number().int().min(2),
  evidence: z.array(z.string()),
  steps: z.array(z.string()),
  variables: z.array(z.string()),
  source: z.enum(['cluster', 'sequence']),
  occurrences: z.array(occurrence),
})
const candidate = z.object({
  id: z.string().uuid(),
  target: z.string(),
  title: text,
  kind: z.enum(['document', 'strategy', 'workflow']),
  instances: z.number().int().min(2),
  status,
  evidence: z.array(z.string()),
  pattern: pattern.optional(),
})
const skill = z.object({
  id: z.string().uuid().optional(),
  title: text,
  purpose: text,
  target: text,
  scope: text,
  format: text,
  variables: text,
  sources: text,
  dedup: text,
  success: text,
  candidateId: z.string().uuid().optional(),
  workflow: workflow.optional(),
})
const published = skill.extend({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.number(),
})
const run = z.object({
  id: z.string().uuid(),
  skillId: z.string().uuid(),
  version: z.number().int().positive(),
  target: text,
  state: z.enum([
    'queued',
    'reading',
    'generating',
    'applying',
    'verifying',
    'succeeded',
    'no_change',
    'failed',
    'canceled',
    'conflict',
    'needs_verification',
    'reviewed',
  ]),
  createdAt: z.number(),
  updatedAt: z.number(),
  log: z.string(),
  receipt: z.string(),
  error: z.string(),
})
const agent = z.object({
  id: z.enum(['codex', 'claude', 'openadapt']),
  installed: z.boolean(),
  authenticated: z.boolean(),
  enabled: z.boolean(),
  detail: z.string(),
})
const rule = z.object({
  title: text,
  steps: text,
  variables: text,
  prerequisites: text,
  approvals: text,
  candidateId: z.string().uuid().optional(),
})
export const reuseInputs = {
  'reuse.recordings': z.object({}),
  'reuse.recordWorkflow': recordingInput,
  'reuse.beginRecording': z.object({ id: z.string().uuid() }),
  'reuse.stopRecording': z.object({ id: z.string().uuid() }),
  'reuse.candidates': z.object({}),
  'reuse.candidateStatus': z.object({ id: z.string().uuid(), status }),
  'reuse.skills': z.object({}),
  'reuse.saveSkill': skill,
  'reuse.agents': z.object({}),
  'reuse.run': z.object({
    skillId: z.string().uuid(),
    version: z.number().int().positive(),
    parameters: parameters.optional(),
  }),
  'reuse.runs': z.object({}),
  'reuse.cancel': z.object({ id: z.string().uuid() }),
  'reuse.verify': z.object({ id: z.string().uuid() }),
  'reuse.acknowledgeRun': z.object({ id: z.string().uuid() }),
  'reuse.rules': z.object({}),
  'reuse.saveRule': rule,
} as const
export const reuseOutputs = {
  'reuse.recordings': z.array(recording),
  'reuse.recordWorkflow': recording,
  'reuse.beginRecording': z.null(),
  'reuse.stopRecording': z.null(),
  'reuse.candidates': z.array(candidate),
  'reuse.candidateStatus': z.null(),
  'reuse.skills': z.array(published),
  'reuse.saveSkill': published,
  'reuse.agents': z.array(agent),
  'reuse.run': run,
  'reuse.runs': z.array(run),
  'reuse.cancel': z.null(),
  'reuse.verify': run,
  'reuse.acknowledgeRun': z.null(),
  'reuse.rules': z.array(rule.extend({ id: z.string().uuid(), createdAt: z.number() })),
  'reuse.saveRule': rule.extend({ id: z.string().uuid(), createdAt: z.number() }),
} as const
