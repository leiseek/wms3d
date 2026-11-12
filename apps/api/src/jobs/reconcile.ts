/**
 * 对账（02 §6.5，D12/D50）：
 *   on_hand = SUM(qty_delta)（FULL OUTER JOIN + COALESCE 0，缺失余额行视为 0）；
 *   存在余额行且有流水的键：最新 movement 的 balance_after = on_hand。
 * 增量：校验 checkpoint 之后的流水涉及的键 + 上次运行后 updated_at 变化的余额行；全量：全部键。
 * 新 checkpoint 只推进到“必然已提交”的流水（created_at 早于 now() − 5 分钟；事务上限 120s，B-N7），
 * 避免 bigserial 乱序提交导致漏检。单语句读取 → 同一快照，进行中的事务对余额与流水同时不可见。
 */
import type { Queryable } from '../modules/inventory/util.ts';

export interface ReconcileMismatch {
  warehouseId: string;
  locationId: string;
  skuId: string;
  lotNo: string;
  onHand: number | null;
  ledgerSum: number;
  lastBalanceAfter: number | null;
}

export interface ReconcileReport {
  full: boolean;
  checkedKeys: number;
  mismatches: ReconcileMismatch[];
  maxMovementId: number;
}

const COMMIT_MARGIN = `interval '5 minutes'`;

export async function reconcile(
  q: Queryable,
  opts: { full: boolean; record?: boolean },
): Promise<ReconcileReport> {
  const prev = await q.query<{ max_movement_id: string; ran_at: Date }>(
    `SELECT max_movement_id, ran_at FROM reconcile_checkpoints ORDER BY id DESC LIMIT 1`,
  );
  const fromId = opts.full ? 0 : Number(prev.rows[0]?.max_movement_id ?? 0);
  const since = opts.full ? null : (prev.rows[0]?.ran_at ?? null);

  const keysSql = opts.full
    ? `SELECT location_id, sku_id, lot_no FROM stock_movements
       UNION SELECT location_id, sku_id, lot_no FROM stock_balances`
    : `SELECT location_id, sku_id, lot_no FROM stock_movements WHERE id > $1
       UNION SELECT location_id, sku_id, lot_no FROM stock_balances
        WHERE $2::timestamptz IS NULL OR updated_at > $2::timestamptz - ${COMMIT_MARGIN}`;
  const r = await q.query<{
    n: number;
    wh: string | null;
    location_id: string | null;
    sku_id: string | null;
    lot_no: string | null;
    on_hand: number | null;
    s: string | null;
    last: number | null;
    ckpt: string | null;
  }>(
    `WITH k AS (${keysSql}),
          m AS (SELECT sm.location_id, sm.sku_id, sm.lot_no, MIN(sm.warehouse_id::text)::uuid AS wh,
                       SUM(sm.qty_delta)::bigint AS s,
                       (array_agg(sm.balance_after ORDER BY sm.id DESC))[1] AS last
                  FROM stock_movements sm JOIN k USING (location_id, sku_id, lot_no)
                 GROUP BY 1, 2, 3),
          b AS (SELECT sb.location_id, sb.sku_id, sb.lot_no, sb.warehouse_id AS wh, sb.on_hand
                  FROM stock_balances sb JOIN k USING (location_id, sku_id, lot_no)),
          j AS (SELECT COALESCE(b.wh, m.wh) AS wh, location_id, sku_id, lot_no, b.on_hand, COALESCE(m.s, 0) AS s, m.last
                  FROM m FULL OUTER JOIN b USING (location_id, sku_id, lot_no)),
          bad AS (SELECT * FROM j
                   WHERE COALESCE(on_hand, 0) <> s OR (on_hand IS NOT NULL AND last IS NOT NULL AND last <> on_hand))
     SELECT (SELECT count(*)::int FROM j) AS n,
            (SELECT COALESCE(max(id), $1)::text FROM stock_movements WHERE created_at < now() - ${COMMIT_MARGIN}) AS ckpt,
            bad.wh, bad.location_id, bad.sku_id, bad.lot_no, bad.on_hand, bad.s::text AS s, bad.last
       FROM (SELECT 1) one LEFT JOIN bad ON true`,
    opts.full ? [fromId] : [fromId, since],
  );
  const first = r.rows[0]!;
  const mismatches = r.rows
    .filter((x) => x.location_id !== null)
    .map((x) => ({
      warehouseId: x.wh!,
      locationId: x.location_id!,
      skuId: x.sku_id!,
      lotNo: x.lot_no!,
      onHand: x.on_hand,
      ledgerSum: Number(x.s),
      lastBalanceAfter: x.last,
    }));
  const maxMovementId = Math.max(fromId, Number(first.ckpt ?? fromId));
  if (opts.record !== false)
    await q.query(
      `INSERT INTO reconcile_checkpoints (max_movement_id, mismatches, full_run) VALUES ($1, $2, $3)`,
      [maxMovementId, mismatches.length, opts.full],
    );
  return { full: opts.full, checkedKeys: first.n, mismatches, maxMovementId };
}
