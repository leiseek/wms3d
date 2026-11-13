import { mkdir } from 'node:fs/promises';
import { devices, expect, test, type Page } from '@playwright/test';
import { loginToDashboard, SHOTS } from './helpers';

/** 冒烟：所有页面无控制台错误；并输出交付截图到 SHOTS 目录。 */
function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (
      (m.type() === 'error' || m.type() === 'warning') &&
      !/WebGL|GPU|swiftshader|Failed to load resource|GL Driver|React DevTools/i.test(m.text())
    )
      errors.push(m.text());
  });
  // HTTP 失败单独记录（预期：启动时无 cookie 的 /auth/refresh 401；设计器探测草稿不存在的 404）
  page.on('response', (r) => {
    if (r.status() >= 400 && !/\/auth\/refresh|favicon|\/layout\?version=draft/.test(r.url()))
      errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return errors;
}

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test('所有页面可打开且无控制台错误（admin）', async ({ page }) => {
  const errors = trackErrors(page);
  await loginToDashboard(page, 'admin');
  for (const path of [
    '/stock',
    '/movements',
    '/transactions',
    '/adjust',
    '/skus',
    '/locations',
    '/warehouses',
    '/rack-types',
    '/layout',
    '/labels',
    '/users',
    '/audit',
    '/twin',
    '/',
  ]) {
    await page.goto(path);
    await expect(
      page
        .locator('.ant-layout-content')
        .locator('h4, [data-testid=layout-designer], [data-testid=no-draft]')
        .first(),
      path,
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800); // 让页面查询完成（/twin 有 SSE 长连接，不能等 networkidle）
  }
  expect(errors).toEqual([]);
});

test('截图：看板、SKU 列表、标签预览、库存查询 + 3D 定位', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  await loginToDashboard(page, 'admin');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${SHOTS}/01-dashboard.png`, fullPage: true });

  await page.getByTestId('nav-skus').click();
  await expect(page.getByTestId('sku-table')).toContainText('SKU-001');
  await page.screenshot({ path: `${SHOTS}/02-sku-list.png`, fullPage: true });

  await page.getByTestId('nav-labels').click();
  await page.getByPlaceholder('货架码，如 A01-L01').fill('RA01-L01');
  await page.getByPlaceholder('货架码，如 A01-L01').press('Enter');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('label-select-page').click();
  await page.getByTestId('label-templates').getByText('loc-100x50').click();
  await page.getByTestId('label-preview').click();
  await expect(page.getByTestId('label-pdf')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/03-label-print-preview.png`, fullPage: true });

  await page.getByTestId('nav-stock').click();
  await page.getByTestId('stock-sku-search').locator('input').fill('SKU-001');
  await page.getByTestId('stock-sku-search').locator('input').press('Enter');
  await expect(page.getByTestId('stock-sku-table')).toContainText('矿泉水');
  await page.screenshot({ path: `${SHOTS}/04-stock-by-sku.png`, fullPage: true });
  await page.getByTestId('stock-locate-all').click();
  await expect(page.getByTestId('twin-panel')).toBeVisible();
  await expect(page.getByText(/布局 v\d+ · \d+ 仓位/)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(4000); // 相机飞行 + 首帧
  await page.screenshot({ path: `${SHOTS}/05-stock-3d-locate.png` });

  await page.keyboard.press('Escape');
  await page.getByTestId('nav-twin').click();
  await page.getByTestId('twin-locate').locator('input').fill('SKU-002');
  await page.getByTestId('twin-locate').locator('input').press('Enter');
  await expect(page.getByTestId('twin-found')).toContainText('SKU-002');
  await expect(page.getByTestId('twin-sse')).toHaveText('实时', { timeout: 15_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/06-twin-live-locate.png` });
  expect(errors).toEqual([]);
});

const M45 = process.env.M45_SHOTS_DIR ?? '/workspace/wms3d-artifacts/screens/m4.5';

test('M4.5 截图：设计器 3D 预览、标签核对、孪生图例（桌面）', async ({ page }) => {
  test.setTimeout(120_000);
  await mkdir(M45, { recursive: true });
  await loginToDashboard(page, 'admin');

  await page.goto('/layout');
  const noDraft = page.getByTestId('no-draft');
  if (await noDraft.isVisible().catch(() => false)) {
    const fromCurrent = page.getByTestId('create-draft');
    if (await fromCurrent.isVisible()) await fromCurrent.click();
    else await page.getByTestId('create-blank-draft').click();
  }
  await expect(page.getByTestId('layout-designer')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('toggle-3d').click();
  await expect(page.getByTestId('twin-preview')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${M45}/designer-3d-preview.png` });

  await page.goto('/labels');
  await page.getByTestId('label-select-page').click();
  await page.getByTestId('label-templates').getByText('loc-100x50').click();
  await page.getByTestId('label-preview').click();
  await expect(page.getByTestId('label-pdf')).toBeVisible();
  await page.getByTestId('label-verify').click();
  await expect(page.getByTestId('label-verify-summary')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${M45}/label-verify.png`, fullPage: true });

  await page.goto('/twin');
  await expect(page.getByTestId('twin-page')).toBeVisible();
  await expect(page.getByTestId('twin-legend')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('twin-legend')).toContainText('空 0%');
  await expect(page.getByTestId('twin-legend')).toContainText('<50%');
  await expect(page.getByTestId('twin-legend')).toContainText('50–90%');
  await expect(page.getByTestId('twin-legend')).toContainText('>90% 满');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${M45}/twin-desktop.png` });
  const legend = page.getByTestId('twin-legend');
  await legend.screenshot({ path: `${M45}/legend.png` });
});

test('M4.5 截图：孪生手机视口', async ({ browser }) => {
  test.setTimeout(120_000);
  await mkdir(M45, { recursive: true });
  const ctx = await browser.newContext({
    ...devices['Pixel 7'],
    locale: 'zh-CN',
    timezoneId: 'America/Los_Angeles',
  });
  const page = await ctx.newPage();
  await loginToDashboard(page, 'admin');
  await page.goto('/twin');
  await expect(page.getByTestId('twin-legend')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${M45}/twin-phone.png` });
  await ctx.close();
});
