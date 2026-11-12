import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
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
