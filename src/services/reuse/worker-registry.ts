export interface DetectionWorker<TFact, TFinding> {
  id: string
  version: number
  evaluate(snapshot: readonly TFact[]): TFinding[]
}

export interface WorkerResult<TFinding> {
  findings: { workerId: string; workerVersion: number; value: TFinding }[]
  failures: { workerId: string; message: string }[]
}

function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const child of Object.values(value)) freeze(child)
}

/** Trusted, shipped rules only. Third-party code requires a separate process with time limits. */
export class WorkerRegistry<TFact, TFinding> {
  private workers = new Map<string, DetectionWorker<TFact, TFinding>>()
  constructor(private validate: (finding: TFinding, snapshot: readonly TFact[]) => boolean) {}

  register(worker: DetectionWorker<TFact, TFinding>): () => void {
    if (
      !/^[a-z][a-z0-9.-]{0,63}$/.test(worker.id) ||
      !Number.isInteger(worker.version) ||
      worker.version < 1
    )
      throw new Error('Invalid discovery worker identity')
    if (this.workers.has(worker.id)) throw new Error(`Duplicate discovery worker: ${worker.id}`)
    this.workers.set(worker.id, worker)
    return () => {
      if (this.workers.get(worker.id) === worker) this.workers.delete(worker.id)
    }
  }

  list(): { id: string; version: number }[] {
    return [...this.workers.values()].map(({ id, version }) => ({ id, version }))
  }

  evaluate(input: readonly TFact[]): WorkerResult<TFinding> {
    const snapshot = structuredClone(input.slice(-5000))
    freeze(snapshot)
    const result: WorkerResult<TFinding> = { findings: [], failures: [] }
    for (const worker of this.workers.values()) {
      try {
        const values = worker.evaluate(snapshot)
        if (
          !Array.isArray(values) ||
          values.length > 100 ||
          values.some((value) => !this.validate(value, snapshot))
        )
          throw new Error('Invalid or ungrounded worker findings')
        result.findings.push(
          ...values.map((value) => ({ workerId: worker.id, workerVersion: worker.version, value })),
        )
      } catch (error) {
        result.failures.push({
          workerId: worker.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return result
  }
}
