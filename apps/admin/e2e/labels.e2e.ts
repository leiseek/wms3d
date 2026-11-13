import { expect, test } from '@playwright/test';
import { loginToDashboard } from './helpers';

test('标签：仓位 → 模板 → 预览 PDF；货架只显示货架模板', async ({ page }) => {
  await loginToDashboard(page, 'manager');
  await page.getByTestId('nav-labels').click();
  await expect(page.getByTestId('print-guide')).toContainText('实际大小 / 100%');
  await page.getByTestId('label-select-page').click();
  await expect(page.getByTestId('label-selected-count')).not.toHaveText('已选 0');
  await page.getByTestId('label-templates').getByText('loc-100x50').click();
  const req = page.waitForRequest((r) => r.url().includes('/labels/render'));
  await page.getByTestId('label-preview').click();
  const body = (await req).postDataJSON() as { template: string; kind: string; ids: string[] };
  expect(body.template).toBe('loc-100x50');
  expect(body.kind).toBe('LOCATION');
  expect(body.ids.length).toBeGreaterThan(0);
  await expect(page.getByTestId('label-pdf')).toBeVisible();
  await expect(page.getByTestId('label-download')).toBeEnabled();
  await expect(page.getByTestId('label-capacity')).toContainText('容量检查');
  await expect(page.getByTestId('label-job-count')).toBeVisible();

  // A4 多联模板不能选 ZPL
  await page.getByTestId('label-templates').getByText('a4-3x8').click();
  await page.getByTestId('label-format').click();
  await expect(page.locator('.ant-select-item-option-disabled', { hasText: 'ZPL' })).toBeVisible();
  await page.keyboard.press('Escape');

  // 货架：只列出支持 RACK 的模板
  await page.getByTestId('label-kind').getByText('货架标签').click();
  const tpls = page.getByTestId('label-templates');
  await expect(tpls).toContainText('rack-100x150');
  await expect(tpls).not.toContainText('loc-100x50');
});

test('补打队列：申请 → 一键打印 → 标记完成', async ({ page }) => {
  await loginToDashboard(page, 'manager');
  await page.getByTestId('nav-labels').click();
  await page.getByRole('tab', { name: '补打队列' }).click();
  await page.getByTestId('reprint-code').fill('WH1.A02-02-A01');
  await page.getByTestId('reprint-add').click();
  const q = page.getByTestId('reprint-queue');
  const row = q.locator('tr', { hasText: 'A02-02-A01' }).first();
  await expect(row).toBeVisible();
  await row.locator('input[type=checkbox]').check();
  await page.getByTestId('reprint-print').click();
  await expect(page.getByText('补打 1 张')).toBeVisible();
  const req = page.waitForRequest((r) => r.url().includes('/labels/render'));
  await page.getByTestId('label-preview').click();
  const body = (await req).postDataJSON() as { reprintRequestIds?: string[] };
  expect(body.reprintRequestIds).toHaveLength(1);
  await expect(page.getByTestId('label-pdf')).toBeVisible();
  await page.getByRole('tab', { name: '补打队列' }).click();
  await page.getByText('已完成', { exact: true }).click();
  await expect(q.locator('tr', { hasText: 'A02-02-A01' }).first()).toBeVisible();
});

test('标签回读核对：生成后可见通过/失败', async ({ page }) => {
  await loginToDashboard(page, 'manager');
  await page.getByTestId('nav-labels').click();
  await expect(page.getByRole('cell', { name: 'A01-01-A01', exact: true })).toBeVisible();
  await page.getByTestId('label-select-page').click();
  await expect(page.getByText(/已选 [1-9]/)).toBeVisible();
  await page.getByTestId('label-templates').getByText('loc-100x50').click();
  await expect(page.getByTestId('label-preview')).toBeEnabled();
  await page.getByTestId('label-preview').click();
  await expect(page.getByTestId('label-pdf')).toBeVisible();
  const req = page.waitForRequest((r) => r.url().includes('/labels/verify'));
  await page.getByTestId('label-verify').click();
  await req;
  await expect(page.getByTestId('label-verify-summary')).toBeVisible();
  await expect(page.getByTestId('label-verify-result')).toBeVisible();
  await expect(page.getByTestId('label-verify-pass').first()).toBeVisible();
});
