// 契约 mock（@wms3d/api-client/mock，进程内）：twin3d 包不依赖 api-client，playground 以相对路径引用源码。
import type { Occupancy, TwinModel, WmsEvent } from '@wms3d/contracts';
import { demo } from '@wms3d/domain';
import { createMockApi, type MockApi } from '../../api-client/src/mock/core.ts';
import { createApiClient, type ApiClient } from '../../api-client/src/client.ts';
import { newIdempotencyKey } from '../../api-client/src/idempotency.ts';

export interface MockSession {
  api: MockApi;
  client: ApiClient;
  warehouseId: string;
  getTwin(): Promise<TwinModel>;
  getOccupancy(v: number): Promise<Occupancy | null>;
  locate(q: string): Promise<{ layoutVersion: number; locationIds: string[] }>;
  inbound(locationCode: string, qty: number): Promise<void>;
  outboundAll(locationId: string): Promise<void>;
  setActive(locationId: string, active: boolean): Promise<void>;
  subscribe(fn: (e: WmsEvent) => void): () => void;
}

export async function createMockSession(): Promise<MockSession> {
  const api = createMockApi();
  let token: string | null = null;
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const res = await api.handle({ method: init?.method ?? 'GET', url, headers, body });
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
  const client = createApiClient({ getAccessToken: () => token, fetch: f });
  const login = async (username: string) => {
    const r = await client.r.authLogin({
      body: {
        username,
        password: demo.DEMO_PASSWORD,
        deviceId: 'twin-playground-01',
        client: 'mobile',
      },
    });
    token = r.accessToken;
  };
  await login('manager');
  const WH = demo.demoWarehouse.id;
  const op = demo.demoUsers.find((u) => u.username === 'manager')!;
  return {
    api,
    client,
    warehouseId: WH,
    getTwin: async () => (await client.r.getTwin({ params: { id: WH } }))!,
    getOccupancy: async (v) =>
      client.r.getOccupancy({ params: { id: WH }, query: { layoutVersion: v } }),
    locate: async (q) => {
      const r = await client.r.locate({ query: { warehouseId: WH, q } });
      return {
        layoutVersion: r.layoutVersion,
        locationIds: [...new Set(r.items.map((i) => i.locationId))],
      };
    },
    inbound: async (locationCode, qty) => {
      const sku = demo.demoSkus[Math.floor(Math.random() * demo.demoSkus.length)]!;
      await client.r.postTransaction({
        body: {
          type: 'INBOUND',
          warehouseId: WH,
          performedBy: op.id,
          clientCreatedAt: new Date().toISOString(),
          lines: [{ locationCode, skuBarcode: sku.barcodes[0]!.barcode, qty }],
        },
        idempotencyKey: newIdempotencyKey(),
      });
    },
    outboundAll: async (locationId) => {
      const bal = await client.r.listBalances({ query: { warehouseId: WH, locationId } });
      const loc = demo.demoLocations.find((l) => l.id === locationId)!;
      for (const b of bal.items) {
        if (b.onHand <= 0) continue;
        const sku = demo.demoSkus.find((s) => s.id === b.skuId)!;
        await client.r.postTransaction({
          body: {
            type: 'OUTBOUND',
            warehouseId: WH,
            performedBy: op.id,
            clientCreatedAt: new Date().toISOString(),
            lines: [
              { locationCode: loc.payload, skuBarcode: sku.barcodes[0]!.barcode, qty: b.onHand },
            ],
          },
          idempotencyKey: newIdempotencyKey(),
        });
      }
    },
    setActive: async (locationId, active) => {
      await client.r.patchLocation({ params: { id: locationId }, body: { isActive: active } });
    },
    subscribe: (fn) => api.subscribe((wh, e) => wh === WH && fn(e)),
  };
}
