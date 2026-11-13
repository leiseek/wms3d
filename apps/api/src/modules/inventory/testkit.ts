/**
 * WS-A2 集成测试工具（仅测试使用，不被业务代码引用）：克隆真库 + 演示数据 + 注入测试 verifier 的 app。
 * A1 合并真实 verifier 之前，用 buildApp({ configure }) 注入（见 ws-a2 简报“备注”）。
 */
import { randomUUID } from 'node:crypto';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { demo } from '@wms3d/domain';
import { buildApp, type WmsApp } from '../../app.ts';
import { createDb, type DbHandle } from '../../db/client.ts';
import { seedDemo } from '../../db/seed-demo.ts';
import type { AuthContext } from '../../lib/auth.ts';
import { cloneTestDb, type TestDb } from '../../test/pg.ts';

export const WH1 = demo.demoWarehouse.id;
export const WH2 = demo.demoWarehouse2.id;
export const USERS = Object.fromEntries(demo.demoUsers.map((u) => [u.username, u.id])) as Record<
  'admin' | 'manager' | 'op1' | 'op2' | 'viewer',
  string
>;
export const SKUS = demo.demoSkus;
/** WH1 货架仓位（默认容量 200）与地面仓位（无容量） */
export const LOCS = demo.demoLocations;
export const loc = (code: string): string => {
  const l = LOCS.find((x) => x.code === code);
  if (!l) throw new Error(`no demo location ${code}`);
  return l.id;
};
export const RCV = loc('RCV-01');
let freshIdx = 0;
/** 依次分配一个尚未被本测试文件用过的货架仓位（容量 200） */
export const fresh = (): string => {
  const stocked = new Set(demo.demoBalances.map((b) => b.locationId));
  const racked = LOCS.filter((l) => l.rackKey && !stocked.has(l.id));
  if (!racked.length) throw new Error('no empty demo rack location');
  const l = racked[freshIdx++ % racked.length]!;
  return l.id;
};
export const SHP = loc('SHP-01');

export interface Kit {
  tdb: TestDb;
  app: WmsApp;
  db: DbHandle;
  /** wms_owner 连接（只在测试里用于构造场景，例如改设备会话时间） */
  owner: pg.Pool;
  auth: Map<string, AuthContext>;
  /** WH2 的仓位 id（跨仓用例） */
  wh2Locs: string[];
  sessions: Record<string, string>;
  req(token: string, opts: InjectOptions): Promise<LightMyRequestResponse>;
  txn(token: string, body: Record<string, unknown>, key?: string): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export const DEVICE = 'dev-test-0001';
export const DEVICE2 = 'dev-test-0002';

export async function createKit(opts: { poolMax?: number; build?: boolean } = {}): Promise<Kit> {
  const tdb = cloneTestDb();
  await seedDemo(tdb.appUrl);
  const owner = new pg.Pool({ connectionString: tdb.ownerUrl, max: 3 });
  // WH2：一个库区 + 4 个仓位（跨仓用例）
  const z = await owner.query<{ id: string }>(
    `INSERT INTO zones (warehouse_id, layout_version, code, kind, polygon) VALUES ($1,1,'A','STORAGE','[]') RETURNING id`,
    [WH2],
  );
  const wh2Locs: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const r = await owner.query<{ id: string }>(
      `INSERT INTO locations (warehouse_id, zone_id, code, kind, pick_seq) VALUES ($1,$2,$3,'STORAGE',$4) RETURNING id`,
      [WH2, z.rows[0]!.id, `A01-01-A0${i}`, i * 10],
    );
    wh2Locs.push(r.rows[0]!.id);
  }
  await owner.query(`INSERT INTO devices (id, name) VALUES ($1,'t1'),($2,'t2')`, [DEVICE, DEVICE2]);
  const sessions: Record<string, string> = {};
  for (const [name, id] of Object.entries(USERS)) {
    const r = await owner.query<{ id: string }>(
      `INSERT INTO device_sessions (device_id, user_id, started_at) VALUES ($1,$2, now() - interval '1 hour') RETURNING id`,
      [DEVICE, id],
    );
    sessions[name] = r.rows[0]!.id;
  }
  const ctx = (
    name: keyof typeof USERS,
    role: AuthContext['role'],
    warehouseIds: AuthContext['warehouseIds'],
  ): AuthContext => ({
    userId: USERS[name],
    role,
    warehouseIds,
    deviceId: DEVICE,
    sessionId: sessions[name]!,
    mustChangePassword: false,
  });
  const auth = new Map<string, AuthContext>([
    ['admin', ctx('admin', 'ADMIN', 'all')],
    ['manager', ctx('manager', 'MANAGER', [WH1])],
    ['op1', ctx('op1', 'OPERATOR', [WH1])],
    ['op2', ctx('op2', 'OPERATOR', [WH1])],
    ['viewer', ctx('viewer', 'VIEWER', [WH1])],
  ]);
  const db = createDb(tdb.appUrl, opts.poolMax ?? 10);
  const app = buildApp({
    databaseUrl: tdb.appUrl,
    env: {},
    configure: (s) => {
      s.db = db;
      s.verifyToken = async (t) => auth.get(t) ?? null;
    },
  });
  await app.ready();
  const req = (token: string, o: InjectOptions) =>
    app.inject({
      ...o,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(o.headers ?? {}) },
    });
  return {
    tdb,
    app,
    db,
    owner,
    auth,
    wh2Locs,
    sessions,
    req,
    txn: (token, body, key = randomUUID()) =>
      req(token, {
        method: 'POST',
        url: '/api/v1/inventory/transactions',
        headers: { 'idempotency-key': key },
        payload: body,
      }),
    close: async () => {
      await app.close();
      await db.close().catch(() => undefined);
      await owner.end();
      tdb.drop();
    },
  };
}

/** 交易命令构造器（performedBy 缺省为令牌用户） */
export function cmd(
  type: 'INBOUND' | 'OUTBOUND' | 'TRANSFER' | 'ADJUST',
  lines: unknown[],
  extra: Record<string, unknown> = {},
  user: keyof typeof USERS = 'op1',
): Record<string, unknown> {
  return {
    type,
    warehouseId: WH1,
    performedBy: USERS[user],
    clientCreatedAt: new Date().toISOString(),
    lines,
    ...(type === 'ADJUST' ? { reason: 'FOUND' } : {}),
    ...extra,
  };
}

export async function onHand(q: pg.Pool, locationId: string, skuId: string): Promise<number> {
  const r = await q.query<{ on_hand: number }>(
    `SELECT on_hand FROM stock_balances WHERE location_id = $1 AND sku_id = $2 AND lot_no = ''`,
    [locationId, skuId],
  );
  return r.rows[0]?.on_hand ?? 0;
}
