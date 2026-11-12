import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { cloneTestDb, pgAvailable, type TestDb } from '../test/pg.ts';
import { withLongTransaction } from './client.ts';

describe.skipIf(!pgAvailable)('数据库迁移与约束（02 §5/§5.1）', () => {
  let tdb: TestDb;
  let app: pg.Pool;
  let owner: pg.Pool;
  beforeAll(() => {
    tdb = cloneTestDb();
    app = new pg.Pool({ connectionString: tdb.appUrl, max: 3 });
    owner = new pg.Pool({ connectionString: tdb.ownerUrl, max: 2 });
  });
  afterAll(async () => {
    await app?.end();
    await owner?.end();
    tdb?.drop();
  });

  const seedWarehouse = async () => {
    const wh = await app.query<{ id: string }>(
      `INSERT INTO warehouses (code, name, width_m, depth_m, height_m) VALUES ('WT1','t',10,10,5) RETURNING id`,
    );
    const whId = wh.rows[0]!.id;
    const z = await app.query<{ id: string }>(
      `INSERT INTO zones (warehouse_id, layout_version, code, kind, polygon) VALUES ($1,1,'A','STORAGE','[]') RETURNING id`,
      [whId],
    );
    return { whId, zoneId: z.rows[0]!.id };
  };

  it('运行时角色默认 transaction_timeout=30s', async () => {
    const r = await app.query<{ transaction_timeout: string }>('SHOW transaction_timeout');
    expect(r.rows[0]!.transaction_timeout).toBe('30s');
  });

  it('wms_app 不能 UPDATE/DELETE 台账（权限），属主也被触发器拦截（D11）', async () => {
    await expect(app.query(`UPDATE stock_movements SET qty_delta = 0`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query(`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`TRUNCATE inv_txns CASCADE`)).rejects.toThrow(/permission denied/);
    await owner.query(`INSERT INTO audit_logs (action, entity, result) VALUES ('t','t','SUCCESS')`);
    await expect(owner.query(`UPDATE audit_logs SET action='x'`)).rejects.toThrow(/append-only/);
    await expect(owner.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    await expect(owner.query(`TRUNCATE audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('仓位编码唯一约束可延迟：同一事务内互换编码成功（D15）', async () => {
    const { whId, zoneId } = await seedWarehouse();
    const c = await app.connect();
    try {
      const ins = `INSERT INTO locations (warehouse_id, zone_id, code, kind) VALUES ($1,$2,$3,'STORAGE') RETURNING id`;
      const a = (await c.query<{ id: string }>(ins, [whId, zoneId, 'A01-01-A01'])).rows[0]!.id;
      const b = (await c.query<{ id: string }>(ins, [whId, zoneId, 'A01-01-A02'])).rows[0]!.id;
      await c.query('BEGIN');
      await c.query(`UPDATE locations SET code='A01-01-A02' WHERE id=$1`, [a]);
      await c.query(`UPDATE locations SET code='A01-01-A01' WHERE id=$1`, [b]);
      await c.query('COMMIT');
      await expect(c.query(ins, [whId, zoneId, 'A01-01-A01'])).rejects.toThrow(
        /locations_wh_code_uq|duplicate/,
      );
    } finally {
      c.release();
    }
  });

  it('code 列按 "C" 排序', async () => {
    const r = await app.query<{ c: string }>(
      `SELECT collation_name AS c FROM information_schema.columns WHERE table_name='locations' AND column_name='code'`,
    );
    expect(r.rows[0]!.c).toBe('C');
  });

  it('事务内 SET LOCAL 不能延长 transaction_timeout；withLongTransaction 可以（R3，09 用例 17）', async () => {
    const short = new pg.Pool({ connectionString: tdb.appUrl, max: 1 });
    short.on('error', () => undefined);
    try {
      const c = await short.connect();
      c.on('error', () => undefined);
      await c.query(`SET transaction_timeout='1s'`);
      await c.query('BEGIN');
      await c.query(`SET LOCAL transaction_timeout='5s'`);
      await expect(c.query('SELECT pg_sleep(2)')).rejects.toThrow();
      c.release(true);
    } finally {
      await short.end();
    }
    // 会话级 SET 后再 BEGIN：3s 的事务存活，结束后回到角色默认 30s
    const r = await withLongTransaction(app, '5s', async (c) => {
      await c.query('SELECT pg_sleep(3)');
      return (await c.query<{ transaction_timeout: string }>('SHOW transaction_timeout')).rows[0]!
        .transaction_timeout;
    });
    expect(r).toBe('5s');
    const after = await app.query<{ transaction_timeout: string }>('SHOW transaction_timeout');
    expect(after.rows[0]!.transaction_timeout).toBe('30s');
  }, 20_000);
});

describe.skipIf(!pgAvailable)('演示数据 seed（09 §4）', () => {
  it('写入主数据且幂等', async () => {
    const { seedDemo } = await import('./seed-demo.ts');
    const tdb = cloneTestDb();
    try {
      expect(await seedDemo(tdb.appUrl)).toBe('seeded');
      expect(await seedDemo(tdb.appUrl)).toBe('skipped');
      const c = new pg.Client({ connectionString: tdb.appUrl });
      await c.connect();
      const r = await c.query<{ l: number; s: number; u: number; b: number }>(
        `SELECT (SELECT count(*) FROM locations)::int l, (SELECT count(*) FROM skus)::int s, (SELECT count(*) FROM users)::int u, (SELECT count(*) FROM barcode_registry)::int b`,
      );
      await c.end();
      expect(r.rows[0]).toMatchObject({ l: 386, s: 24, u: 5 });
      expect(r.rows[0]!.b).toBeGreaterThan(386 + 16 + 24);
    } finally {
      tdb.drop();
    }
  }, 30_000);
});
