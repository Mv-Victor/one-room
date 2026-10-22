import { describe, expect, it } from 'vitest'
import { detectPatterns, docsTarget, type WorkflowInstance } from './pattern-detector'

const strategy = (id: string, object: string, start: number): WorkflowInstance => ({
  id,
  object,
  start,
  end: start + 1000,
  target: object,
  kind: 'strategy',
  steps: [`云舵：选择 ${object} 目标`, '云舵：设置规则', '云舵：保存草稿'],
  apps: ['云舵'],
  evidence: [id],
  editing: true,
})
describe('shared workflow recurrence', () => {
  it('detects two different strategy objects within minutes, without a title match', () => {
    const [pattern] = detectPatterns([strategy('a', 'GMV', 1000), strategy('b', 'ROI', 5000)])
    expect(pattern.instances).toBe(2)
    expect(pattern.occurrences.map((item) => item.object)).toEqual(['GMV', 'ROI'])
    expect(pattern.evidence).toEqual(['a', 'b'])
  })
  it('does not count A→B→A, repeated delivery or shared evidence as another run', () => {
    const a = strategy('a', 'GMV', 1000)
    expect(detectPatterns([a, a, { ...a, id: 'return', start: 5000, end: 6000 }])).toEqual([])
    expect(detectPatterns([a, { ...a, id: 'later', start: 86400000, end: 86401000 }])).toEqual([])
    expect(detectPatterns([a, { ...strategy('duplicate-adapter', 'ROI', 1100) }])).toEqual([])
  })
  it('rejects passive viewing and unrelated workflows in the same application', () => {
    const b = { ...strategy('b', 'ROI', 5000), steps: ['云舵：下载报表', '云舵：发送报表'] }
    expect(detectPatterns([strategy('a', 'GMV', 1000), b])).toEqual([])
    expect(detectPatterns([strategy('a', 'GMV', 1000), { ...b, editing: false }])).toEqual([])
    expect(
      detectPatterns([
        { ...strategy('a', 'GMV', 1000), steps: ['输入'] },
        { ...strategy('b', 'ROI', 5000), steps: ['输入'] },
      ]),
    ).toEqual([])
  })
  it('uses upstream cluster membership and its recipe across variable step wording', () => {
    const recipe = {
      title: '批量配置策略',
      steps: ['选目标', '设规则', '保存草稿'],
      variables: ['目标'],
    }
    const a = { ...strategy('a', 'GMV', 1000), clusterId: 'cluster', recipe }
    const b = {
      ...strategy('b', 'ROI', 5000),
      clusterId: 'cluster',
      steps: ['打开配置', '提交草稿'],
    }
    expect(detectPatterns([a, b])[0]).toMatchObject({
      source: 'cluster',
      steps: recipe.steps,
      variables: ['目标'],
    })
  })
  it('normalizes document URLs and keeps same-session returns together', () => {
    const document = (id: string, start: number, target: string): WorkflowInstance => ({
      ...strategy(id, '日报', start),
      kind: 'document',
      target,
      steps: ['编辑日报'],
    })
    const url = 'https://docs.corp.kuaishou.com/d/home/test'
    const a = document('a', 1000, url)
    expect(detectPatterns([a, document('return', 5000, url)])).toEqual([])
    const [pattern] = detectPatterns([a, document('next', 86401000, url + '?channel=kim')])
    expect(pattern).toMatchObject({ instances: 2, target: url, kind: 'document' })
    expect(docsTarget('https://evil.example/d/home/test')).toBeNull()
  })
})
