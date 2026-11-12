import type pg from 'pg';
import type { DbHandle } from '../db/client.ts';
import { ApiError } from './problem.ts';
import type { AppServices } from './services.ts';

/** 取连接池；未配置数据库（例如无库单测）时返回 503 语义的 INTERNAL。 */
export function poolOf(services: AppServices): pg.Pool {
  const db: DbHandle | null = services.db;
  if (!db) throw new ApiError('INTERNAL', '未配置数据库（DATABASE_URL）');
  return db.pool;
}

export type Queryable = pg.Pool | pg.PoolClient;

/** 普通事务（READ COMMITTED，受 wms_app 角色 30s transaction_timeout 约束）。 */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  } finally {
    client.release();
  }
}

/** timestamptz / Date → ISO-8601 UTC（契约 Timestamp）。 */
export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}
export function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}
export function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}
export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

export function pgCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}
export function pgConstraint(e: unknown): string | undefined {
  return (e as { constraint?: string } | null)?.constraint;
}
export const isUniqueViolation = (e: unknown) => pgCode(e) === '23505';

/** keyset 游标（不透明 base64url JSON）。 */
export function encodeCursor(v: unknown): string {
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
}
export function decodeCursor<T>(c: string | undefined): T | null {
  if (!c) return null;
  try {
    return JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as T;
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'cursor 无效');
  }
}
