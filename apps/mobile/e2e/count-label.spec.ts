import { expect, test } from '@playwright/test';
import { hidType, login, nativeHid, LOC1, SKU1, type W } from './helpers';

async function startBlindCount(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    type Api = {
      r: {
        me(a: object): Promise<{ warehouses: { id: string; code: string }[] }>;
        listLocations(a: object): Promise<{ items: { id: string; code: string }[] }>;
        createCount(a: object): Promise<{ id: string; code: string }>;
        startCount(a: object): Promise<unknown>;
      };
    };
    const svc = (window as never as W & { __wms3d: { services: { api: Api } } }).__wms3d.services;
    const me = await svc.api.r.me({});
    const warehouseId = me.warehouses.find((w) => w.code === 'WH1')!.id;
    const locs = await svc.api.r.listLocations({
      params: { id: warehouseId },
      query: { limit: 500 },
    });
    const loc = locs.items.find((x) => x.code === 'A01-01-A01');
    if (!loc) throw new Error('missing A01-01-A01');
    const t = await svc.api.r.createCount({
      body: { warehouseId, scope: { locationIds: [loc.id] }, blind: true },
    });
    await svc.api.r.startCount({ params: { id: t.id }, body: {} });
    return t.code;
  });
}

test('盲盘：选择进行中任务、扫仓位扫 SKU、提交', async ({ page }) => {
  await login(page, 'manager');
  const code = await startBlindCount(page);
  await page.getByTestId('tab-more').click();
  await expect(page.getByTestId('more-page')).toBeVisible();
  await page.getByTestId('menu-count').click();
  await expect(page.getByTestId('count-page')).toBeVisible();
  await page.getByTestId(`count-task-${code}`).click();
  await hidType(page, LOC1);
  await expect(page.getByTestId('count-location')).toContainText('A01-01-A01', { timeout: 10_000 });
  await hidType(page, SKU1);
  await expect(page.getByTestId('count-lines')).toContainText('SKU-001');
  await page.getByTestId('count-submit').click();
  await expect(page.getByTestId('count-msg')).toContainText('已提交', { timeout: 15_000 });
});

test('标签核对：扫仓位码点亮，漏贴列表更新', async ({ page }) => {
  await login(page);
  await page.getByTestId('tab-twin').click();
  await expect(page.getByTestId('twin-page')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () =>
      !!(window as unknown as { __wms3d?: { services?: { md?: { ready?: boolean } } } }).__wms3d
        ?.services?.md?.ready,
    { timeout: 20_000 },
  );
  await page.getByTestId('twin-label-check').click();
  await expect(page.getByTestId('label-check')).toBeVisible();
  await expect(page.getByTestId('label-check-missing')).toContainText('漏贴');
  await nativeHid(page, LOC1);
  await expect(page.getByTestId('label-check-progress')).toContainText('已扫 1', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('label-check-missing')).not.toContainText('A01-01-A01');
});
