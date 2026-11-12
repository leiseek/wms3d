import { expect, test } from '@playwright/test';
import { login, loginToDashboard } from './helpers';

test('错误密码显示中文错误', async ({ page }) => {
  await login(page, 'admin', 'wrong-password');
  await expect(page.getByTestId('login-error')).toContainText('用户名或密码错误');
});

test('登录 → 管理员建用户 → 新用户强制改密 → 进入看板', async ({ page }) => {
  const username = `e2e${Date.now() % 1_000_000}`;
  await loginToDashboard(page, 'admin');
  await page.getByTestId('nav-users').click();
  await page.getByTestId('user-new').click();
  await page.getByTestId('user-username').fill(username);
  await page.getByTestId('user-display').fill('E2E 操作员');
  await page.getByTestId('user-warehouses').click();
  await page.getByTitle('WH1 演示一号仓').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('user-temp-password').fill('Temp#12345');
  await page.getByTestId('user-save').click();
  await expect(page.getByTestId('users-table')).toContainText(username);
  await expect(page.getByTestId('users-table')).toContainText('待改密');

  await page.getByTestId('user-menu').hover();
  await page.getByText('退出登录').click();
  await expect(page).toHaveURL(/\/login/);

  await login(page, username, 'Temp#12345');
  await expect(page).toHaveURL(/\/change-password/);
  await expect(page.getByTestId('force-change-hint')).toBeVisible();
  // 未改密时访问其他页面被重定向回改密页
  await page.goto('/stock');
  await expect(page).toHaveURL(/\/change-password|\/login/);
  if (page.url().includes('/login')) {
    await login(page, username, 'Temp#12345');
    await expect(page).toHaveURL(/\/change-password/);
  }
  // 当前口令错误 → 400 VALIDATION_FAILED，错误标在“当前密码”字段上（v1.2）
  await page.getByTestId('pwd-current').fill('Wrong#12345');
  await page.getByTestId('pwd-new').fill('NewPass#2026');
  await page.getByTestId('pwd-confirm').fill('NewPass#2026');
  await page.getByTestId('pwd-submit').click();
  await expect(page.locator('#currentPassword_help')).toContainText('当前密码不正确');
  await page.getByTestId('pwd-current').fill('Temp#12345');
  await page.getByTestId('pwd-new').fill('NewPass#2026');
  await page.getByTestId('pwd-confirm').fill('NewPass#2026');
  await page.getByTestId('pwd-submit').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
});
