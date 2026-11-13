/**
 * M5 截图与盘点/预警/看板路径（真实 API + admin + mobile web）。
 */
import { mkdir } from 'node:fs/promises';
import { devices, expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD, as, uuidv7 } from '../../lib/api.ts';
import { ports } from '../../lib/env.ts';

const SHOTS = process.env.M5_SHOTS_DIR ?? '/workspace/wms3d-artifacts/screens/m5';

async function loginAdmin(page: Page, user = 'admin') {
  await page.goto(`http://127.0.0.1:${ports.admin}/login`);
  await page.getByTestId('login-username').fill(user);
  await page.getByTestId('login-password').fill(DEMO_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 20_000 });
}

async function loginMobile(page: Page, user = 'op1') {
  await page.goto(`http://127.0.0.1:${ports.mobile}/`);
  await expect(page.getByTestId('login-page')).toBeVisible();
  await page.getByTestId('login-username').fill(user);
  await page.getByTestId('login-password').fill(DEMO_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('work-page')).toBeVisible({ timeout: 20_000 });
}

async function hidType(page: Page, text: string) {
  await page.locator('body').focus();
  await page.keyboard.type(text, { delay: 8 });
  await page.keyboard.press('Enter');
}

test('M5：修后预览/定位/空仓图例 + 盘点/预警/看板', async ({ browser }) => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });

  const adminCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'America/Los_Angeles',
  });
  const adminPage = await adminCtx.newPage();
  await loginAdmin(adminPage);
  await expect(adminPage.getByTestId('dashboard-kpis')).toBeVisible();
  await adminPage.waitForTimeout(1000);
  await adminPage.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });

  await adminPage.getByTestId('dashboard-alerts-link').click();
  await expect(adminPage.getByTestId('alerts-page')).toBeVisible({ timeout: 20_000 });
  await expect(adminPage.getByTestId('alerts-table')).toBeVisible();
  await adminPage.screenshot({ path: `${SHOTS}/alerts.png`, fullPage: true });

  const whId = as('admin').session.warehouses.find((w) => w.code === 'WH1')!.id;
  const locRes = await as('admin').get<{ items: { id: string; code: string }[] }>(
    `/warehouses/${whId}/locations?limit=20`,
  );
  expect(locRes.status, locRes.text).toBe(200);
  const loc = locRes.body.items[0];
  expect(loc).toBeTruthy();
  const created = await as('manager').post<{ id: string; code: string }>('/counts', {
    body: { warehouseId: whId, scope: { locationIds: [loc!.id] }, blind: true },
    idempotencyKey: uuidv7(),
  });
  expect(created.status, created.text).toBe(201);
  await as('manager').post(`/counts/${created.body.id}/start`, { body: {} });

  await adminPage.goto(`http://127.0.0.1:${ports.admin}/counts`);
  await expect(adminPage.getByTestId('counts-page')).toBeVisible();
  await expect(adminPage.getByTestId('counts-table')).toContainText(created.body.code);
  await adminPage.getByText(created.body.code, { exact: false }).first().click();
  await expect(adminPage.getByTestId('count-lines')).toBeVisible({ timeout: 15_000 });
  await expect(adminPage.getByTestId('count-review')).toBeVisible();
  await adminPage.screenshot({ path: `${SHOTS}/stocktake.png`, fullPage: true });

  await adminPage.goto(`http://127.0.0.1:${ports.admin}/layout`);
  const noDraft = adminPage.getByTestId('no-draft');
  const designer = adminPage.getByTestId('layout-designer');
  await expect(noDraft.or(designer)).toBeVisible({ timeout: 30_000 });
  if (await noDraft.isVisible()) {
    const fromCurrent = adminPage.getByTestId('create-draft');
    if (await fromCurrent.isVisible()) await fromCurrent.click();
    else await adminPage.getByTestId('create-blank-draft').click();
  }
  await expect(designer).toBeVisible({ timeout: 30_000 });
  const toggle = adminPage.getByTestId('toggle-3d');
  if (!(await toggle.isChecked().catch(() => false))) await toggle.click();
  await expect(adminPage.getByTestId('twin-preview')).toBeVisible({ timeout: 30_000 });
  await adminPage.waitForTimeout(3500);
  await adminPage.screenshot({ path: `${SHOTS}/designer-3d-preview.png` });

  await adminPage.goto(`http://127.0.0.1:${ports.admin}/twin`);
  await expect(adminPage.getByTestId('twin-page')).toBeVisible();
  await expect(adminPage.getByTestId('twin-legend')).toContainText('空 0%', { timeout: 30_000 });
  await adminPage.waitForTimeout(2500);
  await adminPage.screenshot({ path: `${SHOTS}/twin-desktop-overview.png` });
  const inbound = await as('op1').post('/inventory/transactions', {
    body: {
      type: 'INBOUND',
      warehouseId: whId,
      performedBy: as('op1').session.userId,
      clientCreatedAt: new Date().toISOString(),
      lines: [{ locationCode: `WH1.${loc!.code}`, skuBarcode: '6900010000004', qty: 5 }],
    },
    idempotencyKey: uuidv7(),
  });
  expect(inbound.status, inbound.text).toBe(201);
  const skuCode = 'SKU-001';
  await adminPage.getByTestId('twin-locate').locator('input').fill(skuCode);
  await adminPage.getByTestId('twin-locate').getByRole('button', { name: '定 位' }).click();
  await expect(adminPage.getByTestId('twin-found')).toContainText(skuCode, { timeout: 20_000 });
  await adminPage.waitForTimeout(3500);
  await adminPage.screenshot({ path: `${SHOTS}/twin-desktop.png` });
  await adminPage.getByTestId('twin-legend').screenshot({ path: `${SHOTS}/legend.png` });

  const mobileCtx = await browser.newContext({
    ...devices['Pixel 7'],
    locale: 'zh-CN',
    timezoneId: 'America/Los_Angeles',
  });
  const mobilePage = await mobileCtx.newPage();
  await loginMobile(mobilePage);
  await mobilePage.getByTestId('tab-more').click();
  await mobilePage.getByTestId('menu-count').click();
  await expect(mobilePage.getByTestId('count-page')).toBeVisible();
  await mobilePage.getByText(created.body.code, { exact: false }).first().click();
  await hidType(mobilePage, `WH1.${loc!.code}`);
  await expect(mobilePage.getByTestId('count-location')).toContainText(loc!.code, {
    timeout: 15_000,
  });
  await mobilePage.screenshot({ path: `${SHOTS}/stocktake-mobile.png` });

  await mobilePage.getByTestId('tab-twin').click();
  await expect(mobilePage.getByTestId('twin-page')).toBeVisible();
  await mobilePage.getByTestId('twin-label-check').click();
  await expect(mobilePage.getByTestId('label-check')).toBeVisible();
  await hidType(mobilePage, `WH1.${loc!.code}`);
  await expect(mobilePage.getByTestId('label-check-progress')).toContainText('已扫', {
    timeout: 15_000,
  });
  await mobilePage.waitForTimeout(2000);
  await mobilePage.screenshot({ path: `${SHOTS}/label-check.png` });

  await adminCtx.close();
  await mobileCtx.close();
});
