import { createHash } from 'node:crypto'

import type { WorkflowInstance, WorkflowPattern } from './types'
export type { WorkflowInstance, WorkflowPattern } from './types'

export function docsTarget(value: string): string | null {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/^\/(?:d|k)\/home\/(?:view\/)?([a-zA-Z0-9_-]+)\/?$/)
    return url.protocol === 'https:' &&
      url.hostname === 'docs.corp.kuaishou.com' &&
      !url.port &&
      match
      ? `https://docs.corp.kuaishou.com/d/home/${match[1]}`
      : null
  } catch {
    return null
  }
}
const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))]
const key = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24)
const day = (at: number): string => new Date(at + 8 * 3600000).toISOString().slice(0, 10)

function signature(instance: WorkflowInstance): string[] {
  return unique(
    instance.steps.map((step) => {
      let value = step.normalize('NFKC').toLowerCase()
      const objectAlias = instance.object.match(/^for\s+(.+)$/i)?.[1]
      for (const variable of [instance.object, instance.target, objectAlias].filter(
        (value): value is string => !!value,
      ))
        value = value.split(variable.normalize('NFKC').toLowerCase()).join('{object}')
      return value
        .replace(/https?:\/\/\S+/g, '{url}')
        .replace(/\d+/g, '#')
        .replace(/[\s\p{P}\p{S}]/gu, '')
    }),
  ).filter(Boolean)
}
function similarity(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0
  const row = new Array<number>(right.length + 1).fill(0)
  for (const a of left) {
    let prior = 0
    for (let j = 1; j <= right.length; j++) {
      const saved = row[j]
      row[j] = a === right[j - 1] ? prior + 1 : Math.max(row[j], row[j - 1])
      prior = saved
    }
  }
  return row[right.length] / Math.max(left.length, right.length)
}

/** Deterministic local recurrence over grounded instances; never invokes an agent or model. */
export function detectPatterns(input: readonly WorkflowInstance[]): WorkflowPattern[] {
  const instances: WorkflowInstance[] = []
  for (const item of [...input].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
    if (
      !item.editing ||
      !item.object.trim() ||
      !item.evidence.length ||
      !Number.isFinite(item.start) ||
      !Number.isFinite(item.end) ||
      item.end <= item.start
    )
      continue
    const target = docsTarget(item.target) || item.target
    const normalized = {
      ...item,
      target,
      steps: unique(item.steps),
      evidence: unique(item.evidence),
    }
    const prior = [...instances]
      .reverse()
      .find(
        (other) =>
          other.kind === item.kind &&
          (other.target || other.object) === (target || item.object) &&
          (other.id === item.id ||
            other.evidence.some((id) => item.evidence.includes(id)) ||
            (day(other.start) === day(item.start) && item.start - other.end < 30 * 60000)),
      )
    if (prior) {
      prior.end = Math.max(prior.end, item.end)
      prior.steps = unique([...prior.steps, ...item.steps])
      prior.evidence = unique([...prior.evidence, ...item.evidence])
      prior.apps = unique([...prior.apps, ...item.apps])
      prior.clusterId ||= item.clusterId
      prior.recipe ||= item.recipe
    } else instances.push(normalized)
  }
  const groups: WorkflowInstance[][] = []
  for (const item of instances) {
    if (item.kind !== 'document' && signature(item).length < 2) continue
    const group = groups.find((members) => {
      const first = members[0]
      if (first.kind !== item.kind) return false
      if (item.kind === 'document')
        return (first.target || first.object) === (item.target || item.object)
      if (item.clusterId && first.clusterId) return item.clusterId === first.clusterId
      return members.every(
        (member) =>
          member.apps.some((app) => item.apps.includes(app)) &&
          similarity(signature(member), signature(item)) >= 0.75,
      )
    })
    if (group) group.push(item)
    else groups.push([item])
  }
  return groups
    .map((group) => group.filter((item, index) => !group.slice(0, index).some(prior =>
      item.start < prior.end && prior.start < item.end)))
    .filter((group) => group.length >= 2)
    .map((group) => {
      const first = group[0]
      const recipe = group.find((item) => item.recipe?.steps.length)?.recipe
      const identity =
        first.kind === 'document'
          ? first.target || first.object
          : first.clusterId || JSON.stringify([unique(first.apps).sort(), signature(first)])
      return {
        key: key(`${first.kind}:${identity}`),
        title:
          recipe?.title ||
          (first.kind === 'document'
            ? `更新 ${first.object}`
            : first.kind === 'strategy'
              ? '重复配置策略'
              : `重复流程：${first.steps[0]}`),
        kind: first.kind,
        target: first.kind === 'document' ? docsTarget(first.target) || '' : '',
        instances: group.length,
        evidence: unique(group.flatMap((item) => item.evidence)),
        steps: recipe?.steps.length ? recipe.steps : first.steps,
        variables: recipe?.variables.length
          ? recipe.variables
          : first.kind === 'document'
            ? ['日期', '报告周期']
            : first.kind === 'strategy'
              ? ['策略对象', '目标', '规则参数']
              : ['操作对象', '输入参数'],
        source: group.every((item) => item.clusterId && item.clusterId === first.clusterId)
          ? 'cluster'
          : 'sequence',
        occurrences: group.map((item) => ({
          id: item.id,
          object: item.object,
          start: item.start,
          end: item.end,
          evidence: item.evidence,
        })),
      }
    })
}
