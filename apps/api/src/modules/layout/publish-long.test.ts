import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo } from '@wms3d/domain';
import { pgAvailable } from '../../test/pg.ts';
import { login, setupKit, WH2, type Kit } from '../../lib/testkit.ts';
import { layoutTestHooks } from './publish.ts';

/** 09 §2 #17：发布事务（withLongTransaction 120s）持续 > 60s 不被 wms_app 默认 transaction_timeout=30s 杀掉。 */
describe.skipIf(!pgAvailable || process.env.WMS_SKIP_SLOW_TESTS === '1')('#17 长发布事务', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await setupKit();
  }, 60_000);
  afterAll(async () => {
    layoutTestHooks.beforeCommit = null;
    await k?.close();
  });

  it('提交前 sleep 62s 仍成功提交', async () => {
    const admin = await login(k.app, 'admin');
    const h = admin.h;
    const d = await k.app.inject({
      method: 'POST',
      url: `/api/v1/warehouses/${WH2}/layout/draft`,
      headers: h,
      payload: { basedOnVersion: null },
    });
    const s = await k.app.inject({
      method: 'PUT',
      url: `/api/v1/warehouses/${WH2}/layout/draft`,
      headers: { ...h, 'if-match': String(d.json().rowVersion) },
      payload: { doc: demo.demoLayout },
    });
    layoutTestHooks.beforeCommit = async (c) => {
      await c.query('SELECT pg_sleep(62)');
    };
    const t0 = Date.now();
    const p = await k.app.inject({
      method: 'POST',
      url: `/api/v1/warehouses/${WH2}/layout/publish`,
      headers: h,
      payload: { rowVersion: s.json().rowVersion },
    });
    layoutTestHooks.beforeCommit = null;
    expect(Date.now() - t0).toBeGreaterThan(60_000);
    expect(p.statusCode).toBe(200);
    const n = await k.pool.query(
      `SELECT count(*)::int AS n FROM locations WHERE warehouse_id = $1`,
      [WH2],
    );
    expect(n.rows[0].n).toBe(386);
    // 会话级 transaction_timeout 已复原（连接归还池后不泄漏 120s）
    const tt = await k.app.services.db!.pool.query<{ transaction_timeout: string }>(
      'SHOW transaction_timeout',
    );
    expect(tt.rows[0]!.transaction_timeout).toBe('30s');
  }, 120_000);
});
