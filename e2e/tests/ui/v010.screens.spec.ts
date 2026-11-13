/**
 * v0.1.0 交付截图：同一份 seed:demo（主数据 + 约 65% 占用 + 多日流水 + 低库存 + 进行中盘点）。
 */
import { mkdir } from 'node:fs/promises';
import { devices, expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD } from '../../lib/api.ts';
import { ports } from '../../lib/env.ts';
import { EMPTY_LOCS, SKU1 } from '../../lib/fixtures.ts';

const SHOTS = process.env.V010_SHOTS_DIR ?? '/workspace/wms3d-artifacts/screens/v0.1.0';
const SKU_BARCODE = SKU1.barcodes[0]!.barcode;
const SKU_CODE = SKU1.code;

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

test('v0.1.0 交付截图（同一演示实例）', async ({ browser }) => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });

  const adminCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'America/Los_Angeles',
  });
  const adminPage = await adminCtx.newPage();
  await loginAdmin(adminPage);
  await expect(adminPage.getByTestId('dashboard-kpis')).toBeVisible();
  await expect(adminPage.getByText(/今日入库/).first()).toBeVisible();
  await adminPage.waitForTimeout(800);
  await adminPage.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });

  await adminPage.getByTestId('dashboard-alerts-link').click();
  await expect(adminPage.getByTestId('alerts-page')).toBeVisible({ timeout: 20_000 });
  await adminPage.screenshot({ path: `${SHOTS}/alerts.png`, fullPage: true });

  await adminPage.goto(`http://127.0.0.1:${ports.admin}/counts`);
  await expect(adminPage.getByTestId('counts-page')).toBeVisible();
  await adminPage.getByTestId('counts-table').locator('tr').nth(1).click();
  await expect(adminPage.getByTestId('count-lines')).toBeVisible({ timeout: 15_000 });
  await adminPage.screenshot({ path: `${SHOTS}/stocktake.png`, fullPage: true });

  await adminPage.goto(`http://127.0.0.1:${ports.admin}/stock`);
  await expect(
    adminPage.getByTestId('stock-page').or(adminPage.locator('table').first()),
  ).toBeVisible({
    timeout: 20_000,
  });
  await adminPage.waitForTimeout(800);
  await adminPage.screenshot({ path: `${SHOTS}/stock.png`, fullPage: true });

  await adminPage.goto(`http://127.0.0.1:${ports.admin}/labels`);
  await expect(adminPage.getByRole('cell', { name: 'A01-01-A01', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await adminPage.getByTestId('label-select-page').click();
  await expect(adminPage.getByText(/已选 [1-9]/)).toBeVisible();
  await adminPage.getByTestId('label-templates').getByText('loc-100x50').click();
  await expect(adminPage.getByTestId('label-preview')).toBeEnabled();
  await adminPage.getByTestId('label-preview').click();
  await expect(adminPage.getByTestId('label-pdf')).toBeVisible({ timeout: 30_000 });
  await adminPage.screenshot({ path: `${SHOTS}/labels.png`, fullPage: true });

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
  await adminPage.getByTestId('twin-locate').locator('input').fill(SKU_CODE);
  await adminPage.getByTestId('twin-locate').getByRole('button', { name: '定 位' }).click();
  await expect(adminPage.getByTestId('twin-found')).toContainText(SKU_CODE, { timeout: 20_000 });
  await adminPage.waitForTimeout(3500);
  await adminPage.screenshot({ path: `${SHOTS}/twin-desktop-locate.png` });

  const empty = EMPTY_LOCS[0]!;
  const locPayload = empty.payload.startsWith('WH') ? empty.payload : `WH1.${empty.code}`;

  const shootMobile = async (
    ctxName: 'phone' | 'tablet',
    device: (typeof devices)[string] | { viewport: { width: number; height: number } },
  ) => {
    const ctx = await browser.newContext({
      ...device,
      locale: 'zh-CN',
      timezoneId: 'America/Los_Angeles',
    });
    const page = await ctx.newPage();
    await loginMobile(page);
    await expect(page.getByTestId('mode-PUTAWAY')).toBeVisible();
    await hidType(page, locPayload);
    await expect(page.getByTestId('current-location')).toHaveText(empty.code, { timeout: 15_000 });
    await hidType(page, SKU_BARCODE);
    const confirm = page.getByTestId('btn-confirm');
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect(page.getByTestId('recent-item').first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/inbound-${ctxName}.png` });

    await page.getByTestId('mode-PICK').click();
    await hidType(page, locPayload);
    await expect(page.getByTestId('current-location')).toHaveText(empty.code, { timeout: 15_000 });
    await hidType(page, SKU_BARCODE);
    const pickConfirm = page.getByTestId('btn-confirm');
    if (await pickConfirm.isVisible().catch(() => false)) await pickConfirm.click();
    await expect(page.getByTestId('recent-item').first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/outbound-${ctxName}.png` });

    await page.getByTestId('tab-query').click();
    await page.getByTestId('query-input').fill(SKU_CODE);
    await page.getByTestId('query-go').click();
    await expect(page.getByTestId('locate-result')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('locate-3d').click();
    await expect(page.getByTestId('twin-page')).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SHOTS}/twin-${ctxName}-locate.png` });
    await ctx.close();
  };

  await shootMobile('phone', devices['Pixel 7']);
  await shootMobile('tablet', {
    ...devices['Pixel 7'],
    viewport: { width: 1280, height: 800 },
    isMobile: true,
  });

  await adminCtx.close();
});
