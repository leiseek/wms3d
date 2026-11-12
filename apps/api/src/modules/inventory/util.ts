/**
 * WS-A2 共享小工具：事务包装（死锁重试）、游标编解码、时间格式、审计写入。
 * 其他 ws-a2 模块（counts/twin/sync/...）从这里引用，避免跨 WS 依赖。
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../../lib/problem.ts';

export type Queryable = Pick<pg.PoolClient, 'query'>;

/** pg 错误码 */
export const PG = {
  UNIQUE: '23505',
  DEADLOCK: '40P01',
  SERIALIZATION: '40001',
  FK: '23503',
} as const;

export function pgCode(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}
export function pgConstraint(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'constraint' in e
    ? String((e as { constraint: unknown }).constraint)
    : undefined;
}

export function requirePool(pool: pg.Pool | undefined | null): pg.Pool {
  if (!pool) throw new ApiError('INTERNAL', '数据库未配置');
  return pool;
}

/**
 * READ COMMITTED 事务；死锁（40P01）兜底重试 1 次（ADR-0003 §7）。
 * `fn` 抛出的任何错误都会回滚；返回值在 COMMIT 成功后才交给调用方。
 */
export async function withTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  retries = 1,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (pgCode(e) === PG.DEADLOCK && attempt < retries) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}

/** Date | string → ISO-8601 UTC（Z）。 */
export function iso(v: Date | string): string;
export function iso(v: Date | string | null | undefined): string | null;
export function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

/** 不透明游标：base64url(JSON)。解析失败 → 400。 */
export function encodeCursor(v: unknown): string {
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
}
export function decodeCursor<T>(c: string | undefined, check: (v: unknown) => v is T): T | null {
  if (!c) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (check(v)) return v;
  } catch {
    /* fallthrough */
  }
  throw new ApiError('VALIDATION_FAILED', 'cursor 无效');
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface AuditEntry {
  userId: string | null;
  warehouseId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  result?: 'SUCCESS' | 'DENIED' | 'FAILED';
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  deviceId?: string | null;
  traceId?: string | null;
}

/** 审计与业务数据同一事务写入（08 §3，D34）。 */
export async function writeAudit(q: Queryable, a: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (user_id, warehouse_id, action, entity, entity_id, result, before, after, ip, device_id, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      a.userId,
      a.warehouseId,
      a.action,
      a.entity,
      a.entityId,
      a.result ?? 'SUCCESS',
      a.before === undefined ? null : JSON.stringify(a.before),
      a.after === undefined ? null : JSON.stringify(a.after),
      a.ip ?? null,
      a.deviceId ?? null,
      a.traceId ?? null,
    ],
  );
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
