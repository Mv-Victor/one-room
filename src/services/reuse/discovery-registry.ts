import { detectPatterns, type WorkflowInstance, type WorkflowPattern } from './pattern-detector'
import { WorkerRegistry, type DetectionWorker } from './worker-registry'
import { detectBehaviorSequences } from './behavior-sequences'

export type DiscoveryWorker = DetectionWorker<WorkflowInstance, WorkflowPattern>
export interface DiscoveryResult {
  patterns: WorkflowPattern[]
  failures: { workerId: string; message: string }[]
}

/** SOP specialization; the generic host can also register non-SOP reminder rules. */
export class DiscoveryRegistry {
  private host = new WorkerRegistry<WorkflowInstance, WorkflowPattern>((pattern, snapshot) => {
    const allowed = new Set(snapshot.flatMap((item) => item.evidence))
    return (
      pattern.instances >= 2 &&
      pattern.evidence.length > 0 &&
      pattern.evidence.every((id) => allowed.has(id)) &&
      pattern.occurrences.length === pattern.instances &&
      new Set(pattern.occurrences.map((item) => item.id)).size === pattern.instances &&
      pattern.occurrences.every(
        (item) => item.evidence.length > 0 && item.evidence.every((id) => allowed.has(id)),
      )
    )
  })
  register(worker: DiscoveryWorker): () => void {
    return this.host.register(worker)
  }
  list(): { id: string; version: number }[] {
    return this.host.list()
  }
  evaluate(input: readonly WorkflowInstance[]): DiscoveryResult {
    const result = this.host.evaluate(input)
    return {
      patterns: result.findings.map(({ workerId, value }) => ({
        ...value,
        key: `${workerId}:${value.key}`,
      })),
      failures: result.failures,
    }
  }
}

export function createDiscoveryRegistry(): DiscoveryRegistry {
  const registry = new DiscoveryRegistry()
  registry.register({
    id: 'document-sop',
    version: 1,
    evaluate: (snapshot) => detectPatterns(snapshot.filter((item) => item.kind === 'document')),
  })
  registry.register({
    id: 'behavior-sop',
    version: 1,
    evaluate: (snapshot) =>
      [
        ...detectPatterns(snapshot.filter((item) => item.kind === 'workflow')),
        ...detectBehaviorSequences(snapshot),
      ].slice(0, 100),
  })
  registry.register({
    id: 'strategy-sop',
    version: 1,
    evaluate: (snapshot) => detectPatterns(snapshot.filter((item) => item.kind === 'strategy')),
  })
  return registry
}
