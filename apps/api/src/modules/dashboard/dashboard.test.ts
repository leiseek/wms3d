import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, Dashboard } from '@wms3d/contracts';
import { z } from 'zod';
import { createKit, cmd, DEVICE, fresh, SKUS, WH1, WH2, type Kit } from '../inventory/testkit.ts';
import { reconcile } from '../../jobs/reconcile.ts';

const S = (i: number) => SKUS[i]!.id;

describe('dashboard + audit（PG 集成）', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await createKit();
  });
  afterAll(async () => k?.close());
  const dash = async (token = 'viewer') => {
    const r = await k.req(token, { method: 'GET', url: `/api/v1/dashboard?warehouseId=${WH1}` });
    expect(r.statusCode).toBe(200);
    return Dashboard.parse(r.json());
  };

  it('看板：今日计数按仓库时区业务时间；待同步、对账、备份、补打', async () => {
    const d0 = await dash();
    expect(d0.reconcile).toEqual({ lastRunAt: null, mismatches: null });
    expect(d0.backup).toEqual({ lastLocalAt: null, lastRemoteAt: null, remoteConfigured: false });
    const L = fresh();
    expect(
      (await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(1), qty: 10 }]))).statusCode,
    ).toBe(201);
    // client_created_at 与服务端相差 > 24h → 按 created_at 计入今日
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    expect(
      (
        await k.txn(
          'op1',
          cmd('INBOUND', [{ locationId: L, skuId: S(1), qty: 1 }], { clientCreatedAt: old }),
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (await k.txn('op1', cmd('OUTBOUND', [{ locationId: L, skuId: S(1), qty: 2 }]))).statusCode,
    ).toBe(201);
    expect(
      (
        await k.txn(
          'manager',
          cmd('ADJUST', [{ locationId: L, skuId: S(1), qtyDelta: 1 }], {}, 'manager'),
        )
      ).statusCode,
    ).toBe(201);
    // 业务日起点（Asia/Shanghai）；若距今 < 23h，则构造一笔 client_created_at 落在昨天的交易（不计入今日）
    const st = await k.db.pool.query<{ start: Date }>(
      `SELECT date_trunc('day', now() AT TIME ZONE timezone) AT TIME ZONE timezone AS start FROM warehouses WHERE id = $1`,
      [WH1],
    );
    const start = st.rows[0]!.start.getTime();
    if (Date.now() - start < 23 * 3600_000) {
      const r = await k.txn(
        'op1',
        cmd('TRANSFER', [{ fromLocationId: L, toLocationId: fresh(), skuId: S(1), qty: 1 }], {
          clientCreatedAt: new Date(start - 30 * 60_000).toISOString(),
        }),
      );
      expect(r.statusCode).toBe(201);
    }
    await k.owner.query(
      `UPDATE devices SET pending_outbox = 3, pending_warehouse_id = $2 WHERE id = $1`,
      [DEVICE, WH1],
    );
    await k.owner.query(`INSERT INTO ops_status (key, value) VALUES ('backup', $1)`, [
      JSON.stringify({
        lastLocalAt: '2026-11-12T01:00:00.000Z',
        lastRemoteAt: null,
        remoteConfigured: true,
      }),
    ]);
    await k.owner.query(
      `INSERT INTO label_reprint_requests (warehouse_id, kind, entity_id, reason, requested_by) VALUES ($1,'LOCATION',$2,'DAMAGED',$3)`,
      [WH1, L, k.auth.get('op1')!.userId],
    );
    await reconcile(k.db.pool, { full: true });
    const d = await dash();
    expect(d.today).toEqual({
      inbound: d0.today.inbound + 2,
      outbound: d0.today.outbound + 1,
      transfer: d0.today.transfer, // 昨天的 TRANSFER（若构造）不计入
      adjust: d0.today.adjust + 1,
    });
    expect(d.pendingSync).toEqual({ devices: 1, records: 3 });
    expect(d.reconcile.mismatches).toBe(0);
    expect(d.reconcile.lastRunAt).not.toBeNull();
    expect(d.backup).toEqual({
      lastLocalAt: '2026-11-12T01:00:00.000Z',
      lastRemoteAt: null,
      remoteConfigured: true,
    });
    expect(d.pendingReprints).toBe(1);
    expect(d.totalOnHand).toBe(d0.totalOnHand + 10);
    expect(d.locations.occupied).toBeGreaterThanOrEqual(1);
    const low = await k.req('viewer', {
      method: 'GET',
      url: `/api/v1/inventory/low-stock?warehouseId=${WH1}`,
    });
    expect(d.lowStockCount).toBe(low.json().items.length);
    expect(
      (await k.req('viewer', { method: 'GET', url: `/api/v1/dashboard?warehouseId=${WH2}` }))
        .statusCode,
    ).toBe(404);
  });

  it('审计：ADMIN 全部；MANAGER 必须带授权仓库（否则 404）；OPERATOR 403；id 倒序 keyset', async () => {
    const L = fresh();
    for (let i = 0; i < 3; i++)
      expect(
        (
          await k.txn(
            'manager',
            cmd('ADJUST', [{ locationId: L, skuId: S(2), qtyDelta: 1 }], {}, 'manager'),
          )
        ).statusCode,
      ).toBe(201);
    const list = (token: string, qs: string) =>
      k.req(token, { method: 'GET', url: `/api/v1/audit-logs?${qs}` });
    const Page = z.object({ items: z.array(AuditLog), nextCursor: z.string().nullable() });
    const all = Page.parse((await list('admin', 'limit=200')).json());
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    const ids = all.items.map((a) => a.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect((await list('manager', 'limit=5')).statusCode).toBe(404);
    expect((await list('manager', `warehouseId=${WH2}`)).statusCode).toBe(404);
    expect((await list('op1', `warehouseId=${WH1}`)).statusCode).toBe(403);
    expect((await list('viewer', `warehouseId=${WH1}`)).statusCode).toBe(403);
    // 分页：limit=1 逐页走完 action 过滤后的结果
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const r = await list(
        'manager',
        `warehouseId=${WH1}&action=inventory.adjust&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(r.statusCode).toBe(200);
      const p = Page.parse(r.json());
      seen.push(...p.items.map((x) => x.id));
      expect(p.items.every((x) => x.action === 'inventory.adjust' && x.warehouseId === WH1)).toBe(
        true,
      );
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
