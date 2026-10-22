import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestNativePermission } from '../../src/services/capture/helper-client';

const native = vi.hoisted(() => ({ request: vi.fn(), stop: vi.fn() }));
vi.mock('../../src/services/capture/native-session', () => ({
  NativeSession: class {
    request = native.request;
    stop = native.stop;
  },
}));

const capability = { supported: true, permission: 'unknown', state: 'permission_required', reason: null };
const hello = {
  helperVersion: '0.2.1-permissions', minimumMacOS: '14.0', architecture: 'arm64',
  permissions: { screen: 'unknown', accessibility: 'unknown', inputMonitoring: 'unknown' },
  permissionReasons: { screen: null, accessibility: null, inputMonitoring: null },
  capabilities: { windowEvents: capability, windowCapture: capability, accessibilityText: capability, visionOcr: capability, inputTiming: capability },
  foundationMethods: ['hello', 'permissions.request'], captureStarted: false,
};

describe('explicit native permission requests', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(['screen', 'accessibility', 'inputMonitoring'] as const)('registers only the selected %s permission without starting capture', async kind => {
    native.request.mockResolvedValueOnce({ payload: hello })
      .mockResolvedValueOnce({ payload: { kind, requested: true, granted: false } });
    await requestNativePermission('/native/helper', kind);
    expect(native.request.mock.calls).toEqual([
      ['hello', { role: 'executor' }],
      ['permissions.request', { kind }, {}, 60_000],
    ]);
    expect(native.stop).toHaveBeenCalledOnce();
  });

  it('reports an outdated helper instead of opening an unregistered permissions page', async () => {
    native.request.mockResolvedValueOnce({ payload: { ...hello, foundationMethods: ['hello'] } });
    await expect(requestNativePermission('/native/helper', 'screen')).rejects.toMatchObject({ error: { detailCode: 'HELPER_UPDATE_REQUIRED' } });
    expect(native.request).toHaveBeenCalledOnce();
    expect(native.stop).toHaveBeenCalledOnce();
  });

  it('propagates a failed permission request and terminates the helper', async () => {
    native.request.mockResolvedValueOnce({ payload: hello }).mockRejectedValueOnce(new Error('PERMISSION_REQUEST_FAILED'));
    await expect(requestNativePermission('/native/helper', 'accessibility')).rejects.toThrow('PERMISSION_REQUEST_FAILED');
    expect(native.stop).toHaveBeenCalledOnce();
  });
});
