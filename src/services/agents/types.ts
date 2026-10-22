import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DomainError } from '../../shared/errors'

export const CODEX_VERSION = '0.144.1'
export const MAX_AGENT_INPUT_BYTES = 2 * 1024 * 1024
export const MAX_AGENT_LINE_BYTES = 4 * 1024 * 1024
export const MAX_AGENT_STDOUT_BYTES = 16 * 1024 * 1024
export const MAX_AGENT_STDERR_BYTES = 1024 * 1024
export const AGENT_TIMEOUT_MS = 120_000
export const AGENT_KILL_GRACE_MS = 2_000

const uuid = z.string().uuid().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const bindingShape = {
  runId: uuid,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  skillVersionId: uuid,
  inputSnapshotHash: hash,
  targetSnapshotHash: hash,
  sectionRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
  sourceRefs: z.array(z.string().min(1).max(128)).min(1).max(2000),
}

export const ProposalBindingSchema = z.strictObject(bindingShape)
export const ProposalSchema = z.strictObject({
  ...bindingShape,
  replacementMarkdown: z.string().min(1).max(MAX_AGENT_INPUT_BYTES),
})
export type ProposalBinding = z.infer<typeof ProposalBindingSchema>
export type Proposal = z.infer<typeof ProposalSchema>
export interface ValidatedProposal {
  proposal: Proposal
  canonicalBytes: Buffer
  proposalHash: string
}

export interface AgentCapabilityStatus {
  id: 'codex' | 'claude'
  installed: boolean
  authenticated: boolean
  authState: 'ready' | 'missing' | 'unknown'
  enabled: boolean
  version: string | null
  capabilityState: 'unverified' | 'ready' | 'capability_blocked' | 'disabled'
  detail: string
  detailCode?: string
}

export interface CapabilityRecord {
  provider: 'codex'
  state: 'ready' | 'capability_blocked'
  fingerprint: string
  version: string | null
  checkedAt: number
  detailCode?: string
  checks: {
    supportedVersion: boolean
    supportedArguments: boolean
    authentication: boolean
    isolatedStartup: boolean
    readOnly: boolean
    proposalSchema: boolean
    cancellation: boolean
    timeout: boolean
  }
}

// Only a trusted host can attest OS/configuration isolation. Absence of JSONL tool
// events alone does not establish that a plugin or MCP process never started.
export interface IsolationEvidence {
  manifestVersion: 1
  configurationHash: string
  readOnlyEnforced: boolean
  externalToolStartupPrevented: boolean
  processTreeObserved: boolean
}
export interface IsolationRequest {
  binaryPath: string
  version: string
  platform: NodeJS.Platform
  arch: string
  argv: readonly string[]
  environment: Readonly<NodeJS.ProcessEnv>
  runDir: string
}
export type IsolationVerifier = (request: IsolationRequest) => Promise<IsolationEvidence | null>

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function validateProposal(value: unknown, frozen: ProposalBinding): ValidatedProposal {
  const parsed = ProposalSchema.safeParse(value)
  const binding = ProposalBindingSchema.safeParse(frozen)
  if (!parsed.success || !binding.success) throw invalidOutput()
  const proposal = parsed.data
  for (const key of ['runId', 'generation', 'skillVersionId', 'inputSnapshotHash', 'targetSnapshotHash', 'sectionRef'] as const) {
    if (proposal[key] !== binding.data[key]) throw invalidOutput()
  }
  const actual = [...proposal.sourceRefs].sort()
  const expected = [...binding.data.sourceRefs].sort()
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw invalidOutput()
  if (Buffer.byteLength(proposal.replacementMarkdown, 'utf8') > MAX_AGENT_INPUT_BYTES) throw invalidOutput()
  const canonicalBytes = Buffer.from(JSON.stringify({
    runId: proposal.runId,
    generation: proposal.generation,
    skillVersionId: proposal.skillVersionId,
    inputSnapshotHash: proposal.inputSnapshotHash,
    targetSnapshotHash: proposal.targetSnapshotHash,
    sectionRef: proposal.sectionRef,
    sourceRefs: actual,
    replacementMarkdown: proposal.replacementMarkdown,
  }), 'utf8')
  if (canonicalBytes.byteLength > MAX_AGENT_INPUT_BYTES) throw invalidOutput()
  return { proposal: { ...proposal, sourceRefs: actual }, canonicalBytes, proposalHash: sha256(canonicalBytes) }
}

export function invalidOutput(): DomainError {
  return new DomainError('INTERNAL', 'Codex 返回的结果不符合审核协议。', 'INVALID_AGENT_OUTPUT')
}
