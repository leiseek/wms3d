import { expect, test } from '@playwright/test';
import { loginToDashboard } from './helpers';

test('盘点：创建任务并开始；低库存预警页与看板入口', async ({ page }) => {
  await loginToDashboard(page, 'manager');
  await expect(page.getByTestId('dashboard-kpis')).toBeVisible();
  await page.getByTestId('dashboard-alerts-link').click();
  await expect(page.getByTestId('alerts-page')).toBeVisible();
  await expect(page.getByTestId('alerts-table')).toBeVisible();

  await page.getByTestId('nav-counts').click();
  await expect(page.getByTestId('counts-page')).toBeVisible();
  await page.getByTestId('counts-create').click();
  const zones = page.getByTestId('counts-zones');
  await zones.click();
  const opt = page.locator('.ant-select-item-option-content').first();
  await expect(opt).toBeVisible();
  await opt.click();
  await page.getByTestId('counts-create-ok').click();
  await expect(page.getByTestId('count-start')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('count-start').click();
  await expect(page.getByTestId('count-review')).toBeVisible({ timeout: 15_000 });
});
