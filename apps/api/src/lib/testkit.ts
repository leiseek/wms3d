/** WS-A1 集成测试工具：克隆测试库 + 演示数据 + 真实 buildApp（真实 verifier/deviceGuard/resolver）。仅测试使用。 */
import pg from 'pg';
import { demo } from '@wms3d/domain';
import { buildApp, type WmsApp } from '../app.ts';
import { seedDemo } from '../db/seed-demo.ts';
import { cloneTestDb, type TestDb } from '../test/pg.ts';

export const PW = demo.DEMO_PASSWORD;
export const WH1 = demo.demoWarehouse.id;
export const WH2 = demo.demoWarehouse2.id;
export const TEST_ENV: NodeJS.ProcessEnv = {
  JWT_SECRET: 'test-secret-test-secret-test-secret-0001',
  JWT_KID: 'k1',
  NODE_ENV: 'test',
};

export interface Kit {
  tdb: TestDb;
  app: WmsApp;
  pool: pg.Pool;
  owner: pg.Pool;
  close(): Promise<void>;
}

export async function setupKit(env: NodeJS.ProcessEnv = {}): Promise<Kit> {
  const tdb = cloneTestDb();
  await seedDemo(tdb.appUrl);
  const app = buildApp({ databaseUrl: tdb.appUrl, env: { ...TEST_ENV, ...env } });
  await app.ready();
  const pool = new pg.Pool({ connectionString: tdb.appUrl, max: 4 });
  const owner = new pg.Pool({ connectionString: tdb.ownerUrl, max: 2 });
  return {
    tdb,
    app,
    pool,
    owner,
    close: async () => {
      await app.close();
      await pool.end();
      await owner.end();
      tdb.drop();
    },
  };
}

let seq = 0;
export const devId = (p = 'dev') =>
  `${p}-${process.pid}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

export interface Session {
  token: string;
  refreshToken: string;
  deviceId: string;
  userId: string;
  sessionId: string;
  h: Record<string, string>;
}

export async function login(
  app: WmsApp,
  username: string,
  opts: { password?: string; deviceId?: string; ip?: string } = {},
): Promise<Session> {
  const deviceId = opts.deviceId ?? devId(username);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password: opts.password ?? PW, deviceId, client: 'mobile' },
    ...(opts.ip ? { remoteAddress: opts.ip } : {}),
  });
  if (res.statusCode !== 200) throw new Error(`login ${username} → ${res.statusCode} ${res.body}`);
  const b = res.json();
  return {
    token: b.accessToken,
    refreshToken: b.refreshToken,
    deviceId,
    userId: b.user.id,
    sessionId: b.session.id,
    h: { authorization: `Bearer ${b.accessToken}` },
  };
}

/** 复制 admin 的口令哈希创建受限用户（避免再算 argon2）。 */
export async function createUserLike(
  pool: pg.Pool,
  username: string,
  role: string,
  warehouseIds: string[],
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (username, display_name, role, all_warehouses, password_hash, must_change_password)
     SELECT $1::text, $1::text, $2::text, false, password_hash, false FROM users WHERE username = 'admin' RETURNING id`,
    [username, role],
  );
  const id = r.rows[0]!.id;
  for (const w of warehouseIds)
    await pool.query(`INSERT INTO user_warehouses (user_id, warehouse_id) VALUES ($1,$2)`, [id, w]);
  return id;
}
