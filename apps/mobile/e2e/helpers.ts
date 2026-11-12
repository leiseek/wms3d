import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'Wms3d#demo';
export const LOC1 = 'WH1.A01-01-A01';
export const LOC2 = 'WH1.A01-01-A02';
export const LOC3 = 'WH1.A01-01-B01';
export const SKU1 = '6900010000004';
export const SKU1_CASE = 'SKU-001-CASE12';
export const SKU2 = '6900010000370';

/** 打开应用并登录（使用应用内键盘之外的直接填写；inputMode=none 不影响 fill） */
export async function login(page: Page, user = 'op1'): Promise<void> {
  if (!page.url().startsWith('http')) await page.goto('/');
  await expect(page.getByTestId('login-page')).toBeVisible();
  await page.getByTestId('login-username').fill(user);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('work-page')).toBeVisible({ timeout: 20_000 });
}

/** 模拟 HID 扫码枪：快速键入 + Enter（走 window keydown 的 JS 节奏判别，不聚焦输入框） */
export async function hidType(page: Page, text: string): Promise<void> {
  await page.locator('body').focus();
  // 每键 8ms（真实扫码枪 5–30ms）；同码 80ms 内的重复帧会被 ScanHub 去重
  await page.keyboard.type(text, { delay: 8 });
  await page.keyboard.press('Enter');
}

/** 模拟原生 pre-IME 拦截层上报（hidScan 事件） */
export async function nativeHid(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => (window as never as W).__wms3d.emitHid(t), text);
}

export async function setOffline(page: Page, offline: boolean): Promise<void> {
  await page.evaluate((o) => ((window as never as W).__wms3d.net.offline = o), offline);
}

export interface W {
  __wms3d: {
    emitHid(t: string): void;
    camera(b: unknown[]): boolean;
    net: { offline: boolean; requests: number };
    mock: {
      store: {
        sessions: Map<string, { id: string; userId: string; endedAt: string | null }>;
        txns:
          | { id: string; type: string; performedBy?: string; createdBy?: string }[]
          | Map<string, unknown>;
        balances: unknown;
      };
    };
  };
}

export async function balanceOf(page: Page, locCode: string, skuCode: string): Promise<number> {
  return page.evaluate(
    ({ locCode, skuCode }) => {
      const s = (window as never as { __wms3d: { mock: { store: Record<string, unknown> } } })
        .__wms3d.mock.store as never as {
        locations: Map<string, { id: string; code: string }>;
        skus: Map<string, { id: string; code: string }>;
        balances: Map<string, { locationId: string; skuId: string; onHand: number }>;
      };
      const code = locCode.replace(/^WH\d+\./, '');
      const loc = [...s.locations.values()].find((l) => l.code === code);
      const sku = [...s.skus.values()].find((k) => k.code === skuCode);
      let n = 0;
      for (const b of s.balances.values())
        if (b.locationId === loc?.id && b.skuId === sku?.id) n += b.onHand;
      return n;
    },
    { locCode, skuCode },
  );
}
