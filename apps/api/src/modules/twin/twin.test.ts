import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Occupancy, TwinModel } from '@wms3d/contracts';
import { createKit, cmd, fresh, SKUS, WH1, WH2, type Kit } from '../inventory/testkit.ts';
import { computeOccupancy, occupancyEtag, OccupancyCache, TwinIndexCache } from './service.ts';

const S = (i: number) => SKUS[i]!.id;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('twin（PG 集成）', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await createKit();
  });
  afterAll(async () => k?.close());
  const occ = (headers: Record<string, string> = {}, lv = 1) =>
    k.req('viewer', {
      method: 'GET',
      url: `/api/v1/warehouses/${WH1}/twin/occupancy?layoutVersion=${lv}`,
      headers,
    });

  it('TwinModel：ETag = layoutVersion，304，列数组与仓位数一致；无发布布局 → 404；跨仓 → 404', async () => {
    const r = await k.req('viewer', { method: 'GET', url: `/api/v1/warehouses/${WH1}/twin` });
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBe('"lv-1"');
    const m = TwinModel.parse(r.json());
    const n = await k.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM locations WHERE warehouse_id = $1`,
      [WH1],
    );
    expect(m.locations.id).toHaveLength(n.rows[0]!.n);
    expect(new Set(m.locations.id).size).toBe(m.locations.id.length);
    const r304 = await k.req('viewer', {
      method: 'GET',
      url: `/api/v1/warehouses/${WH1}/twin`,
      headers: { 'if-none-match': '"lv-1"' },
    });
    expect(r304.statusCode).toBe(304);
    expect(
      (await k.req('admin', { method: 'GET', url: `/api/v1/warehouses/${WH2}/twin` })).statusCode,
    ).toBe(404);
    expect(
      (await k.req('viewer', { method: 'GET', url: `/api/v1/warehouses/${WH2}/twin` })).statusCode,
    ).toBe(404);
  });

  it('occupancy：LAYOUT_STALE 携带 currentLayoutVersion；If-None-Match 命中 304', async () => {
    const stale = await occ({}, 2);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'LAYOUT_STALE',
      context: { currentLayoutVersion: 1 },
    });
    const a = await occ();
    expect(a.statusCode).toBe(200);
    Occupancy.parse(a.json());
    const b = await occ({ 'if-none-match': a.headers.etag as string });
    expect(b.statusCode).toBe(304);
  });

  it('#12 两笔交易以与开始相反的顺序提交：最终 occupancy 内容与 ETag 与重新计算一致', async () => {
    const LA = fresh();
    const LB = fresh();
    const model = TwinModel.parse(
      (await k.req('viewer', { method: 'GET', url: `/api/v1/warehouses/${WH1}/twin` })).json(),
    );
    const ia = model.locations.id.indexOf(LA);
    const ib = model.locations.id.indexOf(LB);
    const blocker = await k.owner.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM locations WHERE id = $1 FOR UPDATE`, [LA]);
      const pA = k.txn('op1', cmd('INBOUND', [{ locationId: LA, skuId: S(3), qty: 7 }])); // 先开始，被阻塞
      await sleep(300);
      const rB = await k.txn('op1', cmd('INBOUND', [{ locationId: LB, skuId: S(4), qty: 9 }])); // 后开始，先提交
      expect(rB.statusCode).toBe(201);
      const mid = await occ();
      const e1 = mid.headers.etag as string;
      expect(Occupancy.parse(mid.json()).qty[ib]).toBe(9);
      expect(Occupancy.parse(mid.json()).qty[ia]).toBe(0);
      await blocker.query('COMMIT');
      expect((await pA).statusCode).toBe(201);
      const fin = await occ({ 'if-none-match': e1 });
      expect(fin.statusCode).toBe(200);
      const body = Occupancy.parse(fin.json());
      expect(body.qty[ia]).toBe(7);
      expect(body.qty[ib]).toBe(9);
      const recomputed = await computeOccupancy(k.db.pool, new TwinIndexCache(k.db.pool), WH1);
      expect(fin.headers.etag).toBe(recomputed!.etag);
      expect(fin.headers.etag).not.toBe(e1);
      const { asOf: _a, ...core } = body;
      const { asOf: _b, ...core2 } = recomputed!.body;
      expect(core).toEqual(core2);
      expect(occupancyEtag(core)).toBe(fin.headers.etag);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('停用仓位（locations.changed）改变 ETag，isActive 置 0；effectiveMax 来自货架类型默认', async () => {
    const LC = fresh();
    const before = await occ();
    const e0 = before.headers.etag as string;
    const model = TwinModel.parse(
      (await k.req('viewer', { method: 'GET', url: `/api/v1/warehouses/${WH1}/twin` })).json(),
    );
    const ic = model.locations.id.indexOf(LC);
    expect(Occupancy.parse(before.json()).effectiveMax[ic]).toBe(200);
    await k.owner.query(`UPDATE locations SET is_active = false WHERE id = $1`, [LC]);
    k.app.services.bus.publish(WH1, {
      event: 'locations.changed',
      data: { layoutVersion: 1, locationIds: [LC] },
    });
    const after = await occ({ 'if-none-match': e0 });
    expect(after.statusCode).toBe(200);
    expect(after.headers.etag).not.toBe(e0);
    expect(Occupancy.parse(after.json()).isActive[ic]).toBe(0);
  });
});

describe('OccupancyCache（单元）', () => {
  it('单飞 + 最小间隔；请求拿到不早于其到达时脏标记的结果', async () => {
    let n = 0;
    const cache = new OccupancyCache(
      async () => {
        n++;
        await sleep(30);
        return {
          body: {
            asOf: '',
            layoutVersion: 1,
            qty: [n],
            skuCount: [],
            fill: [],
            isActive: [],
            effectiveMax: [],
          },
          etag: `"${n}"`,
        };
      },
      { minIntervalMs: 100, ttlMs: 60_000 },
    );
    const [a, b, c] = await Promise.all([cache.get('w'), cache.get('w'), cache.get('w')]);
    expect(n).toBe(1);
    expect(a!.etag).toBe(b!.etag);
    expect(c!.etag).toBe('"1"');
    expect((await cache.get('w'))!.etag).toBe('"1"');
    const t0 = Date.now();
    cache.markDirty('w');
    const p1 = cache.get('w');
    await sleep(5);
    cache.markDirty('w'); // 在重算进行中再次标脏
    const p2 = cache.get('w');
    expect((await p1)!.etag).not.toBe('"1"');
    const r2 = await p2;
    expect(Number(JSON.parse(r2!.etag))).toBeGreaterThanOrEqual(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
  });
});
