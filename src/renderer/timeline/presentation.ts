import type { Period } from '../../shared/schemas';

export const activityLabels = { direct_chat: '私聊', group_chat: '群聊', meeting: '会议', document: '文档', business: '业务操作', unknown: '类型未知' } as const;
export const actionLabels = { view: '查看', suspected_edit: '疑似编辑', context_switch: '切换窗口', unknown: '动作未知' } as const;
export const summaryLabels = { not_authorized: '未授权总结', not_configured: '模型待配置', pending: '总结中', failed: '总结失败', insufficient: '总结依据不足', ready: '已有总结' } as const;
export const basisLabels = { observed: '观察事实', inferred: '推断', confirmed: '人工确认' } as const;

export function appTone(bundleId: string): string {
  let hash = 0;
  for (const character of bundleId) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `app-tone-${Math.abs(hash) % 6}`;
}

export function periodTitle(period: Period): string {
  return `${period.appName} · ${actionLabels[period.action ?? 'unknown']} · ${activityLabels[period.activityType]} · ${period.objectLabel ?? '对象未知'} · ${period.topic ?? '主题未知'}`;
}
