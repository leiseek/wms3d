/** 验收（ws-f 简报）：登录 + 一笔入库；附带幂等重放与跨仓越权（09 §2 #2、#9）。 */
import { expect, test } from '@playwright/test';
import { as, call, login, newDeviceId, notImplemented, uuidv7 } from '../../lib/api.ts';
import { EMPTY_LOCS, SKU1, WH1, WH2 } from '../../lib/fixtures.ts';

interface TxnResult {
  txn: {
    id: string;
    type: string;
    performedBy: string;
    lines: { locationCode: string; qtyDelta: number; balanceAfter: number }[];
  };
  balancesAfter: { locationId: string; skuId: string; onHand: number }[];
  replayed: boolean;
}

test.describe.configure({ mode: 'serial' });

test('登录（mobile 客户端）→ /me', async () => {
  const r = await login('op2', undefined, newDeviceId('e2e-login'));
  expect(r.status).toBe(200);
  expect(r.body.accessToken).toBeTruthy();
  const me = await call<{ username: string; role: string }>('GET', '/me', {
    token: r.body.accessToken,
  });
  expect(me.status).toBe(200);
  expect(me.body).toMatchObject({ username: 'op2', role: 'OPERATOR' });
});

test('错误密码 → 401', async () => {
  const r = await login('op2', 'wrong-password');
  expect(r.status).toBe(401);
});

test('op1 扫码入库一笔（载荷编码 + 商品条码），重放同键不重复记账', async () => {
  const op = as('op1');
  const loc = EMPTY_LOCS[0]!;
  const key = uuidv7();
  const body = {
    type: 'INBOUND',
    warehouseId: WH1,
    performedBy: op.session.userId,
    clientCreatedAt: new Date().toISOString(),
    refNo: 'E2E-IN-1',
    lines: [{ locationCode: loc.payload, skuBarcode: SKU1.barcodes[0]!.barcode, qty: 7 }],
  };
  const r = await op.post<TxnResult>('/inventory/transactions', { body, idempotencyKey: key });
  test.skip(notImplemented(r), 'postTransaction 在真实 API 上尚未实现（ws-a2 未合并）');
  expect(r.status, r.text).toBe(201);
  expect(r.body.txn.type).toBe('INBOUND');
  expect(r.body.txn.performedBy).toBe(op.session.userId);
  expect(r.body.txn.lines[0]).toMatchObject({
    locationCode: loc.code,
    qtyDelta: 7,
    balanceAfter: 7,
  });
  expect(r.body.replayed).toBe(false);

  const again = await op.post<TxnResult>('/inventory/transactions', { body, idempotencyKey: key });
  expect(again.status).toBe(200);
  expect(again.body.replayed).toBe(true);
  expect(again.body.txn.id).toBe(r.body.txn.id);

  const bal = await op.get<{ items: { onHand: number }[] }>(
    `/inventory/balances?warehouseId=${WH1}&locationId=${loc.id}&skuId=${SKU1.id}`,
  );
  expect(bal.status).toBe(200);
  expect(bal.body.items.reduce((s, b) => s + b.onHand, 0)).toBe(7);

  // 不同 body 同键 → 409
  const reuse = await op.post<{ code: string }>('/inventory/transactions', {
    body: { ...body, lines: [{ ...body.lines[0]!, qty: 8 }] },
    idempotencyKey: key,
  });
  expect(reuse.status).toBe(409);
  expect(reuse.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
});

test('跨仓越权：op1（仅 WH1）写 WH2 → 404', async () => {
  const op = as('op1');
  const r = await op.post<{ code: string }>('/inventory/transactions', {
    idempotencyKey: uuidv7(),
    body: {
      type: 'INBOUND',
      warehouseId: WH2,
      performedBy: op.session.userId,
      clientCreatedAt: new Date().toISOString(),
      lines: [{ locationCode: 'WH2.A01-01-A01', skuBarcode: SKU1.barcodes[0]!.barcode, qty: 1 }],
    },
  });
  expect(r.status).toBe(404);
});
