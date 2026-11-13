import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  ERROR_STATUS,
  LayoutDoc,
  parseEvent,
  problem,
  requestHash,
  routeList,
  routes,
  TxnCommand,
  txnHashInput,
  type RouteSpec,
} from './index.ts';
import { buildOpenApi } from './openapi.ts';

const W = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const U = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

describe('路由表完整性', () => {
  const list = routeList as readonly RouteSpec[];
  it('operationId 与 key 一致且唯一', () => {
    for (const [k, r] of Object.entries(routes)) expect(r.id).toBe(k);
    expect(new Set(list.map((r) => r.id)).size).toBe(list.length);
  });
  it('method + path 唯一', () => {
    const keys = list.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('每个路由都有响应定义、owner，非 GET 有 body 或明确无 body', () => {
    for (const r of list) {
      expect(Object.keys(r.responses).length, r.id).toBeGreaterThan(0);
      expect(['ws-a1', 'ws-a2']).toContain(r.owner);
      if (r.method === 'GET') expect(r.body, r.id).toBeUndefined();
    }
  });
  it('作用域字段在对应 schema 中存在', () => {
    for (const r of list) {
      if (r.scope.from === 'path') expect(r.path, r.id).toContain(`:${r.scope.field}`);
      if (r.scope.from === 'query')
        expect(Object.keys((r.query as unknown as { shape: object }).shape), r.id).toContain(
          r.scope.field,
        );
    }
  });
  it('库存写接口要求幂等键并校验设备', () => {
    expect(routes.postTransaction.idempotency).toBe('required');
    expect(routes.postTransaction.checksDevice).toBe(true);
    expect(routes.reverseTransaction.idempotency).toBe('required');
  });
  it('覆盖 03 §5 的全部端点（77 个操作 / 65 条路径）', () => {
    expect(list.length).toBe(77);
    expect(new Set(list.map((r) => r.path)).size).toBe(65);
  });
});

describe('交易命令', () => {
  const base = { warehouseId: W, performedBy: U, clientCreatedAt: '2026-11-12T08:00:00.000Z' };
  it('INBOUND 接受载荷形式仓位码 + SKU 条码', () => {
    const r = TxnCommand.parse({
      type: 'INBOUND',
      ...base,
      lines: [{ locationCode: 'WH1.A03-17-C02', skuBarcode: '6901234567890', qty: 12 }],
    });
    expect(r.createdOffline).toBe(false);
  });
  it('仓位引用二选一', () => {
    expect(
      TxnCommand.safeParse({ type: 'OUTBOUND', ...base, lines: [{ skuId: W, qty: 1 }] }).success,
    ).toBe(false);
    expect(
      TxnCommand.safeParse({
        type: 'OUTBOUND',
        ...base,
        lines: [{ locationId: W, locationCode: 'A03-01-A01', skuId: W, qty: 1 }],
      }).success,
    ).toBe(false);
  });
  it('不接受客户端提交 COUNT_ADJUST / REVERSAL', () => {
    expect(TxnCommand.safeParse({ type: 'COUNT_ADJUST', ...base, lines: [] }).success).toBe(false);
    expect(TxnCommand.safeParse({ type: 'REVERSAL', ...base, lines: [] }).success).toBe(false);
  });
  it('ADJUST: qtyDelta ≠ 0；OTHER 需 note；DATA_FIX 需 refNo', () => {
    const line = { locationId: W, skuId: U, qtyDelta: -2 };
    expect(
      TxnCommand.safeParse({ type: 'ADJUST', ...base, reason: 'DAMAGE', lines: [line] }).success,
    ).toBe(true);
    expect(
      TxnCommand.safeParse({
        type: 'ADJUST',
        ...base,
        reason: 'DAMAGE',
        lines: [{ ...line, qtyDelta: 0 }],
      }).success,
    ).toBe(false);
    expect(
      TxnCommand.safeParse({ type: 'ADJUST', ...base, reason: 'OTHER', lines: [line] }).success,
    ).toBe(false);
    expect(
      TxnCommand.safeParse({ type: 'ADJUST', ...base, reason: 'DATA_FIX', lines: [line] }).success,
    ).toBe(false);
  });
  it('TRANSFER from ≠ to；每命令 ≤ 200 行', () => {
    expect(
      TxnCommand.safeParse({
        type: 'TRANSFER',
        ...base,
        lines: [{ fromLocationId: W, toLocationId: W, skuId: U, qty: 1 }],
      }).success,
    ).toBe(false);
    const many = Array.from({ length: 201 }, () => ({ locationId: W, skuId: U, qty: 1 }));
    expect(TxnCommand.safeParse({ type: 'INBOUND', ...base, lines: many }).success).toBe(false);
  });
  it('body 中没有 deviceId（取自令牌 did，R3）', () => {
    expect(Object.keys(TxnCommand.options[0].shape)).not.toContain('deviceId');
  });
});

describe('JCS golden vectors（RFC 8785）', () => {
  const vectors: Array<[unknown, string]> = [
    [{ b: 2, a: 1 }, '{"a":1,"b":2}'],
    [{ z: [3, { y: true, x: null }], a: 'é' }, '{"a":"é","z":[3,{"x":null,"y":true}]}'],
    [{ n: [1e21, 1e-7, -0, 0.1, 100, 1.5] }, '{"n":[1e+21,1e-7,0,0.1,100,1.5]}'],
    [{ s: 'line\n"q"\u0001' }, '{"s":"line\\n\\"q\\"\\u0001"}'],
    [{ '\u20ac': 1, '\r': 2, '1': 3, a: 4 }, '{"\\r":2,"1":3,"a":4,"€":1}'],
    [{ u: undefined, k: 1 }, '{"k":1}'],
  ];
  it.each(vectors)('canonicalize #%#', (input, expected) => {
    expect(canonicalize(input)).toBe(expected);
  });
  it('requestHash 去掉传输层字段，且与 node:crypto sha256 一致', async () => {
    const body = {
      type: 'INBOUND',
      warehouseId: W,
      performedBy: U,
      clientCreatedAt: '2026-11-12T08:00:00Z',
      createdOffline: true,
      performerSessionId: U,
      lines: [{ locationCode: 'A03-17-C02', skuBarcode: '6901234567890', qty: 12 }],
    };
    const expectedInput = `{"lines":[{"locationCode":"A03-17-C02","qty":12,"skuBarcode":"6901234567890"}],"performedBy":"${U}","type":"INBOUND","warehouseId":"${W}"}`;
    expect(txnHashInput(body)).toBe(expectedInput);
    const h = await requestHash(body);
    expect(h).toBe(createHash('sha256').update(expectedInput).digest('hex'));
    expect(
      await requestHash({
        ...body,
        clientCreatedAt: '2030-01-01T00:00:00Z',
        createdOffline: false,
      }),
    ).toBe(h);
  });
});

describe('错误与事件', () => {
  it('problem() 生成 RFC 9457 结构', () => {
    const p = problem('INSUFFICIENT_STOCK', 'A03-17-C02 上 SKU-001 仅有 3');
    expect(p).toMatchObject({
      type: 'urn:wms3d:error:INSUFFICIENT_STOCK',
      status: 422,
      code: 'INSUFFICIENT_STOCK',
    });
    expect(ERROR_STATUS.PERFORMER_NOT_ALLOWED).toBe(403);
  });
  it('parseEvent 校验负载', () => {
    expect(parseEvent('layout.published', '{"layoutVersion":3}')).toEqual({
      event: 'layout.published',
      data: { layoutVersion: 3 },
    });
    expect(parseEvent('layout.published', '{"layoutVersion":"x"}')).toBeNull();
    expect(parseEvent('nope', '{}')).toBeNull();
  });
});

describe('布局文档', () => {
  it('levelHeightsM 长度必须等于 levels；旋转只允许 90° 步进', () => {
    const doc = {
      schemaVersion: 2,
      warehouse: { widthM: 60, depthM: 40, heightM: 10 },
      zones: [],
      rackTypes: [
        {
          key: 't',
          bays: 2,
          levels: 2,
          positionsPerLevel: 1,
          bayWidthM: 2,
          depthM: 1,
          levelHeightsM: [1.5],
          beamM: 0.1,
          uprightM: 0.08,
          defaultMaxQty: null,
        },
      ],
      racks: [],
      floorAreas: [],
    };
    expect(LayoutDoc.safeParse(doc).success).toBe(false);
    doc.rackTypes[0]!.levelHeightsM = [1.5, 1.5];
    expect(LayoutDoc.safeParse(doc).success).toBe(true);
    expect(
      LayoutDoc.safeParse({
        ...doc,
        racks: [
          {
            key: 'r',
            zone: 'A',
            type: 't',
            aisle: 1,
            rackNo: 1,
            bayStart: 1,
            x: 0,
            z: 0,
            rotationDeg: 45,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('OpenAPI 冻结', () => {
  it('提交的 openapi.json 与 contracts 源一致（改契约后运行 pnpm --filter @wms3d/contracts gen:openapi）', () => {
    const committed = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
    expect(committed).toEqual(buildOpenApi());
  });
  it('无悬空 $ref', () => {
    const doc = buildOpenApi() as { components: { schemas: Record<string, unknown> } };
    const refs = [...JSON.stringify(doc).matchAll(/#\/components\/schemas\/(\w+)/g)].map(
      (m) => m[1]!,
    );
    expect(refs.filter((r) => !(r in doc.components.schemas))).toEqual([]);
  });
});
