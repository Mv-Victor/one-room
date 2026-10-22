import { describe, expect, it } from 'vitest';
import { inferLocalActivity } from '../../src/services/worklog/activity-events';

const previous = { authorized: true, objectKey: 'com.example.editor:42', text: '日报内容' };
const current = { ...previous, text: '日报内容更新' };

describe('local activity evidence', () => {
  it('marks changed text plus input timing as suspected, never confirmed', () => {
    expect(inferLocalActivity({ trigger: 'typing_pause', current, previous })).toEqual({ action: 'suspected_edit', basis: 'inferred' });
    expect(inferLocalActivity({ trigger: 'checkpoint', current, previous }).action).toBe('unknown');
    expect(inferLocalActivity({ trigger: 'typing_pause', current: previous, previous }).action).toBe('unknown');
  });

  it('does not compare unauthorized or different window text', () => {
    expect(inferLocalActivity({ trigger: 'typing_pause', current, previous: { ...previous, authorized: false } }).action).toBe('unknown');
    expect(inferLocalActivity({ trigger: 'typing_pause', current, previous: { ...previous, objectKey: 'com.example.editor:43' } }).action).toBe('unknown');
  });

  it('records authorized context switches without requiring extracted text', () => {
    expect(inferLocalActivity({ trigger: 'window_focus', current: { ...current, text: null } })).toEqual({ action: 'context_switch', basis: 'observed' });
    expect(inferLocalActivity({ trigger: 'app_switch', current: { ...current, authorized: false } }).action).toBe('unknown');
  });
});
