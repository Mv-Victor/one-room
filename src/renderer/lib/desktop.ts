import type { MethodOutput, OneRoomApi, Reply } from '../../shared/contracts';

export type DesktopSnapshot = {
  status: MethodOutput<'app.getStatus'>;
  settings: MethodOutput<'settings.get'>;
  permissions: MethodOutput<'permissions.get'>;
};

export const fixtureEnabled = import.meta.env.DEV && new URLSearchParams(window.location.search).get('fixture') === '1';
let fixtureApi: OneRoomApi | null = null;
let fixtureConnection: Promise<OneRoomApi> | null = null;

export function desktopApi() {
  if (fixtureEnabled) {
    if (!fixtureApi) throw new Error('测试数据正在准备。');
    return fixtureApi;
  }
  if (!window.oneRoom) throw new Error('桌面连接不可用，请在 One Room 桌面应用中打开。');
  return window.oneRoom;
}

export async function connectDesktopApi(): Promise<OneRoomApi> {
  if (import.meta.env.DEV && fixtureEnabled) {
    fixtureConnection ??= import('../../shared/fixtures/worklog').then(({ createFixtureApi }) => {
      fixtureApi = createFixtureApi({ delayEvidenceMs: 250 });
      return fixtureApi;
    });
    return fixtureConnection;
  }
  return desktopApi();
}

export function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data;
}

export async function loadDesktopSnapshot(): Promise<DesktopSnapshot> {
  const api = await connectDesktopApi();
  const [status, settings, permissions] = await Promise.all([
    api.app.getStatus({}),
    api.settings.get({}),
    api.permissions.get({}),
  ]);
  return { status: unwrap(status), settings: unwrap(settings), permissions: unwrap(permissions) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请重试。';
}
