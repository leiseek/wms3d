import { createApiClient } from '@wms3d/api-client';

/**
 * 会话：access token 只在内存；refresh token 是 HttpOnly cookie（client=web）。
 * 401 → api-client single-flight 调 refresh → 成功则重试原请求；失败则触发 onSessionExpired（跳登录）。
 */
let accessToken: string | null = null;
let onExpired: (() => void) | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const getAccessToken = () => accessToken;
export const onSessionExpired = (fn: (() => void) | null) => {
  onExpired = fn;
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

/** 用 refresh cookie 换新 access token（启动恢复会话 / 401 重试 / SSE 重连共用）。 */
export async function refreshSession(): Promise<boolean> {
  try {
    const r = await api.r.authRefresh({ body: { deviceId: deviceId() } });
    accessToken = r.accessToken;
    return true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    const code = (e as { code?: string }).code;
    const authFail =
      status === 401 ||
      code === 'UNAUTHENTICATED' ||
      code === 'DEVICE_DISABLED' ||
      code === 'PASSWORD_CHANGE_REQUIRED';
    if (!authFail) throw e; // 5xx / 429 / 网络错误：不跳登录页，由调用方重试
    accessToken = null;
    return false;
  }
}

export const api = createApiClient({
  credentials: 'same-origin',
  getAccessToken: () => accessToken,
  refresh: async () => {
    const ok = await refreshSession();
    if (!ok) onExpired?.();
    return ok;
  },
});
