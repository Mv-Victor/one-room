import type { Activity } from '../../shared/activity-schemas';
import type { CaptureTrigger } from '../capture/triggers';

export type LocalActivityContext = {
  authorized: boolean;
  objectKey: string | null;
  text: string | null;
};

type Input = {
  trigger: CaptureTrigger;
  current: LocalActivityContext;
  previous?: LocalActivityContext | null;
};

export function inferLocalActivity({ trigger, current, previous }: Input): Pick<Activity, 'action' | 'basis'> {
  if (!current.authorized) return { action: 'unknown', basis: 'observed' };
  if (trigger === 'app_switch' || trigger === 'window_focus') {
    return { action: 'context_switch', basis: 'observed' };
  }
  // Window identity plus input timing supports a suspicion, never proof of a saved edit.
  if (
    trigger === 'typing_pause' && previous?.authorized && current.objectKey &&
    current.objectKey === previous.objectKey && current.text?.trim() && previous.text?.trim() &&
    current.text !== previous.text
  ) {
    return { action: 'suspected_edit', basis: 'inferred' };
  }
  return { action: 'unknown', basis: 'observed' };
}
