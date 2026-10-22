import type { WorkflowAPI, WorkflowBinding } from './workflow-types'
export interface WorkflowInstance {
  id: string
  kind: 'document' | 'strategy' | 'workflow'
  object: string
  target: string
  start: number
  end: number
  steps: string[]
  apps: string[]
  evidence: string[]
  editing: boolean
  clusterId?: string
  recipe?: { title: string; steps: string[]; variables: string[] }
}
export interface WorkflowPattern {
  key: string
  title: string
  kind: WorkflowInstance['kind']
  target: string
  instances: number
  evidence: string[]
  steps: string[]
  variables: string[]
  source: 'cluster' | 'sequence'
  occurrences: { id: string; object: string; start: number; end: number; evidence: string[] }[]
}
export interface Candidate {
  id: string
  target: string
  title: string
  kind: WorkflowInstance['kind']
  instances: number
  status: 'new' | 'accepted' | 'ignored' | 'later'
  evidence: string[]
  pattern?: WorkflowPattern
}
export interface SkillInput {
  id?: string
  title: string
  purpose: string
  target: string
  scope: string
  format: string
  variables: string
  sources: string
  dedup: string
  success: string
  candidateId?: string
  workflow?: WorkflowBinding
  sourceObservationIds?: string[]
}
export interface SkillVersion extends SkillInput {
  id: string
  version: number
  createdAt: number
}
export type RunState =
  | 'queued'
  | 'reading'
  | 'generating'
  | 'applying'
  | 'verifying'
  | 'succeeded'
  | 'no_change'
  | 'failed'
  | 'canceled'
  | 'conflict'
  | 'needs_verification'
  | 'reviewed'
export interface AgentRun {
  id: string
  skillId: string
  version: number
  target: string
  state: RunState
  createdAt: number
  updatedAt: number
  log: string
  receipt: string
  error: string
}
export interface AgentStatus {
  id: 'codex' | 'claude' | 'openadapt'
  installed: boolean
  authenticated: boolean
  enabled: boolean
  detail: string
}
export interface StrategyRule {
  id: string
  title: string
  steps: string
  variables: string
  prerequisites: string
  approvals: string
  createdAt: number
  candidateId?: string
  sourceObservationIds?: string[]
}
export interface ReuseAPI extends WorkflowAPI {
  candidates(): Promise<Candidate[]>
  candidateStatus(id: string, status: Candidate['status']): Promise<void>
  skills(): Promise<SkillVersion[]>
  saveSkill(input: SkillInput): Promise<SkillVersion>
  agents(): Promise<AgentStatus[]>
  run(skillId: string, version: number, parameters?: Record<string, string>): Promise<AgentRun>
  runs(): Promise<AgentRun[]>
  cancel(id: string): Promise<void>
  verify(id: string): Promise<AgentRun>
  acknowledgeRun(id: string): Promise<void>
  rules(): Promise<StrategyRule[]>
  saveRule(input: Omit<StrategyRule, 'id' | 'createdAt'>): Promise<StrategyRule>
}
export function draftSkill(candidate: Candidate): SkillInput {
  return {
    title: candidate.title,
    purpose: candidate.pattern?.steps.join('\n') || candidate.title,
    target: candidate.target,
    scope: '',
    format:
      candidate.kind === 'document'
        ? '保留既有 JsonML 节点、标题层级、表格及非目标章节格式'
        : '按确认的录制步骤执行，页面不匹配时停止',
    variables: (candidate.pattern?.variables || ['日期', '报告周期']).join('、'),
    sources: '',
    dedup:
      candidate.kind === 'document'
        ? '同一日期和章节不重复追加；已存在的内容按既有规则更新'
        : '结果不明时不自动重试，先核验实际结果',
    success:
      candidate.kind === 'document'
        ? '目标章节更新完成、非目标内容不变、格式保留、回读核验通过'
        : '完成全部步骤并核验实际结果',
    candidateId: candidate.id,
  }
}
