/**
 * #17（09 §2，B-N7 / R3）真实时长版：默认跳过（约 61s）；WMS_SLOW_TESTS=1 时运行。
 * 等比短超时版本已在 apps/api/src/db/db.test.ts（Lead）中常规运行。
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withLongTransaction } from '../db/client.ts';
import { cloneTestDb, type TestDb } from '../test/pg.ts';

describe.skipIf(process.env.WMS_SLOW_TESTS !== '1')('#17 事务超时（真实时长）', () => {
  let tdb: TestDb;
  let pool: pg.Pool;
  beforeAll(() => {
    tdb = cloneTestDb();
    pool = new pg.Pool({ connectionString: tdb.appUrl, max: 4 });
    pool.on('error', () => undefined); // 被 transaction_timeout 终止的连接
  });
  afterAll(async () => {
    await pool.end();
    tdb.drop();
  });

  const sleepTx = async (fn: (c: pg.PoolClient) => Promise<void>) => {
    const c = await pool.connect();
    c.on('error', () => undefined);
    try {
      await fn(c);
    } finally {
      c.release(true);
    }
  };

  it('pg_sleep(31) 被角色级 30s 终止；事务内 SET LOCAL 不能延长；withLongTransaction 120s 下 60s 不被终止', async () => {
    const killed = sleepTx(async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT pg_sleep(31)');
    });
    const setLocal = sleepTx(async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL transaction_timeout = '120s'`);
      await c.query('SELECT pg_sleep(31)');
    });
    const long = withLongTransaction(pool, '120s', async (c) => {
      await c.query('SELECT pg_sleep(60)');
      return 'ok';
    });
    const [a, b, c] = await Promise.allSettled([killed, setLocal, long]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(c).toEqual({ status: 'fulfilled', value: 'ok' });
  }, 90_000);
});
