import { expect, test } from '@playwright/test';
import {
  LOC1,
  LOC2,
  SKU1,
  SKU1_CASE,
  SKU2,
  balanceOf,
  hidType,
  login,
  nativeHid,
} from './helpers.ts';

test('登录 → 连续上架（HID 键入）→ 空闲自动提交 → 撤销', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await expect(page.getByTestId('prompt')).toHaveText('请扫仓位');

  await hidType(page, LOC2);
  await expect(page.getByTestId('current-location')).toHaveText('A01-01-A02');
  await hidType(page, SKU1);
  await expect(page.getByTestId('pending-qty')).toHaveText('1');
  await hidType(page, SKU1);
  await hidType(page, SKU1);
  await expect(page.getByTestId('pending-qty')).toHaveText('3');
  await expect(page.getByTestId('countdown')).toBeVisible();
  // 空闲 3s 自动提交 → 灰勾 → 服务端确认绿勾
  await expect(page.getByTestId('recent-item').first()).toHaveAttribute('data-status', 'DONE', {
    timeout: 10_000,
  });
  await expect.poll(() => balanceOf(page, LOC2, 'SKU-001')).toBe(3);
  await expect(page.getByTestId('current-location')).toHaveText('A01-01-A02'); // 仓位粘滞

  // 扫另一 SKU（原生拦截层事件）→ 箱码 ×12 → 手动确认
  await nativeHid(page, SKU1_CASE);
  await expect(page.getByTestId('pending-qty')).toHaveText('12');
  await page.getByTestId('btn-confirm').click();
  await expect(page.getByTestId('recent-item')).toHaveCount(2);
  await expect(page.getByTestId('recent-item').first()).toHaveAttribute('data-status', 'DONE');
  await expect.poll(() => balanceOf(page, LOC2, 'SKU-001')).toBe(15);

  // 撤销上一笔（已 DONE → 冲正）
  await page.getByTestId('btn-undo').click();
  await expect(page.getByTestId('recent-item').first()).toHaveAttribute('data-status', 'CANCELLED');
  await expect.poll(() => balanceOf(page, LOC2, 'SKU-001')).toBe(3);

  // 新 SKU 自动提交前切换仓位：先提交当前行
  await hidType(page, SKU2);
  await hidType(page, LOC1);
  await expect(page.getByTestId('current-location')).toHaveText('A01-01-A01');
  await expect.poll(() => balanceOf(page, LOC2, 'SKU-002')).toBe(1);
});

test('意外码打断式拒绝：遮罩期间扫码被丢弃', async ({ page }) => {
  await page.goto('/');
  await login(page);
  // 未扫仓位先扫 SKU
  await hidType(page, SKU1);
  await expect(page.getByTestId('hint')).toContainText('仓位');
  // 未知仓位格式 / 其他仓库条码
  await hidType(page, 'WH2.A01-01-A01');
  await expect(page.getByTestId('reject-overlay')).toBeVisible();
  await expect(page.getByTestId('reject-message')).toContainText('WH2');
  await hidType(page, LOC1); // 遮罩期间丢弃
  await page.getByTestId('reject-ack').click();
  await expect(page.getByTestId('reject-overlay')).toBeHidden();
  await expect(page.getByTestId('current-location')).toHaveText('—');
  // 完全未知的码
  await hidType(page, LOC1);
  await expect(page.getByTestId('current-location')).toHaveText('A01-01-A01');
  await hidType(page, 'ZZZ-NOT-A-CODE-999');
  await expect(page.getByTestId('reject-overlay')).toBeVisible();
  await page.getByTestId('reject-ack').click();
  await expect(page.getByTestId('current-location')).toHaveText('A01-01-A01');
});
