/**
 * 09 §2 必过 #5（WS-A1 × WS-A2 联合验收，Lead 维护）：布局发布（停用仓位）与入库并发。
 * 不变量：任何时刻都不存在“已停用仓位上有库存”。发布要么先赢（入库得到 LOCATION_INACTIVE），
 * 要么入库先赢（发布得到 422 LAYOUT_HAS_STOCK、仓位保持启用）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LayoutVersion, type LayoutDoc } from '@wms3d/contracts';
import { pgAvailable } from './pg.ts';
import { login, setupKit, WH1, type Kit, type Session } from '../lib/testkit.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!pgAvailable)('#5 布局发布（停用仓位）× 入库并发（A1×A2 联合）', () => {
  let k: Kit;
  let admin: Session;
  let op: Session;
  let skuId: string;
  beforeAll(async () => {
    k = await setupKit();
    admin = await login(k.app, 'admin');
    op = await login(k.app, 'op1');
    skuId = (await k.pool.query(`SELECT id FROM skus ORDER BY code LIMIT 1`)).rows[0].id;
  }, 60_000);
  afterAll(async () => k?.close());

  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, h = {}) =>
    k.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { ...admin.h, ...h },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const rackLocs = async (rackKey: string) =>
    (
      await k.pool.query<{ id: string }>(
        `SELECT l.id FROM locations l JOIN racks r ON r.id = l.rack_id
         WHERE l.warehouse_id = $1 AND r.layout_key = $2 AND l.is_active`,
        [WH1, rackKey],
      )
    ).rows.map((r) => r.id);

  const violations = async () =>
    Number(
      (
        await k.pool.query(
          `SELECT count(*)::int AS n FROM stock_balances b JOIN locations l ON l.id = b.location_id
           WHERE NOT l.is_active AND b.on_hand <> 0`,
        )
      ).rows[0].n,
    );

  const inbound = (locationId: string) =>
    k.app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transactions',
      headers: { ...op.h, 'idempotency-key': randomUUID() },
      payload: {
        type: 'INBOUND',
        warehouseId: WH1,
        performedBy: op.userId,
        clientCreatedAt: new Date().toISOString(),
        lines: [{ locationId, skuId, qty: 1 }],
      },
    });

  it('多轮不同交错：无停用仓位有库存，结果二选一且一致', async () => {
    const base = (await api('GET', `/warehouses/${WH1}/layout`)).json().doc as LayoutDoc;
    const victims = base.racks.slice(-6).map((r) => r.key);
    const outcomes: string[] = [];
    for (const [i, rackKey] of victims.entries()) {
      const cur = (await api('GET', `/warehouses/${WH1}/layout`)).json().doc as LayoutDoc;
      const doc = structuredClone(cur);
      doc.racks = doc.racks.filter((r) => r.key !== rackKey);
      await api('DELETE', `/warehouses/${WH1}/layout/draft`);
      const d = LayoutVersion.parse(
        (await api('POST', `/warehouses/${WH1}/layout/draft`, { basedOnVersion: null })).json(),
      );
      const s = await api(
        'PUT',
        `/warehouses/${WH1}/layout/draft`,
        { doc },
        {
          'if-match': String(d.rowVersion),
        },
      );
      expect(s.statusCode).toBe(200);
      const rv = LayoutVersion.parse(s.json()).rowVersion;
      const targets = (await rackLocs(rackKey)).slice(0, 12);
      expect(targets.length).toBeGreaterThan(0);

      // 交错：[发布延迟, 入库延迟基数(ms)]，覆盖“入库先赢 / 发布先赢 / 发布进行中入库到达”三种
      const [pubDelay, txDelay] = (
        [
          [3, 0],
          [0, 0],
          [0, 5],
          [0, 15],
          [0, 40],
          [0, -1],
        ] as const
      )[i]!;
      const txns = targets.map((id, j) =>
        sleep(txDelay < 0 ? j * 4 : txDelay + (j % 3)).then(() => inbound(id)),
      );
      const pub = sleep(pubDelay).then(() =>
        api('POST', `/warehouses/${WH1}/layout/publish`, { rowVersion: rv, confirmRecode: false }),
      );
      const [p, ...rs] = await Promise.all([pub, ...txns]);

      const ok = rs.filter((r) => r.statusCode === 201 || r.statusCode === 200).length;
      const inactive = rs.filter((r) => r.json().code === 'LOCATION_INACTIVE').length;
      for (const r of rs) expect([200, 201, 422]).toContain(r.statusCode);
      expect(ok + inactive).toBe(rs.length);

      if (p.statusCode === 200) {
        // 发布赢：被删货架的仓位全部停用且无库存（发布前已提交的入库会让发布失败，不会走到这里）
        expect(ok).toBe(0);
        expect(await rackLocs(rackKey)).toEqual([]);
        outcomes.push(`publish-first(${inactive} rejected)`);
      } else {
        expect(p.statusCode).toBe(422);
        expect(p.json().code).toBe('LAYOUT_HAS_STOCK');
        expect(ok).toBeGreaterThan(0);
        expect((await rackLocs(rackKey)).length).toBeGreaterThanOrEqual(targets.length);
        outcomes.push(`inbound-first(${ok} ok, ${inactive} rejected)`);
        await api('DELETE', `/warehouses/${WH1}/layout/draft`);
      }
      expect(await violations()).toBe(0);
    }
    console.info('#5 outcomes:', outcomes.join('; '));
  }, 120_000);
});
