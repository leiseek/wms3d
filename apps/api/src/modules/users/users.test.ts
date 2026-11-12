import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppVersion, BulkResult, Location, User, Warehouse } from '@wms3d/contracts';
import { pgAvailable } from '../../test/pg.ts';
import { login, setupKit, WH1, type Kit, type Session } from '../../lib/testkit.ts';

describe.skipIf(!pgAvailable)('users / devices / warehouses / locations', () => {
  let k: Kit;
  let admin: Session;
  let mgr: Session;
  let op: Session;
  beforeAll(async () => {
    k = await setupKit({ APP_LATEST_VERSION: '0.2.0', APP_MIN_VERSION: '0.1.0' });
    admin = await login(k.app, 'admin');
    mgr = await login(k.app, 'manager');
    op = await login(k.app, 'op1');
  }, 60_000);
  afterAll(async () => k?.close());

  const api = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    s: Session = admin,
  ) =>
    k.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: s.h,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  it('appVersion 公开', async () => {
    const r = await k.app.inject({ method: 'GET', url: '/api/v1/app/version' });
    expect(AppVersion.parse(r.json())).toMatchObject({ latest: '0.2.0', minSupported: '0.1.0' });
  });

  it('用户：创建/重名 409/列表分页/改角色与仓库/不能停用自己/重置口令', async () => {
    const c = await api('POST', '/users', {
      username: 'u-new',
      displayName: '新人',
      role: 'OPERATOR',
      warehouseIds: [WH1],
      temporaryPassword: 'Temp#12345',
    });
    expect(c.statusCode).toBe(201);
    const u = User.parse(c.json());
    expect(u).toMatchObject({ mustChangePassword: true, warehouses: [{ id: WH1, code: 'WH1' }] });
    expect(
      (
        await api('POST', '/users', {
          username: 'U-NEW',
          displayName: 'x',
          role: 'VIEWER',
          temporaryPassword: 'Temp#12345',
        })
      ).statusCode,
    ).toBe(409);
    const p1 = await api('GET', '/users?limit=2');
    expect(p1.json().items).toHaveLength(2);
    const p2 = await api('GET', `/users?limit=2&cursor=${p1.json().nextCursor}`);
    expect(p2.json().items[0].username > p1.json().items[1].username).toBe(true);
    const pt = await api('PATCH', `/users/${u.id}`, { role: 'MANAGER', allWarehouses: true });
    expect(User.parse(pt.json())).toMatchObject({ role: 'MANAGER', allWarehouses: true });
    expect((await api('PATCH', `/users/${admin.userId}`, { isActive: false })).statusCode).toBe(
      409,
    );
    expect(
      (await api('POST', `/users/${u.id}/reset-password`, { temporaryPassword: 'Other#12345' }))
        .statusCode,
    ).toBe(204);
    const s = await login(k.app, 'u-new', { password: 'Other#12345' });
    expect(
      (await k.app.inject({ method: 'GET', url: '/api/v1/me', headers: s.h })).json()
        .mustChangePassword,
    ).toBe(true);
    const au = await k.pool.query(
      `SELECT action FROM audit_logs WHERE entity='user' AND entity_id=$1 ORDER BY id`,
      [u.id],
    );
    expect(au.rows.map((x) => x.action)).toEqual(
      expect.arrayContaining(['user.create', 'user.update', 'user.password.reset']),
    );
  });

  it('设备心跳：pendingCount / appVersion；deviceId 不一致 400；设备列表', async () => {
    const hb = await api(
      'POST',
      '/devices/heartbeat',
      { deviceId: op.deviceId, appVersion: '0.1.7', pendingOutbox: 4, warehouseId: WH1 },
      op,
    );
    expect(hb.statusCode).toBe(200);
    expect(hb.json().disabled).toBe(false);
    expect(
      (
        await api(
          'POST',
          '/devices/heartbeat',
          { deviceId: 'someone-else-01', appVersion: '1', pendingOutbox: 0 },
          op,
        )
      ).statusCode,
    ).toBe(400);
    const list = await api('GET', '/devices');
    const d = list.json().items.find((x: { id: string }) => x.id === op.deviceId);
    expect(d).toMatchObject({ appVersion: '0.1.7', pendingOutbox: 4 });
  });

  it('仓库：创建（模式校验）/ 有仓位后模式锁定 409 / 前缀开关重建登记表', async () => {
    const bad = await api('POST', '/warehouses', {
      code: 'WH9',
      name: 'x',
      widthM: 10,
      depthM: 10,
      heightM: 5,
      locationCodePattern: '{Nope}',
    });
    expect(bad.statusCode).toBe(400);
    const c = await api(
      'POST',
      '/warehouses',
      { code: 'WH3', name: '三号', widthM: 10, depthM: 10, heightM: 5 },
      admin,
    );
    expect(c.statusCode).toBe(201);
    expect(Warehouse.parse(c.json())).toMatchObject({
      locationCodePatternLocked: false,
      publishedLayoutVersion: null,
    });
    const lock = await api('PATCH', `/warehouses/${WH1}`, {
      locationCodePattern: '{Zone}{Aisle:2}{Bay:2}{Level:A}{Pos:2}',
    });
    expect(lock.statusCode).toBe(409);
    const off = await api('PATCH', `/warehouses/${WH1}`, { barcodePrefixEnabled: false });
    expect(off.json().barcodePrefixEnabled).toBe(false);
    expect(
      (
        await k.pool.query(
          `SELECT 1 FROM barcode_registry WHERE value='A01-01-A01' AND kind='LOCATION'`,
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (await k.pool.query(`SELECT 1 FROM barcode_registry WHERE value='WH1.A01-01-A01'`)).rowCount,
    ).toBe(0);
    await api('PATCH', `/warehouses/${WH1}`, { barcodePrefixEnabled: true });
    expect(
      (await k.pool.query(`SELECT 1 FROM barcode_registry WHERE value='WH1.A01-01-A01'`)).rowCount,
    ).toBe(1);
    expect((await api('GET', `/warehouses/${WH1}/zones`, undefined, op)).json().items.length).toBe(
      4,
    );
    expect((await api('GET', `/warehouses/${WH1}/racks`, undefined, op)).json().items.length).toBe(
      16,
    );
    const ws = await api('GET', '/warehouses', undefined, op);
    expect(ws.json().items.map((w: { code: string }) => w.code)).toEqual(['WH1']);
  });

  it('仓位：列表过滤+游标 / PATCH / 批量 / 有库存停用 422', async () => {
    const l = await api('GET', `/warehouses/${WH1}/locations?zone=B&limit=50`, undefined, op);
    const items = l.json().items.map((x: unknown) => Location.parse(x));
    expect(items).toHaveLength(50);
    expect(items.every((x: { code: string }) => x.code.startsWith('B'))).toBe(true);
    const next = await api(
      'GET',
      `/warehouses/${WH1}/locations?zone=B&limit=50&cursor=${l.json().nextCursor}`,
      undefined,
      op,
    );
    expect(next.json().items[0].code > items[49].code).toBe(true);
    const q = await api('GET', `/warehouses/${WH1}/locations?q=a01-01`, undefined, op);
    expect(q.json().items.length).toBe(6);
    const id = items[0].id;
    const p = await api('PATCH', `/locations/${id}`, { maxQty: 33, pickSeq: 5 }, mgr);
    expect(Location.parse(p.json())).toMatchObject({ maxQty: 33, pickSeq: 5 });
    const b = await api(
      'PATCH',
      `/warehouses/${WH1}/locations/bulk`,
      { ids: items.slice(1, 5).map((x: { id: string }) => x.id), patch: { maxQty: null } },
      mgr,
    );
    expect(BulkResult.parse(b.json())).toMatchObject({ updated: 4, failed: [] });
    const sku = (await k.pool.query(`SELECT id FROM skus LIMIT 1`)).rows[0].id;
    await k.owner.query(
      `INSERT INTO stock_balances (warehouse_id, location_id, sku_id, on_hand) VALUES ($1,$2,$3,2)`,
      [WH1, items[6].id, sku],
    );
    const st = await api('PATCH', `/locations/${items[6].id}`, { isActive: false }, mgr);
    expect(st.json().code).toBe('LAYOUT_HAS_STOCK');
    const bulk = await api(
      'PATCH',
      `/warehouses/${WH1}/locations/bulk`,
      { ids: [items[6].id, items[7].id], patch: { isActive: false } },
      mgr,
    );
    expect(bulk.json()).toMatchObject({
      updated: 1,
      failed: [{ id: items[6].id, code: items[6].code }],
    });
    // 运行时停用不释放条码（仍可扫到并提示停用）
    expect(
      (await k.pool.query(`SELECT 1 FROM barcode_registry WHERE entity_id=$1`, [items[7].id]))
        .rowCount,
    ).toBe(1);
  });
});
