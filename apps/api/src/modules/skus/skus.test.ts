import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportResult, Sku } from '@wms3d/contracts';
import { pgAvailable } from '../../test/pg.ts';
import { createUserLike, login, setupKit, WH1, type Kit, type Session } from '../../lib/testkit.ts';
import { csvCell, parseCsv, unescapeCell } from './csv.ts';

describe('CSV 工具（防公式注入）', () => {
  it('=+-@ 与控制字符前缀单引号；含逗号/引号/换行加引号；往返', () => {
    expect(csvCell('=cmd|/C calc')).toBe(`'=cmd|/C calc`);
    expect(csvCell('+1')).toBe(`'+1`);
    expect(csvCell('-2')).toBe(`'-2`);
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('a,"b"\nc')).toBe(`"a,""b""\nc"`);
    expect(csvCell('普通')).toBe('普通');
    const t = parseCsv(`\uFEFFcode,name\r\nA,"x, ""y"""\r\nB,'=1`);
    expect(t).toEqual([
      ['code', 'name'],
      ['A', 'x, "y"'],
      ['B', `'=1`],
    ]);
    expect(unescapeCell(`'=1`)).toBe('=1');
  });
});

describe.skipIf(!pgAvailable)('skus（05 §3，D25）', () => {
  let k: Kit;
  let admin: Session;
  let mgr1: Session;
  beforeAll(async () => {
    k = await setupKit();
    admin = await login(k.app, 'admin');
    await createUserLike(k.pool, 'mgr1', 'MANAGER', [WH1]);
    mgr1 = await login(k.app, 'mgr1');
  }, 60_000);
  afterAll(async () => k?.close());

  const api = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  const upload = (csv: string, dryRun: boolean) => {
    const B = 'xxBOUNDARYxx';
    return k.app.inject({
      method: 'POST',
      url: `/api/v1/skus/import?dryRun=${dryRun}`,
      headers: { ...admin.h, 'content-type': `multipart/form-data; boundary=${B}` },
      payload: `--${B}\r\nContent-Disposition: form-data; name="file"; filename="s.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${B}--\r\n`,
    });
  };

  it('CRUD + 条码跨实体唯一（与仓位裸编码/载荷冲突 → 409 BARCODE_CONFLICT）', async () => {
    const c = await api('POST', '/skus', {
      code: 'T-1',
      name: '测试',
      barcodes: [{ barcode: '6900000000011', packQty: 1, isPrimary: true }],
    });
    expect(c.statusCode).toBe(201);
    const sku = Sku.parse(c.json());
    expect(sku.barcodes[0]).toMatchObject({ barcode: '6900000000011', isPrimary: true });
    expect((await api('POST', '/skus', { code: 'T-1', name: 'dup' })).statusCode).toBe(409);
    const clash1 = await api('POST', '/skus', {
      code: 'T-2',
      name: 'x',
      barcodes: [{ barcode: '6900000000011' }],
    });
    expect(clash1.json().code).toBe('BARCODE_CONFLICT');
    const clash2 = await api('POST', `/skus/${sku.id}/barcodes`, { barcode: 'WH1.A01-01-A01' });
    expect(clash2.json().code).toBe('BARCODE_CONFLICT');
    const clash3 = await api('POST', `/skus/${sku.id}/barcodes`, { barcode: 'A01-01-A01' });
    expect(clash3.json().code).toBe('BARCODE_CONFLICT');
    const add = await api('POST', `/skus/${sku.id}/barcodes`, { barcode: 'BOX-T1', packQty: 12 });
    expect(add.statusCode).toBe(201);
    const p = await api('PATCH', `/skus/${sku.id}`, { name: '改名', safetyStock: 5 });
    expect(Sku.parse(p.json())).toMatchObject({ name: '改名', safetyStock: 5 });
    const bid = Sku.parse(p.json()).barcodes.find((b) => b.barcode === 'BOX-T1')!.id;
    expect((await api('DELETE', `/skus/${sku.id}/barcodes/${bid}`)).statusCode).toBe(200);
    expect(
      (await k.pool.query(`SELECT 1 FROM barcode_registry WHERE value='BOX-T1'`)).rowCount,
    ).toBe(0);
    const q = await api('GET', '/skus?q=6900000000011');
    expect(q.json().items.map((s: { code: string }) => s.code)).toEqual(['T-1']);
    const au = await k.pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE entity='sku' AND entity_id=$1`,
      [sku.id],
    );
    expect(au.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('skuWrite 策略：仓库受限 MANAGER → 403', async () => {
    const r = await api('POST', '/skus', { code: 'T-9', name: 'x' }, mgr1);
    expect(r.statusCode).toBe(403);
    expect((await api('GET', '/skus', undefined, mgr1)).statusCode).toBe(200);
  });

  it('CSV 错误行报告准确；有错误不提交', async () => {
    const csv = [
      'code,name,barcode,pack_qty,safety_stock',
      'E-1,好的,6900000001001,1,0', // 2
      ',缺编码,,,', // 3
      'E-2,,,,', // 4 缺 name
      'E-3,坏数,6900000001003,0,x', // 5 pack_qty 与 safety_stock
      'E-4,重复条码,6900000001001,1,0', // 6
      'E-5,冲突,WH1.A01-01-A01,1,0', // 7
      'E 6,非法编码,,,', // 8
    ].join('\r\n');
    const r = ImportResult.parse((await upload(csv, false)).json());
    expect(r.totalRows).toBe(7);
    expect(r.created).toBe(0);
    expect(r.committedBatches).toBe(0);
    const by = r.errors.map((e) => `${e.row}:${e.column}:${e.code}`).sort();
    expect(by).toEqual(
      [
        '3:code:REQUIRED',
        '4:name:REQUIRED',
        '5:safety_stock:FORMAT',
        '5:pack_qty:FORMAT',
        '6:barcode:DUPLICATE',
        '7:barcode:BARCODE_CONFLICT',
        '8:code:FORMAT',
      ].sort(),
    );
    expect((await k.pool.query(`SELECT 1 FROM skus WHERE code='E-1'`)).rowCount).toBe(0);
  });

  it('缺列或空单元格不覆盖已有字段（CR1 #5）', async () => {
    const code = `KEEP-${Date.now()}`;
    const created = (
      await api('POST', '/skus', {
        code,
        name: 'Keep me',
        spec: '原规格',
        uom: 'CS',
        safetyStock: 50,
        lengthMm: 100,
        widthMm: 80,
        heightMm: 60,
        weightG: 250,
      })
    ).json();
    expect((await upload(`code,name\n${code},只改名\n`, false)).statusCode).toBe(200);
    const after = (
      await k.pool.query(
        `SELECT name, spec, uom, safety_stock, length_mm, width_mm, height_mm, weight_g FROM skus WHERE id=$1`,
        [created.id],
      )
    ).rows[0];
    expect(after).toMatchObject({
      name: '只改名',
      spec: '原规格',
      uom: 'CS',
      safety_stock: 50,
      length_mm: 100,
      width_mm: 80,
      height_mm: 60,
      weight_g: 250,
    });
  });

  it('10k 行导入 < 10s（每 1000 行一个事务），可重跑（幂等 upsert）；导出转义 =cmd', async () => {
    const lines = ['code,name,spec,uom,barcode,pack_qty,safety_stock'];
    for (let i = 0; i < 10_000; i++)
      lines.push(
        `BULK-${String(i).padStart(5, '0')},批量 ${i},规格,EA,BC${String(i).padStart(10, '0')},1,${i % 7}`,
      );
    lines.push(`EVIL-1,=cmd|' /C calc'!A0,+spec,EA,,,`);
    const csv = lines.join('\n');
    const dry = ImportResult.parse((await upload(csv, true)).json());
    expect(dry).toMatchObject({ dryRun: true, totalRows: 10_001, errors: [], committedBatches: 0 });
    const t0 = Date.now();
    const r = ImportResult.parse((await upload(csv, false)).json());
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ dryRun: false, created: 10_001, updated: 0, errors: [] });
    expect(r.committedBatches).toBe(11);
    expect(ms).toBeLessThan(10_000);
    const n = await k.pool.query(
      `SELECT count(*)::int AS n FROM barcode_registry WHERE kind='SKU' AND value LIKE 'BC%'`,
    );
    expect(n.rows[0].n).toBe(10_000);
    const again = ImportResult.parse((await upload(csv, false)).json());
    expect(again).toMatchObject({ created: 0, updated: 10_001, errors: [] });

    const ex = await k.app.inject({
      method: 'GET',
      url: '/api/v1/skus/export.csv',
      headers: admin.h,
    });
    expect(ex.statusCode).toBe(200);
    expect(ex.headers['content-type']).toMatch(/text\/csv/);
    expect(ex.body.startsWith('\uFEFFcode,')).toBe(true);
    const evil = ex.body.split('\r\n').find((l) => l.startsWith('EVIL-1,'))!;
    expect(evil).toContain(`'=cmd`);
    expect(evil).toContain(`'+spec`);
    expect(evil).not.toMatch(/,=cmd/);
    // 导出再导入原值不变（单引号前缀被还原）
    expect((await k.pool.query(`SELECT name FROM skus WHERE code='EVIL-1'`)).rows[0].name).toBe(
      `=cmd|' /C calc'!A0`,
    );
  }, 60_000);
});
