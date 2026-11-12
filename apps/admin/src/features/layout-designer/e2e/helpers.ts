import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { LayoutDoc, LayoutVersion } from '@wms3d/contracts';

export const MOCK = `http://127.0.0.1:${process.env.D1_E2E_MOCK_PORT ?? 4431}/api/v1`;
export const SHOTS = process.env.D1_SHOTS_DIR ?? '/workspace/wms3d-artifacts/screens/ws-d1';
mkdirSync(SHOTS, { recursive: true });

/** 直接调 mock（模拟"另一个人"或准备数据） */
export async function http(user = 'admin') {
  const r = await fetch(`${MOCK}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: user,
      password: 'Wms3d#demo',
      deviceId: `web-ws-d1-e2e-${user}`,
      client: 'web',
    }),
  });
  const { accessToken } = (await r.json()) as { accessToken: string };
  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: number,
  ): Promise<{ status: number; json: T }> => {
    const res = await fetch(`${MOCK}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(ifMatch !== undefined ? { 'if-match': String(ifMatch) } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
  };
  const me = (await call<{ warehouses: Array<{ id: string; code: string }> }>('GET', '/me')).json;
  const wh = me.warehouses.find((w) => w.code === 'WH1')!;
  return {
    call,
    whId: wh.id,
    /** 丢弃已有草稿，基于当前已发布版本新建 */
    async freshDraft(): Promise<LayoutVersion> {
      await call('DELETE', `/warehouses/${wh.id}/layout/draft`);
      const w = (
        await call<{ publishedLayoutVersion: number | null }>('GET', `/warehouses/${wh.id}`)
      ).json;
      return (
        await call<LayoutVersion>('POST', `/warehouses/${wh.id}/layout/draft`, {
          basedOnVersion: w.publishedLayoutVersion,
        })
      ).json;
    },
    async draft(): Promise<LayoutVersion> {
      return (await call<LayoutVersion>('GET', `/warehouses/${wh.id}/layout?version=draft`)).json;
    },
    async saveDraft(doc: LayoutDoc, rowVersion: number) {
      return call<LayoutVersion>('PUT', `/warehouses/${wh.id}/layout/draft`, { doc }, rowVersion);
    },
  };
}

export async function openDesigner(page: Page, user = 'admin') {
  await page.goto(`/?user=${user}`);
  await expect(page.getByTestId('layout-designer')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () =>
      !!(
        window as never as { __wmsLayoutDesigner?: { canvas(): unknown } }
      ).__wmsLayoutDesigner?.canvas(),
  );
}

type Handle = {
  getDoc(): LayoutDoc;
  exec(label: string, fn: (d: LayoutDoc) => LayoutDoc): void;
  select(keys: string[]): void;
  canvas(): {
    rackCorners(k: string): Array<[number, number]> | null;
    worldToScreen(x: number, z: number): [number, number];
    fit(): void;
  };
  flush(): Promise<boolean>;
  rowVersion(): number;
};
export const H = 'window.__wmsLayoutDesigner';
export const getDoc = (page: Page) =>
  page.evaluate(() =>
    (window as never as { __wmsLayoutDesigner: Handle }).__wmsLayoutDesigner.getDoc(),
  );
export const setDoc = (page: Page, doc: LayoutDoc) =>
  page.evaluate(
    (d) =>
      (window as never as { __wmsLayoutDesigner: Handle }).__wmsLayoutDesigner.exec(
        '测试载入',
        () => d,
      ),
    doc,
  );
export const toScreen = (page: Page, x: number, z: number) =>
  page.evaluate(
    ([a, b]) =>
      (window as never as { __wmsLayoutDesigner: Handle }).__wmsLayoutDesigner
        .canvas()
        .worldToScreen(a!, b!),
    [x, z],
  );
export const rackCorners = (page: Page, key: string) =>
  page.evaluate(
    (k) =>
      (window as never as { __wmsLayoutDesigner: Handle }).__wmsLayoutDesigner
        .canvas()
        .rackCorners(k),
    key,
  );
export const fitView = (page: Page) =>
  page.evaluate(() =>
    (window as never as { __wmsLayoutDesigner: Handle }).__wmsLayoutDesigner.canvas().fit(),
  );
export const clickWorld = async (page: Page, x: number, z: number, opts?: { dbl?: boolean }) => {
  const [sx, sy] = await toScreen(page, x, z);
  if (opts?.dbl) await page.mouse.dblclick(sx, sy);
  else await page.mouse.click(sx, sy);
};
export async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', /saved|idle/, {
    timeout: 15_000,
  });
}
