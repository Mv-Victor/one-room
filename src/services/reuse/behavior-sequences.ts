import { createHash } from 'node:crypto'
import type { WorkflowInstance, WorkflowPattern } from './types'

const unique = (values: string[]): string[] => [...new Set(values)]
function action(item: WorkflowInstance): string {
  return (
    item.apps.join('|') +
    ':' +
    item.steps
      .map((step) =>
        step
          .normalize('NFKC')
          .toLowerCase()
          .split(item.object.normalize('NFKC').toLowerCase())
          .join('{对象}')
          .replace(/https?:\/\/\S+/g, '{地址}')
          .replace(/\d+/g, '#')
          .replace(/\s+/g, ''),
      )
      .join('→')
  )
}

/** Bounded exact sequence mining fallback over already-extracted actions, without model calls. */
export function detectBehaviorSequences(snapshot: readonly WorkflowInstance[]): WorkflowPattern[] {
  const rows = [...snapshot]
    .sort((a, b) => a.start - b.start)
    .filter(
      (item) =>
        item.kind === 'workflow' &&
        !item.clusterId &&
        item.editing &&
        item.steps.length === 1 &&
        item.evidence.length > 0 &&
        item.end > item.start,
    )
  const groups = new Map<string, WorkflowInstance[][]>()
  for (let length = 5; length >= 2; length--) {
    for (let index = 0; index + length <= rows.length; index++) {
      const window = rows.slice(index, index + length)
      if (
        window.some(
          (item, i) =>
            i > 0 && (item.start < window[i - 1].end || item.start - window[i - 1].end > 5 * 60000),
        )
      )
        continue
      const tokens = window.map(action)
      if (new Set(tokens).size < 2) continue
      const identity = tokens.join('\n')
      const group = groups.get(identity) || []
      const evidence = new Set(window.flatMap((item) => item.evidence))
      // A return to the same objects or an overlapping window is not a new task instance.
      if (
        group.some(
          (prior) =>
            prior.some((item) => item.evidence.some((id) => evidence.has(id))) ||
            (prior.map((item) => item.object).join('|') ===
              window.map((item) => item.object).join('|') &&
              window[0].start - prior.at(-1)!.end < 30 * 60000),
        )
      )
        continue
      group.push(window)
      groups.set(identity, group)
    }
  }
  const patterns: WorkflowPattern[] = []
  for (const [identity, group] of groups) {
    if (group.length < 2) continue
    const evidence = unique(group.flat(2).flatMap((item) => item.evidence))
    // Prefer maximal repeated sequences over their contained fragments.
    if (patterns.some((pattern) => evidence.every((id) => pattern.evidence.includes(id)))) continue
    const first = group[0]
    patterns.push({
      key: createHash('sha256').update(identity).digest('hex').slice(0, 24),
      kind: 'workflow',
      title: `重复操作：${first[0].steps[0]} → ${first.at(-1)!.steps[0]}`,
      target: '',
      instances: group.length,
      evidence,
      steps: first.flatMap((item) => item.steps.map((step) => `${item.apps.join(' / ')}：${step}`)),
      variables: ['操作对象', '输入参数'],
      source: 'sequence',
      occurrences: group.map((window) => ({
        id: window.map((item) => item.id).join(':'),
        object: window.map((item) => item.object).join(' → '),
        start: window[0].start,
        end: window.at(-1)!.end,
        evidence: unique(window.flatMap((item) => item.evidence)),
      })),
    })
    if (patterns.length >= 100) break
  }
  return patterns
}
