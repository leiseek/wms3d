import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;
export interface DbHandle {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

/** 运行时连接池（wms_app）。timestamptz 以 ISO 字符串返回（schema mode: 'string'）。 */
export function createDb(url: string, max = 10): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max });
  const db = drizzle(pool, { schema });
  return { pool, db, close: () => pool.end() };
}

/**
 * 长事务（布局发布 120s，B-N7）。实测 PG 17.11：transaction_timeout 在事务开始时计时，
 * 事务内 SET LOCAL 无法延长（R3 nit 3）。因此在 BEGIN 之前做会话级 SET，结束后 RESET 回角色默认值（30s）。
 */
export async function withLongTransaction<T>(
  pool: pg.Pool,
  timeout: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!/^\d+(ms|s|min)$/.test(timeout)) throw new Error(`非法 timeout：${timeout}`);
  const client = await pool.connect();
  try {
    await client.query(`SET transaction_timeout = '${timeout}'`);
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
    await client.query('RESET transaction_timeout').catch(() => undefined);
    client.release();
  }
}
