import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Candidate } from './types'
import type { WorkflowPattern } from './pattern-detector'

export function saveCandidates(db: Database.Database, patterns: WorkflowPattern[]): Candidate[] {
  return db.transaction(() => {
    const currentKeys = new Set<string>()
    for (const pattern of patterns) {
      const identity =
        pattern.kind === 'document' && pattern.target ? pattern.target : 'pattern:' + pattern.key
      currentKeys.add(identity)
      db.prepare(
        `INSERT INTO or_candidates(id,target,title,kind,instances,evidence,details)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(target) DO UPDATE SET
        title=excluded.title,instances=excluded.instances,evidence=excluded.evidence,details=excluded.details`,
      ).run(
        randomUUID(),
        identity,
        pattern.title,
        pattern.kind,
        pattern.instances,
        JSON.stringify(pattern.evidence),
        JSON.stringify(pattern),
      )
    }
    // Obsolete findings are not allowed to linger after source deletion or correction.
    for (const row of db.prepare('SELECT id,target FROM or_candidates').all() as {
      id: string
      target: string
    }[]) {
      if (!currentKeys.has(row.target))
        db.prepare('DELETE FROM or_candidates WHERE id=?').run(row.id)
    }
    return (
      db.prepare('SELECT * FROM or_candidates ORDER BY instances DESC').all() as {
        id: string
        target: string
        title: string
        kind: Candidate['kind']
        instances: number
        status: Candidate['status']
        evidence: string
        details: string
      }[]
    ).map((row) => {
      const pattern = row.details ? (JSON.parse(row.details) as WorkflowPattern) : undefined
      return { ...row, target: pattern?.target || '', evidence: JSON.parse(row.evidence), pattern }
    })
  })()
}
