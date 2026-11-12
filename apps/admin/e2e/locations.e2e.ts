import { expect, test } from '@playwright/test';
import { loginToDashboard } from './helpers';

test('仓位批量停用：空仓位成功，有库存仓位列入失败清单', async ({ page }) => {
  await loginToDashboard(page, 'manager');
  await page.getByTestId('nav-locations').click();
  // A01-01：A01（有库存）、A02（空）
  await page.getByTestId('loc-search').locator('input').fill('A01-01-A0');
  await page.getByTestId('loc-search').locator('input').press('Enter');
  const table = page.getByTestId('loc-table');
  const rowEmpty = table.locator('tr', { hasText: 'A01-01-A02' });
  const rowStock = table.locator('tr', { hasText: 'A01-01-A01' });
  await expect(rowEmpty).toBeVisible();
  await rowEmpty.locator('input[type=checkbox]').check();
  await rowStock.locator('input[type=checkbox]').check();
  await page.getByTestId('loc-bulk-edit').click();
  await page.getByTestId('loc-bulk-ok').click();
  await expect(page.getByText('1 个仓位未更新')).toBeVisible();
  await expect(page.getByText(/有库存或不可修改：A01-01-A01/)).toBeVisible();
  await expect(rowEmpty).toContainText('停用');
  await expect(rowStock).toContainText('启用');
});
