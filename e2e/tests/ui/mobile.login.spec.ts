/** 移动端 Web 冒烟（手机视口，E2E_UI=1）。原生扫码/SPP 由 Robolectric 与真机清单覆盖（09 §5.1）。 */
import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD } from '../../lib/api.ts';

test('mobile 登录页可登录', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('用户名').fill('op1');
  await page.getByLabel('密码').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page.getByTestId('welcome')).toContainText('OPERATOR');
});
