import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LayoutVersion, PublishResult, ValidateResult, type LayoutDoc } from '@wms3d/contracts';
import { demo, expandLayout } from '@wms3d/domain';
import { pgAvailable } from '../../test/pg.ts';
import { login, setupKit, WH1, WH2, type Kit, type Session } from '../../lib/testkit.ts';

const clone = (d: LayoutDoc): LayoutDoc => structuredClone(d);

describe.skipIf(!pgAvailable)('layout 草稿/校验/发布（08，09 §2 #13，golden）', () => {
  let k: Kit;
  let admin: Session;
  beforeAll(async () => {
    k = await setupKit();
    admin = await login(k.app, 'admin');
  }, 60_000);
  afterAll(async () => k?.close());

  const api = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    h: Record<string, string> = {},
  ) =>
    k.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { ...admin.h, ...h },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function draftWith(wh: string, doc: LayoutDoc, basedOnVersion: number | null = null) {
    await api('DELETE', `/warehouses/${wh}/layout/draft`);
    const d = await api('POST', `/warehouses/${wh}/layout/draft`, { basedOnVersion });
    expect(d.statusCode).toBe(201);
    const v = LayoutVersion.parse(d.json());
    const s = await api(
      'PUT',
      `/warehouses/${wh}/layout/draft`,
      { doc },
      { 'if-match': String(v.rowVersion) },
    );
    expect(s.statusCode).toBe(200);
    return LayoutVersion.parse(s.json()).rowVersion;
  }
  const publish = (wh: string, rowVersion: number, confirmRecode = false) =>
    api('POST', `/warehouses/${wh}/layout/publish`, { rowVersion, confirmRecode });
  const locs = async (wh: string) =>
    (
      await k.pool.query<{ id: string; code: string; is_active: boolean; rack_key: string | null }>(
        `SELECT l.id, l.code, l.is_active, r.layout_key AS rack_key FROM locations l LEFT JOIN racks r ON r.id = l.rack_id WHERE l.warehouse_id = $1`,
        [wh],
      )
    ).rows;
  const stock = async (locationId: string, qty: number) => {
    const sku = (await k.pool.query(`SELECT id FROM skus ORDER BY code LIMIT 1`)).rows[0].id;
    const wh = (await k.pool.query(`SELECT warehouse_id FROM locations WHERE id=$1`, [locationId]))
      .rows[0].warehouse_id;
    await k.owner.query(
      `INSERT INTO stock_balances (warehouse_id, location_id, sku_id, on_hand) VALUES ($1,$2,$3,$4)
       ON CONFLICT (location_id, sku_id, lot_no) DO UPDATE SET on_hand = EXCLUDED.on_hand`,
      [wh, locationId, sku, qty],
    );
  };

  it('golden：空仓 WH2 发布演示布局 → 386 仓位，编码与 packages/domain 一致；条码登记；补打', async () => {
    const rv = await draftWith(WH2, demo.demoLayout);
    const v = await api('POST', `/warehouses/${WH2}/layout/validate`, {});
    const vr = ValidateResult.parse(v.json());
    expect(vr.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    expect(vr.locationCount).toBe(386);
    expect(vr.diff.added).toHaveLength(386);
    const p = await publish(WH2, rv);
    expect(p.statusCode).toBe(200);
    const pr = PublishResult.parse(p.json());
    expect(pr.layoutVersion).toBe(1);
    expect(pr.diff.added).toHaveLength(386);
    const expected = expandLayout(demo.demoLayout, demo.demoWarehouse2.locationCodePattern)
      .locations.map((l) => l.code)
      .sort();
    expect(expected).toHaveLength(386);
    expect((await locs(WH2)).map((l) => l.code).sort()).toEqual(expected);
    const reg = await k.pool.query(
      `SELECT count(*)::int AS n FROM barcode_registry WHERE warehouse_id = $1 AND kind = 'LOCATION'`,
      [WH2],
    );
    expect(reg.rows[0].n).toBe(386);
    const rp = await k.pool.query(
      `SELECT count(*)::int AS n FROM label_reprint_requests WHERE warehouse_id=$1 AND reason='LAYOUT_NEW'`,
      [WH2],
    );
    expect(rp.rows[0].n).toBeGreaterThanOrEqual(386);
    const w = await api('GET', `/warehouses/${WH2}`);
    expect(w.json().publishedLayoutVersion).toBe(1);
    // 重复点击：草稿已发布 → 返回同一结果
    const again = await publish(WH2, rv);
    expect(again.statusCode).toBe(200);
    expect(again.json().layoutVersion).toBe(1);
  });

  it('原样重发 WH1：386 kept，id 不变', async () => {
    const before = await locs(WH1);
    const rv = await draftWith(WH1, demo.demoLayout, 1);
    const p = await publish(WH1, rv);
    expect(p.statusCode).toBe(200);
    const pr = PublishResult.parse(p.json());
    expect(pr.diff).toMatchObject({
      kept: 386,
      added: [],
      recoded: [],
      deactivated: [],
      reused: [],
    });
    const after = await locs(WH1);
    expect(new Map(after.map((l) => [l.code, l.id]))).toEqual(
      new Map(before.map((l) => [l.code, l.id])),
    );
  });

  it('If-Match 过期 → 412（保存与发布）', async () => {
    const rv = await draftWith(WH1, demo.demoLayout, null);
    const stale = await api(
      'PUT',
      `/warehouses/${WH1}/layout/draft`,
      { doc: demo.demoLayout },
      { 'if-match': String(rv - 1) },
    );
    expect(stale.statusCode).toBe(412);
    expect(stale.json().code).toBe('PRECONDITION_FAILED');
    const p = await publish(WH1, rv + 5);
    expect(p.statusCode).toBe(412);
    await api('DELETE', `/warehouses/${WH1}/layout/draft`);
  });

  it('#13 删除货架再原位重画（新 key）→ 第二轮按 code 复用原 id', async () => {
    const before = (await locs(WH1)).filter((l) => l.rack_key === 'a3r2');
    expect(before).toHaveLength(24);
    // 1) 删除
    const del = clone(demo.demoLayout);
    del.racks = del.racks.filter((r) => r.key !== 'a3r2');
    let p = await publish(WH1, await draftWith(WH1, del, null));
    expect(p.statusCode).toBe(200);
    expect(PublishResult.parse(p.json()).diff.deactivated).toHaveLength(24);
    const mid = await locs(WH1);
    expect(mid.filter((l) => before.some((b) => b.id === l.id)).every((l) => !l.is_active)).toBe(
      true,
    );
    // 2) 原位重画：新 key
    const redraw = clone(demo.demoLayout);
    redraw.racks = redraw.racks.map((r) => (r.key === 'a3r2' ? { ...r, key: 'redrawn-1' } : r));
    p = await publish(WH1, await draftWith(WH1, redraw, null));
    expect(p.statusCode).toBe(200);
    const pr = PublishResult.parse(p.json());
    expect(pr.diff.reused).toHaveLength(24);
    expect(pr.diff.added).toHaveLength(0);
    const after = await locs(WH1);
    const byId = new Map(after.map((l) => [l.id, l]));
    for (const b of before) {
      expect(byId.get(b.id)).toMatchObject({
        code: b.code,
        is_active: true,
        rack_key: 'redrawn-1',
      });
    }
    expect(after.filter((l) => l.is_active)).toHaveLength(386);
    const reg = await k.pool.query(
      `SELECT count(*)::int AS n FROM barcode_registry WHERE warehouse_id = $1 AND kind = 'LOCATION'`,
      [WH1],
    );
    expect(reg.rows[0].n).toBe(386);
  });

  it('同草稿内删除+重画（新 key）→ 直接复用', async () => {
    const cur = clone(demo.demoLayout);
    cur.racks = cur.racks.map((r) => (r.key === 'a3r2' ? { ...r, key: 'redrawn-1' } : r));
    const before = (await locs(WH1)).filter((l) => l.rack_key === 'redrawn-1');
    const doc = clone(cur);
    doc.racks = doc.racks.map((r) => (r.key === 'redrawn-1' ? { ...r, key: 'redrawn-2' } : r));
    const p = await publish(WH1, await draftWith(WH1, doc, null));
    expect(p.statusCode).toBe(200);
    expect(PublishResult.parse(p.json()).diff.reused).toHaveLength(24);
    const ids = new Set(
      (await locs(WH1)).filter((l) => l.rack_key === 'redrawn-2').map((l) => l.id),
    );
    expect(before.every((b) => ids.has(b.id))).toBe(true);
  });

  it('改码互换：有库存需确认；确认后互换编码不撞唯一约束，库存跟随 id；补打请求', async () => {
    const base = (await api('GET', `/warehouses/${WH1}/layout`)).json().doc as LayoutDoc;
    const before = await locs(WH1);
    const a = before.find((l) => l.code === 'A01-01-A01')!;
    await stock(a.id, 7);
    const doc = clone(base);
    doc.racks = doc.racks.map((r) =>
      r.key === 'a1l1' ? { ...r, key: 'a1l2' } : r.key === 'a1l2' ? { ...r, key: 'a1l1' } : r,
    );
    const rv = await draftWith(WH1, doc, null);
    const need = await publish(WH1, rv);
    expect(need.statusCode).toBe(422);
    expect(need.json().code).toBe('LAYOUT_RECODE_NEEDS_CONFIRM');
    const ok = await publish(WH1, rv, true);
    expect(ok.statusCode).toBe(200);
    const pr = PublishResult.parse(ok.json());
    expect(pr.diff.recoded).toHaveLength(48);
    expect(pr.diff.recoded.find((x) => x.locationId === a.id)).toMatchObject({
      from: 'A01-01-A01',
      onHand: 7,
    });
    const after = new Map((await locs(WH1)).map((l) => [l.id, l]));
    const moved = after.get(a.id)!;
    expect(moved.code).not.toBe('A01-01-A01');
    expect([...after.values()].find((l) => l.code === 'A01-01-A01')!.id).not.toBe(a.id);
    const bal = await k.pool.query(
      `SELECT sum(on_hand)::int AS q FROM stock_balances WHERE location_id = $1`,
      [a.id],
    );
    expect(bal.rows[0].q).toBe(7);
    const reg = await k.pool.query(`SELECT entity_id FROM barcode_registry WHERE value = $1`, [
      `WH1.${moved.code}`,
    ]);
    expect(reg.rows[0]?.entity_id).toBe(a.id);
    const rp = await k.pool.query(
      `SELECT count(*)::int AS n FROM label_reprint_requests WHERE warehouse_id=$1 AND reason='LAYOUT_RECODE' AND kind='LOCATION' AND status='PENDING'`,
      [WH1],
    );
    expect(rp.rows[0].n).toBeGreaterThanOrEqual(48);
  });

  it('停用有库存仓位 → 422 LAYOUT_HAS_STOCK，什么都不改', async () => {
    const base = (await api('GET', `/warehouses/${WH1}/layout`)).json().doc as LayoutDoc;
    const victim = (await locs(WH1)).find((l) => l.rack_key === 'b1r2' && l.is_active)!;
    await stock(victim.id, 3);
    const doc = clone(base);
    doc.racks = doc.racks.filter((r) => r.key !== 'b1r2');
    const ver = (await api('GET', `/warehouses/${WH1}`)).json().publishedLayoutVersion;
    const p = await publish(WH1, await draftWith(WH1, doc, null));
    expect(p.statusCode).toBe(422);
    expect(p.json().code).toBe('LAYOUT_HAS_STOCK');
    expect((await api('GET', `/warehouses/${WH1}`)).json().publishedLayoutVersion).toBe(ver);
    expect((await locs(WH1)).find((l) => l.id === victim.id)!.is_active).toBe(true);
    await api('DELETE', `/warehouses/${WH1}/layout/draft`);
  });

  it('校验失败 → 422 LAYOUT_INVALID；重复 rack key → 错误', async () => {
    const doc = clone(demo.demoLayout);
    doc.racks.push({ ...doc.racks[0]! });
    const rv = await draftWith(WH1, doc, null);
    const v = ValidateResult.parse(
      (await api('POST', `/warehouses/${WH1}/layout/validate`, {})).json(),
    );
    expect(v.issues.some((i) => i.severity === 'ERROR')).toBe(true);
    const p = await publish(WH1, rv);
    expect(p.json().code).toBe('LAYOUT_INVALID');
    await api('DELETE', `/warehouses/${WH1}/layout/draft`);
  });

  it('版本列表、按版本取布局、货架类型库', async () => {
    const vs = await api('GET', `/warehouses/${WH1}/layout/versions`);
    expect(vs.statusCode).toBe(200);
    expect(vs.json().items.length).toBeGreaterThan(3);
    expect((await api('GET', `/warehouses/${WH1}/layout?version=1`)).json().version).toBe(1);
    const rt = await api('POST', '/rack-types', {
      ...demo.demoLayout.rackTypes[0]!,
      key: 'shelf-x',
      name: 'X',
    });
    expect(rt.statusCode).toBe(201);
    expect(
      (
        await api('POST', '/rack-types', {
          ...demo.demoLayout.rackTypes[0]!,
          key: 'shelf-x',
          name: 'X',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await api('GET', '/rack-types'))
        .json()
        .items.some((t: { key: string }) => t.key === 'shelf-x'),
    ).toBe(true);
  });
});
