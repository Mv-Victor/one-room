import { docsTarget, type WorkflowInstance } from './pattern-detector'

export interface DiscoveryActivity {
  id: string
  start: number
  end: number
  app: string
  title: string
  object: string
  action: string
  topic: string
  text: string
  url?: string
  evidence: string[]
}
export function activityInstance(activity: DiscoveryActivity): WorkflowInstance | null {
  if (
    !/编辑|更新|撰写|输入|创建|保存|配置|选择|筛选|导出|下载|上传|发送|整理|复制|粘贴|审批|提交|搜索|查询|suspected_edit|edit|update|create|save|select|filter|export|download|upload|send|copy|paste|submit|search/i.test(
      activity.action,
    )
  )
    return null
  const text = [activity.url, activity.title, activity.object, activity.topic, activity.text].join(
    '\n',
  )
  const target =
    docsTarget(activity.url || '') ||
    (text.match(/https:\/\/docs\.corp\.kuaishou\.com\/[^\s"'<>，。；）)]+/g) || [])
      .map(docsTarget)
      .find(Boolean) ||
    ''
  const strategy = /策略|配券|发券|strategy|coupon/i.test(text)
  const document = !!target || /日报|周报|文档|document|report/i.test(text)
  const object = activity.object || activity.title
  const steps =
    !document || strategy
      ? (activity.action + '\n' + activity.topic + '\n' + activity.text).match(
          /(?:打开|选择|设置|填写|配置|创建|保存|提交|筛选|导出|下载|上传|发送|整理|复制|粘贴|审批|搜索|查询|open|select|configure|create|save|submit|filter|export|download|upload|send|copy|paste|search)[^，。;；\n→]{1,80}/gi,
        ) || (strategy ? [] : [activity.action + ' ' + object])
      : ['编辑 ' + object]
  return {
    id: activity.id,
    kind: strategy ? 'strategy' : document ? 'document' : 'workflow',
    object,
    target: document && !strategy ? target : object,
    start: activity.start,
    end: activity.end,
    steps,
    apps: [activity.app],
    evidence: activity.evidence,
    editing: true,
  }
}
