import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiSession, loginToDashboard } from './helpers';

test('入库（模拟移动端过账）后：余额与台账可见；交易单冲正', async ({ page, request }) => {
  const s = await apiSession(request, 'op1');
  const refNo = `E2E-IN-${Date.now()}`;
  const r = await s.post<{ txn: { id: string } }>(
    '/inventory/transactions',
    {
      type: 'INBOUND',
      warehouseId: s.warehouseId,
      performedBy: s.userId,
      clientCreatedAt: new Date().toISOString(),
      refNo,
      lines: [{ locationCode: 'WH1.A01-03-B02', skuBarcode: '6900010000745', qty: 7 }],
    },
    { 'idempotency-key': `e2e-${randomUUID()}` },
  );
  expect(r.txn.id).toBeTruthy();

  await loginToDashboard(page, 'manager');
  // 按仓位查余额
  await page.getByTestId('nav-stock').click();
  await page.getByRole('tab', { name: '按仓位' }).click();
  await page.getByTestId('stock-loc-search').locator('input').fill('WH1.A01-03-B02');
  await page.getByTestId('stock-loc-search').locator('input').press('Enter');
  await expect(page.getByRole('row', { name: /SKU-003/ })).toContainText('7');

  // 台账
  await page.getByTestId('nav-movements').click();
  const mv = page.getByTestId('movements-table');
  const row = mv.locator('tr', { hasText: 'A01-03-B02' }).first();
  await expect(row).toContainText('SKU-003');
  await expect(row).toContainText('+7');

  // 交易单 → 冲正
  await page.getByTestId('nav-txns').click();
  await page.getByPlaceholder('单号').fill(refNo);
  await page.getByPlaceholder('单号').press('Enter');
  await page.getByTestId('txns-table').locator('tr', { hasText: refNo }).click();
  await expect(page.getByTestId('txn-detail')).toContainText('入库');
  await page.getByTestId('txn-reverse').click();
  await page.getByTestId('txn-reverse-ok').click();
  await expect(page.getByText('已冲正').first()).toBeVisible();
  await expect(page.getByTestId('txn-reversed')).toBeVisible();
  await expect(page.getByTestId('txn-reverse')).toBeDisabled();
});
