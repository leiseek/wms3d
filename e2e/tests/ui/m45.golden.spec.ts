/**
 * M4.5 黄金路径（真实 API + admin + mobile web）：
 * 设计布局 → 发布 → 打印标签并回读核对 → 扫码上架 → 3D 可见 → 定位 SKU → 出库。
 */
import { mkdir } from 'node:fs/promises';
import { devices, expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD, as } from '../../lib/api.ts';
import { ports } from '../../lib/env.ts';

const SHOTS = process.env.M45_SHOTS_DIR ?? '/workspace/wms3d-artifacts/screens/m4.5';
const SKU_BARCODE = '6900010000004';
const SKU_CODE = 'SKU-001';

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

test('黄金路径：设计→发布→打印核对→上架→3D→定位→出库', async ({ browser }) => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });

  const adminCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'America/Los_Angeles',
  });
  const adminPage = await adminCtx.newPage();
  await loginAdmin(adminPage);

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
  await adminPage.waitForTimeout(3000);
  await adminPage.screenshot({ path: `${SHOTS}/designer-3d-preview.png` });

  await adminPage.getByTestId('publish').click();
  await expect(adminPage.getByTestId('publish-dialog')).toBeVisible({ timeout: 20_000 });
  const recode = adminPage.getByTestId('recode-confirm');
  if (await recode.isVisible().catch(() => false)) await recode.check();
  const confirm = adminPage.getByTestId('publish-confirm');
  await expect(confirm).toBeEnabled({ timeout: 20_000 });
  await confirm.click();
  await expect(adminPage.getByTestId('publish-done')).toContainText('已发布 v', {
    timeout: 30_000,
  });
  await adminPage.getByTestId('publish-close').click();

  await adminPage.goto(`http://127.0.0.1:${ports.admin}/labels`);
  await adminPage.getByTestId('label-select-page').click();
  await adminPage.getByTestId('label-templates').getByText('loc-100x50').click();
  await adminPage.getByTestId('label-preview').click();
  await expect(adminPage.getByTestId('label-pdf')).toBeVisible({ timeout: 30_000 });
  await adminPage.getByTestId('label-verify').click();
  await expect(adminPage.getByTestId('label-verify-summary')).toBeVisible({ timeout: 60_000 });
  await expect(adminPage.getByTestId('label-verify-pass').first()).toBeVisible();
  await adminPage.screenshot({ path: `${SHOTS}/label-verify.png`, fullPage: true });

  const whId = as('admin').session.warehouses.find((w) => w.code === 'WH1')!.id;
  const locRes = await as('admin').get<{
    items: { id: string; code: string; isActive?: boolean }[];
  }>(`/warehouses/${whId}/locations?limit=500`);
  expect(locRes.status, locRes.text).toBe(200);
  const balRes = await as('admin').get<{ items: { locationId: string; onHand: number }[] }>(
    `/inventory/balances?warehouseId=${whId}&limit=500`,
  );
  expect(balRes.status, balRes.text).toBe(200);
  const stocked = new Set(
    (balRes.body.items ?? []).filter((b) => b.onHand > 0).map((b) => b.locationId),
  );
  const empty = (locRes.body.items ?? []).find(
    (l) => !stocked.has(l.id) && l.isActive !== false && /^[A-Z]\d\d-\d\d-[A-Z]\d\d$/.test(l.code),
  );
  expect(empty, '需要一个空仓位做上架').toBeTruthy();
  const locPayload = `WH1.${empty!.code}`;

  const mobileCtx = await browser.newContext({
    ...devices['Pixel 7'],
    locale: 'zh-CN',
    timezoneId: 'America/Los_Angeles',
  });
  const mobilePage = await mobileCtx.newPage();
  await loginMobile(mobilePage);
  await expect(mobilePage.getByTestId('mode-PUTAWAY')).toBeVisible();
  await hidType(mobilePage, locPayload);
  await expect(mobilePage.getByTestId('current-location')).toHaveText(empty!.code, {
    timeout: 15_000,
  });
  await hidType(mobilePage, SKU_BARCODE);
  const confirmBtn = mobilePage.getByTestId('btn-confirm');
  if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
  await expect(mobilePage.getByTestId('recent-item').first()).toHaveAttribute(
    'data-status',
    'DONE',
    {
      timeout: 20_000,
    },
  );

  await adminPage.goto(`http://127.0.0.1:${ports.admin}/twin`);
  await expect(adminPage.getByTestId('twin-page')).toBeVisible();
  await expect(adminPage.getByTestId('twin-legend')).toContainText('空 0%', { timeout: 30_000 });
  await expect(adminPage.getByTestId('twin-legend')).toContainText('<50%');
  await expect(adminPage.getByTestId('twin-legend')).toContainText('50–90%');
  await expect(adminPage.getByTestId('twin-legend')).toContainText('>90% 满');
  await adminPage.getByTestId('twin-locate').locator('input').fill(SKU_CODE);
  await adminPage.getByTestId('twin-locate').locator('input').press('Enter');
  await expect(adminPage.getByTestId('twin-found')).toContainText(SKU_CODE, { timeout: 20_000 });
  await adminPage.waitForTimeout(4000);
  await adminPage.screenshot({ path: `${SHOTS}/twin-desktop.png` });
  await adminPage.getByTestId('twin-legend').screenshot({ path: `${SHOTS}/legend.png` });

  await mobilePage.getByTestId('tab-query').click();
  await mobilePage.getByTestId('query-input').fill(SKU_CODE);
  await mobilePage.getByTestId('query-go').click();
  await expect(mobilePage.getByTestId('locate-result')).toBeVisible({ timeout: 20_000 });
  await expect(mobilePage.getByTestId('locate-row').filter({ hasText: empty!.code })).toBeVisible();
  await mobilePage.getByTestId('locate-3d').click();
  await expect(mobilePage.getByTestId('twin-page')).toBeVisible();
  await expect(mobilePage.getByTestId('twin-highlight')).toContainText(SKU_CODE);
  await expect(
    mobilePage.locator('.twin-view canvas, [data-testid=twin-page] canvas').first(),
  ).toBeVisible({
    timeout: 20_000,
  });
  await mobilePage.waitForTimeout(3000);
  await mobilePage.screenshot({ path: `${SHOTS}/twin-phone.png` });

  await mobilePage.getByTestId('tab-work').click();
  await mobilePage.getByTestId('mode-PICK').click();
  await hidType(mobilePage, locPayload);
  await expect(mobilePage.getByTestId('current-location')).toHaveText(empty!.code, {
    timeout: 15_000,
  });
  await hidType(mobilePage, SKU_BARCODE);
  const pickConfirm = mobilePage.getByTestId('btn-confirm');
  if (await pickConfirm.isVisible().catch(() => false)) await pickConfirm.click();
  await expect(mobilePage.getByTestId('recent-item').first()).toHaveAttribute(
    'data-status',
    'DONE',
    {
      timeout: 20_000,
    },
  );

  await adminCtx.close();
  await mobileCtx.close();
});
