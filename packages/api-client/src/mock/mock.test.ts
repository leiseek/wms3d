import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { setupServer } from 'msw/node';
import { Problem, routeList, routes, type RouteSpec } from '@wms3d/contracts';
import { demo } from '@wms3d/domain';
import { createApiClient, newIdempotencyKey, ApiError, type ApiClient } from '../index.ts';
import { createMockApi, createMswHandlers, type MockApi } from './index.ts';
import { buildMockServer } from './server.ts';
import { byteCompare, sha256Hex } from './util.ts';

const WH1 = demo.demoWarehouse.id;
const WH2 = demo.demoWarehouse2.id;
const ADMIN = demo.demoUsers[0]!.id;

/** 把 mock core 包装成 fetch，并对每个 JSON 响应做契约校验 */
function contractFetch(api: MockApi, seen: Set<string>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const res = await api.handle({ method: init?.method ?? 'GET', url, headers, body });
    const path = new URL(url, 'http://x').pathname.replace('/api/v1', '');
    const spec = [...(routeList as readonly RouteSpec[])]
      .sort((a, b) => (a.path.match(/:/g)?.length ?? 0) - (b.path.match(/:/g)?.length ?? 0))
      .find(
        (r) =>
          r.method === (init?.method ?? 'GET') &&
          new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path),
      );
    if (spec && res.body.kind === 'json') {
      const schema =
        res.status >= 400 ? Problem : (spec.responses[res.status] as z.ZodType | null | undefined);
      expect(schema, `${spec.id} 未声明状态码 ${res.status}`).toBeTruthy();
      const r = schema!.safeParse(res.body.value);
      expect(
        r.success,
        `${spec.id} ${res.status} 响应不符合契约：${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`,
      ).toBe(true);
      if (res.status < 400) seen.add(spec.id);
    } else if (spec && res.status < 400) seen.add(spec.id);
    const payload =
      res.body.kind === 'json'
        ? JSON.stringify(res.body.value)
        : res.body.kind === 'text'
          ? res.body.value
          : null;
    return new Response(res.status === 204 || res.status === 304 ? null : payload, {
      status: res.status,
      headers: res.headers,
    });
  };
}

async function login(
  api: MockApi,
  seen: Set<string>,
  username: string,
  deviceId = 'dev-test-0001',
): Promise<ApiClient> {
  let token: string | null = null;
  const c = createApiClient({ getAccessToken: () => token, fetch: contractFetch(api, seen) });
  const r = await c.r.authLogin({
    body: { username, password: demo.DEMO_PASSWORD, deviceId, client: 'mobile' },
  });
  token = r.accessToken;
  return c;
}

describe('mock 覆盖全部契约路由', () => {
  it('每个 routeId 都有 mock handler', () => {
    const api = createMockApi();
    const missing = routeList.map((r) => r.id).filter((id) => !api.implemented.has(id));
    expect(missing).toEqual([]);
  });
});

