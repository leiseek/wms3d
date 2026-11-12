import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { loginToDashboard } from './helpers';

const HEADER =
  'code,name,spec,uom,barcode,pack_qty,safety_stock,length_mm,width_mm,height_mm,weight_g';

test('SKU CSV 导入：含错误行 → 错误报告可下载、不能提交；修正后可导入', async ({ page }) => {
  await loginToDashboard(page, 'admin');
  await page.getByTestId('nav-skus').click();
  await page.getByTestId('sku-import-open').click();

  const bad = [
    HEADER,
    'E2E-001,测试商品一,500ml,EA,6909990000011,1,5,,,,',
    ',缺编码,,EA,,1,0,,,,', // REQUIRED code
    'E2E-002,条码冲突,,EA,6909990000011,1,0,,,,', // BARCODE_CONFLICT
    'E2E-003,格式错误,,EA,,abc,0,,,,', // FORMAT pack_qty
  ].join('\n');
  await page
    .getByTestId('sku-import-upload')
    .locator('input[type=file]')
    .setInputFiles({
      name: 'bad.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(bad, 'utf8'),
    });
  await expect(page.getByTestId('sku-import-error-count')).toHaveText('错误 3');
  const errors = page.getByTestId('sku-import-errors');
  await expect(errors).toContainText('REQUIRED');
  await expect(errors).toContainText('BARCODE_CONFLICT');
  await expect(errors).toContainText('FORMAT');
  await expect(page.getByTestId('sku-import-commit')).toBeDisabled();

  const dl = page.waitForEvent('download');
  await page.getByTestId('sku-import-download-errors').click();
  const file = await (await dl).path();
  const report = await readFile(file, 'utf8');
  expect(report).toContain('row,column,error,message,source');
  expect(report).toContain('BARCODE_CONFLICT');
  expect(report.split('\r\n').filter(Boolean)).toHaveLength(4);

  await page.getByRole('button', { name: '重新上传' }).click();
  const good = [
    HEADER,
    'E2E-001,测试商品一,500ml,EA,6909990000011,1,5,,,,',
    'E2E-001,测试商品一,500ml,EA,E2E-001-CASE,12,5,,,,',
  ].join('\n');
  await page
    .getByTestId('sku-import-upload')
    .locator('input[type=file]')
    .setInputFiles({
      name: 'good.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(good, 'utf8'),
    });
  await expect(page.getByTestId('sku-import-error-count')).toHaveText('错误 0');
  await expect(page.getByTestId('sku-import-summary')).toContainText('SKU 1');
  await page.getByTestId('sku-import-commit').click();
  await expect(page.getByText('导入完成')).toBeVisible();
});

test('SKU 列表搜索与新建', async ({ page }) => {
  await loginToDashboard(page, 'admin');
  await page.getByTestId('nav-skus').click();
  await expect(page.getByTestId('sku-table')).toContainText('SKU-001');
  const code = `E2E-N${Date.now() % 100000}`;
  await page.getByTestId('sku-new').click();
  await page.getByTestId('sku-code').fill(code);
  await page.getByTestId('sku-name').fill('E2E 新建商品');
  await page.getByTestId('sku-save').click();
  await expect(page.getByText('已保存')).toBeVisible();
  await page.getByTestId('sku-search').locator('input').fill(code);
  await page.getByTestId('sku-search').locator('input').press('Enter');
  await expect(page.getByTestId('sku-table')).toContainText('E2E 新建商品');
});
