/** 管理后台浏览器冒烟（E2E_UI=1）：经 Vite 代理 /api → e2e 后端。页面随 WS-B 演进，此处只依赖登录页的可访问名称与 data-testid。 */
import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD } from '../../lib/api.ts';

test('admin 登录后显示欢迎信息', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('用户名').fill('manager');
  await page.getByLabel('密码').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page.getByTestId('welcome')).toContainText('MANAGER');
});
