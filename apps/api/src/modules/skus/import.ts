import type pg from 'pg';
import type { z } from 'zod';
import { SKU_CSV_COLUMNS, type ImportResult } from '@wms3d/contracts';
import { writeAudit, type AuditEntry } from '../../lib/audit.ts';
import { withTx } from '../../lib/db.ts';
import { lockBarcodes } from '../../lib/registry.ts';
import { parseCsv, unescapeCell } from './csv.ts';
import { findBarcodeClashes } from './service.ts';

type Result = z.infer<typeof ImportResult>;
type RowError = Result['errors'][number];

const SKU_CODE = /^[A-Za-z0-9._\-/]+$/;
const BARCODE = /^[\x21-\x7E]+$/;
export const IMPORT_BATCH_ROWS = 1000;
export const IMPORT_MAX_ROWS = 50_000;

interface SkuPlan {
  code: string;
  name: string;
  spec: string | null;
  uom: string;
  safetyStock: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  weightG: number | null;
  barcodes: { barcode: string; packQty: number }[];
  rows: number;
}

/**
 * CSV 导入（05 §3、03 §1.3）：先全量预校验（dryRun 同一代码路径），commit 时每 1000 行一个事务按 code upsert（天然幂等，
 * 失败可从断点重跑）。有任何错误行 → 不提交（返回完整错误报告）。行号 = 文件行号（表头为第 1 行）。
 */
