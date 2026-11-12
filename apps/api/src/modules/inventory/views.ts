/** 行 → 契约视图（Txn 等）。所有 JSON 响应再经契约 serializer 校验。 */
import type { Txn } from '@wms3d/contracts';
import { iso, type Queryable } from './util.ts';

interface TxnRow {
  id: string;
  warehouse_id: string;
  type: Txn['type'];
  idempotency_key: string;
  reason: Txn['reason'];
  ref_no: string | null;
  note: string | null;
  reverses_txn_id: string | null;
  reversed_by: string | null;
  performed_by: string;
  submitted_by: string;
  device_id: string | null;
  created_offline: boolean;
  client_created_at: Date | null;
  created_at: Date;
}
interface LineRow {
  txn_id: string;
  location_id: string;
  location_code: string;
  sku_id: string;
  sku_code: string;
  lot_no: string;
  qty_delta: number;
  balance_after: number;
}

export const TXN_COLS = `t.id, t.warehouse_id, t.type, t.idempotency_key, t.reason, t.ref_no, t.note, t.reverses_txn_id,
  (SELECT r.id FROM inv_txns r WHERE r.reverses_txn_id = t.id) AS reversed_by,
  t.performed_by, t.submitted_by, t.device_id, t.created_offline, t.client_created_at, t.created_at`;

/** 按给定 id 顺序返回（缺失的 id 跳过）。 */
export async function loadTxns(q: Queryable, ids: string[]): Promise<Txn[]> {
  if (!ids.length) return [];
  const t = await q.query<TxnRow>(
    `SELECT ${TXN_COLS} FROM inv_txns t WHERE t.id = ANY($1::uuid[])`,
    [ids],
  );
  return attachLines(q, t.rows, ids);
}

export async function attachLines(q: Queryable, rows: TxnRow[], order?: string[]): Promise<Txn[]> {
  if (!rows.length) return [];
  const m = await q.query<LineRow>(
    `SELECT m.txn_id, m.location_id, l.code AS location_code, m.sku_id, s.code AS sku_code, m.lot_no, m.qty_delta, m.balance_after
       FROM stock_movements m JOIN locations l ON l.id = m.location_id JOIN skus s ON s.id = m.sku_id
      WHERE m.txn_id = ANY($1::uuid[]) ORDER BY m.id`,
    [rows.map((r) => r.id)],
  );
  const lines = new Map<string, Txn['lines']>();
  for (const l of m.rows) {
    let arr = lines.get(l.txn_id);
    if (!arr) lines.set(l.txn_id, (arr = []));
    arr.push({
      locationId: l.location_id,
      locationCode: l.location_code,
      skuId: l.sku_id,
      skuCode: l.sku_code,
      lotNo: l.lot_no,
      qtyDelta: l.qty_delta,
      balanceAfter: l.balance_after,
    });
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = order ? order.map((id) => byId.get(id)).filter((r) => !!r) : rows;
  return ordered.map((r) => ({
    id: r.id,
    warehouseId: r.warehouse_id,
    type: r.type,
    idempotencyKey: r.idempotency_key,
    reason: r.reason,
    refNo: r.ref_no,
    note: r.note,
    reversesTxnId: r.reverses_txn_id,
    reversedByTxnId: r.reversed_by,
    performedBy: r.performed_by,
    submittedBy: r.submitted_by,
    deviceId: r.device_id,
    createdOffline: r.created_offline,
    clientCreatedAt: iso(r.client_created_at),
    createdAt: iso(r.created_at),
    lines: lines.get(r.id) ?? [],
  }));
}
export type { TxnRow };
