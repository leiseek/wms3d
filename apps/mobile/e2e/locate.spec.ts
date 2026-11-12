import { expect, test } from '@playwright/test';
import { LOC1, LOC2, SKU1, hidType, login } from './helpers.ts';

const SHOTS = process.env.WMS_E2E_SHOTS ?? '/workspace/wms3d-artifacts/screens/ws-c';

test('作业页截图：连续上架进行中（倒计时 + 最近记录）', async ({ page }, info) => {
  await page.goto('/');
  await login(page);
  await hidType(page, LOC2);
  await hidType(page, SKU1);
  await page.getByTestId('btn-confirm').click();
  await expect(page.getByTestId('recent-item').first()).toHaveAttribute('data-status', 'DONE');
  await hidType(page, SKU1);
  await expect(page.getByTestId('countdown')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-putaway.png` });
});

test('SKU 定位 → 在 3D 中查看（twin3d 高亮）', async ({ page }, info) => {
  await page.goto('/');
  await login(page);
  await page.getByTestId('tab-query').click();
  await page.getByTestId('query-input').fill('SKU-001');
  await page.getByTestId('query-go').click();
  await expect(page.getByTestId('locate-result')).toBeVisible();
  await expect(page.getByTestId('locate-row').first()).toContainText('A01-01-A01');
  if (info.project.name === 'phone')
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-locate.png` });

  await page.getByTestId('locate-3d').click();
  await expect(page.getByTestId('twin-page')).toBeVisible();
  await expect(page.getByTestId('twin-highlight')).toContainText('SKU-001');
  await expect(page.locator('.twin-view canvas').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2500); // 启动基准 + 飞行
  if (info.project.name === 'tablet')
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-locate-3d.png` });

  // 扫仓位码查明细
  await page.getByTestId('tab-query').click();
  await hidType(page, LOC1);
  await expect(page.getByTestId('location-result')).toContainText('SKU-001');
});

test('相机扫码：WebView 透明 + 瞄准框 + 2 帧确认', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await hidType(page, LOC2);
  await page.getByTestId('btn-camera').click();
  await expect(page.getByTestId('camera-aim')).toBeVisible();
  const bg = await page.evaluate(() => [
    document.documentElement.classList.contains('barcode-scanner-active'),
    getComputedStyle(document.body).backgroundColor,
    getComputedStyle(document.querySelector('[data-testid=camera-area]')!).backgroundColor,
  ]);
  expect(bg).toEqual([true, 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);

  const r = (await page.getByTestId('camera-aim').boundingBox())!;
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const cx = (r.x + r.width / 2) * dpr;
  const cy = (r.y + r.height / 2) * dpr;
  const at = (x: number, y: number, v: string) => ({
    rawValue: v,
    format: 'EAN_13',
    cornerPoints: [
      [x - 40, y - 20],
      [x + 40, y - 20],
      [x + 40, y + 20],
      [x - 40, y + 20],
    ],
  });
  const emit = (b: unknown[]) =>
    page.evaluate(
      (x) => (window as never as { __wms3d: { camera(b: unknown[]): boolean } }).__wms3d.camera(x),
      b,
    );
  // 框外的码忽略；框内需连续 2 帧
  expect(await emit([at(5, 5, '6900010000370')])).toBe(true);
  await emit([at(cx, cy, SKU1)]);
  await expect(page.getByTestId('pending-line')).toBeHidden();
  await emit([at(cx, cy, SKU1), at(5, 5, '6900010000370')]);
  await expect(page.getByTestId('pending-qty')).toHaveText('1');
  // 同码持续在框内不重复触发
  await emit([at(cx, cy, SKU1)]);
  await emit([at(cx, cy, SKU1)]);
  await expect(page.getByTestId('pending-qty')).toHaveText('1');

  await page.getByTestId('camera-close').click();
  expect(
    await page.evaluate(() =>
      document.documentElement.classList.contains('barcode-scanner-active'),
    ),
  ).toBe(false);
});
