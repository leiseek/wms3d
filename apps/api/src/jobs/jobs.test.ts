import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo } from '@wms3d/domain';
import {
  createKit,
  cmd,
  fresh,
  SKUS,
  USERS,
  DEVICE,
  type Kit,
} from '../modules/inventory/testkit.ts';
import { seedStock } from '../modules/inventory/seed-stock.ts';
import { JOB_ID, LOCK_NS } from '../db/locks.ts';
import {
  JOBS,
  purgeIdempotencyKeys,
  purgeRefreshTokens,
  purgeZeroBalances,
  reconcile,
  runExclusive,
} from './index.ts';

const S = (i: number) => SKUS[i]!.id;

describe('夜间任务 + 演示库存（PG 集成）', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await createKit();
  });
  afterAll(async () => k?.close());
  const pool = () => k.db.pool;

  it('seed-stock：经 postTransaction 写入 demoBalances，幂等重放，对账 0 不一致', async () => {
    const a = await seedStock(k.tdb.appUrl);
    expect(a.created).toBe(demo.demoBalances.length);
    expect(a.reconcile.mismatches).toEqual([]);
    const b = await seedStock(k.tdb.appUrl);
    expect(b).toMatchObject({ created: 0, replayed: demo.demoBalances.length });
    const sum = await pool().query<{ n: number }>(
      `SELECT COALESCE(sum(on_hand),0)::int AS n FROM stock_balances`,
    );
    expect(sum.rows[0]!.n).toBe(demo.demoBalances.reduce((n, x) => n + x.onHand, 0));
  });

  it('对账能发现人为制造的不一致（增量：改余额；全量：删余额行）；checkpoint 只推进到必然已提交的流水', async () => {
    const L = fresh();
    expect(
      (await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(5), qty: 8 }]))).statusCode,
    ).toBe(201);
    const clean = await reconcile(pool(), { full: false });
    expect(clean.mismatches).toEqual([]);
    expect(clean.maxMovementId).toBe(0); // 全部流水都在 5 分钟内 → 不推进
    await k.owner.query(
      `UPDATE stock_balances SET on_hand = on_hand + 1, updated_at = now() WHERE location_id = $1 AND sku_id = $2`,
      [L, S(5)],
    );
    const inc = await reconcile(pool(), { full: false });
    expect(inc.mismatches).toEqual([
      expect.objectContaining({
        locationId: L,
        skuId: S(5),
        onHand: 9,
        ledgerSum: 8,
        lastBalanceAfter: 8,
      }),
    ]);
    await k.owner.query(
      `UPDATE stock_balances SET on_hand = 8 WHERE location_id = $1 AND sku_id = $2`,
      [L, S(5)],
    );
    const L2 = fresh();
    expect(
      (await k.txn('op1', cmd('INBOUND', [{ locationId: L2, skuId: S(6), qty: 4 }]))).statusCode,
    ).toBe(201);
    await k.owner.query(`DELETE FROM stock_balances WHERE location_id = $1`, [L2]);
    const full = await reconcile(pool(), { full: true });
    expect(full.mismatches).toEqual([
      expect.objectContaining({ locationId: L2, skuId: S(6), onHand: null, ledgerSum: 4 }),
    ]);
    const ck = await pool().query<{ mismatches: number; full_run: boolean }>(
      `SELECT mismatches, full_run FROM reconcile_checkpoints ORDER BY id DESC LIMIT 1`,
    );
    expect(ck.rows[0]).toEqual({ mismatches: 1, full_run: true });
    // 修复：同值补回余额行
    await k.owner.query(
      `INSERT INTO stock_balances (warehouse_id, location_id, sku_id, lot_no, on_hand) SELECT warehouse_id, $1, $2, '', 4 FROM locations WHERE id = $1`,
      [L2, S(6)],
    );
    expect((await reconcile(pool(), { full: true })).mismatches).toEqual([]);
  });

  it('清理：0 余额行 > 90 天、幂等记录 > 30 天、过期 refresh token；之后对账仍一致', async () => {
    const L = fresh();
    expect(
      (await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(7), qty: 5 }]))).statusCode,
    ).toBe(201);
    expect(
      (await k.txn('op1', cmd('OUTBOUND', [{ locationId: L, skuId: S(7), qty: 5 }]))).statusCode,
    ).toBe(201);
    const L2 = fresh();
    expect(
      (await k.txn('op1', cmd('INBOUND', [{ locationId: L2, skuId: S(7), qty: 5 }]))).statusCode,
    ).toBe(201);
    expect(
      (await k.txn('op1', cmd('OUTBOUND', [{ locationId: L2, skuId: S(7), qty: 5 }]))).statusCode,
    ).toBe(201);
    await k.owner.query(
      `UPDATE stock_balances SET updated_at = now() - interval '91 days' WHERE location_id = $1 AND sku_id = $2`,
      [L, S(7)],
    );
    expect(await purgeZeroBalances(pool())).toBe(1);
    const left = await pool().query(
      `SELECT location_id FROM stock_balances WHERE location_id = ANY($1::uuid[]) AND sku_id = $2`,
      [[L, L2], S(7)],
    );
    expect(left.rows).toEqual([{ location_id: L2 }]);

    await k.owner.query(
      `INSERT INTO idempotency_keys (scope, key, user_id, request_hash, response, created_at)
       VALUES ('t', 'old', $1, repeat('a',64), '{}', now() - interval '31 days'), ('t', 'new', $1, repeat('a',64), '{}', now())`,
      [USERS.op1],
    );
    expect(await purgeIdempotencyKeys(pool())).toBe(1);
    await k.owner.query(
      `INSERT INTO refresh_tokens (user_id, device_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, gen_random_uuid(), repeat('b',64), now() - interval '30 days'),
              ($1, $2, gen_random_uuid(), repeat('c',64), now() + interval '30 days')`,
      [USERS.op1, DEVICE],
    );
    expect(await purgeRefreshTokens(pool())).toBe(1);
    expect((await reconcile(pool(), { full: true })).mismatches).toEqual([]);
  });

  it('pg_try_advisory_lock(LOCK_NS.JOB, n)：他处持锁时跳过；任务表编号齐全', async () => {
    const holder = await k.owner.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock($1, $2)`, [LOCK_NS.JOB, JOB_ID.RECONCILE_FULL]);
      const r = await runExclusive(pool(), JOB_ID.RECONCILE_FULL, async () => 'ran');
      expect(r).toEqual({ skipped: true });
      await holder.query(`SELECT pg_advisory_unlock($1, $2)`, [LOCK_NS.JOB, JOB_ID.RECONCILE_FULL]);
      expect(await runExclusive(pool(), JOB_ID.RECONCILE_FULL, async () => 'ran')).toEqual({
        skipped: false,
        result: 'ran',
      });
    } finally {
      holder.release();
    }
    expect(new Set(JOBS.map((j) => j.id))).toEqual(new Set(Object.values(JOB_ID)));
  });
});
