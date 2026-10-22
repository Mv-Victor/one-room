import { describe, expect, it } from 'vitest'
import { WorkerRegistry } from './worker-registry'

describe('generic reminder host', () => {
  it('supports non-SOP findings, provenance and independent worker failure', () => {
    const host = new WorkerRegistry<
      { id: string; overdue: boolean },
      { evidence: string; message: string }
    >((finding, facts) => facts.some((fact) => fact.id === finding.evidence))
    host.register({
      id: 'overdue-task',
      version: 2,
      evaluate: (facts) =>
        facts
          .filter((fact) => fact.overdue)
          .map((fact) => ({ evidence: fact.id, message: '待跟进' })),
    })
    host.register({
      id: 'broken',
      version: 1,
      evaluate: () => {
        throw new Error('offline')
      },
    })
    host.register({
      id: 'invented',
      version: 1,
      evaluate: () => [{ evidence: 'missing', message: 'wrong' }],
    })
    const result = host.evaluate([{ id: 'task-1', overdue: true }])
    expect(result.findings).toEqual([
      {
        workerId: 'overdue-task',
        workerVersion: 2,
        value: { evidence: 'task-1', message: '待跟进' },
      },
    ])
    expect(result.failures.map((item) => item.workerId)).toEqual(['broken', 'invented'])
  })
})
