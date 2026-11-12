/**
 * RBAC 自动矩阵（09 §2）：owner = ws-a2 的全部契约路由 × {无令牌, ADMIN, MANAGER, OPERATOR, VIEWER} × {本仓, 他仓}。
 * 期望：无令牌 401；角色不在 roles → 403；非 ADMIN 访问未授权仓库 → 404（不泄露存在性）；
 * 允许时状态 < 500 且不为 401/403/404；2xx JSON 响应用契约 schema 解析（即全部经契约序列化器）。
 */
import { randomUUID } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type RouteDef } from '@wms3d/contracts';
import type { z } from 'zod';
import { createKit, cmd, fresh, SKUS, USERS, WH1, WH2, type Kit } from './testkit.ts';

type Role = 'admin' | 'manager' | 'op1' | 'viewer';
type Where = 'own' | 'other';
const ROLE_OF: Record<Role, string> = {
  admin: 'ADMIN',
  manager: 'MANAGER',
  op1: 'OPERATOR',
  viewer: 'VIEWER',
};
const S = (i: number) => SKUS[i]!.id;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const expiredJwt = () =>
  `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) - 5, n: randomUUID() })}.s`;

const owned = Object.values(routes as Record<string, RouteDef>).filter((r) => r.owner === 'ws-a2');
/** WH2 未发布布局：ADMIN 访问其孪生数据合法地返回 404 */
const WH2_HAS_NO_LAYOUT = new Set(['getTwin', 'getOccupancy']);

