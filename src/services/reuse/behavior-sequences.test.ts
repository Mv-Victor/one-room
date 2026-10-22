import { describe, expect, it } from 'vitest'
import { detectBehaviorSequences } from './behavior-sequences'
import { activityInstance } from './activity-input'
import { detectPatterns } from './pattern-detector'
import type { WorkflowInstance } from './types'

const step = (
  id: string,
  app: string,
  action: string,
  object: string,
  start: number,
): WorkflowInstance => ({
  id,
  kind: 'workflow',
  apps: [app],
  steps: [action + ' ' + object],
  object,
  target: object,
  evidence: [id],
  editing: true,
  start,
  end: start + 1000,
})
describe('通用操作序列', () => {
  it('识别跨应用导出并发送，不依赖文档或策略词', () => {
    const [pattern] = detectBehaviorSequences([
      step('a', '数据台', '导出', '甲订单', 1),
      step('b', 'Kim', '发送', '甲订单', 3001),
      step('c', '数据台', '导出', '乙订单', 6001),
      step('d', 'Kim', '发送', '乙订单', 9001),
    ])
    expect(pattern.instances).toBe(2)
    expect(pattern.evidence).toEqual(['a', 'b', 'c', 'd'])
  })
  it('不将同一任务的切换返回、重复截图或单动作计作重复流程', () => {
    const a = step('a', '数据台', '导出', '甲订单', 1),
      b = step('b', 'Kim', '发送', '甲订单', 3001)
    expect(
      detectBehaviorSequences([
        a,
        b,
        { ...a, id: 'c', start: 6001, end: 7001 },
        { ...b, id: 'd', start: 9001, end: 10001 },
      ]),
    ).toEqual([])
    expect(detectBehaviorSequences([a, { ...a, start: 9001, end: 10001 }])).toEqual([])
  })
  it('保留通用动作，但被动浏览不进入操作实例', () => {
    const activity = {
      id: '1',
      start: 1,
      end: 2,
      app: '后台',
      title: '订单中心',
      object: '订单甲',
      topic: '',
      text: '选择订单甲→下载明细',
      evidence: ['1'],
    }
    expect(activityInstance({ ...activity, action: '导出' })?.kind).toBe('workflow')
    expect(activityInstance({ ...activity, action: '浏览' })).toBeNull()
  })
  it('支持有上游语义聚类和配方的非文档流程', () => {
    const a = {
      ...step('a', '后台', '处理', '工单甲', 1),
      steps: ['分配负责人', '关闭工单'],
      clusterId: 'tickets',
      recipe: {
        title: '工单分配',
        steps: ['分配负责人', '关闭工单'],
        variables: ['工单', '负责人'],
      },
    }
    const b = {
      ...a,
      id: 'b',
      object: '工单乙',
      target: '工单乙',
      evidence: ['b'],
      start: 3001,
      end: 4001,
    }
    expect(detectPatterns([a, b])[0]).toMatchObject({
      kind: 'workflow',
      source: 'cluster',
      instances: 2,
    })
  })
})
