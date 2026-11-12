/** 夜间清理（08 §夜间任务、02 §7）。每批用 SKIP LOCKED，避免与库存引擎的锁顺序冲突。 */
import type { Queryable } from '../modules/inventory/util.ts';

const BATCH = 5000;

async function loop(q: Queryable, sql: string, args: unknown[]): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await q.query(sql, args);
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < BATCH) return total;
  }
}

/** 0 余额行保留 90 天（对账口径：缺失余额行视为 0）。 */
export function purgeZeroBalances(q: Queryable, days = 90): Promise<number> {
  return loop(
    q,
    `DELETE FROM stock_balances WHERE ctid IN (
        SELECT ctid FROM stock_balances
         WHERE on_hand = 0 AND updated_at < now() - make_interval(days => $1)
         LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
       AND on_hand = 0`,
    [days],
  );
}

/** 幂等记录（idempotency_keys）保留 30 天。 */
export function purgeIdempotencyKeys(q: Queryable, days = 30): Promise<number> {
  return loop(
    q,
    `DELETE FROM idempotency_keys WHERE ctid IN (
        SELECT ctid FROM idempotency_keys WHERE created_at < now() - make_interval(days => $1)
         LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)`,
    [days],
  );
}

/** 过期 refresh token（过期或吊销后再保留 graceDays 天，便于重放检测与审计）。 */
export function purgeRefreshTokens(q: Queryable, graceDays = 7): Promise<number> {
  return loop(
    q,
    `DELETE FROM refresh_tokens WHERE ctid IN (
        SELECT ctid FROM refresh_tokens
         WHERE GREATEST(expires_at, COALESCE(revoked_at, expires_at)) < now() - make_interval(days => $1)
         LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)`,
    [graceDays],
  );
}
