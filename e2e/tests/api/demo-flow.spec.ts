/**
 * 演示脚本（ws-f 简报 §2）：建仓 → 设计 → 发布 → 打印 → 导入 → 上架（离线 + 在线）→ 定位 → 出库。
 * 串行；真实 API 上尚未实现的步骤（501）显式 skip，其后依赖它的步骤一并 skip，报告里可见。
 */
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { as, notImplemented, state, uuidv7, type Res } from '../../lib/api.ts';
import { DEMO_LOCATION_COUNT, demoLayout } from '../../lib/fixtures.ts';

test.describe.configure({ mode: 'serial' });

const admin = () => as('admin');
const manager = () => as('manager');
const ctx: {
  whId?: string;
  whCode?: string;
  locs?: { id: string; code: string }[];
  skuCode?: string;
  barcode?: string;
  skuId?: string;
  blocked?: string;
  rowVersion?: number;
} = {};
const guard = (r: Res, step: string) => {
  if (notImplemented(r)) ctx.blocked = `${step}：真实 API 返回 501（尚未实现）`;
  test.skip(notImplemented(r), ctx.blocked);
};
test.beforeEach(() => test.skip(!!ctx.blocked, ctx.blocked));

test('1 建仓（ADMIN）', async () => {
  ctx.whCode = `Z${randomBytes(2).toString('hex').toUpperCase().slice(0, 3)}`;
  const r = await admin().post<{ id: string; code: string }>('/warehouses', {
    body: {
      code: ctx.whCode,
      name: `e2e 演示仓 ${ctx.whCode}`,
      widthM: 60,
      depthM: 40,
      heightM: 10,
    },
  });
  guard(r, '建仓');
  expect(r.status, r.text).toBe(201);
  expect(r.body.code).toBe(ctx.whCode);
  ctx.whId = r.body.id;
});

