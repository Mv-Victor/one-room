import { describe, expect, it } from 'vitest'
import { createDiscoveryRegistry } from './discovery-registry'
import type { WorkflowInstance } from './pattern-detector'

describe('registered discovery workers', () => {
  it('supports registration, duplicate guards, removal and isolated failures', () => {
    const registry = createDiscoveryRegistry()
    const remove = registry.register({
      id: 'custom-reminder',
      version: 1,
      evaluate: () => {
        throw new Error('offline')
      },
    })
    expect(() =>
      registry.register({ id: 'custom-reminder', version: 2, evaluate: () => [] }),
    ).toThrow('Duplicate')
    expect(registry.evaluate([]).failures).toEqual([
      { workerId: 'custom-reminder', message: 'offline' },
    ])
    remove()
    expect(registry.evaluate([]).failures).toEqual([])
    expect(registry.list().map((item) => item.id)).toEqual([
      'document-sop',
      'behavior-sop',
      'strategy-sop',
    ])
  })
  it('prevents input mutation and rejects invented evidence while built-ins still run', () => {
    const registry = createDiscoveryRegistry()
    registry.register({
      id: 'mutator',
      version: 1,
      evaluate: (rows) => {
        rows[0].steps.push('invented')
        return []
      },
    })
    const instance: WorkflowInstance = {
      id: 'a',
      kind: 'document',
      object: '日报',
      target: '',
      start: 1,
      end: 2,
      apps: ['Docs'],
      steps: ['编辑日报'],
      evidence: ['a'],
      editing: true,
    }
    const result = registry.evaluate([
      instance,
      { ...instance, id: 'b', start: 86400001, end: 86400002, evidence: ['b'] },
    ])
    expect(result.patterns).toHaveLength(1)
    expect(result.failures[0].workerId).toBe('mutator')
    expect(instance.steps).toEqual(['编辑日报'])
  })
})
