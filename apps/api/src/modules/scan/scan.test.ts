import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScanResolution } from '@wms3d/contracts';
import { pgAvailable } from '../../test/pg.ts';
import { login, setupKit, WH1, WH2, type Kit, type Session } from '../../lib/testkit.ts';

describe.skipIf(!pgAvailable)('scan/resolve（02 §3.2）', () => {
  let k: Kit;
  let op: Session;
  let admin: Session;
  beforeAll(async () => {
    k = await setupKit();
    op = await login(k.app, 'op1');
    admin = await login(k.app, 'admin');
  }, 60_000);
  afterAll(async () => k?.close());

  const scan = async (code: string, wh = WH1, s: Session = op) => {
    const r = await k.app.inject({
      method: 'GET',
      url: `/api/v1/scan/resolve?warehouseId=${wh}&code=${encodeURIComponent(code)}`,
      headers: s.h,
    });
    return {
      status: r.statusCode,
      body: r.statusCode === 200 ? ScanResolution.parse(r.json()) : r.json(),
    };
  };

  it('仓位：前缀载荷 / 裸编码 / 小写 / AIM 前缀与回车', async () => {
    for (const raw of ['WH1.A01-01-A01', 'A01-01-A01', 'wh1.a01-01-a01', ']C1WH1.A01-01-A01\r\n']) {
      const r = await scan(raw);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        kind: 'LOCATION',
        raw,
        location: { code: 'A01-01-A01', payload: 'WH1.A01-01-A01' },
      });
    }
  });

  it('货架、SKU（含包装数）、未知', async () => {
    const rack = (
      await k.pool.query(
        `SELECT code FROM racks WHERE warehouse_id=$1 AND is_active ORDER BY code LIMIT 1`,
        [WH1],
      )
    ).rows[0].code;
    expect((await scan(`WH1.${rack}`)).body).toMatchObject({ kind: 'RACK', rack: { code: rack } });
    const bc = (
      await k.pool.query(
        `SELECT b.barcode, b.pack_qty, s.code FROM sku_barcodes b JOIN skus s ON s.id=b.sku_id ORDER BY b.pack_qty DESC LIMIT 1`,
      )
    ).rows[0];
    const r = await scan(bc.barcode);
    expect(r.body).toMatchObject({ kind: 'SKU', sku: { code: bc.code }, packQty: bc.pack_qty });
    expect((await scan('NO-SUCH-THING-999')).body.kind).toBe('UNKNOWN');
  });

  it('他仓前缀 → WRONG_WAREHOUSE；越权仓库 → 404', async () => {
    const r = await scan('WH2.A01-01-A01');
    expect(r.body).toMatchObject({ kind: 'WRONG_WAREHOUSE', otherWarehouseCode: 'WH2' });
    expect((await scan('A01-01-A01', WH2)).status).toBe(404);
    // 全仓用户在空仓 WH2 扫 WH1 载荷
    expect((await scan('WH1.A01-01-A01', WH2, admin)).body).toMatchObject({
      kind: 'WRONG_WAREHOUSE',
      otherWarehouseCode: 'WH1',
    });
  });
});