describe('mock 场景 × 契约校验（所有 JSON 响应用 contracts schema 校验）', () => {
  const api = createMockApi({ now: () => new Date('2026-11-12T08:00:00.000Z') });
  const seen = new Set<string>();
  let admin: ApiClient;
  let op: ApiClient;

  beforeAll(async () => {
    admin = await login(api, seen, 'admin');
    op = await login(api, seen, 'op1', 'dev-test-0002');
  });

  it('认证、用户、设备', async () => {
    expect((await admin.r.me({})).username).toBe('admin');
    await admin.r.appVersion({});
    await admin.r.health({});
    await admin.r.ready({});
    const users = await admin.r.listUsers({ query: {} });
    expect(users.items.length).toBe(5);
    const u = await admin.r.createUser({
      body: {
        username: 'op3',
        displayName: '新人',
        role: 'OPERATOR',
        warehouseIds: [WH1],
        temporaryPassword: 'Temp#1234',
      },
    });
    await admin.r.getUser({ params: { id: u.id } });
    await admin.r.patchUser({ params: { id: u.id }, body: { displayName: '新人2' } });
    await admin.r.resetPassword({ params: { id: u.id }, body: { temporaryPassword: 'Temp#5678' } });
    const devs = await admin.r.listDevices({});
    await admin.r.patchDevice({ params: { id: devs.items[0]!.id }, body: { name: '平板 1' } });
    await op.r.heartbeat({
      body: { deviceId: 'dev-test-0002', appVersion: '0.1.0', pendingOutbox: 2 },
    });
    await expect(op.r.listUsers({ query: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // v1.2（WS-A1-1）：当前口令错误 / 新旧相同 → 400 VALIDATION_FAILED（不触发 401 刷新）
    await expect(
      op.r.changePassword({ body: { currentPassword: 'wrong-pass', newPassword: 'Other#pass1' } }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(
      op.r.changePassword({
        body: { currentPassword: demo.DEMO_PASSWORD, newPassword: demo.DEMO_PASSWORD },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await op.r.changePassword({
      body: { currentPassword: demo.DEMO_PASSWORD, newPassword: 'Other#pass1' },
    });
    await op.r.changePassword({
      body: { currentPassword: 'Other#pass1', newPassword: demo.DEMO_PASSWORD },
    });
    // 刷新与登出（另开一个会话）
    let tk: string | null = null;
    const c3 = createApiClient({ getAccessToken: () => tk, fetch: contractFetch(api, seen) });
    const l3 = await c3.r.authLogin({
      body: {
        username: 'viewer',
        password: demo.DEMO_PASSWORD,
        deviceId: 'dev-test-0003',
        client: 'mobile',
      },
    });
    const rf = await c3.r.authRefresh({
      body: { refreshToken: l3.refreshToken!, deviceId: 'dev-test-0003' },
    });
    tk = rf.accessToken;
    await c3.r.authLogout({ body: {} });
    await expect(c3.r.me({})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('仓库、布局、仓位', async () => {
    const whs = await op.r.listWarehouses({});
    expect(whs.items.map((w) => w.code)).toEqual(['WH1']);
    await expect(op.r.getWarehouse({ params: { id: WH2 } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await admin.r.getWarehouse({ params: { id: WH1 } });
    await admin.r.patchWarehouse({ params: { id: WH1 }, body: { name: '演示一号仓' } });
    const created = await admin.r.createWarehouse({
      body: { code: 'WH9', name: '九号', widthM: 20, depthM: 20, heightM: 6 },
    });
    expect(created.locationCodePatternLocked).toBe(false);
    expect((await admin.r.listZones({ params: { id: WH1 } })).items).toHaveLength(4);
    expect((await admin.r.listRacks({ params: { id: WH1 } })).items).toHaveLength(16);
    const rts = await admin.r.listRackTypes({});
    const spec = {
      ...demo.demoLayout.rackTypes[0]!,
      key: 'std-2x2',
      bays: 2,
      levels: 2,
      levelHeightsM: [1.5, 1.5],
    };
    const rt = await admin.r.createRackType({ body: spec });
    await admin.r.patchRackType({ params: { id: rt.id }, body: { ...spec, name: '小架' } });
    expect(rts.items.length).toBe(1);
    await admin.r.listLayoutVersions({ params: { id: WH1 } });
    const pub = await admin.r.getLayout({ params: { id: WH1 }, query: {} });
    expect(pub.version).toBe(1);
    const draft = await admin.r.createDraft({ params: { id: WH1 }, body: { basedOnVersion: 1 } });
    const doc = structuredClone(draft.doc);
    doc.floorAreas = doc.floorAreas.filter((f) => f.locationCode !== 'SHP-01'); // 停用一个无库存的地面仓位
    await expect(
      admin.r.saveDraft({ params: { id: WH1 }, body: { doc }, ifMatch: 5 }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const saved = await admin.r.saveDraft({ params: { id: WH1 }, body: { doc }, ifMatch: 0 });
    const v = await admin.r.validateLayout({ params: { id: WH1 }, body: {} });
    expect(v.diff.deactivated.map((d) => d.code)).toEqual(['SHP-01']);
    const res = await admin.r.publishLayout({
      params: { id: WH1 },
      body: { rowVersion: saved.rowVersion },
    });
    expect(res.layoutVersion).toBe(2);
    // 草稿删除
    await admin.r.createDraft({ params: { id: WH1 }, body: { basedOnVersion: 2 } });
    await admin.r.deleteDraft({ params: { id: WH1 } });
    const locs = await op.r.listLocations({ params: { id: WH1 }, query: { zone: 'A', limit: 10 } });
    expect(locs.items).toHaveLength(10);
    expect(locs.nextCursor).toBe('10');
    const l0 = locs.items[0]!;
    await admin.r.patchLocation({ params: { id: l0.id }, body: { maxQty: 300 } });
    await admin.r.bulkPatchLocations({
      params: { id: WH1 },
      body: { ids: [l0.id], patch: { pickSeq: 5 } },
    });
  });

  it('SKU、扫码、同步', async () => {
    const list = await op.r.listSkus({ query: { q: 'SKU-001' } }).catch((e: ApiError) => {
      throw new Error(JSON.stringify(e.problem));
    });
    const sku = list.items[0]!;
    await op.r.getSku({ params: { id: sku.id } });
    const n = await admin.r.createSku({
      body: { code: 'SKU-NEW', name: '新品', barcodes: [{ barcode: 'NEW-0001' }] },
    });
    await admin.r.patchSku({ params: { id: n.id }, body: { safetyStock: 3 } });
    const withB = await admin.r.addSkuBarcode({
      params: { id: n.id },
      body: { barcode: 'NEW-0002', packQty: 6 },
    });
    await admin.r.deleteSkuBarcode({ params: { id: n.id, barcodeId: withB.barcodes[1]!.id } });
    await expect(
      admin.r.createSku({
        body: { code: 'SKU-X', name: 'x', barcodes: [{ barcode: sku.barcodes[0]!.barcode }] },
      }),
    ).rejects.toMatchObject({ code: 'BARCODE_CONFLICT' });
    const fd = new FormData();
    await admin.r.importSkus({ query: { dryRun: 'true' }, body: fd });
    const csv = await admin.r.exportSkus({});
    expect(await csv.text()).toMatch(/^\uFEFF?code,name/);
    const loc = demo.demoLocations.find((l) => l.rackKey)!;
    expect((await op.r.scanResolve({ query: { warehouseId: WH1, code: loc.payload } })).kind).toBe(
      'LOCATION',
    );
    expect(
      (await op.r.scanResolve({ query: { warehouseId: WH1, code: loc.code.toLowerCase() } })).kind,
    ).toBe('LOCATION');
    expect(
      (await op.r.scanResolve({ query: { warehouseId: WH1, code: sku.barcodes[0]!.barcode } }))
        .kind,
    ).toBe('SKU');
    expect(
      (await op.r.scanResolve({ query: { warehouseId: WH1, code: `WH2.${loc.code}` } })).kind,
    ).toBe('WRONG_WAREHOUSE');
    expect((await op.r.scanResolve({ query: { warehouseId: WH1, code: 'RA01-L01' } })).kind).toBe(
      'RACK',
    );
    const p1 = await op.r.syncMasterdata({ query: { warehouseId: WH1, limit: 100 } });
    expect(p1.hasMore).toBe(true);
    expect(p1.total).toBeGreaterThan(400);
    const p2 = await op.r.syncMasterdata({
      query: { warehouseId: WH1, cursor: p1.nextCursor!, limit: 2000 },
    });
    // v1.2（WS-A2-1）：客户端可用同步结果复算 digest
    const lines = [p1, p2].flatMap((p) => [
      ...p.skus.map((x) => `sku|${x.id}|${x.updatedAt}`),
      ...p.barcodes.map((x) => `barcode|${x.id}|${x.updatedAt}`),
      ...p.locations.map((x) => `location|${x.id}|${x.updatedAt}`),
    ]);
    lines.sort(byteCompare);
    const dg = await op.r.syncDigest({ query: { warehouseId: WH1 } });
    expect(dg.hash).toBe(sha256Hex(lines.join('\n')));
  });

  it('库存交易、幂等、冲正、查询', async () => {
    const empty = demo.demoLocations.find((l, i) => l.rackKey && i % 3 === 1)!;
    const sku = demo.demoSkus[0]!;
    const key = newIdempotencyKey();
    const cmd = {
      type: 'INBOUND' as const,
      warehouseId: WH1,
      performedBy: demo.demoUsers[2]!.id,
      clientCreatedAt: '2026-11-12T07:59:00.000Z',
      lines: [{ locationCode: empty.payload, skuBarcode: sku.barcodes[0]!.barcode, qty: 10 }],
    };
    const r1 = await op.r.postTransaction({ body: cmd, idempotencyKey: key });
    expect(r1.replayed).toBe(false);
    expect(r1.balancesAfter[0]!.onHand).toBe(10);
    const r2 = await op.r.postTransaction({ body: cmd, idempotencyKey: key });
    expect(r2.replayed).toBe(true);
    await expect(
      op.r.postTransaction({
        body: { ...cmd, lines: [{ ...cmd.lines[0]!, qty: 11 }] },
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      op.r.postTransaction({
        body: { ...cmd, type: 'OUTBOUND', lines: [{ ...cmd.lines[0]!, qty: 999 }] },
        idempotencyKey: newIdempotencyKey(),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await expect(
      op.r.postTransaction({
        body: { ...cmd, performedBy: ADMIN },
        idempotencyKey: newIdempotencyKey(),
      }),
    ).rejects.toMatchObject({ code: 'PERFORMER_NOT_ALLOWED' });
    const out = await op.r.postTransaction({
      body: { ...cmd, type: 'OUTBOUND', lines: [{ ...cmd.lines[0]!, qty: 3 }] },
      idempotencyKey: newIdempotencyKey(),
    });
    const to = demo.demoLocations.find((l, i) => l.rackKey && i % 3 === 2)!;
    await op.r.postTransaction({
      body: {
        type: 'TRANSFER',
        warehouseId: WH1,
        performedBy: cmd.performedBy,
        clientCreatedAt: cmd.clientCreatedAt,
        lines: [{ fromLocationId: empty.id, toLocationId: to.id, skuId: sku.id, qty: 2 }],
      },
      idempotencyKey: newIdempotencyKey(),
    });
    await admin.r.postTransaction({
      body: {
        type: 'ADJUST',
        warehouseId: WH1,
        performedBy: ADMIN,
        clientCreatedAt: cmd.clientCreatedAt,
        reason: 'FOUND',
        lines: [{ locationId: to.id, skuId: sku.id, qtyDelta: 1 }],
      },
      idempotencyKey: newIdempotencyKey(),
    });
    const rev = await op.r.reverseTransaction({
      params: { id: out.txn.id },
      body: {},
      idempotencyKey: newIdempotencyKey(),
    });
    expect(rev.txn.type).toBe('REVERSAL');
    await expect(
      op.r.reverseTransaction({
        params: { id: out.txn.id },
        body: {},
        idempotencyKey: newIdempotencyKey(),
      }),
    ).rejects.toMatchObject({ code: 'TXN_ALREADY_REVERSED' });
    expect((await op.r.getTransaction({ params: { id: out.txn.id } })).reversedByTxnId).toBe(
      rev.txn.id,
    );
    expect(
      (await op.r.listTransactions({ query: { warehouseId: WH1, limit: 3 } })).items[0]!.type,
    ).toBe('REVERSAL');
    expect(
      (await op.r.listBalances({ query: { warehouseId: WH1, locationId: empty.id } })).items[0]!
        .onHand,
    ).toBe(8);
    await op.r.listMovements({ query: { warehouseId: WH1 } });
    expect(await (await admin.r.exportMovements({ query: { warehouseId: WH1 } })).text()).toMatch(
      /txn_type/,
    );
    expect(
      (await op.r.locate({ query: { warehouseId: WH1, q: sku.code } })).items.length,
    ).toBeGreaterThan(0);
    await op.r.lowStock({ query: { warehouseId: WH1 } });
  });

  it('孪生、盘点、标签、看板、审计、事件', async () => {
    const twin = await op.r.getTwin({ params: { id: WH1 } });
    expect(twin!.locations.id.length).toBeGreaterThan(300);
    expect(
      await op.r.getTwin({ params: { id: WH1 }, ifNoneMatch: `"lv-${twin!.layoutVersion}"` }),
    ).toBeNull();
    const occ = await op.r.getOccupancy({
      params: { id: WH1 },
      query: { layoutVersion: twin!.layoutVersion },
    });
    expect(occ!.qty).toHaveLength(twin!.locations.id.length);
    await expect(
      op.r.getOccupancy({ params: { id: WH1 }, query: { layoutVersion: 99 } }),
    ).rejects.toMatchObject({ code: 'LAYOUT_STALE' });

    const loc = demo.demoLocations.find((l) => l.rackKey)!;
    const task = await admin.r.createCount({
      body: { warehouseId: WH1, scope: { locationIds: [loc.id] } },
    });
    await admin.r.listCounts({ query: { warehouseId: WH1 } });
    await admin.r.getCount({ params: { id: task.id } });
    await admin.r.startCount({ params: { id: task.id }, body: {} });
    const sub = await op.r.submitCount({
      params: { id: task.id },
      body: {
        submissionId: newIdempotencyKey().replace(/^(.{14})./, '$14'),
        locationId: loc.id,
        clientCountedAt: '2026-11-12T08:00:00.000Z',
        lines: [],
      },
    });
    expect(sub.lines.every((l) => l.systemQtyAtCount === null)).toBe(true);
    await op.r.listCountLines({ params: { id: task.id }, query: {} });
    await admin.r.reviewCount({ params: { id: task.id }, body: {} });
    const closed = await admin.r.closeCount({ params: { id: task.id }, body: {} });
    expect(closed.task.status).toBe('CLOSED');
    const t2 = await admin.r.createCount({ body: { warehouseId: WH1, scope: { zones: ['B'] } } });
    await admin.r.cancelCount({ params: { id: t2.id }, body: {} });

    const tpl = await op.r.listLabelTemplates({});
    expect(tpl.items).toHaveLength(7);
    const pdf = await admin.r.renderLabels({
      body: { template: 'loc-100x50', kind: 'LOCATION', warehouseId: WH1, ids: [loc.id] },
    });
    expect(pdf.headers.get('content-type')).toMatch(/pdf/);
    expect(pdf.headers.get('x-label-count')).toBe('1');
    // v1.2（WS-A1-2/3）：ZPL 可选输出；A4 + ZPL → 400；RACK 只能用 rack-100x150
    const zpl = await admin.r.renderLabels({
      body: {
        template: 'loc-100x50',
        kind: 'LOCATION',
        warehouseId: WH1,
        ids: [loc.id],
        format: 'ZPL',
      },
    });
    expect(zpl.headers.get('content-type')).toMatch(/zpl/);
    expect(await zpl.text()).toContain('^XA');
    await expect(
      admin.r.renderLabels({
        body: {
          template: 'a4-3x8',
          kind: 'LOCATION',
          warehouseId: WH1,
          ids: [loc.id],
          format: 'ZPL',
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(
      admin.r.renderLabels({
        body: { template: 'loc-100x50', kind: 'RACK', warehouseId: WH1, ids: [loc.id] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(tpl.items.find((t) => t.key === 'loc-100x50')!.maxModules).toEqual({
      dpi203: 253,
      dpi300: 281,
    });
    await admin.r.calibrationPdf({ query: { template: 'loc-100x50' } });
    const rp = await op.r.createReprint({
      body: { warehouseId: WH1, kind: 'LOCATION', entityId: loc.id, reason: 'DAMAGED' },
    });
    await op.r.listReprints({ query: { warehouseId: WH1 } });
    await admin.r.patchReprint({ params: { id: rp.id }, body: { status: 'DONE' } });

    const dash = await op.r.dashboard({ query: { warehouseId: WH1 } });
    expect(dash.locations.total).toBeGreaterThan(300);
    await admin.r.auditLogs({ query: {} });
    const sse = await op.r.events({ query: { warehouseId: WH1 } });
    expect(sse.headers.get('content-type')).toMatch(/event-stream/);
  });

  it('场景覆盖了全部成功响应路由', () => {
    const notSeen = routeList.map((r) => r.id).filter((id) => !seen.has(id));
    expect(notSeen).toEqual([]);
  });
});

describe('MSW handlers + 类型化客户端（单飞刷新）', () => {
  const api = createMockApi({ accessTtlSec: 900 });
  const server = setupServer(...createMswHandlers(api));
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterAll(() => server.close());

  it('过期 token 触发一次刷新后重试', async () => {
    let token: string | null = 'mock.invalid';
    let refreshCalls = 0;
    let refreshToken = '';
    const c = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => token,
      refresh: async () => {
        refreshCalls += 1;
        const r = await c.r.authRefresh({ body: { refreshToken, deviceId: 'dev-msw-0001' } });
        token = r.accessToken;
        return true;
      },
    });
    const saved = token;
    token = null;
    const l = await c.r.authLogin({
      body: {
        username: 'manager',
        password: demo.DEMO_PASSWORD,
        deviceId: 'dev-msw-0001',
        client: 'mobile',
      },
    });
    refreshToken = l.refreshToken!;
    token = saved; // 无效 token
    const [a, b] = await Promise.all([c.r.me({}), c.r.listWarehouses({})]);
    expect(a.username).toBe('manager');
    expect(b.items.length).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('problem+json 映射为 ApiError', async () => {
    const c = createApiClient({ baseUrl: 'http://api.test', getAccessToken: () => null });
    const e = await c.r.me({}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('UNAUTHENTICATED');
  });
});

describe('mock server（Fastify）', () => {
  it('登录 → me → SSE 推送 stock.changed', async () => {
    const { app } = buildMockServer();
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const login = await fetch(`${url}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'op1',
          password: demo.DEMO_PASSWORD,
          deviceId: 'dev-srv-0001',
          client: 'web',
        }),
      });
      expect(login.status).toBe(200);
      expect(login.headers.get('set-cookie')).toMatch(/wms_rt=.*HttpOnly/);
      const { accessToken } = (await login.json()) as { accessToken: string };
      const auth = { authorization: `Bearer ${accessToken}` };
      expect((await fetch(`${url}/api/v1/me`, { headers: auth })).status).toBe(200);
      const ctrl = new AbortController();
      const sse = await fetch(`${url}/api/v1/events?warehouseId=${WH1}`, {
        headers: auth,
        signal: ctrl.signal,
      });
      const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = (await reader.read()).value ?? '';
      expect(buf).toMatch(/event: ping/);
      const loc = demo.demoLocations.find((l) => l.rackKey)!;
      const post = await fetch(`${url}/api/v1/inventory/transactions`, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json',
          'idempotency-key': newIdempotencyKey(),
        },
        body: JSON.stringify({
          type: 'INBOUND',
          warehouseId: WH1,
          performedBy: demo.demoUsers[2]!.id,
          clientCreatedAt: '2026-11-12T08:00:00.000Z',
          lines: [{ locationId: loc.id, skuId: demo.demoSkus[1]!.id, qty: 1 }],
        }),
      });
      expect(post.status).toBe(201);
      while (!buf.includes('stock.changed')) buf += (await reader.read()).value ?? '';
      ctrl.abort();
      expect(buf).toMatch(/event: stock\.changed/);
    } finally {
      await app.close();
    }
  });
});

void routes;
