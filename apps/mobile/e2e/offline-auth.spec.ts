import { expect, test, type Page } from '@playwright/test';
import {
  LOC1,
  LOC3,
  SKU1,
  SKU2,
  balanceOf,
  hidType,
  login,
  setOffline,
  type W,
} from './helpers.ts';

async function putaway(page: Page, sku: string) {
  await hidType(page, sku);
  await expect(page.getByTestId('pending-line')).toBeVisible();
  await page.getByTestId('btn-confirm').click();
  await expect(page.getByTestId('pending-line')).toBeHidden();
}

test('离线 10 单 → 恢复网络后按序自动补传', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await setOffline(page, true);
  await hidType(page, LOC3);
  await expect(page.getByTestId('current-location')).toHaveText('A01-01-B01');
  for (let i = 0; i < 10; i++) await putaway(page, i % 2 ? SKU2 : SKU1);
  await expect(page.getByTestId('offline-note')).toBeVisible();
  await expect(page.getByTestId('sb-net')).toHaveText('离线');
  await expect(page.getByTestId('sb-pending')).toHaveText('待传 10');
  await expect(page.locator('[data-testid=recent-item][data-status=DONE]')).toHaveCount(0);
  expect(await balanceOf(page, LOC3, 'SKU-001')).toBe(0);

  await setOffline(page, false);
  await expect(page.getByTestId('sb-pending')).toHaveText('待传 0', { timeout: 30_000 });
  await expect(page.getByTestId('sb-net')).toHaveText('在线');
  expect(await balanceOf(page, LOC3, 'SKU-001')).toBe(5);
  expect(await balanceOf(page, LOC3, 'SKU-002')).toBe(5);
  // 幂等键：每单一笔交易，无重复入账
  const n = await page.evaluate(
    () => (window as never as W).__wms3d.mock.store.txns as unknown as { refNo: string | null }[],
  );
  expect(n.filter((t) => t.refNo !== 'SEED')).toHaveLength(10);
});

test('令牌过期 → BLOCKED_AUTH 暂停 → 重新登录后继续上传', async ({ page }) => {
  await page.goto('/');
  await login(page);
  // 服务端结束会话：access 失效、refresh 失败
  await page.evaluate(() => {
    for (const s of (window as never as W).__wms3d.mock.store.sessions.values())
      if (!s.endedAt) s.endedAt = new Date().toISOString();
  });
  await hidType(page, LOC1);
  await putaway(page, SKU2);
  await expect(page.getByTestId('auth-blocked')).toBeVisible();
  await expect(page.getByTestId('recent-item').first()).toHaveAttribute(
    'data-status',
    'BLOCKED_AUTH',
  );
  await expect(page.getByTestId('sb-pending')).toHaveText('待传 1');

  await page.getByTestId('relogin').click();
  await expect(page.getByTestId('login-pending')).toContainText('1 条待传');
  await login(page);
  await expect(page.getByTestId('sb-pending')).toHaveText('待传 0');
  await expect(page.getByTestId('auth-blocked')).toBeHidden();
  expect(await balanceOf(page, LOC1, 'SKU-002')).toBe(1);
});

test('换班代交：A 离线单据由 B 登录后上传（performedBy=A）；伪造的代交被拒', async ({ page }) => {
  await page.goto('/');
  await login(page, 'op1');
  await setOffline(page, true);
  await hidType(page, LOC3);
  await putaway(page, SKU1);
  await putaway(page, SKU2);
  await expect(page.getByTestId('sb-pending')).toHaveText('待传 2');
  // 伪造：把第二单的 performerSessionId 改成不存在的会话
  await page.evaluate(async () => {
    const ob = (window as never as W & { __wms3d: { services: { outbox: unknown } } }).__wms3d
      .services.outbox as {
      store: {
        list(): Promise<{ payload: { performerSessionId?: string }; label: string }[]>;
        put(e: unknown): Promise<void>;
      };
    };
    const all = await ob.store.list();
    const e = all[all.length - 1]!;
    await ob.store.put({
      ...e,
      payload: { ...e.payload, performerSessionId: crypto.randomUUID() },
    });
  });

  await page.getByTestId('tab-more').click();
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login-pending')).toContainText('2 条待传');
  await setOffline(page, false);
  await login(page, 'op2');
  await expect(page.getByTestId('sb-pending')).toHaveText('待传 0', { timeout: 20_000 });
  await expect(page.getByTestId('reject-overlay')).toBeVisible();
  await expect(page.getByTestId('reject-message')).toContainText('PERFORMER_NOT_ALLOWED');
  await page.getByTestId('reject-ack').click();
  await expect(page.getByTestId('sb-rejected')).toHaveText('异常 1');

  const txns = await page.evaluate(() =>
    (
      (window as never as W).__wms3d.mock.store.txns as unknown as {
        refNo: string | null;
        performedBy: string;
        submittedBy: string;
      }[]
    ).filter((t) => t.refNo !== 'SEED'),
  );
  expect(txns).toHaveLength(1);
  expect(txns[0]!.performedBy).not.toBe(txns[0]!.submittedBy); // A 执行、B 提交
  expect(await balanceOf(page, LOC3, 'SKU-001')).toBe(1);
  expect(await balanceOf(page, LOC3, 'SKU-002')).toBe(0);

  // 异常单页：可见并可作废
  await page.getByTestId('sb-rejected').click();
  await expect(page.getByTestId('exception-item')).toHaveCount(1);
  await page.getByTestId('exc-discard').click();
  await expect(page.getByTestId('exception-item')).toHaveCount(0);
});
