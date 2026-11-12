import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LabelTemplate, ReprintRequest } from '@wms3d/contracts';
import { pgAvailable } from '../../test/pg.ts';
import { login, setupKit, WH1, type Kit, type Session } from '../../lib/testkit.ts';
import { checkCapacity, renderLabelsPdf } from './labels-shim.ts';

describe('labels shim', () => {
  it('容量估算与 A4 分页', async () => {
    expect(checkCapacity('loc-60x40', 'WH1.A01-01-A01', 203).ok).toBe(true);
    expect(checkCapacity('loc-60x40', 'X'.repeat(30), 203)).toMatchObject({ ok: false, max: 230 });
    expect(checkCapacity('rack-100x150', 'X'.repeat(80), 203).ok).toBe(true);
    const items = Array.from({ length: 30 }, (_, i) => ({
      kind: 'LOCATION' as const,
      code: `A-${i}`,
      payload: `WH1.A-${i}`,
    }));
    const pdf = Buffer.from(
      await renderLabelsPdf({ template: 'a4-3x8', dpi: 203, startCell: 20, items }),
    ).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toMatch(/\/Count 3 /); // 起始格 20：5 + 24 + 1
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });
});

describe.skipIf(!pgAvailable)('labels / 补打队列（07）', () => {
  let k: Kit;
  let mgr: Session;
  let op: Session;
  let locId: string;
  beforeAll(async () => {
    k = await setupKit();
    mgr = await login(k.app, 'manager');
    op = await login(k.app, 'op1');
    locId = (
      await k.pool.query(`SELECT id FROM locations WHERE warehouse_id=$1 AND code='A01-01-A01'`, [
        WH1,
      ])
    ).rows[0].id;
  }, 60_000);
  afterAll(async () => k?.close());

  const api = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    s: Session = mgr,
  ) =>
    k.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: s.h,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  it('模板列表', async () => {
    const r = await api('GET', '/labels/templates', undefined, op);
    const items = r.json().items.map((t: unknown) => LabelTemplate.parse(t));
    expect(items.map((t: { key: string }) => t.key)).toHaveLength(7);
  });

  it('渲染：ids / filter；模板类型不符 400；ZPL 501；超容量 400；审计', async () => {
    const r = await api('POST', '/labels/render', {
      template: 'loc-100x50',
      kind: 'LOCATION',
      warehouseId: WH1,
      ids: [locId],
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.headers['x-label-count']).toBe('1');
    const f = await api('POST', '/labels/render', {
      template: 'a4-3x8',
      kind: 'LOCATION',
      warehouseId: WH1,
      filter: {
        rack: (
          await k.pool.query(
            `SELECT r.code FROM racks r JOIN locations l ON l.rack_id=r.id WHERE l.id=$1`,
            [locId],
          )
        ).rows[0].code,
      },
    });
    expect(f.headers['x-label-count']).toBe('24');
    expect(
      (
        await api('POST', '/labels/render', {
          template: 'sku-60x40',
          kind: 'LOCATION',
          warehouseId: WH1,
          ids: [locId],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api('POST', '/labels/render', {
          template: 'loc-100x50',
          kind: 'LOCATION',
          warehouseId: WH1,
          ids: [locId],
          format: 'ZPL',
        })
      ).statusCode,
    ).toBe(501);
    const long = await api('POST', '/skus', {
      code: 'LONG-1',
      name: '超长',
      barcodes: [{ barcode: 'L'.repeat(40), isPrimary: true }],
    });
    const cap = await api('POST', '/labels/render', {
      template: 'sku-60x40',
      kind: 'SKU',
      warehouseId: WH1,
      ids: [long.json().id],
    });
    expect(cap.statusCode).toBe(400);
    expect(cap.json().context.items[0].code).toBe('LONG-1');
    const au = await k.pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action='labels.render'`,
    );
    expect(au.rows[0].n).toBe(2);
  });

  it('校准页：dpi 仅 203/300', async () => {
    expect(
      (await api('GET', '/labels/calibration.pdf?template=loc-70x30&dpi=300')).statusCode,
    ).toBe(200);
    expect(
      (await api('GET', '/labels/calibration.pdf?template=loc-70x30&dpi=600')).statusCode,
    ).toBe(400);
  });

  it('补打队列：创建（去重）→ 列表 → 打印标记 DONE；PENDING 之外不可改', async () => {
    const c = await api(
      'POST',
      '/label-reprint-requests',
      { warehouseId: WH1, kind: 'LOCATION', entityId: locId, reason: 'DAMAGED' },
      op,
    );
    expect(c.statusCode).toBe(201);
    const rp = ReprintRequest.parse(c.json());
    expect(rp).toMatchObject({ code: 'A01-01-A01', status: 'PENDING' });
    const dup = await api(
      'POST',
      '/label-reprint-requests',
      { warehouseId: WH1, kind: 'LOCATION', entityId: locId, reason: 'MISSING' },
      op,
    );
    expect(dup.json().id).toBe(rp.id);
    const bad = await api(
      'POST',
      '/label-reprint-requests',
      {
        warehouseId: WH1,
        kind: 'LOCATION',
        entityId: '00000000-0000-4000-8000-00000000beef',
        reason: 'DAMAGED',
      },
      op,
    );
    expect(bad.statusCode).toBe(404);
    const other = (
      await k.pool.query(`SELECT id FROM locations WHERE warehouse_id=$1 AND code='A01-01-A02'`, [
        WH1,
      ])
    ).rows[0].id;
    expect(
      (
        await api(
          'POST',
          '/label-reprint-requests',
          { warehouseId: WH1, kind: 'LOCATION', entityId: other, reason: 'OTHER' },
          op,
        )
      ).statusCode,
    ).toBe(201);
    const list = await api(
      'GET',
      `/label-reprint-requests?warehouseId=${WH1}&status=PENDING&limit=1`,
      undefined,
      op,
    );
    expect(list.json().items).toHaveLength(1);
    expect(list.json().nextCursor).toBeTruthy();
    const page2 = await api(
      'GET',
      `/label-reprint-requests?warehouseId=${WH1}&status=PENDING&limit=1&cursor=${list.json().nextCursor}`,
      undefined,
      op,
    );
    expect(page2.json().items[0]?.id).not.toBe(list.json().items[0].id);
    const r = await api('POST', '/labels/render', {
      template: 'loc-100x50',
      kind: 'LOCATION',
      warehouseId: WH1,
      ids: [locId],
      reprintRequestIds: [rp.id],
    });
    expect(r.headers['x-reprints-done']).toBe('1');
    const again = await api('PATCH', `/label-reprint-requests/${rp.id}`, { status: 'CANCELLED' });
    expect(again.statusCode).toBe(409);
    const same = await api('PATCH', `/label-reprint-requests/${rp.id}`, { status: 'DONE' });
    expect(same.statusCode).toBe(200);
    expect(same.json().doneAt).toBeTruthy();
  });
});
