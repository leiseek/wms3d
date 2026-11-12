import { routes } from '@wms3d/contracts';
import type { z } from 'zod';
import type { Dashboard } from '@wms3d/contracts';
import { ApiError } from '../../lib/problem.ts';
import type { ApiModule } from '../types.ts';
import { lowStock } from '../inventory/queries.ts';
import { iso, isRecord, type Queryable } from '../inventory/util.ts';

const tsOrNull = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;

/** 看板（today 按仓库时区的业务日，D31）。 */
export async function dashboard(q: Queryable, wh: string): Promise<z.output<typeof Dashboard>> {
  const r = await q.query<{
    total: number;
    inactive: number;
    occupied: number;
    skus: number;
    on_hand: number;
    inbound: number;
    outbound: number;
    transfer: number;
    adjust: number;
    devices: number;
    records: number;
    reprints: number;
    now: Date;
  }>(
    `WITH w AS (SELECT id, timezone FROM warehouses WHERE id = $1),
          day AS (SELECT (date_trunc('day', now() AT TIME ZONE w.timezone) AT TIME ZONE w.timezone) AS start FROM w),
          b AS (SELECT location_id, sku_id, on_hand FROM stock_balances WHERE warehouse_id = $1 AND on_hand > 0),
          -- 业务时间（02 §7）：client_created_at，与服务端相差 > 24h 时用 created_at
          t AS (SELECT type, count(*)::int AS n FROM inv_txns, day
                 WHERE warehouse_id = $1
                   AND created_at >= day.start - interval '1 day' AND created_at < day.start + interval '2 days'
                   AND CASE WHEN client_created_at IS NOT NULL
                             AND abs(extract(epoch FROM client_created_at - created_at)) <= 86400
                            THEN client_created_at ELSE created_at END
                       >= day.start
                   AND CASE WHEN client_created_at IS NOT NULL
                             AND abs(extract(epoch FROM client_created_at - created_at)) <= 86400
                            THEN client_created_at ELSE created_at END
                       < day.start + interval '1 day'
                 GROUP BY type)
     SELECT
       (SELECT count(*)::int FROM locations WHERE warehouse_id = $1) AS total,
       (SELECT count(*)::int FROM locations WHERE warehouse_id = $1 AND NOT is_active) AS inactive,
       (SELECT count(DISTINCT location_id)::int FROM b) AS occupied,
       (SELECT count(DISTINCT sku_id)::int FROM b) AS skus,
       (SELECT COALESCE(sum(on_hand), 0)::int FROM b) AS on_hand,
       COALESCE((SELECT n FROM t WHERE type = 'INBOUND'), 0) AS inbound,
       COALESCE((SELECT n FROM t WHERE type = 'OUTBOUND'), 0) AS outbound,
       COALESCE((SELECT n FROM t WHERE type = 'TRANSFER'), 0) AS transfer,
       COALESCE((SELECT sum(n) FROM t WHERE type IN ('ADJUST','COUNT_ADJUST')), 0)::int AS adjust,
       (SELECT count(*)::int FROM devices WHERE pending_outbox > 0 AND pending_warehouse_id = $1) AS devices,
       (SELECT COALESCE(sum(pending_outbox), 0)::int FROM devices WHERE pending_outbox > 0 AND pending_warehouse_id = $1) AS records,
       (SELECT count(*)::int FROM label_reprint_requests WHERE warehouse_id = $1 AND status = 'PENDING') AS reprints,
       now() AS now
     FROM w`,
    [wh],
  );
  const x = r.rows[0];
  if (!x) throw new ApiError('NOT_FOUND');
  const [low, rec, backup] = await Promise.all([
    lowStock(q, wh),
    q.query<{ ran_at: Date; mismatches: number }>(
      `SELECT ran_at, mismatches FROM reconcile_checkpoints ORDER BY id DESC LIMIT 1`,
    ),
    q.query<{ value: unknown }>(`SELECT value FROM ops_status WHERE key = 'backup'`),
  ]);
  const bv = backup.rows[0]?.value;
  const b = isRecord(bv) ? bv : {};
  return {
    warehouseId: wh,
    asOf: iso(x.now),
    locations: { total: x.total, occupied: x.occupied, inactive: x.inactive },
    skusInStock: x.skus,
    totalOnHand: x.on_hand,
    today: { inbound: x.inbound, outbound: x.outbound, transfer: x.transfer, adjust: x.adjust },
    lowStockCount: low.length,
    pendingSync: { devices: x.devices, records: x.records },
    reconcile: {
      lastRunAt: rec.rows[0] ? iso(rec.rows[0].ran_at) : null,
      mismatches: rec.rows[0]?.mismatches ?? null,
    },
    backup: {
      lastLocalAt: tsOrNull(b.lastLocalAt),
      lastRemoteAt: tsOrNull(b.lastRemoteAt),
      remoteConfigured: b.remoteConfigured === true,
    },
    pendingReprints: x.reprints,
  };
}

/**
 * dashboard 模块（tag 'dashboard'，ws-a2）。
 * shim（docs/contract-requests/ws-a2-1.md）：无数据库时不注册。
 */
export const dashboardModule: ApiModule = ({ routes: r, services }) => {
  const db = services.db;
  if (!db) return;
  const pool = db.pool;
  r.register(routes.dashboard, async ({ warehouseId }) => dashboard(pool, warehouseId!));
};
