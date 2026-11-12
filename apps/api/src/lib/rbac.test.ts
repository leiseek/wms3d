/**
 * RBAC 自动矩阵（ws-a1 验收）：routeList 中 owner=ws-a1 的全部路由 × 5 个身份 × 跨仓库。
 * 断言 401/403/404 与契约 roles/scope/policy 一致；GET 正向请求 200 且响应体符合契约 schema（序列化器已校验，再 parse 一次）。
 * 写接口只测反向（403/404 发生在任何副作用之前），正向由各模块用例覆盖。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { routeList, type RouteSpec } from '@wms3d/contracts';
import { demo } from '@wms3d/domain';
import { pgAvailable } from '../test/pg.ts';
import { createUserLike, login, setupKit, WH1, WH2, type Kit, type Session } from './testkit.ts';

type Who = { name: string; role: 'ADMIN' | 'MANAGER' | 'OPERATOR' | 'VIEWER'; all: boolean };
const WHO: Who[] = [
  { name: 'admin', role: 'ADMIN', all: true },
  { name: 'manager', role: 'MANAGER', all: true },
  { name: 'mgr1', role: 'MANAGER', all: false },
  { name: 'op1', role: 'OPERATOR', all: false },
  { name: 'viewer', role: 'VIEWER', all: false },
];

interface Fx {
  loc: Record<string, string>;
  reprint: Record<string, string>;
  userId: string;
  deviceId: string;
  rackTypeId: string;
  skuId: string;
  barcodeId: string;
}
interface Req {
  method: RouteSpec['method'];
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

const BOUNDARY = 'rbacboundary';
const multipart = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="s.csv"\r\nContent-Type: text/csv\r\n\r\ncode,name\r\nRB-1,x\r\n--${BOUNDARY}--\r\n`;

function sample(id: string, wh: string, f: Fx, deviceId: string): Req {
  const W = `/warehouses/${wh}`;
  const m: Record<string, Req> = {
    authLogout: { method: 'POST', url: '/auth/logout', payload: {} },
    me: { method: 'GET', url: '/me' },
    changePassword: {
      method: 'POST',
      url: '/me/password',
      payload: { currentPassword: 'x', newPassword: '12345678' },
    },
    listUsers: { method: 'GET', url: '/users' },
    createUser: {
      method: 'POST',
      url: '/users',
      payload: {
        username: 'rbac-x',
        displayName: 'x',
        role: 'VIEWER',
        temporaryPassword: '12345678',
      },
    },
    getUser: { method: 'GET', url: `/users/${f.userId}` },
    patchUser: { method: 'PATCH', url: `/users/${f.userId}`, payload: { displayName: 'x' } },
    resetPassword: {
      method: 'POST',
      url: `/users/${f.userId}/reset-password`,
      payload: { temporaryPassword: '12345678' },
    },
    listDevices: { method: 'GET', url: '/devices' },
    patchDevice: { method: 'PATCH', url: `/devices/${f.deviceId}`, payload: { name: 'x' } },
    heartbeat: {
      method: 'POST',
      url: '/devices/heartbeat',
      payload: { deviceId, appVersion: '0.1.0', pendingOutbox: 0 },
    },
    listWarehouses: { method: 'GET', url: '/warehouses' },
    createWarehouse: { method: 'POST', url: '/warehouses', payload: {} },
    getWarehouse: { method: 'GET', url: W },
    patchWarehouse: { method: 'PATCH', url: W, payload: { name: 'x' } },
    listZones: { method: 'GET', url: `${W}/zones` },
    listRacks: { method: 'GET', url: `${W}/racks` },
    listRackTypes: { method: 'GET', url: '/rack-types' },
    createRackType: { method: 'POST', url: '/rack-types', payload: {} },
    patchRackType: { method: 'PATCH', url: `/rack-types/${f.rackTypeId}`, payload: { name: 'x' } },
    listLayoutVersions: { method: 'GET', url: `${W}/layout/versions` },
    getLayout: { method: 'GET', url: `${W}/layout` },
    createDraft: { method: 'POST', url: `${W}/layout/draft`, payload: { basedOnVersion: null } },
    saveDraft: {
      method: 'PUT',
      url: `${W}/layout/draft`,
      payload: { doc: demo.demoLayout },
      headers: { 'if-match': '1' },
    },
    deleteDraft: { method: 'DELETE', url: `${W}/layout/draft` },
    validateLayout: { method: 'POST', url: `${W}/layout/validate`, payload: {} },
    publishLayout: { method: 'POST', url: `${W}/layout/publish`, payload: { rowVersion: 1 } },
    listLocations: { method: 'GET', url: `${W}/locations` },
    patchLocation: { method: 'PATCH', url: `/locations/${f.loc[wh]}`, payload: { maxQty: 50 } },
    bulkPatchLocations: {
      method: 'PATCH',
      url: `${W}/locations/bulk`,
      payload: { ids: [f.loc[wh]], patch: { maxQty: 50 } },
    },
    listSkus: { method: 'GET', url: '/skus' },
    createSku: { method: 'POST', url: '/skus', payload: { code: 'RBAC-1', name: 'x' } },
    getSku: { method: 'GET', url: `/skus/${f.skuId}` },
    patchSku: { method: 'PATCH', url: `/skus/${f.skuId}`, payload: { name: 'x' } },
    addSkuBarcode: {
      method: 'POST',
      url: `/skus/${f.skuId}/barcodes`,
      payload: { barcode: 'RBAC0000001' },
    },
    deleteSkuBarcode: { method: 'DELETE', url: `/skus/${f.skuId}/barcodes/${f.barcodeId}` },
    importSkus: {
      method: 'POST',
      url: '/skus/import?dryRun=true',
      payload: multipart,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    },
    exportSkus: { method: 'GET', url: '/skus/export.csv' },
    scanResolve: { method: 'GET', url: `/scan/resolve?warehouseId=${wh}&code=A01-01-A01` },
    listLabelTemplates: { method: 'GET', url: '/labels/templates' },
    renderLabels: {
      method: 'POST',
      url: '/labels/render',
      payload: { template: 'loc-100x50', kind: 'LOCATION', warehouseId: wh, ids: [f.loc[wh]] },
    },
    calibrationPdf: { method: 'GET', url: '/labels/calibration.pdf?template=loc-100x50&dpi=203' },
    listReprints: { method: 'GET', url: `/label-reprint-requests?warehouseId=${wh}` },
    createReprint: {
      method: 'POST',
      url: '/label-reprint-requests',
      payload: { warehouseId: wh, kind: 'LOCATION', entityId: f.loc[wh], reason: 'DAMAGED' },
    },
    patchReprint: {
      method: 'PATCH',
      url: `/label-reprint-requests/${f.reprint[wh]}`,
      payload: { status: 'CANCELLED' },
    },
  };
  const r = m[id];
  if (!r) throw new Error(`RBAC 矩阵缺少样例：${id}`);
  return r;
}

const A1 = (routeList as readonly RouteSpec[]).filter(
  (r) => r.owner === 'ws-a1' && r.roles !== 'public',
);

describe.skipIf(!pgAvailable)('RBAC 自动矩阵（ws-a1 路由 × 5 身份 × 跨仓）', () => {
  let k: Kit;
  let f: Fx;
  const sess = new Map<string, Session>();
  beforeAll(async () => {
    k = await setupKit();
    await createUserLike(k.pool, 'mgr1', 'MANAGER', [WH1]);
    for (const w of WHO) sess.set(w.name, await login(k.app, w.name));
    const admin = sess.get('admin')!;
    // WH2 也发布演示布局，使跨仓资源真实存在
    const d = await k.app.inject({
      method: 'POST',
      url: `/api/v1/warehouses/${WH2}/layout/draft`,
      headers: admin.h,
      payload: { basedOnVersion: null },
    });
    const s = await k.app.inject({
      method: 'PUT',
      url: `/api/v1/warehouses/${WH2}/layout/draft`,
      headers: { ...admin.h, 'if-match': String(d.json().rowVersion) },
      payload: { doc: demo.demoLayout },
    });
    const p = await k.app.inject({
      method: 'POST',
      url: `/api/v1/warehouses/${WH2}/layout/publish`,
      headers: admin.h,
      payload: { rowVersion: s.json().rowVersion },
    });
    expect(p.statusCode).toBe(200);
    const loc: Record<string, string> = {};
    const reprint: Record<string, string> = {};
    for (const wh of [WH1, WH2]) {
      loc[wh] = (
        await k.pool.query(`SELECT id FROM locations WHERE warehouse_id=$1 AND code='A01-01-A01'`, [
          wh,
        ])
      ).rows[0].id;
      reprint[wh] = (
        await k.pool.query(
          `INSERT INTO label_reprint_requests (warehouse_id, kind, entity_id, reason, requested_by)
           SELECT $1, 'LOCATION', $2, 'DAMAGED', id FROM users WHERE username='admin' RETURNING id`,
          [wh, loc[wh]],
        )
      ).rows[0].id;
    }
    const sku = (
      await k.pool.query(
        `SELECT s.id, b.id AS bid FROM skus s JOIN sku_barcodes b ON b.sku_id = s.id ORDER BY s.code LIMIT 1`,
      )
    ).rows[0];
    f = {
      loc,
      reprint,
      userId: (await k.pool.query(`SELECT id FROM users WHERE username='op2'`)).rows[0].id,
      deviceId: sess.get('op1')!.deviceId,
      rackTypeId: (await k.pool.query(`SELECT id FROM rack_types LIMIT 1`)).rows[0].id,
      skuId: sku.id,
      barcodeId: sku.bid,
    };
  }, 90_000);
  afterAll(async () => k?.close());

  const send = (r: Req, h: Record<string, string>) =>
    k.app.inject({
      method: r.method,
      url: `/api/v1${r.url}`,
      headers: { ...h, ...(r.headers ?? {}) },
      ...(r.payload !== undefined ? { payload: r.payload as string } : {}),
    });

  it('覆盖全部 ws-a1 非 public 路由', () => {
    expect(A1.length).toBeGreaterThanOrEqual(45);
    for (const r of A1) expect(() => sample(r.id, WH1, f, 'x')).not.toThrow();
  });

  it('无 token → 401', async () => {
    for (const r of A1) {
      const res = await send(sample(r.id, WH1, f, 'dev-x-0001'), {});
      expect(res.statusCode, r.id).toBe(401);
    }
  });

  it.each(WHO.map((w) => [w.name, w] as const))(
    '%s：403 / 跨仓 404 / GET 正向 200',
    async (_n, who) => {
      const s = sess.get(who.name)!;
      const failures: string[] = [];
      let checks = 0;
      for (const r of A1) {
        const allowed = r.roles === 'any' || (r.roles as readonly string[]).includes(who.role);
        const scoped = r.scope.from !== 'none';
        const write = r.method !== 'GET';
        const policyDenied =
          r.policy === 'skuWrite' && !(who.role === 'ADMIN' || (who.role === 'MANAGER' && who.all));
        const check = async (wh: string, expected: number | 'ok') => {
          checks++;
          const res = await send(sample(r.id, wh, f, s.deviceId), s.h);
          if (expected === 'ok') {
            if (res.statusCode !== 200)
              failures.push(
                `${r.id}@${wh === WH1 ? 'WH1' : 'WH2'} → ${res.statusCode} ${res.body.slice(0, 160)}`,
              );
            else if (!r.produces || r.produces === 'application/json') {
              const schema = r.responses[200] as z.ZodType | null | undefined;
              const pr = schema?.safeParse(res.json());
              if (pr && !pr.success)
                failures.push(`${r.id} 响应不符契约：${pr.error.message.slice(0, 200)}`);
            }
          } else if (res.statusCode !== expected) {
            failures.push(
              `${r.id}@${wh === WH1 ? 'WH1' : 'WH2'} 期望 ${expected}，实际 ${res.statusCode} ${res.body.slice(0, 160)}`,
            );
          }
        };
        if (!allowed) {
          await check(WH1, 403);
          continue;
        }
        if (scoped && !who.all) await check(WH2, 404);
        if (policyDenied) await check(WH1, 403);
        else if (!write) await check(who.all ? WH2 : WH1, 'ok');
      }
      expect(failures).toEqual([]);
      expect(checks).toBeGreaterThanOrEqual(15);
    },
  );

  it('#9 跨仓 locationId：受限用户改 WH2 仓位 → 404 且无变化；库存不变', async () => {
    const mgr1 = sess.get('mgr1')!;
    const sku = (await k.pool.query(`SELECT id FROM skus ORDER BY code LIMIT 1`)).rows[0].id;
    await k.owner.query(
      `INSERT INTO stock_balances (warehouse_id, location_id, sku_id, on_hand) VALUES ($1,$2,$3,5)`,
      [WH2, f.loc[WH2], sku],
    );
    const before = (
      await k.pool.query(`SELECT is_active, max_qty FROM locations WHERE id=$1`, [f.loc[WH2]])
    ).rows[0];
    const r = await send(
      { method: 'PATCH', url: `/locations/${f.loc[WH2]}`, payload: { isActive: false, maxQty: 1 } },
      mgr1.h,
    );
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('NOT_FOUND');
    const b = await send(
      {
        method: 'PATCH',
        url: `/warehouses/${WH1}/locations/bulk`,
        payload: { ids: [f.loc[WH2]], patch: { maxQty: 1 } },
      },
      mgr1.h,
    );
    expect(b.statusCode).toBe(200);
    expect(b.json().updated).toBe(0); // 他仓 id 不会被本仓批量接口改动
    expect(
      (await k.pool.query(`SELECT is_active, max_qty FROM locations WHERE id=$1`, [f.loc[WH2]]))
        .rows[0],
    ).toEqual(before);
    const bal = await k.pool.query(`SELECT on_hand FROM stock_balances WHERE location_id=$1`, [
      f.loc[WH2],
    ]);
    expect(bal.rows[0].on_hand).toBe(5);
    // 不存在与越权不可区分
    const ghost = await send(
      {
        method: 'PATCH',
        url: `/locations/00000000-0000-4000-8000-00000000dead`,
        payload: { maxQty: 1 },
      },
      mgr1.h,
    );
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().detail).toBe(r.json().detail);
  });
});
