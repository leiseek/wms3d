/**
 * advisory lock 命名空间（02 §3.2，B-N16）：一律使用双 int 形式 pg_advisory_[xact_]lock(ns, id)。
 * 禁止 hashtext() 单 key 形式。新增命名空间走契约请求。
 */
export const LOCK_NS = {
  /** 条码命名空间：SKU 条码写入、布局发布（id = 0） */
  BARCODE: 1,
  /** 迁移（id = 0） */
  MIGRATION: 2,
  /** 夜间任务（id = JOB_ID.*） */
  JOB: 3,
  /** 布局发布（id = warehouses.lock_seq） */
  LAYOUT_PUBLISH: 4,
} as const;

export const JOB_ID = {
  RECONCILE_INCREMENTAL: 1,
  RECONCILE_FULL: 2,
  PURGE_REFRESH_TOKENS: 3,
  PURGE_ZERO_BALANCES: 4,
  PURGE_DONE_IDEMPOTENCY: 5,
} as const;

export function xactLockSql(ns: number, id: number): { text: string; values: [number, number] } {
  return { text: 'SELECT pg_advisory_xact_lock($1, $2)', values: [ns, id] };
}
