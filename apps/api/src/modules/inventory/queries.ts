/** 库存查询（03 §5）：交易、余额、台账（id desc keyset）、CSV 导出（分批）、定位、低库存。 */
import { Readable } from 'node:stream';
import type pg from 'pg';
import type { z } from 'zod';
import type {
  Balance,
  BalancesQuery,
  LocateResult,
  LowStockItem,
  Movement,
  MovementsQuery,
  Txn,
  TxnsQuery,
} from '@wms3d/contracts';
import { attachLines, TXN_COLS, type TxnRow } from './views.ts';
import { decodeCursor, encodeCursor, iso, isRecord, type Queryable } from './util.ts';

type Q<T extends z.ZodType> = z.output<T>;
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const isTsIdCursor = (v: unknown): v is { t: string; i: string } =>
  isRecord(v) && typeof v.t === 'string' && typeof v.i === 'string';
const isNumCursor = (v: unknown): v is { i: number } => isRecord(v) && Number.isSafeInteger(v.i);

class Where {
  readonly parts: string[] = [];
  readonly vals: unknown[] = [];
  add(sqlFrag: (p: string) => string, v: unknown): this {
    this.vals.push(v);
    this.parts.push(sqlFrag(`$${this.vals.length}`));
    return this;
  }
  raw(frag: string): this {
    this.parts.push(frag);
    return this;
  }
  p(v: unknown): string {
    this.vals.push(v);
    return `$${this.vals.length}`;
  }
  get sql(): string {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }
}

/** 交易列表：created_at desc, id desc（uuid 无序，用时间 + id 作 keyset）。时间游标保留微秒。 */
export async function listTransactions(
  q: Queryable,
  wh: string,
  query: Q<typeof TxnsQuery>,
): Promise<Page<Txn>> {
  const w = new Where().add((p) => `t.warehouse_id = ${p}`, wh);
  if (query.type) w.add((p) => `t.type = ${p}`, query.type);
  if (query.performedBy) w.add((p) => `t.performed_by = ${p}`, query.performedBy);
  if (query.refNo) w.add((p) => `t.ref_no = ${p}`, query.refNo);
  if (query.from) w.add((p) => `t.created_at >= ${p}`, query.from);
  if (query.to) w.add((p) => `t.created_at < ${p}`, query.to);
  const c = decodeCursor(query.cursor, isTsIdCursor);
  if (c) w.raw(`(t.created_at, t.id) < (${w.p(c.t)}::timestamptz, ${w.p(c.i)}::uuid)`);
  const r = await q.query<TxnRow & { cts: string }>(
    `SELECT ${TXN_COLS}, to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cts
       FROM inv_txns t ${w.sql} ORDER BY t.created_at DESC, t.id DESC LIMIT ${query.limit + 1}`,
    w.vals,
  );
  const more = r.rows.length > query.limit;
  const rows = r.rows.slice(0, query.limit);
  const last = rows[rows.length - 1];
  return {
    items: await attachLines(q, rows),
    nextCursor: more && last ? encodeCursor({ t: last.cts, i: last.id }) : null,
  };
}

/** 余额（on_hand > 0），按 (仓位编码, SKU 编码, lot) keyset。 */
export async function listBalances(
  q: Queryable,
  wh: string,
  query: Q<typeof BalancesQuery>,
): Promise<Page<Q<typeof Balance>>> {
  const w = new Where().add((p) => `b.warehouse_id = ${p}`, wh).raw('b.on_hand > 0');
  if (query.skuId) w.add((p) => `b.sku_id = ${p}`, query.skuId);
  if (query.locationId) w.add((p) => `b.location_id = ${p}`, query.locationId);
  if (query.zone) w.add((p) => `z.code = ${p}`, query.zone.toUpperCase());
  const isBalCursor = (v: unknown): v is { l: string; s: string; o: string } =>
    isRecord(v) && typeof v.l === 'string' && typeof v.s === 'string' && typeof v.o === 'string';
  const c = decodeCursor(query.cursor, isBalCursor);
  if (c) w.raw(`(l.code, s.code, b.lot_no) > (${w.p(c.l)}, ${w.p(c.s)}, ${w.p(c.o)})`);
  const r = await q.query<{
    location_id: string;
    location_code: string;
    sku_id: string;
    sku_code: string;
    sku_name: string;
    lot_no: string;
    on_hand: number;
    updated_at: Date;
  }>(
    `SELECT b.location_id, l.code AS location_code, b.sku_id, s.code AS sku_code, s.name AS sku_name, b.lot_no, b.on_hand, b.updated_at
       FROM stock_balances b JOIN locations l ON l.id = b.location_id JOIN skus s ON s.id = b.sku_id
       JOIN zones z ON z.id = l.zone_id
       ${w.sql} ORDER BY l.code, s.code, b.lot_no LIMIT ${query.limit + 1}`,
    w.vals,
  );
  const more = r.rows.length > query.limit;
  const rows = r.rows.slice(0, query.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((b) => ({
      warehouseId: wh,
      locationId: b.location_id,
      locationCode: b.location_code,
      skuId: b.sku_id,
      skuCode: b.sku_code,
      skuName: b.sku_name,
      lotNo: b.lot_no,
      onHand: b.on_hand,
      updatedAt: iso(b.updated_at),
    })),
    nextCursor:
      more && last
        ? encodeCursor({ l: last.location_code, s: last.sku_code, o: last.lot_no })
        : null,
  };
}

