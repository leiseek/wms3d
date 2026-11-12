import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncDigest, SyncPage } from '@wms3d/contracts';
import { createKit, LOCS, SKUS, WH1, WH2, type Kit } from '../inventory/testkit.ts';

type Page = ReturnType<typeof SyncPage.parse>;

describe('sync/masterdata（PG 集成）', () => {
  let k: Kit;
  const X = LOCS[10]!.id;
  beforeAll(async () => {
    k = await createKit();
    // 构造历史：全部主数据 2 天前更新，仅仓位 X 在 1 天前更新（绕过 updated_at 触发器）
    const c = await k.owner.connect();
    try {
      await c.query('BEGIN');
      for (const t of ['skus', 'sku_barcodes', 'locations']) {
        await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
        await c.query(`UPDATE ${t} SET updated_at = now() - interval '2 days'`);
      }
      await c.query(`UPDATE locations SET updated_at = now() - interval '1 day' WHERE id = $1`, [
        X,
      ]);
      for (const t of ['skus', 'sku_barcodes', 'locations'])
        await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
  afterAll(async () => k?.close());

  const get = async (cursor?: string, limit = 50, token = 'viewer') => {
    const qs = new URLSearchParams({ warehouseId: WH1, limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    const r = await k.req(token, { method: 'GET', url: `/api/v1/sync/masterdata?${qs}` });
    expect(r.statusCode).toBe(200);
    return SyncPage.parse(r.json());
  };
  const round = async (cursor?: string, limit = 50) => {
    const pages: Page[] = [];
    let c = cursor;
    for (;;) {
      const p = await get(c, limit);
      pages.push(p);
      c = p.nextCursor!;
      if (!p.hasMore) break;
    }
    return { pages, next: c };
  };
  let afterFull = '';

  it('首次全量：分页 keyset 在大量同时间戳下不重不漏；total 仅第一页；载荷 = 仓库码前缀', async () => {
    const { pages, next } = await round(undefined, 37);
    afterFull = next;
    expect(pages.length).toBeGreaterThan(5);
    expect(pages[0]!.total).toBeDefined();
    expect(pages.slice(1).every((p) => p.total === undefined)).toBe(true);
    expect(pages.every((p) => p.tombstones.length === 0)).toBe(true);
    const ids = pages.flatMap((p) => [...p.skus, ...p.barcodes, ...p.locations].map((x) => x.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(pages[0]!.total);
    const locs = pages.flatMap((p) => p.locations);
    const nLoc = await k.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM locations WHERE warehouse_id = $1`,
      [WH1],
    );
    expect(locs).toHaveLength(nLoc.rows[0]!.n);
    expect(pages.flatMap((p) => p.skus)).toHaveLength(SKUS.length);
    const rcv = locs.find((l) => l.code === 'RCV-01')!;
    expect(rcv.payload).toBe('WH1.RCV-01');
    expect(locs.find((l) => l.code === 'A01-01-A01')?.rackCode).toBeTruthy();
  });

  it('增量：180s 安全窗口 + 变更 + tombstones（仅首页、本仓/全局）', async () => {
    const S0 = SKUS[0]!.id;
    const bc = SKUS[4]!.barcodes[1]!.id;
    await k.owner.query(`UPDATE skus SET name = '改名测试' WHERE id = $1`, [S0]);
    await k.owner.query(`DELETE FROM sku_barcodes WHERE id = $1`, [bc]);
    await k.owner.query(
      `INSERT INTO masterdata_tombstones (entity, entity_id, warehouse_id) VALUES ('barcode', $1, NULL), ('location', gen_random_uuid(), $2)`,
      [bc, WH2],
    );
    const { pages, next } = await round(afterFull, 1);
    const skus = pages.flatMap((p) => p.skus);
    const locs = pages.flatMap((p) => p.locations);
    expect(skus.map((s) => s.id)).toEqual([S0]);
    expect(skus[0]!.name).toBe('改名测试');
    expect(locs.map((l) => l.id)).toEqual([X]); // 1 天前更新的 X 落在窗口内（已见最大值 − 180s）
    expect(pages[0]!.tombstones).toEqual([expect.objectContaining({ entity: 'barcode', id: bc })]);
    expect(pages.slice(1).every((p) => p.tombstones.length === 0)).toBe(true);
    expect(pages.every((p) => p.total === undefined)).toBe(true);
    // 下一轮：窗口推进到 S0 的 updated_at − 180s，X 不再返回
    const again = await round(next);
    expect(again.pages.flatMap((p) => p.locations)).toEqual([]);
    expect(again.pages.flatMap((p) => p.skus).map((s) => s.id)).toEqual([S0]);
  });

  it('摘要：计数正确、稳定、主数据变化后改变；坏游标 400；跨仓 404', async () => {
    const d = async () => {
      const r = await k.req('viewer', {
        method: 'GET',
        url: `/api/v1/sync/masterdata/digest?warehouseId=${WH1}`,
      });
      expect(r.statusCode).toBe(200);
      return SyncDigest.parse(r.json());
    };
    const a = await d();
    expect(a.skus).toBe(SKUS.length);
    expect(a).toEqual(await d());
    await k.owner.query(`UPDATE locations SET max_qty = 150 WHERE id = $1`, [X]);
    const b = await d();
    expect(b.hash).not.toBe(a.hash);
    expect(b.locations).toBe(a.locations);
    // 客户端用全量同步得到的副本逐位复算摘要
    const { pages } = await round(undefined, 500);
    const lines = pages
      .flatMap((p) => [
        ...p.skus.map((x) => ['sku', x.id, x.updatedAt]),
        ...p.barcodes.map((x) => ['barcode', x.id, x.updatedAt]),
        ...p.locations.map((x) => ['location', x.id, x.updatedAt]),
      ])
      .map((x) => x.join('|'))
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    expect(createHash('sha256').update(lines.join('\n')).digest('hex')).toBe(b.hash);
    const bad = await k.req('viewer', {
      method: 'GET',
      url: `/api/v1/sync/masterdata?warehouseId=${WH1}&cursor=zzz`,
    });
    expect(bad.statusCode).toBe(400);
    const other = await k.req('viewer', {
      method: 'GET',
      url: `/api/v1/sync/masterdata?warehouseId=${WH2}`,
    });
    expect(other.statusCode).toBe(404);
  });
});
