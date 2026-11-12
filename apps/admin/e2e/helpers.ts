import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'Wms3d#demo';
const apiBase = () => `http://127.0.0.1:${process.env.PORT_API ?? '4200'}/api/v1`;

export async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

export async function loginToDashboard(page: Page, username = 'admin') {
  await login(page, username);
  await expect(page.getByTestId('dashboard')).toBeVisible();
}

/** 直接调 mock API（模拟移动端过账等前置数据）。 */
export async function apiSession(request: APIRequestContext, username = 'admin') {
  const r = await request.post(`${apiBase()}/auth/login`, {
    data: {
      username,
      password: PASSWORD,
      deviceId: `e2e-${username}-${Date.now()}`,
      client: 'mobile',
    },
  });
  expect(r.ok()).toBeTruthy();
  const body = (await r.json()) as {
    accessToken: string;
    user: { id: string; warehouses: { id: string; code: string }[] };
  };
  const headers = { authorization: `Bearer ${body.accessToken}` };
  const wh = body.user.warehouses.find((w) => w.code === 'WH1')!.id;
  return {
    userId: body.user.id,
    warehouseId: wh,
    get: async <T>(path: string) => {
      const res = await request.get(`${apiBase()}${path}`, { headers });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()) as T;
    },
    post: async <T>(path: string, data: unknown, extra: Record<string, string> = {}) => {
      const res = await request.post(`${apiBase()}${path}`, {
        headers: { ...headers, ...extra },
        data,
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()) as T;
    },
  };
}

export const SHOTS = process.env.WSB_SHOTS_DIR ?? '/workspace/wms3d-artifacts/screens/ws-b';