interface MovementRow {
  id: string;
  txn_id: string;
  txn_type: Q<typeof Movement>['txnType'];
  location_id: string;
  location_code: string;
  sku_id: string;
  sku_code: string;
  lot_no: string;
  qty_delta: number;
  balance_after: number;
  performed_by: string;
  created_at: Date;
}

function movementsSql(
  wh: string,
  query: Omit<Q<typeof MovementsQuery>, 'limit' | 'cursor'>,
  beforeId: number | null,
  limit: number,
) {
  const w = new Where().add((p) => `m.warehouse_id = ${p}`, wh);
  if (query.skuId) w.add((p) => `m.sku_id = ${p}`, query.skuId);
  if (query.locationId) w.add((p) => `m.location_id = ${p}`, query.locationId);
  if (query.from) w.add((p) => `m.created_at >= ${p}`, query.from);
  if (query.to) w.add((p) => `m.created_at < ${p}`, query.to);
  if (beforeId !== null) w.add((p) => `m.id < ${p}`, beforeId);
  return {
    text: `SELECT m.id, m.txn_id, t.type AS txn_type, m.location_id, l.code AS location_code, m.sku_id, s.code AS sku_code,
                  m.lot_no, m.qty_delta, m.balance_after, t.performed_by, m.created_at
             FROM stock_movements m JOIN inv_txns t ON t.id = m.txn_id
             JOIN locations l ON l.id = m.location_id JOIN skus s ON s.id = m.sku_id
             ${w.sql} ORDER BY m.id DESC LIMIT ${limit}`,
    values: w.vals,
  };
}

const movementView = (wh: string, m: MovementRow): Q<typeof Movement> => ({
  id: Number(m.id),
  txnId: m.txn_id,
  txnType: m.txn_type,
  warehouseId: wh,
  locationId: m.location_id,
  locationCode: m.location_code,
  skuId: m.sku_id,
  skuCode: m.sku_code,
  lotNo: m.lot_no,
  qtyDelta: m.qty_delta,
  balanceAfter: m.balance_after,
  performedBy: m.performed_by,
  createdAt: iso(m.created_at),
});

/** 台账：id desc keyset（D33）。 */
export async function listMovements(
  q: Queryable,
  wh: string,
  query: Q<typeof MovementsQuery>,
): Promise<Page<Q<typeof Movement>>> {
  const c = decodeCursor(query.cursor, isNumCursor);
  const r = await q.query<MovementRow>(movementsSql(wh, query, c?.i ?? null, query.limit + 1));
  const more = r.rows.length > query.limit;
  const rows = r.rows.slice(0, query.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((m) => movementView(wh, m)),
    nextCursor: more && last ? encodeCursor({ i: Number(last.id) }) : null,
  };
}

/** CSV 单元格：防公式注入（08 §2）——以 = + - @ \t \r 开头的文本前置 '。数字原样。 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s.trimStart())) s = `'${s.trimStart()}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = [
  'id',
  'created_at',
  'txn_id',
  'txn_type',
  'location',
  'sku',
  'lot_no',
  'qty_delta',
  'balance_after',
  'performed_by',
];

/** 台账 CSV：每批 `batch` 行 keyset 读取，流式输出（UTF-8 BOM + CRLF，Excel 友好）。 */
export function movementsCsvStream(
  pool: pg.Pool,
  wh: string,
  query: Omit<Q<typeof MovementsQuery>, 'limit' | 'cursor'>,
  batch = 2000,
): Readable {
  async function* gen() {
    yield '\uFEFF' + CSV_HEADER.join(',') + '\r\n';
    let before: number | null = null;
    for (;;) {
      const r: pg.QueryResult<MovementRow> = await pool.query<MovementRow>(
        movementsSql(wh, query, before, batch),
      );
      if (!r.rows.length) return;
      yield (
        r.rows
          .map((m) =>
            [
              Number(m.id),
              iso(m.created_at),
              m.txn_id,
              m.txn_type,
              m.location_code,
              m.sku_code,
              m.lot_no,
              m.qty_delta,
              m.balance_after,
              m.performed_by,
            ]
              .map(csvCell)
              .join(','),
          )
          .join('\r\n') + '\r\n'
      );
      if (r.rows.length < batch) return;
      before = Number(r.rows[r.rows.length - 1]!.id);
    }
  }
  return Readable.from(gen());
}

