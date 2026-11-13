import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { cloneTestDb, pgAvailable, type TestDb } from '../test/pg.ts';
import { createAdmin } from './create-admin.ts';

describe.skipIf(!pgAvailable)('create-admin CLI（ws-f-1）', () => {
  let tdb: TestDb;
  beforeAll(() => {
    tdb = cloneTestDb();
  });
  afterAll(() => tdb?.drop());

  it('建 ADMIN（all_warehouses、首登改密）+ 审计；重复 → exists；短密码拒绝', async () => {
    const r = await createAdmin(tdb.appUrl, { username: 'root-admin', password: 'Temp#pass-1234' });
    expect(r.status).toBe('created');
    const c = new pg.Client({ connectionString: tdb.appUrl });
    await c.connect();
    try {
      const u = await c.query(
        `SELECT role, all_warehouses, must_change_password FROM users WHERE username = 'root-admin'`,
      );
      expect(u.rows[0]).toEqual({
        role: 'ADMIN',
        all_warehouses: true,
        must_change_password: true,
      });
      const a = await c.query(
        `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'user.create' AND entity_id = $1`,
        [r.status === 'created' ? r.id : ''],
      );
      expect(a.rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
    expect(
      (await createAdmin(tdb.appUrl, { username: 'root-admin', password: 'Temp#pass-1234' }))
        .status,
    ).toBe('exists');
    await expect(
      createAdmin(tdb.appUrl, { username: 'x-admin', password: 'short' }),
    ).rejects.toThrow();
  });
});
