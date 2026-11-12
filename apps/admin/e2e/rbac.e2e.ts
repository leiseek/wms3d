import { expect, test } from '@playwright/test';
import { loginToDashboard } from './helpers';

test('viewer：菜单无写入口、页面无写按钮、越权路径 403', async ({ page }) => {
  await loginToDashboard(page, 'viewer');
  const menu = page.getByTestId('side-menu');
  await expect(menu).toContainText('库存查询');
  await expect(menu).toContainText('SKU');
  await expect(menu).not.toContainText('用户与设备');
  await expect(menu).not.toContainText('调整 / 移库');
  await expect(menu).not.toContainText('标签打印');
  await expect(menu).not.toContainText('审计日志');
  await expect(menu).not.toContainText('布局设计器');

  await page.getByTestId('nav-skus').click();
  await expect(page.getByTestId('sku-table')).toContainText('SKU-001');
  await expect(page.getByTestId('sku-new')).toHaveCount(0);
  await expect(page.getByTestId('sku-import-open')).toHaveCount(0);

  await page.getByTestId('nav-locations').click();
  await expect(page.getByTestId('loc-table')).toBeVisible();
  await expect(page.getByTestId('loc-bulk-edit')).toHaveCount(0);

  await page.goto('/users');
  await expect(page.getByText('没有权限')).toBeVisible();
  await page.goto('/adjust');
  await expect(page.getByText('没有权限')).toBeVisible();
});

test('admin：完整菜单；manager 无用户管理', async ({ page }) => {
  await loginToDashboard(page, 'admin');
  await expect(page.getByTestId('side-menu')).toContainText('用户与设备');
  await expect(page.getByTestId('side-menu')).toContainText('布局设计器');
  await page.getByTestId('nav-layout').click();
  await expect(page.getByTestId('layout-designer').or(page.getByTestId('no-draft'))).toBeVisible({
    timeout: 30_000,
  });
});

test('manager：有调整/标签/审计，无用户管理', async ({ page }) => {
  await loginToDashboard(page, 'manager');
  const menu = page.getByTestId('side-menu');
  await expect(menu).toContainText('调整 / 移库');
  await expect(menu).toContainText('标签打印');
  await expect(menu).toContainText('审计日志');
  await expect(menu).not.toContainText('用户与设备');
});