describe('RBAC 自动矩阵（ws-a2 路由）', () => {
  let k: Kit;
  const whOf = (w: Where) => (w === 'own' ? WH1 : WH2);
  let wh2Loc: string;

  beforeAll(async () => {
    k = await createKit({ poolMax: 6 });
    wh2Loc = k.wh2Locs[0]!;
    // WH2 的初始库存（ADMIN）
    const r = await k.txn('admin', {
      ...cmd(
        'INBOUND',
        [{ locationId: wh2Loc, skuId: S(0), qty: 1000 }],
        { warehouseId: WH2 },
        'admin',
      ),
    });
    expect(r.statusCode).toBe(201);
  }, 60_000);
  afterAll(async () => k?.close());

  const post = (
    token: string,
    url: string,
    payload: object,
    headers: Record<string, string> = {},
  ) => k.req(token, { method: 'POST', url: `/api/v1${url}`, payload, headers });
  const newTxn = async (w: Where, user: Role) => {
    const by: Role = w === 'other' || user === 'viewer' ? 'admin' : user;
    const loc = w === 'own' ? fresh() : wh2Loc;
    const r = await k.txn(
      by,
      cmd('INBOUND', [{ locationId: loc, skuId: S(1), qty: 1 }], { warehouseId: whOf(w) }, by),
    );
    expect(r.statusCode).toBe(201);
    return r.json().txn.id as string;
  };
  const newCount = async (w: Where, start: boolean) => {
    const loc = w === 'own' ? fresh() : wh2Loc;
    const r = await post('admin', '/counts', {
      warehouseId: whOf(w),
      scope: { locationIds: [loc] },
      blind: true,
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    if (start) expect((await post('admin', `/counts/${id}/start`, {})).statusCode).toBe(200);
    return { id, loc };
  };

  /** 每条路由的请求构造（可能先建前置资源） */
  const fixtures: Record<string, (w: Where, role: Role) => Promise<InjectOptions>> = {
    getTwin: async (w) => ({ method: 'GET', url: `/api/v1/warehouses/${whOf(w)}/twin` }),
    getOccupancy: async (w) => ({
      method: 'GET',
      url: `/api/v1/warehouses/${whOf(w)}/twin/occupancy?layoutVersion=1`,
    }),
    syncMasterdata: async (w) => ({
      method: 'GET',
      url: `/api/v1/sync/masterdata?warehouseId=${whOf(w)}&limit=50`,
    }),
    syncDigest: async (w) => ({
      method: 'GET',
      url: `/api/v1/sync/masterdata/digest?warehouseId=${whOf(w)}`,
    }),
    postTransaction: async (w, role) => ({
      method: 'POST',
      url: '/api/v1/inventory/transactions',
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        ...cmd('INBOUND', [{ locationId: w === 'own' ? fresh() : wh2Loc, skuId: S(2), qty: 1 }], {
          warehouseId: whOf(w),
        }),
        performedBy: USERS[role],
      },
    }),
    reverseTransaction: async (w, role) => ({
      method: 'POST',
      url: `/api/v1/inventory/transactions/${await newTxn(w, role)}/reverse`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { note: 'rbac' },
    }),
    listTransactions: async (w) => ({
      method: 'GET',
      url: `/api/v1/inventory/transactions?warehouseId=${whOf(w)}`,
    }),
    getTransaction: async (w) => ({
      method: 'GET',
      url: `/api/v1/inventory/transactions/${await newTxn(w, 'admin')}`,
    }),
    listBalances: async (w) => ({
      method: 'GET',
      url: `/api/v1/inventory/balances?warehouseId=${whOf(w)}`,
    }),
    listMovements: async (w) => ({
      method: 'GET',
      url: `/api/v1/inventory/movements?warehouseId=${whOf(w)}`,
    }),
    exportMovements: async (w) => ({
      method: 'GET',
      url: `/api/v1/inventory/movements.csv?warehouseId=${whOf(w)}`,
    }),
    locate: async (w) => ({
      method: 'GET',
      url: `/api/v1/inventory/locate?warehouseId=${whOf(w)}&q=SKU-001`,
    }),
    lowStock: async (w) => ({
      method: 'GET',
      url: `/api/v1/inventory/low-stock?warehouseId=${whOf(w)}`,
    }),
    createCount: async (w) => ({
      method: 'POST',
      url: '/api/v1/counts',
      payload: {
        warehouseId: whOf(w),
        scope: { locationIds: [w === 'own' ? fresh() : wh2Loc] },
        blind: true,
      },
    }),
    listCounts: async (w) => ({ method: 'GET', url: `/api/v1/counts?warehouseId=${whOf(w)}` }),
    getCount: async (w) => ({
      method: 'GET',
      url: `/api/v1/counts/${(await newCount(w, false)).id}`,
    }),
    listCountLines: async (w) => ({
      method: 'GET',
      url: `/api/v1/counts/${(await newCount(w, true)).id}/lines`,
    }),
    startCount: async (w) => ({
      method: 'POST',
      url: `/api/v1/counts/${(await newCount(w, false)).id}/start`,
      payload: {},
    }),
    submitCount: async (w) => {
      const c = await newCount(w, true);
      return {
        method: 'POST',
        url: `/api/v1/counts/${c.id}/submissions`,
        payload: {
          submissionId: randomUUID(),
          locationId: c.loc,
          clientCountedAt: new Date().toISOString(),
          lines: [{ skuId: S(0), countedQty: 1 }],
        },
      };
    },
    reviewCount: async (w) => ({
      method: 'POST',
      url: `/api/v1/counts/${(await newCount(w, true)).id}/review`,
      payload: {},
    }),
    closeCount: async (w) => ({
      method: 'POST',
      url: `/api/v1/counts/${(await newCount(w, true)).id}/close`,
      payload: {},
    }),
    cancelCount: async (w) => ({
      method: 'POST',
      url: `/api/v1/counts/${(await newCount(w, false)).id}/cancel`,
      payload: {},
    }),
    dashboard: async (w) => ({ method: 'GET', url: `/api/v1/dashboard?warehouseId=${whOf(w)}` }),
    auditLogs: async (w) => ({
      method: 'GET',
      url: `/api/v1/audit-logs?warehouseId=${whOf(w)}&limit=5`,
    }),
    events: async (w) => ({ method: 'GET', url: `/api/v1/events?warehouseId=${whOf(w)}` }),
  };

  it('矩阵覆盖全部 owner=ws-a2 路由', () => {
    expect(Object.keys(fixtures).sort()).toEqual(owned.map((r) => r.id).sort());
  });

  for (const spec of owned) {
    it(`${spec.id} ${spec.method} ${spec.path}`, async () => {
      const allowedRoles = spec.roles as readonly string[];
      // 无令牌 → 401
      const anon = await k.app.inject(await fixtures[spec.id]!('own', 'admin'));
      expect(anon.statusCode, 'anonymous').toBe(401);
      for (const role of ['admin', 'manager', 'op1', 'viewer'] as const) {
        for (const w of ['own', 'other'] as const) {
          const opts = await fixtures[spec.id]!(w, role);
          let token: string = role;
          if (spec.id === 'events') {
            token = expiredJwt(); // 已过期 → 200 后立即关流，inject 可返回
            k.auth.set(token, k.auth.get(role)!);
          }
          const r = await k.req(token, opts);
          const label = `${spec.id} ${role} ${w} → ${r.statusCode} ${r.body.slice(0, 200)}`;
          const roleOk = allowedRoles.includes(ROLE_OF[role]);
          if (!roleOk) {
            expect(r.statusCode, label).toBe(403);
            continue;
          }
          if (w === 'other' && role !== 'admin') {
            expect(r.statusCode, label).toBe(404);
            continue;
          }
          if (w === 'other' && WH2_HAS_NO_LAYOUT.has(spec.id)) {
            expect([404, 409], label).toContain(r.statusCode);
            continue;
          }
          expect(r.statusCode, label).toBeLessThan(500);
          expect([401, 403, 404], label).not.toContain(r.statusCode);
          if (r.statusCode >= 200 && r.statusCode < 300) {
            const schema = spec.responses[r.statusCode] as z.ZodType | null | undefined;
            const ct = String(r.headers['content-type'] ?? '');
            if (schema && ct.includes('application/json')) schema.parse(r.json());
            if (spec.produces === 'text/csv') expect(ct, label).toMatch(/^text\/csv/);
            if (spec.id === 'events') expect(ct, label).toMatch(/^text\/event-stream/);
          }
        }
      }
    }, 60_000);
  }
});
