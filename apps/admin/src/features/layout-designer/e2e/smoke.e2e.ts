import { expect, test } from '@playwright/test';
import { http, openDesigner, SHOTS } from './helpers';

test('载入演示仓草稿', async ({ page }) => {
  const h = await http();
  await h.freshDraft();
  await openDesigner(page);
  await expect(page.getByTestId('doc-props')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/_smoke.png` });
});
