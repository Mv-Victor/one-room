import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { saveCandidates } from './candidate-store'
import { REUSE_SCHEMA_V1 } from './schema-v1'
import { activityInstance } from './activity-input'
import { createDiscoveryRegistry } from './discovery-registry'
import { AgentRunService, type AgentExecutor } from './agent-executor'
import { draftSkill, type WorkflowInstance } from './types'

let db: Database.Database
const target = 'https://docs.corp.kuaishou.com/d/home/daily'
function instances(): WorkflowInstance[] {
  return [1, 2].map((day) => ({
    id: 'doc-' + day,
    kind: 'document',
    object: '团队日报',
    target,
    start: day * 86400000,
    end: day * 86400000 + 1000,
    editing: true,
    evidence: ['source-' + day],
    steps: ['编辑团队日报'],
    apps: ['Docs'],
  }))
}
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(REUSE_SCHEMA_V1)
})
afterEach(() => db.close())

describe('grounded candidate persistence', () => {
  it('marks explicit local manual review separately from automatic success and unlocks the target', () => {
    const executor: AgentExecutor = { detect: async () => [], execute: vi.fn(), cancel: vi.fn() }
    const service = new AgentRunService(db, executor)
    const skill = {
      ...draftSkill({
        id: 'candidate',
        title: '工单',
        target,
        kind: 'workflow',
        instances: 2,
        status: 'new',
        evidence: [],
      }),
      id: 'skill',
      version: 1,
      createdAt: 0,
      candidateId: undefined,
      workflow: { engine: 'openadapt', recordingId: 'recording', digest: 'digest', parameters: {} },
    }
    db.prepare('INSERT INTO or_skills VALUES (?,?,?,?)').run(skill.id, 1, 0, JSON.stringify(skill))
    db.prepare('INSERT INTO or_runs VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'run',
      skill.id,
      1,
      target,
      'applying',
      0,
      0,
      '',
      '',
      '',
    )
    expect(() => service.acknowledge('run')).toThrow()
    db.prepare("UPDATE or_runs SET state='needs_verification' WHERE id='run'").run()
    service.acknowledge('run')
    expect(service.runs()[0].state).toBe('reviewed')
    expect(JSON.parse(service.runs()[0].receipt).manualReview.automaticVerification).toBe(false)
    expect(() =>
      db
        .prepare('INSERT INTO or_runs VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('next', skill.id, 1, target, 'queued', 0, 0, '', '', ''),
    ).not.toThrow()
  })
  it('keeps identity and user status while refreshing evidence, then prunes deleted sources', () => {
    const patterns = createDiscoveryRegistry().evaluate(instances()).patterns
    const [first] = saveCandidates(db, patterns)
    db.prepare("UPDATE or_candidates SET status='ignored' WHERE id=?").run(first.id)
    const [again] = saveCandidates(db, patterns)
    expect(again).toMatchObject({ id: first.id, status: 'ignored', target, instances: 2 })
    expect(draftSkill(again)).toMatchObject({
      candidateId: first.id,
      target,
      purpose: '编辑团队日报',
      sources: '',
      scope: '',
    })
    expect(saveCandidates(db, [])).toEqual([])
  })
  it('freezes skill versions and refuses execution after source invalidation', async () => {
    const [candidate] = saveCandidates(db, createDiscoveryRegistry().evaluate(instances()).patterns)
    const executor: AgentExecutor = { detect: async () => [], execute: vi.fn(), cancel: vi.fn() }
    const service = new AgentRunService(db, executor)
    const input = { ...draftSkill(candidate), scope: '今天', sources: '指定来源' }
    const v1 = service.save(input)
    service.save({ ...input, id: v1.id, scope: '本周' })
    expect(service.skills().find((item) => item.version === 1)?.scope).toBe('今天')
    saveCandidates(db, [])
    await expect(service.start(v1.id, 1)).rejects.toThrow('来源已失效')
    expect(executor.execute).not.toHaveBeenCalled()
    expect(service.runs()).toEqual([])
  })
  it('parses observed strategy steps without inventing a recipe or treating viewing as editing', () => {
    const base = {
      id: 'a',
      start: 1000,
      end: 2000,
      app: 'Chrome',
      title: '策略配置',
      object: 'For GMV',
      action: '配置',
      topic: '选择目标GMV，设置预算100，保存策略',
      text: '',
      evidence: ['a'],
    }
    expect(activityInstance(base)?.steps).toEqual(['选择目标GMV', '设置预算100', '保存策略'])
    expect(activityInstance({ ...base, action: '浏览' })).toBeNull()
    expect(activityInstance({ ...base, topic: '' })?.steps).toEqual([])
    const second = activityInstance({
      ...base,
      id: 'b',
      start: 3000,
      end: 4000,
      object: 'For ROI',
      topic: '选择目标ROI，设置预算200，保存策略',
      evidence: ['b'],
    })!
    expect(
      createDiscoveryRegistry().evaluate([activityInstance(base)!, second]).patterns[0].instances,
    ).toBe(2)
  })
})
