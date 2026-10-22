import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { AgentRunService } from '../reuse/agent-executor'
import { createWorkflowExecutor } from '../reuse/workflow-runtime'
import type { WorkflowRecordingInput } from '../reuse/workflow-types'
import { createDiscoveryRegistry } from '../reuse/discovery-registry'
import { activityInstance } from '../reuse/activity-input'
import { saveCandidates } from '../reuse/candidate-store'
import type { Candidate, SkillInput, StrategyRule } from '../reuse/types'
import { StorageError } from './client'

const executionGate = '执行未启用：尚缺合成能力验证、冻结输入审核及精确差异审核。'
const blockExecution = (): never => {
  throw new StorageError('CAPABILITY_BLOCKED', executionGate, 'EXECUTION_CONTRACT_PENDING')
}

export function createReuseCommands(db: Database.Database, root: string) {
  const registry = createDiscoveryRegistry()
  const runs = new AgentRunService(db, createWorkflowExecutor(root))
  const sourceObservations = (candidateId?: string): string[] => {
    if (!candidateId) return []
    const row = db.prepare('SELECT evidence FROM or_candidates WHERE id=?').get(candidateId) as { evidence: string } | undefined
    if (!row) throw new StorageError('SOURCE_INVALIDATED', '候选来源已失效，请重新确认规则。')
    return [...new Set(JSON.parse(row.evidence) as string[])].sort()
  }
  const discover = () => {
    const rows = db.prepare(`SELECT a.id,c.observedAt AS start,COALESCE(c.endTs,c.observedAt+1) AS end,
      c.appName AS app,c.windowTitle AS title,a.objectLabel AS object,a.action,a.topic,a.summary AS text,
      c.id AS evidence FROM activity_events a JOIN capture_events c ON c.id=a.captureEventId
      WHERE a.deletedAt IS NULL AND c.deletedAt IS NULL ORDER BY c.observedAt DESC LIMIT 5000`).all() as {
        id: string; start: number; end: number; app: string; title: string | null; object: string | null;
        action: string; topic: string | null; text: string | null; evidence: string
      }[]
    const snapshot = rows.flatMap(row => {
      const instance = activityInstance({ ...row, title: row.title || '', object: row.object || '',
        topic: row.topic || '', text: row.text || '', evidence: [row.evidence] })
      return instance ? [instance] : []
    })
    return saveCandidates(db, registry.evaluate(snapshot).patterns)
  }
  return {
    'reuse.recordings': () => runs.workflows.list(),
    'reuse.recordWorkflow': (input: WorkflowRecordingInput) => runs.workflows.start(input),
    'reuse.beginRecording': ({ id }: { id: string }) => { runs.workflows.begin(id); return null },
    'reuse.stopRecording': ({ id }: { id: string }) => { runs.workflows.finish(id); return null },
    'reuse.candidates': discover,
    'reuse.candidateStatus': ({ id, status }: { id: string; status: Candidate['status'] }) => {
      db.prepare('UPDATE or_candidates SET status=? WHERE id=?').run(status, id); return null
    },
    'reuse.skills': () => runs.skills(),
    'reuse.saveSkill': (input: SkillInput) => {
      const savedInput = { ...input, sourceObservationIds: sourceObservations(input.candidateId) }
      return runs.save(savedInput)
    },
    'reuse.agents': async () => (await runs.agents()).map(agent => ({ ...agent, enabled: agent.id === 'openadapt' && agent.enabled,
      detail: agent.id === 'codex' ? `${agent.detail} · ${executionGate}` : agent.detail })),
    'reuse.run': ({ skillId, version, parameters }: { skillId: string; version: number; parameters?: Record<string, string> }) => {
      if (!runs.skills().find(skill => skill.id === skillId && skill.version === version)?.workflow) blockExecution()
      discover(); return runs.start(skillId, version, parameters)
    },
    'reuse.runs': () => runs.runs(),
    'reuse.acknowledgeRun': ({ id }: { id: string }) => {
      const run = runs.runs().find(item => item.id === id)
      if (!run || !runs.skills().find(skill => skill.id === run.skillId && skill.version === run.version)?.workflow) blockExecution()
      runs.acknowledge(id); return null
    },
    'reuse.cancel': ({ id }: { id: string }) => { runs.cancel(id); return null },
    'reuse.verify': ({ id }: { id: string }) => {
      const run = runs.runs().find(item => item.id === id)
      if (!run || !runs.skills().find(skill => skill.id === run.skillId && skill.version === run.version)?.workflow) blockExecution()
      return runs.verify(id)
    },
    'reuse.rules': () => (db.prepare('SELECT body FROM or_rules ORDER BY created_at DESC').all() as {body: string}[]).map(row => JSON.parse(row.body) as StrategyRule),
    'reuse.saveRule': (input: Omit<StrategyRule, 'id' | 'createdAt'>) => db.transaction(() => {
      const rule = { ...input, sourceObservationIds: sourceObservations(input.candidateId), id: randomUUID(), createdAt: Date.now() }
      db.prepare('INSERT INTO or_rules VALUES (?,?,?)').run(rule.id, JSON.stringify(rule), rule.createdAt)
      if (input.candidateId) db.prepare("UPDATE or_candidates SET status='accepted' WHERE id=?").run(input.candidateId)
      return rule
    })(),
    'reuse.stop': () => runs.stop(),
  }
}