test('2 设计：建草稿 → 保存布局（If-Match）→ 校验', async () => {
  const W = `/warehouses/${ctx.whId}`;
  const d = await manager().post<{ rowVersion: number }>(`${W}/layout/draft`, {
    body: { basedOnVersion: null },
  });
  guard(d, '建草稿');
  expect(d.status, d.text).toBe(201);
  const stale = await manager().put(`${W}/layout/draft`, {
    body: { doc: demoLayout },
    ifMatch: d.body.rowVersion + 99,
  });
  expect(stale.status).toBe(412);
  const s = await manager().put<{ rowVersion: number }>(`${W}/layout/draft`, {
    body: { doc: demoLayout },
    ifMatch: d.body.rowVersion,
  });
  expect(s.status, s.text).toBe(200);
  ctx.rowVersion = s.body.rowVersion;
  const v = await manager().post<{ issues: { severity: string }[]; locationCount: number }>(
    `${W}/layout/validate`,
    {
      body: {},
    },
  );
  expect(v.status, v.text).toBe(200);
  expect(v.body.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
  expect(v.body.locationCount).toBe(DEMO_LOCATION_COUNT);
});

test('3 发布：MANAGER 403，ADMIN 成功并生成仓位', async () => {
  const W = `/warehouses/${ctx.whId}`;
  const draft = await admin().get<{ rowVersion: number; status: string }>(
    `${W}/layout?version=draft`,
  );
  expect(draft.status, draft.text).toBe(200);
  expect(draft.body).toMatchObject({ status: 'DRAFT', rowVersion: ctx.rowVersion });
  const denied = await manager().post(`${W}/layout/publish`, {
    body: { rowVersion: ctx.rowVersion },
  });
  expect(denied.status).toBe(403);
  const p = await admin().post<{ layoutVersion: number; diff: { added: unknown[] } }>(
    `${W}/layout/publish`,
    {
      body: { rowVersion: ctx.rowVersion },
    },
  );
  guard(p, '发布');
  expect(p.status, p.text).toBe(200);
  expect(p.body.layoutVersion).toBe(1);
  expect(p.body.diff.added).toHaveLength(DEMO_LOCATION_COUNT);
  const l = await admin().get<{ items: { id: string; code: string }[] }>(
    `${W}/locations?limit=500`,
  );
  expect(l.status, l.text).toBe(200);
  expect(l.body.items.length).toBeGreaterThanOrEqual(Math.min(DEMO_LOCATION_COUNT, 200));
  ctx.locs = l.body.items.filter((x) => /^[A-Z]\d\d-\d\d-[A-Z]\d\d$/.test(x.code));
  expect(ctx.locs.length).toBeGreaterThan(2);
});

test('4 打印：仓位标签 PDF（loc-100x50）', async () => {
  const r = await manager().post('/labels/render', {
    body: {
      template: 'loc-100x50',
      kind: 'LOCATION',
      warehouseId: ctx.whId,
      ids: ctx.locs!.slice(0, 3).map((l) => l.id),
    },
  });
  guard(r, '打印');
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(r.headers.get('content-type')).toContain('application/pdf');
  expect(r.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('5 导入：SKU CSV（dry-run → 提交）', async () => {
  ctx.skuCode = `E2E-${randomBytes(3).toString('hex').toUpperCase()}`;
  ctx.barcode = `E2E${Date.now()}`;
  const csv = `code,name,uom,barcode,pack_qty,safety_stock\n${ctx.skuCode},e2e 测试商品,EA,${ctx.barcode},1,5\n`;
  const form = () => {
    const f = new FormData();
    f.append('file', new Blob([csv], { type: 'text/csv' }), 'skus.csv');
    return f;
  };
  const dry = await admin().post<{ dryRun: boolean; created: number; errors: unknown[] }>(
    '/skus/import?dryRun=true',
    {
      raw: form(),
    },
  );
  guard(dry, '导入');
  expect(dry.status, dry.text).toBe(200);
  expect(dry.body).toMatchObject({ dryRun: true, errors: [] });
  if (state().target === 'mock') {
    // mock 不解析 multipart（packages/api-client/src/mock/server.ts 丢弃文件体）→ 用 createSku 建同一个 SKU
    const c = await admin().post('/skus', {
      body: {
        code: ctx.skuCode,
        name: 'e2e 测试商品',
        barcodes: [{ barcode: ctx.barcode, isPrimary: true }],
      },
    });
    expect(c.status, c.text).toBe(201);
  } else {
    const real = await admin().post<{ created: number; errors: unknown[] }>(
      '/skus/import?dryRun=false',
      {
        raw: form(),
      },
    );
    expect(real.status, real.text).toBe(200);
    expect(real.body).toMatchObject({ created: 1, errors: [] });
  }
  const s = await admin().get<{ items: { id: string; code: string }[] }>(`/skus?q=${ctx.skuCode}`);
  expect(s.status, s.text).toBe(200);
  ctx.skuId = s.body.items.find((x) => x.code === ctx.skuCode)?.id;
  expect(ctx.skuId).toBeTruthy();
});

const inbound = (loc: string, qty: number, offline: boolean) => ({
  type: 'INBOUND',
  warehouseId: ctx.whId,
  performedBy: manager().session.userId,
  clientCreatedAt: new Date(Date.now() - (offline ? 10 * 60_000 : 0)).toISOString(),
  createdOffline: offline,
  lines: [{ locationCode: `${ctx.whCode}.${loc}`, skuBarcode: ctx.barcode, qty }],
});

test('6 上架：离线补传一笔 + 在线一笔（扫码载荷）', async () => {
  const [a, b] = ctx.locs!;
  const off = await manager().post<{ txn: { createdOffline: boolean } }>(
    '/inventory/transactions',
    {
      body: inbound(a!.code, 10, true),
      idempotencyKey: uuidv7(),
    },
  );
  guard(off, '上架（postTransaction）');
  expect(off.status, off.text).toBe(201);
  expect(off.body.txn.createdOffline).toBe(true);
  const on = await manager().post('/inventory/transactions', {
    body: inbound(b!.code, 5, false),
    idempotencyKey: uuidv7(),
  });
  expect(on.status, on.text).toBe(201);
});

test('7 定位：按 SKU 编码定位到两个仓位', async () => {
  const r = await as('manager').get<{ items: { code: string; qty: number }[] }>(
    `/inventory/locate?warehouseId=${ctx.whId}&q=${ctx.skuCode}`,
  );
  guard(r, '定位');
  expect(r.status, r.text).toBe(200);
  const got = Object.fromEntries(r.body.items.map((i) => [i.code, i.qty]));
  expect(got).toEqual({ [ctx.locs![0]!.code]: 10, [ctx.locs![1]!.code]: 5 });
});

test('8 出库：超量 422 INSUFFICIENT_STOCK，正常出库后余额正确', async () => {
  const loc = ctx.locs![0]!.code;
  const body = (qty: number) => ({
    ...inbound(loc, qty, false),
    type: 'OUTBOUND',
    createdOffline: false,
  });
  const over = await manager().post<{ code: string }>('/inventory/transactions', {
    body: body(11),
    idempotencyKey: uuidv7(),
  });
  guard(over, '出库');
  expect(over.status, over.text).toBe(422);
  expect(over.body.code).toBe('INSUFFICIENT_STOCK');
  const ok = await manager().post<{ balancesAfter: { onHand: number }[] }>(
    '/inventory/transactions',
    {
      body: body(4),
      idempotencyKey: uuidv7(),
    },
  );
  expect(ok.status, ok.text).toBe(201);
  expect(ok.body.balancesAfter[0]!.onHand).toBe(6);
  const bal = await manager().get<{ items: { onHand: number }[] }>(
    `/inventory/balances?warehouseId=${ctx.whId}&skuId=${ctx.skuId}`,
  );
  expect(bal.body.items.reduce((s, x) => s + x.onHand, 0)).toBe(11);
});