const BAL_CSV_HEADER = ['location', 'sku', 'name', 'lot_no', 'on_hand', 'updated_at'];

/** 余额 CSV：按 (location_code, sku_code, lot_no) 排序流式输出。 */
export function balancesCsvStream(
  pool: pg.Pool,
  wh: string,
  query: Omit<Q<typeof BalancesQuery>, 'limit' | 'cursor'>,
  batch = 2000,
): Readable {
  async function* gen() {
    yield '\uFEFF' + BAL_CSV_HEADER.join(',') + '\r\n';
    let after: { l: string; s: string; o: string } | null = null;
    for (;;) {
      const page = await listBalances(pool, wh, {
        ...query,
        warehouseId: wh,
        limit: batch,
        cursor: after ? encodeCursor(after) : undefined,
      });
      if (!page.items.length) return;
      yield (
        page.items
          .map((b) =>
            [b.locationCode, b.skuCode, b.skuName, b.lotNo, b.onHand, b.updatedAt]
              .map(csvCell)
              .join(','),
          )
          .join('\r\n') + '\r\n'
      );
      if (!page.nextCursor) return;
      const last = page.items[page.items.length - 1]!;
      after = { l: last.locationCode, s: last.skuCode, o: last.lotNo };
    }
  }
  return Readable.from(gen());
}

/** SKU 定位：编码/条码精确、名称包含；只返回 locationId（客户端用 TwinModel 映射，D16）。 */
export async function locate(
  q: Queryable,
  wh: string,
  text: string,
): Promise<z.output<typeof LocateResult>> {
  const t = text.trim();
  const like = `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const skus = await q.query<{ id: string; code: string; name: string }>(
    `SELECT s.id, s.code, s.name FROM skus s
      WHERE upper(s.code) = upper($1) OR s.name ILIKE $2
         OR EXISTS (SELECT 1 FROM sku_barcodes b WHERE b.sku_id = s.id AND b.barcode = $1)
      ORDER BY (upper(s.code) = upper($1)) DESC, s.code LIMIT 50`,
    [t, like],
  );
  const ids = skus.rows.map((s) => s.id);
  const lv = await q.query<{ v: number | null }>(
    `SELECT published_layout_version AS v FROM warehouses WHERE id = $1`,
    [wh],
  );
  const items = ids.length
    ? (
        await q.query<{ location_id: string; code: string; sku_id: string; on_hand: number }>(
          `SELECT b.location_id, l.code, b.sku_id, b.on_hand FROM stock_balances b JOIN locations l ON l.id = b.location_id
            WHERE b.warehouse_id = $1 AND b.sku_id = ANY($2::uuid[]) AND b.on_hand > 0
            ORDER BY l.pick_seq, l.code LIMIT 1000`,
          [wh, ids],
        )
      ).rows
    : [];
  return {
    layoutVersion: lv.rows[0]?.v ?? 0,
    skus: skus.rows,
    items: items.map((i) => ({
      locationId: i.location_id,
      code: i.code,
      skuId: i.sku_id,
      qty: i.on_hand,
    })),
  };
}

/** 低库存：启用 SKU 的本仓在库合计 < safety_stock（含 0 库存）。 */
export async function lowStock(q: Queryable, wh: string): Promise<Q<typeof LowStockItem>[]> {
  const r = await q.query<{
    id: string;
    code: string;
    name: string;
    on_hand: number;
    safety_stock: number;
  }>(
    `SELECT s.id, s.code, s.name, COALESCE(v.on_hand_total, 0)::int AS on_hand, s.safety_stock
       FROM skus s LEFT JOIN v_sku_stock v ON v.sku_id = s.id AND v.warehouse_id = $1
      WHERE s.is_active AND s.safety_stock > 0 AND COALESCE(v.on_hand_total, 0) < s.safety_stock
      ORDER BY (COALESCE(v.on_hand_total, 0)::float / s.safety_stock), s.code`,
    [wh],
  );
  return r.rows.map((x) => ({
    skuId: x.id,
    skuCode: x.code,
    skuName: x.name,
    onHand: x.on_hand,
    safetyStock: x.safety_stock,
  }));
}
