import { createApiClient } from '@wms3d/api-client';

/**
 * M0b 冒烟：内存 token。WS-C 在 M3 换成：服务器地址配置 + 指纹校验、refreshToken 存原生 Keystore、
 * single-flight 刷新、换班代交的 performerSessionId（02 §6.6）。
 */
let accessToken: string | null = null;
export const setAccessToken = (t: string | null) => {
  accessToken = t;
};

export function deviceId(): string {
  const k = 'wms3d.deviceId';
  let id = localStorage.getItem(k);
  if (!id) {
    id = `mob-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    localStorage.setItem(k, id);
  }
  return id;
}

export const api = createApiClient({ getAccessToken: () => accessToken });