export async function importSkus(
  pool: pg.Pool,
  text: string,
  dryRun: boolean,
  audit: Omit<AuditEntry, 'action' | 'entity'>,
): Promise<Result> {
  const errors: RowError[] = [];
  const err = (row: number, column: string | null, code: RowError['code'], message: string) => {
    if (errors.length < 1000) errors.push({ row, column, code, message });
  };
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = new Map(header.map((h, i) => [h, i]));
  const empty: Result = {
    dryRun,
    totalRows: 0,
    created: 0,
    updated: 0,
    committedBatches: 0,
    errors,
  };
  for (const req of ['code', 'name'] as const)
    if (!col.has(req))
      err(1, req, 'REQUIRED', `缺少列 ${req}（模板列：${SKU_CSV_COLUMNS.join(',')}）`);
  if (errors.length) return empty;
  const data = table.slice(1);
  empty.totalRows = data.length;
  if (data.length > IMPORT_MAX_ROWS) {
    err(1, null, 'FORMAT', `超过 ${IMPORT_MAX_ROWS} 行上限`);
    return empty;
  }
  const get = (r: string[], k: string) => {
    const i = col.get(k);
    return i === undefined ? '' : unescapeCell((r[i] ?? '').trim());
  };
  const int = (
    row: number,
    r: string[],
    k: string,
    min: number,
    def: number | null,
  ): number | null => {
    const v = get(r, k);
    if (v === '') return def;
    if (!/^-?\d+$/.test(v) || Number(v) < min || Number(v) > 1_000_000_000) {
      err(row, k, 'FORMAT', `${k} 必须是 ≥ ${min} 的整数`);
      return def;
    }
    return Number(v);
  };

  const skus = new Map<string, SkuPlan>();
  const barcodeRow = new Map<string, { row: number; code: string }>();
  const order: string[] = [];
  data.forEach((r, i) => {
    const row = i + 2;
    const code = get(r, 'code');
    const name = get(r, 'name');
    if (!code) return err(row, 'code', 'REQUIRED', 'code 必填');
    if (code.length > 64 || !SKU_CODE.test(code))
      return err(row, 'code', 'FORMAT', 'code 只允许字母数字及 . _ - /，最长 64');
    let s = skus.get(code);
    if (!s) {
      if (!name) return err(row, 'name', 'REQUIRED', 'name 必填');
      if (name.length > 128) return err(row, 'name', 'FORMAT', 'name 最长 128');
      const spec = get(r, 'spec');
      const uom = get(r, 'uom') || 'EA';
      if (spec.length > 128) err(row, 'spec', 'FORMAT', 'spec 最长 128');
      if (uom.length > 8) err(row, 'uom', 'FORMAT', 'uom 最长 8');
      s = {
        code,
        name,
        spec: spec || null,
        uom,
        safetyStock: int(row, r, 'safety_stock', 0, 0)!,
        lengthMm: int(row, r, 'length_mm', 1, null),
        widthMm: int(row, r, 'width_mm', 1, null),
        heightMm: int(row, r, 'height_mm', 1, null),
        weightG: int(row, r, 'weight_g', 1, null),
        barcodes: [],
        rows: 0,
      };
      skus.set(code, s);
      order.push(code);
    }
    s.rows++;
    const bc = get(r, 'barcode');
    if (bc) {
      if (bc.length > 64 || !BARCODE.test(bc))
        return err(row, 'barcode', 'FORMAT', '条码须为可打印 ASCII，最长 64');
      const prev = barcodeRow.get(bc);
      if (prev) return err(row, 'barcode', 'DUPLICATE', `条码 ${bc} 与第 ${prev.row} 行重复`);
      barcodeRow.set(bc, { row, code });
      const packQty = int(row, r, 'pack_qty', 1, 1)!;
      s.barcodes.push({ barcode: bc, packQty });
    }
  });

  // 登记表冲突（不持锁预检；commit 时在 BARCODE 锁内复检）
  const allBc = [...barcodeRow.keys()];
  const clashes = await findBarcodeClashes(pool, allBc, (b) => barcodeRow.get(b)?.code ?? null);
  for (const c of clashes) {
    const at = barcodeRow.get(c.barcode)!;
    err(
      at.row,
      'barcode',
      'BARCODE_CONFLICT',
      c.kind === 'SKU'
        ? `条码 ${c.barcode} 已属于 SKU ${c.skuCode}`
        : c.kind === 'BARE_CODE'
          ? `条码 ${c.barcode} 与仓位/货架编码相同`
          : `条码 ${c.barcode} 已被${c.kind === 'RACK' ? '货架' : '仓位'}占用`,
    );
  }
  errors.sort((a, b) => a.row - b.row);

  const exist = await pool.query<{ code: string }>(
    `SELECT code FROM skus WHERE code = ANY($1::text[])`,
    [order],
  );
  const existing = new Set(exist.rows.map((x) => x.code));
  const result: Result = {
    dryRun,
    totalRows: data.length,
    created: order.filter((c) => !existing.has(c)).length,
    updated: order.filter((c) => existing.has(c)).length,
    committedBatches: 0,
    errors,
  };
  if (dryRun || errors.length)
    return { ...result, ...(errors.length && !dryRun ? { created: 0, updated: 0 } : {}) };

  // 分批（按行数切，同一 SKU 不跨批）
  const batches: SkuPlan[][] = [];
  let cur: SkuPlan[] = [];
  let rows = 0;
  for (const code of order) {
    const s = skus.get(code)!;
    if (cur.length && rows + s.rows > IMPORT_BATCH_ROWS) {
      batches.push(cur);
      cur = [];
      rows = 0;
    }
    cur.push(s);
    rows += s.rows;
  }
  if (cur.length) batches.push(cur);

  let created = 0;
  let updated = 0;
  for (const b of batches) {
    const r = await withTx(pool, async (c) => {
      await lockBarcodes(c);
      const bcs = b.flatMap((s) => s.barcodes.map((x) => x.barcode));
      const late = await findBarcodeClashes(c, bcs, (x) => barcodeRow.get(x)?.code ?? null);
      if (late.length) return { late };
      const up = await c.query<{ id: string; code: string; inserted: boolean }>(
        `INSERT INTO skus (code, name, spec, uom, safety_stock, length_mm, width_mm, height_mm, weight_g)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[])
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, spec = EXCLUDED.spec, uom = EXCLUDED.uom,
           safety_stock = EXCLUDED.safety_stock, length_mm = EXCLUDED.length_mm, width_mm = EXCLUDED.width_mm,
           height_mm = EXCLUDED.height_mm, weight_g = EXCLUDED.weight_g
         RETURNING id, code, (xmax = 0) AS inserted`,
        [
          b.map((s) => s.code),
          b.map((s) => s.name),
          b.map((s) => s.spec),
          b.map((s) => s.uom),
          b.map((s) => s.safetyStock),
          b.map((s) => s.lengthMm),
          b.map((s) => s.widthMm),
          b.map((s) => s.heightMm),
          b.map((s) => s.weightG),
        ],
      );
      const idOf = new Map(up.rows.map((x) => [x.code, x.id]));
      const pairs = b.flatMap((s) => s.barcodes.map((x) => ({ skuId: idOf.get(s.code)!, ...x })));
      if (pairs.length) {
        await c.query(
          `INSERT INTO sku_barcodes (sku_id, barcode, pack_qty)
           SELECT * FROM unnest($1::uuid[], $2::text[], $3::int[])
           ON CONFLICT (barcode) DO UPDATE SET pack_qty = EXCLUDED.pack_qty
             WHERE sku_barcodes.sku_id = EXCLUDED.sku_id AND sku_barcodes.pack_qty <> EXCLUDED.pack_qty`,
          [pairs.map((p) => p.skuId), pairs.map((p) => p.barcode), pairs.map((p) => p.packQty)],
        );
        await c.query(
          `INSERT INTO barcode_registry (value, kind, warehouse_id, entity_id)
           SELECT v, 'SKU', NULL, e FROM unnest($1::text[], $2::uuid[]) AS t(v, e)
           ON CONFLICT (value) DO NOTHING`,
          [pairs.map((p) => p.barcode), pairs.map((p) => p.skuId)],
        );
        await c.query(
          `WITH pick AS (
             SELECT DISTINCT ON (sku_id) id, sku_id FROM sku_barcodes WHERE sku_id = ANY($1::uuid[])
              ORDER BY sku_id, is_primary DESC, updated_at, barcode)
           UPDATE sku_barcodes s SET is_primary = true FROM pick WHERE s.id = pick.id AND NOT s.is_primary`,
          [[...new Set(pairs.map((p) => p.skuId))]],
        );
      }
      const ins = up.rows.filter((x) => x.inserted).length;
      await writeAudit(c, {
        ...audit,
        action: 'sku.import',
        entity: 'sku',
        after: {
          skus: up.rows.length,
          created: ins,
          barcodes: pairs.length,
          firstCode: b[0]!.code,
        },
      });
      return { created: ins, updated: up.rows.length - ins };
    });
    if ('late' in r && r.late) {
      for (const c of r.late)
        err(
          barcodeRow.get(c.barcode)?.row ?? 0,
          'barcode',
          'BARCODE_CONFLICT',
          `条码 ${c.barcode} 已被占用（并发写入）`,
        );
      break;
    }
    created += r.created;
    updated += r.updated;
    result.committedBatches++;
  }
  return { ...result, created, updated };
}
