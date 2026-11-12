import type { Sku } from '@wms3d/contracts';
import { iso, type Queryable } from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import type { AuthContext } from '../../lib/auth.ts';

/** skuWrite 策略（D25）：ADMIN，或 all_warehouses=true 的 MANAGER。 */
export function assertSkuWrite(auth: AuthContext): void {
  if (auth.role === 'ADMIN') return;
  if (auth.role === 'MANAGER' && auth.warehouseIds === 'all') return;
  throw new ApiError('FORBIDDEN', 'SKU 主数据为组织级：仅 ADMIN 或全仓 MANAGER 可修改');
}

export interface SkuRow {
  id: string;
  code: string;
  name: string;
  spec: string | null;
  uom: string;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  weight_g: number | null;
  safety_stock: number;
  is_active: boolean;
  image_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function skusView(q: Queryable, rows: SkuRow[]): Promise<Sku[]> {
  const ids = rows.map((r) => r.id);
  const bc = ids.length
    ? await q.query<{
        id: string;
        sku_id: string;
        barcode: string;
        pack_qty: number;
        is_primary: boolean;
      }>(
        `SELECT id, sku_id, barcode, pack_qty, is_primary FROM sku_barcodes WHERE sku_id = ANY($1::uuid[])
          ORDER BY is_primary DESC, barcode`,
        [ids],
      )
    : { rows: [] };
  const by = new Map<string, Sku['barcodes']>(ids.map((id) => [id, []]));
  for (const b of bc.rows)
    by.get(b.sku_id)!.push({
      id: b.id,
      barcode: b.barcode,
      packQty: b.pack_qty,
      isPrimary: b.is_primary,
    });
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    spec: r.spec,
    uom: r.uom,
    lengthMm: r.length_mm,
    widthMm: r.width_mm,
    heightMm: r.height_mm,
    weightG: r.weight_g,
    safetyStock: r.safety_stock,
    isActive: r.is_active,
    imageUrl: r.image_url,
    barcodes: by.get(r.id) ?? [],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }));
}

export async function loadSku(q: Queryable, id: string): Promise<Sku | null> {
  const r = await q.query<SkuRow>(`SELECT * FROM skus WHERE id = $1`, [id]);
  return r.rows[0] ? (await skusView(q, r.rows))[0]! : null;
}

export interface BarcodeClash {
  barcode: string;
  kind: 'SKU' | 'LOCATION' | 'RACK' | 'BARE_CODE';
  skuCode?: string | null;
}

/**
 * 条码登记表冲突（02 §3.2）：已被其他实体登记，或等于任何仓库的裸仓位码/货架码。
 * ownerSkuCode：同一 SKU 已有的条码不算冲突（导入 upsert）。调用方须已持有 BARCODE 锁（写入时）。
 */
export async function findBarcodeClashes(
  q: Queryable,
  barcodes: string[],
  ownerSkuCode?: (barcode: string) => string | null,
): Promise<BarcodeClash[]> {
  if (!barcodes.length) return [];
  const reg = await q.query<{
    value: string;
    kind: 'SKU' | 'LOCATION' | 'RACK';
    sku_code: string | null;
  }>(
    `SELECT g.value, g.kind, s.code AS sku_code FROM barcode_registry g
       LEFT JOIN skus s ON g.kind = 'SKU' AND s.id = g.entity_id
      WHERE g.value = ANY($1::text[])`,
    [barcodes],
  );
  const out: BarcodeClash[] = [];
  for (const r of reg.rows) {
    if (
      r.kind === 'SKU' &&
      ownerSkuCode &&
      r.sku_code !== null &&
      ownerSkuCode(r.value) === r.sku_code
    )
      continue;
    out.push({ barcode: r.value, kind: r.kind, skuCode: r.sku_code });
  }
  const bare = await q.query<{ code: string }>(
    `SELECT code FROM locations WHERE code = ANY($1::text[]) UNION SELECT code FROM racks WHERE code = ANY($1::text[])`,
    [barcodes],
  );
  for (const b of bare.rows) out.push({ barcode: b.code, kind: 'BARE_CODE' });
  return out;
}

export function clashError(clashes: BarcodeClash[]): ApiError {
  const c = clashes[0]!;
  const what =
    c.kind === 'SKU'
      ? `SKU ${c.skuCode ?? ''}`
      : c.kind === 'BARE_CODE'
        ? '仓位/货架编码'
        : c.kind === 'RACK'
          ? '货架'
          : '仓位';
  return new ApiError('BARCODE_CONFLICT', `条码 ${c.barcode} 已被${what}占用`, {
    context: { conflicts: clashes },
  });
}

/** 保证每个 SKU 至多一个主条码；无主条码时取第一条。 */
export async function normalizePrimary(
  q: Queryable,
  skuIds: string[],
  preferBarcodeId?: string,
): Promise<void> {
  if (!skuIds.length) return;
  if (preferBarcodeId)
    await q.query(`UPDATE sku_barcodes SET is_primary = (id = $2) WHERE sku_id = ANY($1::uuid[])`, [
      skuIds,
      preferBarcodeId,
    ]);
  await q.query(
    `WITH pick AS (
       SELECT DISTINCT ON (sku_id) id, sku_id FROM sku_barcodes WHERE sku_id = ANY($1::uuid[])
        ORDER BY sku_id, is_primary DESC, updated_at, barcode)
     UPDATE sku_barcodes b SET is_primary = (b.id = pick.id)
       FROM pick WHERE b.sku_id = pick.sku_id AND b.is_primary <> (b.id = pick.id)`,
    [skuIds],
  );
}
