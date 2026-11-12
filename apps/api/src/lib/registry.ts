import { toPayload } from '@wms3d/domain';
import { LOCK_NS, xactLockSql } from '../db/locks.ts';
import type { Queryable } from './db.ts';
import { ApiError } from './problem.ts';

/** 串行化条码命名空间（02 §3.2）：SKU 条码写入与布局发布、前缀开关都先取此锁。 */
export async function lockBarcodes(q: Queryable): Promise<void> {
  const l = xactLockSql(LOCK_NS.BARCODE, 0);
  await q.query(l.text, l.values);
}

/**
 * 按当前投影重建某仓库的 LOCATION/RACK 登记（02 §3.2/§9 step 5）：先删后插，停用仓位/货架的载荷被释放。
 * 冲突（与 SKU 条码或其他仓库裸编码载荷相同）→ 409 BARCODE_CONFLICT。调用方须已持有 BARCODE 锁并在事务内。
 */
export async function rebuildWarehouseRegistry(
  q: Queryable,
  warehouseId: string,
  /** 布局中存在的仓位（发布时传入）；不传 = 保持当前登记的仓位集合（如切换前缀开关） */
  presentLocationIds?: string[],
): Promise<void> {
  const w = await q.query<{ code: string; prefix: boolean }>(
    `SELECT code, barcode_prefix_enabled AS prefix FROM warehouses WHERE id = $1`,
    [warehouseId],
  );
  const wh = w.rows[0]!;
  let present = presentLocationIds;
  if (!present) {
    const cur = await q.query<{ id: string }>(
      `SELECT entity_id AS id FROM barcode_registry WHERE warehouse_id = $1 AND kind = 'LOCATION'`,
      [warehouseId],
    );
    present = cur.rows.map((x) => x.id);
  }
  await q.query(
    `DELETE FROM barcode_registry WHERE warehouse_id = $1 AND kind IN ('LOCATION','RACK')`,
    [warehouseId],
  );
  // 运行时停用（PATCH isActive=false）的仓位仍在布局中、标签仍在，保留登记，扫码可提示"已停用"
  const ents = await q.query<{ kind: 'LOCATION' | 'RACK'; id: string; code: string }>(
    `SELECT 'LOCATION' AS kind, id, code FROM locations WHERE warehouse_id = $1 AND id = ANY($2::uuid[])
     UNION ALL
     SELECT 'RACK' AS kind, id, code FROM racks WHERE warehouse_id = $1 AND is_active`,
    [warehouseId, present],
  );
  const values = ents.rows.map((e) => toPayload(wh.code, e.code, wh.prefix));
  const clash = await q.query<{ value: string; kind: string }>(
    `SELECT value, kind FROM barcode_registry WHERE value = ANY($1::text[]) ORDER BY value LIMIT 50`,
    [values],
  );
  // SKU 条码不得等于任何裸仓位码（02 §3.2）
  const bare = await q.query<{ value: string }>(
    `SELECT value FROM barcode_registry WHERE kind = 'SKU' AND value = ANY($1::text[]) LIMIT 50`,
    [ents.rows.map((e) => e.code)],
  );
  if (clash.rows.length || bare.rows.length)
    throw new ApiError('BARCODE_CONFLICT', '仓位/货架条码与已登记条码冲突', {
      context: { values: [...clash.rows, ...bare.rows].map((x) => x.value) },
    });
  await q.query(
    `INSERT INTO barcode_registry (value, kind, warehouse_id, entity_id)
     SELECT v, k, $1, e FROM unnest($2::text[], $3::text[], $4::uuid[]) AS t(v, k, e)`,
    [warehouseId, values, ents.rows.map((e) => e.kind), ents.rows.map((e) => e.id)],
  );
}
