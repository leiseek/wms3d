import { createApiClient } from '@wms3d/api-client';

/** M0b 冒烟：内存 access token + web refresh cookie。WS-B 在 M2 替换为正式会话管理（single-flight 刷新、401 跳登录）。 */
let accessToken: string | null = null;
export const setAccessToken = (t: string | null) => {
  accessToken = t;
};

export function deviceId(): string {
  const k = 'wms3d.deviceId';
  let id = localStorage.getItem(k);
  if (!id) {
    id = `web-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    localStorage.setItem(k, id);
  }
  return id;
}

export const api = createApiClient({
  getAccessToken: () => accessToken,
  refresh: async () => {
    try {
      const r = await api.r.authRefresh({ body: { deviceId: deviceId() } });
      accessToken = r.accessToken;
      return true;
    } catch {
      return false;
    }
  },
});
