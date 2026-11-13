/**
 * 库存引擎集成测试（真 PG17，cloneTestDb）：09 §2 必过 #1–#4、#6、#9、#10、#15、#16，
 * 以及幂等 / 锁顺序 / 只追加台账 / 跨仓授权 / 策略。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Problem, TxnResult } from '@wms3d/contracts';
import { pgAvailable } from '../../test/pg.ts';
import {
  cmd,
  createKit,
  DEVICE2,
  fresh,
  onHand,
  RCV,
  SHP,
  SKUS,
  USERS,
  WH1,
  WH2,
  type Kit,
} from './testkit.ts';
import { applyTxn } from './engine.ts';
import { withTx } from './util.ts';

const S = (i: number) => SKUS[i]!.id;
const code = (r: { json(): unknown }) => (r.json() as { code?: string }).code;

async function deadlocks(k: Kit): Promise<number> {
  await new Promise((r) => setTimeout(r, 1200)); // 累计统计约 1s 刷新
  const r = await k.owner.query<{ d: string }>(
    `SELECT deadlocks::text AS d FROM pg_stat_database WHERE datname = current_database()`,
  );
  return Number(r.rows[0]!.d);
}

describe.skipIf(!pgAvailable)('库存引擎 postTransaction（02 §6）', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await createKit({ poolMax: 55 });
  }, 60_000);
  afterAll(async () => k?.close());
  const pool = () => k.db.pool;

  it('入库：载荷形式仓位码 + 箱码 ×12，201，balancesAfter 与台账一致', async () => {
    const before = await onHand(pool(), RCV, S(0));
    const r = await k.txn(
      'op1',
      cmd('INBOUND', [
        { locationCode: 'WH1.RCV-01', skuBarcode: SKUS[0]!.barcodes[1]!.barcode, qty: 2 },
      ]),
    );
    expect(r.statusCode).toBe(201);
    const body = TxnResult.parse(r.json());
    expect(body.replayed).toBe(false);
    expect(body.txn.lines).toHaveLength(1);
    expect(body.txn.lines[0]).toMatchObject({
      locationCode: 'RCV-01',
      qtyDelta: 24,
      balanceAfter: before + 24,
    });
    expect(body.balancesAfter).toEqual([
      { locationId: RCV, skuId: S(0), lotNo: '', onHand: before + 24 },
    ]);
    expect(body.txn.submittedBy).toBe(USERS.op1);
    expect(body.txn.deviceId).toBe('dev-test-0001');
    expect(await onHand(pool(), RCV, S(0))).toBe(before + 24);
  });

  it('裸编码与小写编码同样可解析；WRONG_WAREHOUSE / UNKNOWN_BARCODE', async () => {
    const ok = await k.txn(
      'op1',
      cmd('INBOUND', [{ locationCode: 'rcv-01', skuId: S(1), qty: 1 }]),
    );
    expect(ok.statusCode).toBe(201);
    const wrong = await k.txn(
      'op1',
      cmd('INBOUND', [{ locationCode: 'WH2.A01-01-A01', skuId: S(1), qty: 1 }]),
    );
    expect(wrong.statusCode).toBe(422);
    expect(code(wrong)).toBe('WRONG_WAREHOUSE');
    const unk = await k.txn(
      'op1',
      cmd('INBOUND', [{ locationCode: 'Z99-99-Z99', skuId: S(1), qty: 1 }]),
    );
    expect(code(unk)).toBe('UNKNOWN_BARCODE');
    expect(Problem.parse(unk.json()).errors?.[0]?.path).toBe('lines[0].locationCode');
    const unkSku = await k.txn(
      'op1',
      cmd('INBOUND', [{ locationId: RCV, skuBarcode: 'NOPE-123', qty: 1 }]),
    );
    expect(code(unkSku)).toBe('UNKNOWN_BARCODE');
  });

  describe('幂等（#2、#3）', () => {
    it('同键 20 并发只记一次；其余为 200 replayed，结果相同', async () => {
      const key = randomUUID();
      const body = cmd('INBOUND', [{ locationId: SHP, skuId: S(2), qty: 3 }]);
      const before = await onHand(pool(), SHP, S(2));
      const rs = await Promise.all(Array.from({ length: 20 }, () => k.txn('op1', body, key)));
      const codes = rs.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      expect(codes.filter((c) => c === 200)).toHaveLength(19);
      const ids = new Set(rs.map((r) => TxnResult.parse(r.json()).txn.id));
      expect(ids.size).toBe(1);
      for (const r of rs)
        expect(TxnResult.parse(r.json()).balancesAfter[0]!.onHand).toBe(before + 3);
      expect(await onHand(pool(), SHP, S(2))).toBe(before + 3);
      const n = await pool().query(
        `SELECT count(*)::int n FROM inv_txns WHERE idempotency_key = $1`,
        [key],
      );
      expect(n.rows[0].n).toBe(1);
    });

    it('传输层字段（clientCreatedAt/createdOffline/performerSessionId）不参与哈希；原始体其他变化 → 409 且不泄露', async () => {
      const key = randomUUID();
      const body = cmd('INBOUND', [{ locationId: SHP, skuId: S(3), qty: 1 }]);
      expect((await k.txn('op1', body, key)).statusCode).toBe(201);
      const again = await k.txn(
        'op1',
        { ...body, clientCreatedAt: '2020-01-01T00:00:00Z', createdOffline: false },
        key,
      );
      expect(again.statusCode).toBe(200);
      expect(TxnResult.parse(again.json()).replayed).toBe(true);
      // 不同 body
      const diff = await k.txn(
        'op1',
        { ...body, lines: [{ locationId: SHP, skuId: S(3), qty: 2 }] },
        key,
      );
      expect(diff.statusCode).toBe(409);
      expect(code(diff)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(JSON.stringify(diff.json())).not.toContain(SHP);
      // 原始体多一个默认字段（force:false 显式给出）也算不同请求（哈希按解析前原文，D4）
      const explicit = await k.txn('op1', { ...body, force: false }, key);
      expect(code(explicit)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('不同用户同键（同 body 结构、各自 performedBy）→ 409 且不泄露首次内容', async () => {
      const key = randomUUID();
      expect(
        (await k.txn('op1', cmd('INBOUND', [{ locationId: SHP, skuId: S(4), qty: 1 }]), key))
          .statusCode,
      ).toBe(201);
      const other = await k.txn(
        'op2',
        cmd('INBOUND', [{ locationId: SHP, skuId: S(4), qty: 1 }], {}, 'op2'),
        key,
      );
      expect(other.statusCode).toBe(409);
      expect(code(other)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(Object.keys(other.json() as object).sort()).toEqual([
        'code',
        'status',
        'title',
        'traceId',
        'type',
      ]);
    });

    it('同键在另一个仓库不冲突（作用域 = (warehouse_id, key)）', async () => {
      const key = randomUUID();
      expect(
        (
          await k.txn(
            'admin',
            cmd('INBOUND', [{ locationId: SHP, skuId: S(5), qty: 1 }], {}, 'admin'),
            key,
          )
        ).statusCode,
      ).toBe(201);
      const r = await k.txn(
        'admin',
        cmd(
          'INBOUND',
          [{ locationId: k.wh2Locs[0], skuId: S(5), qty: 1 }],
          { warehouseId: WH2 },
          'admin',
        ),
        key,
      );
      expect(r.statusCode).toBe(201);
    });

    it('#3 首请求 422 回滚后键不留痕，补货后同键重放成功执行', async () => {
      const key = randomUUID();
      const L = fresh();
      const out = cmd('OUTBOUND', [{ locationId: L, skuId: S(6), qty: 5 }], {
        createdOffline: true,
      });
      const first = await k.txn('op1', out, key);
      expect(first.statusCode).toBe(422);
      expect(code(first)).toBe('INSUFFICIENT_STOCK');
      expect(Problem.parse(first.json()).context).toMatchObject({
        available: 0,
        requested: 5,
        createdOffline: true,
      });
      const n = await pool().query(
        `SELECT count(*)::int n FROM inv_txns WHERE idempotency_key = $1`,
        [key],
      );
      expect(n.rows[0].n).toBe(0);
      expect(
        (await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(6), qty: 8 }]))).statusCode,
      ).toBe(201);
      const retry = await k.txn('op1', out, key);
      expect(retry.statusCode).toBe(201);
      expect(TxnResult.parse(retry.json()).balancesAfter[0]!.onHand).toBe(3);
    });

    it('缺少或非法 Idempotency-Key → 400', async () => {
      const r = await k.req('op1', {
        method: 'POST',
        url: '/api/v1/inventory/transactions',
        payload: cmd('INBOUND', [{ locationId: SHP, skuId: S(0), qty: 1 }]),
      });
      expect(r.statusCode).toBe(400);
      const bad = await k.txn(
        'op1',
        cmd('INBOUND', [{ locationId: SHP, skuId: S(0), qty: 1 }]),
        'bad key!',
      );
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('不超卖 / 锁顺序（#1、#4）', () => {
    it('#1 同仓位 50 并发出库不超卖', async () => {
      const L = fresh();
      expect(
        (await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(7), qty: 30 }]))).statusCode,
      ).toBe(201);
      const rs = await Promise.all(
        Array.from({ length: 50 }, () =>
          k.txn('op1', cmd('OUTBOUND', [{ locationId: L, skuId: S(7), qty: 1 }])),
        ),
      );
      expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(30);
      expect(rs.filter((r) => code(r) === 'INSUFFICIENT_STOCK')).toHaveLength(20);
      expect(rs.every((r) => r.statusCode === 201 || r.statusCode === 422)).toBe(true);
      expect(await onHand(pool(), L, S(7))).toBe(0);
      const sum = await pool().query(
        `SELECT COALESCE(SUM(qty_delta),0)::int s, MIN(balance_after)::int m FROM stock_movements WHERE location_id = $1 AND sku_id = $2`,
        [L, S(7)],
      );
      expect(sum.rows[0]).toEqual({ s: 0, m: 0 });
    }, 30_000);

    it('#4 TRANSFER 环形 A→B / B→A 各 20 并发：无死锁、守恒', async () => {
      const A = fresh();
      const B = fresh();
      await k.txn('op1', cmd('INBOUND', [{ locationId: A, skuId: S(8), qty: 50 }]));
      await k.txn('op1', cmd('INBOUND', [{ locationId: B, skuId: S(8), qty: 50 }]));
      const d0 = await deadlocks(k);
      const tr = (from: string, to: string) =>
        k.txn(
          'op1',
          cmd('TRANSFER', [{ fromLocationId: from, toLocationId: to, skuId: S(8), qty: 2 }]),
        );
      const rs = await Promise.all(
        Array.from({ length: 40 }, (_, i) => (i % 2 ? tr(A, B) : tr(B, A))),
      );
      expect(rs.map((r) => r.statusCode).every((c) => c === 201)).toBe(true);
      expect((await onHand(pool(), A, S(8))) + (await onHand(pool(), B, S(8)))).toBe(100);
      expect(await deadlocks(k)).toBe(d0);
    }, 30_000);

    it('多行交易以相反行序并发（[L1,L2] vs [L2,L1]）：统一锁顺序，无死锁', async () => {
      const L1 = fresh();
      const L2 = fresh();
      const d0 = await deadlocks(k);
      const rs = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          k.txn(
            'op1',
            cmd(
              'INBOUND',
              i % 2
                ? [
                    { locationId: L1, skuId: S(9), qty: 1 },
                    { locationId: L2, skuId: S(9), qty: 1 },
                  ]
                : [
                    { locationId: L2, skuId: S(9), qty: 1 },
                    { locationId: L1, skuId: S(9), qty: 1 },
                  ],
            ),
          ),
        ),
      );
      expect(rs.every((r) => r.statusCode === 201)).toBe(true);
      expect(await onHand(pool(), L1, S(9))).toBe(30);
      expect(await onHand(pool(), L2, S(9))).toBe(30);
      expect(await deadlocks(k)).toBe(d0);
    }, 30_000);

    it('多行出库任一行不足 → 整单回滚（无部分扣减、无台账）', async () => {
      const L1 = fresh();
      const L2 = fresh();
      await k.txn('op1', cmd('INBOUND', [{ locationId: L1, skuId: S(10), qty: 5 }]));
      const m0 = await pool().query(`SELECT count(*)::int n FROM stock_movements`);
      const r = await k.txn(
        'op1',
        cmd('OUTBOUND', [
          { locationId: L1, skuId: S(10), qty: 5 },
          { locationId: L2, skuId: S(10), qty: 1 },
        ]),
      );
      expect(code(r)).toBe('INSUFFICIENT_STOCK');
      expect(await onHand(pool(), L1, S(10))).toBe(5);
      const m1 = await pool().query(`SELECT count(*)::int n FROM stock_movements`);
      expect(m1.rows[0].n).toBe(m0.rows[0].n);
    });
  });

  describe('锁内校验：容量 / 混放 / 停用（#5、#6）', () => {
    it('#6 容量：同仓位并发入库不超容（effective_max = 200）', async () => {
      const L = fresh();
      const rs = await Promise.all(
        Array.from({ length: 12 }, () =>
          k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(11), qty: 30 }])),
        ),
      );
      expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(6);
      expect(rs.filter((r) => code(r) === 'LOCATION_CAPACITY_EXCEEDED')).toHaveLength(6);
      expect(await onHand(pool(), L, S(11))).toBe(180);
    }, 30_000);

    it('容量按仓位全部 SKU 合计；MANAGER force 越过（写审计），OPERATOR force → 403', async () => {
      const L = fresh();
      await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(12), qty: 150 }]));
      const over = await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(13), qty: 60 }]));
      expect(code(over)).toBe('LOCATION_CAPACITY_EXCEEDED');
      const opForce = await k.txn(
        'op1',
        cmd('INBOUND', [{ locationId: L, skuId: S(13), qty: 60 }], { force: true }),
      );
      expect(opForce.statusCode).toBe(403);
      const mgr = await k.txn(
        'manager',
        cmd('INBOUND', [{ locationId: L, skuId: S(13), qty: 60 }], { force: true }, 'manager'),
      );
      expect(mgr.statusCode).toBe(201);
      const id = TxnResult.parse(mgr.json()).txn.id;
      const a = await pool().query(`SELECT action, after FROM audit_logs WHERE entity_id = $1`, [
        id,
      ]);
      expect(a.rows[0]).toMatchObject({ action: 'inventory.force', after: { force: true } });
    });

    it('#6 禁止混放：并发不同 SKU 入同一空仓位，只有一种 SKU 成功', async () => {
      await k.owner.query(`UPDATE warehouses SET allow_mixed_sku = false WHERE id = $1`, [WH1]);
      try {
        const L = fresh();
        const rs = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(14 + (i % 5)), qty: 1 }])),
          ),
        );
        const ok = rs.filter((r) => r.statusCode === 201);
        const skus = new Set(ok.map((r) => TxnResult.parse(r.json()).txn.lines[0]!.skuId));
        expect(skus.size).toBe(1);
        expect(rs.filter((r) => code(r) === 'MIXED_SKU_NOT_ALLOWED').length).toBe(10 - ok.length);
        const n = await pool().query(
          `SELECT count(*)::int n FROM stock_balances WHERE location_id = $1 AND on_hand > 0`,
          [L],
        );
        expect(n.rows[0].n).toBe(1);
      } finally {
        await k.owner.query(`UPDATE warehouses SET allow_mixed_sku = true WHERE id = $1`, [WH1]);
      }
    }, 30_000);

    it('停用仓位：入库/出库 → LOCATION_INACTIVE', async () => {
      const L = fresh();
      await k.owner.query(`UPDATE locations SET is_active = false WHERE id = $1`, [L]);
      const r = await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(0), qty: 1 }]));
      expect(code(r)).toBe('LOCATION_INACTIVE');
      await k.owner.query(`UPDATE locations SET is_active = true WHERE id = $1`, [L]);
    });

    it('#5 停用（FOR UPDATE → 检查无库存 → is_active=false）与入库并发：不出现停用仓位上有库存', async () => {
      // 模拟布局发布 / PATCH /locations 的停用流程（02 §6.2，遵守同一锁顺序）
      const deactivate = async (id: string) => {
        const c = await pool().connect();
        try {
          await c.query('BEGIN');
          await c.query(
            `SELECT id FROM locations WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
            [[id]],
          );
          const s = await c.query<{ s: number }>(
            `SELECT COALESCE(SUM(on_hand),0)::int s FROM stock_balances WHERE location_id = $1`,
            [id],
          );
          if (s.rows[0]!.s === 0)
            await c.query(`UPDATE locations SET is_active = false WHERE id = $1`, [id]);
          await c.query('COMMIT');
          return s.rows[0]!.s === 0;
        } finally {
          c.release();
        }
      };
      const targets = Array.from({ length: 6 }, () => fresh());
      for (const L of targets) {
        await Promise.all([
          k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(1), qty: 1 }])),
          deactivate(L),
          k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(2), qty: 1 }])),
        ]);
      }
      const bad = await pool().query(
        `SELECT l.code FROM locations l JOIN stock_balances b ON b.location_id = l.id WHERE NOT l.is_active AND b.on_hand > 0`,
      );
      expect(bad.rows).toEqual([]);
      await k.owner.query(`UPDATE locations SET is_active = true WHERE id = ANY($1::uuid[])`, [
        targets,
      ]);
    }, 30_000);
  });

  describe('跨仓授权（#9）', () => {
    it('WH1 交易引用 WH2 的 locationId → 404，余额不变', async () => {
      const before = await pool().query(`SELECT count(*)::int n FROM stock_movements`);
      const r = await k.txn(
        'admin',
        cmd('INBOUND', [{ locationId: k.wh2Locs[1], skuId: S(0), qty: 1 }], {}, 'admin'),
      );
      expect(r.statusCode).toBe(404);
      const tr = await k.txn(
        'admin',
        cmd(
          'TRANSFER',
          [{ fromLocationId: RCV, toLocationId: k.wh2Locs[1], skuId: S(0), qty: 1 }],
          {},
          'admin',
        ),
      );
      expect(tr.statusCode).toBe(404);
      expect(await onHand(pool(), k.wh2Locs[1]!, S(0))).toBe(0);
      const after = await pool().query(`SELECT count(*)::int n FROM stock_movements`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('无 WH2 授权的用户向 WH2 提交 / 查询 → 404（不暴露存在性）', async () => {
      const r = await k.txn(
        'op1',
        cmd('INBOUND', [{ locationId: k.wh2Locs[0], skuId: S(0), qty: 1 }], { warehouseId: WH2 }),
      );
      expect(r.statusCode).toBe(404);
      const q = await k.req('op1', {
        method: 'GET',
        url: `/api/v1/inventory/balances?warehouseId=${WH2}`,
      });
      expect(q.statusCode).toBe(404);
    });
  });

  describe('策略与只追加台账', () => {
    it('ADJUST 仅 MANAGER+；OTHER 必须带 note；ADJUST 写审计', async () => {
      const L = fresh();
      const op = await k.txn('op1', cmd('ADJUST', [{ locationId: L, skuId: S(3), qtyDelta: 2 }]));
      expect(op.statusCode).toBe(403);
      const noNote = await k.txn(
        'manager',
        cmd(
          'ADJUST',
          [{ locationId: L, skuId: S(3), qtyDelta: 2 }],
          { reason: 'OTHER' },
          'manager',
        ),
      );
      expect(noNote.statusCode).toBe(400);
      const ok = await k.txn(
        'manager',
        cmd('ADJUST', [{ locationId: L, skuId: S(3), qtyDelta: 2 }], {}, 'manager'),
      );
      expect(ok.statusCode).toBe(201);
      const t = TxnResult.parse(ok.json()).txn;
      expect(t.reason).toBe('FOUND');
      const a = await pool().query(
        `SELECT action, result, user_id FROM audit_logs WHERE entity_id = $1`,
        [t.id],
      );
      expect(a.rows).toEqual([
        { action: 'inventory.adjust', result: 'SUCCESS', user_id: USERS.manager },
      ]);
    });

    it('运行时角色不能改/删台账；更正只能通过新交易（冲正）', async () => {
      await expect(pool().query(`UPDATE stock_movements SET qty_delta = 1`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(pool().query(`DELETE FROM inv_txns`)).rejects.toThrow(/permission denied/);
      await expect(
        k.owner.query(`UPDATE stock_movements SET qty_delta = 1 WHERE id = 1`),
      ).rejects.toThrow(/append-only/);
    });

    it('合并后为 0 的命令 → 400；VIEWER 不能写 → 403', async () => {
      const zero = await k.txn(
        'manager',
        cmd(
          'ADJUST',
          [
            { locationId: RCV, skuId: S(0), qtyDelta: 1 },
            { locationId: RCV, skuId: S(0), qtyDelta: -1 },
          ],
          {},
          'manager',
        ),
      );
      expect(zero.statusCode).toBe(400);
      const v = await k.txn(
        'viewer',
        cmd('INBOUND', [{ locationId: RCV, skuId: S(0), qty: 1 }], {}, 'viewer'),
      );
      expect(v.statusCode).toBe(403);
    });
  });

  describe('冲正（#10、#16，02 §6.4）', () => {
    const reverse = (token: string, id: string, key = randomUUID()) =>
      k.req(token, {
        method: 'POST',
        url: `/api/v1/inventory/transactions/${id}/reverse`,
        headers: { 'idempotency-key': key },
        payload: { note: 'undo' },
      });

    it('冲正逐行反向；同键重放 200；第二次（新键）409 TXN_ALREADY_REVERSED；REVERSAL 不可再冲正', async () => {
      const L = fresh();
      const t = TxnResult.parse(
        (await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(4), qty: 7 }]))).json(),
      ).txn;
      const key = randomUUID();
      const r1 = await reverse('op1', t.id, key);
      expect(r1.statusCode).toBe(201);
      const rev = TxnResult.parse(r1.json()).txn;
      expect(rev).toMatchObject({ type: 'REVERSAL', reversesTxnId: t.id });
      expect(rev.lines[0]).toMatchObject({ qtyDelta: -7, balanceAfter: 0 });
      const replay = await reverse('op1', t.id, key);
      expect(replay.statusCode).toBe(200);
      expect(TxnResult.parse(replay.json()).txn.id).toBe(rev.id);
      const again = await reverse('op1', t.id);
      expect(again.statusCode).toBe(409);
      expect(code(again)).toBe('TXN_ALREADY_REVERSED');
      const g = await k.req('op1', {
        method: 'GET',
        url: `/api/v1/inventory/transactions/${t.id}`,
      });
      expect(g.json()).toMatchObject({ reversedByTxnId: rev.id });
      const rr = await reverse('manager', rev.id);
      expect(rr.statusCode).toBe(422);
      expect(code(rr)).toBe('REVERSAL_NOT_ALLOWED');
    });

    it('并发冲正同一交易（不同键）：只成功一次', async () => {
      const L = fresh();
      const t = TxnResult.parse(
        (await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(5), qty: 4 }]))).json(),
      ).txn;
      const rs = await Promise.all(Array.from({ length: 10 }, () => reverse('manager', t.id)));
      expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(rs.filter((r) => code(r) === 'TXN_ALREADY_REVERSED')).toHaveLength(9);
      expect(await onHand(pool(), L, S(5))).toBe(0);
    });

    it('OPERATOR：只能冲正本人、同设备、10 分钟内；COUNT_ADJUST 被拒', async () => {
      const L = fresh();
      const mine = TxnResult.parse(
        (await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(6), qty: 4 }]))).json(),
      ).txn;
      expect((await reverse('op2', mine.id)).statusCode).toBe(403); // 他人
      // 另一设备上的本人
      k.auth.set('op1-dev2', { ...k.auth.get('op1')!, deviceId: DEVICE2 });
      expect((await reverse('op1-dev2', mine.id)).statusCode).toBe(403);
      // 超过 10 分钟：用 owner 构造一笔“旧”交易不可行（只追加），改用 manager 的交易验证“非本人”路径已覆盖；
      // 10 分钟规则用服务器时钟：此处把本机时钟窗口内的单据冲正成功
      expect((await reverse('op1', mine.id)).statusCode).toBe(201);
      // COUNT_ADJUST：用 owner 直接构造一笔 COUNT_ADJUST 交易（engine 由盘点关闭生成，见 counts 测试）
      const ca = await k.owner.query<{ id: string }>(
        `INSERT INTO inv_txns (warehouse_id, type, idempotency_key, request_hash, performed_by, submitted_by, device_id)
         VALUES ($1,'COUNT_ADJUST',$2,$3,$4,$4,'dev-test-0001') RETURNING id`,
        [WH1, `count-close:${randomUUID()}`, '0'.repeat(64), USERS.op1],
      );
      const r = await reverse('op1', ca.rows[0]!.id);
      expect(r.statusCode).toBe(403);
    });

    it('超过 10 分钟的本人单据：OPERATOR 被拒，MANAGER 可冲正', async () => {
      const L = fresh();
      // 只追加表无法改时间：用 owner 写一笔 11 分钟前的交易 + 台账（等价于历史单据）
      const t = await k.owner.query<{ id: string }>(
        `INSERT INTO inv_txns (warehouse_id, type, idempotency_key, request_hash, performed_by, submitted_by, device_id, created_at)
         VALUES ($1,'INBOUND',$2,$3,$4,$4,'dev-test-0001', now() - interval '11 minutes') RETURNING id`,
        [WH1, randomUUID(), '0'.repeat(64), USERS.op1],
      );
      await k.owner.query(
        `INSERT INTO stock_balances (warehouse_id, location_id, sku_id, on_hand) VALUES ($1,$2,$3,3)`,
        [WH1, L, S(7)],
      );
      await k.owner.query(
        `INSERT INTO stock_movements (txn_id, warehouse_id, location_id, sku_id, qty_delta, balance_after) VALUES ($1,$2,$3,$4,3,3)`,
        [t.rows[0]!.id, WH1, L, S(7)],
      );
      expect((await reverse('op1', t.rows[0]!.id)).statusCode).toBe(403);
      expect((await reverse('manager', t.rows[0]!.id)).statusCode).toBe(201);
    });

    it('冲正需把库存加回已停用仓位 → LOCATION_INACTIVE；余额不足 → INSUFFICIENT_STOCK', async () => {
      const L = fresh();
      const L2 = fresh();
      await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: S(8), qty: 5 }]));
      const out = TxnResult.parse(
        (await k.txn('op1', cmd('OUTBOUND', [{ locationId: L, skuId: S(8), qty: 5 }]))).json(),
      ).txn;
      await k.owner.query(`UPDATE locations SET is_active = false WHERE id = $1`, [L]);
      const r = await reverse('manager', out.id);
      expect(code(r)).toBe('LOCATION_INACTIVE');
      await k.owner.query(`UPDATE locations SET is_active = true WHERE id = $1`, [L]);
      const inb = TxnResult.parse(
        (await k.txn('op1', cmd('INBOUND', [{ locationId: L2, skuId: S(8), qty: 5 }]))).json(),
      ).txn;
      await k.txn('op1', cmd('OUTBOUND', [{ locationId: L2, skuId: S(8), qty: 3 }]));
      const r2 = await reverse('manager', inb.id);
      expect(code(r2)).toBe('INSUFFICIENT_STOCK');
    });
  });

  describe('换班代交（#15，02 §6.6）', () => {
    it('A 的离线单在 A 登出、B 登录后由 B 的令牌提交：performed_by=A、submitted_by=B；伪造 → 403', async () => {
      // A=op1 的旧会话（已结束）；B=op2 的新会话（晚于 A）
      const s = await k.owner.query<{ a: string; b: string }>(
        `WITH a AS (INSERT INTO device_sessions (device_id, user_id, started_at, ended_at)
                    VALUES ('dev-test-0001', $1, now() - interval '3 hours', now() - interval '2 hours') RETURNING id),
              b AS (INSERT INTO device_sessions (device_id, user_id, started_at)
                    VALUES ('dev-test-0001', $2, now() - interval '2 hours') RETURNING id)
         SELECT (SELECT id FROM a) a, (SELECT id FROM b) b`,
        [USERS.op1, USERS.op2],
      );
      const { a, b } = s.rows[0]!;
      k.auth.set('op2-shift', { ...k.auth.get('op2')!, sessionId: b });
      const body = cmd('INBOUND', [{ locationId: RCV, skuId: S(9), qty: 1 }], {
        performerSessionId: a,
        createdOffline: true,
      });
      const ok = await k.txn('op2-shift', body);
      expect(ok.statusCode).toBe(201);
      const t = TxnResult.parse(ok.json()).txn;
      expect(t.performedBy).toBe(USERS.op1);
      expect(t.submittedBy).toBe(USERS.op2);
      const row = await pool().query(`SELECT performer_session_id FROM inv_txns WHERE id = $1`, [
        t.id,
      ]);
      expect(row.rows[0].performer_session_id).toBe(a);
      const audit = await pool().query(`SELECT action FROM audit_logs WHERE entity_id = $1`, [
        t.id,
      ]);
      expect(audit.rows[0].action).toBe('inventory.handoff');

      const deny = async (extra: Record<string, unknown>, token = 'op2-shift') =>
        code(await k.txn(token, cmd('INBOUND', [{ locationId: RCV, skuId: S(9), qty: 1 }], extra)));
      // 缺 performerSessionId
      expect(await deny({})).toBe('PERFORMER_NOT_ALLOWED');
      // 会话属于别人（B 自己的会话冒充 A）
      expect(await deny({ performerSessionId: b })).toBe('PERFORMER_NOT_ALLOWED');
      // 其他设备
      const other = await k.owner.query<{ id: string }>(
        `INSERT INTO device_sessions (device_id, user_id, started_at) VALUES ('dev-test-0002', $1, now() - interval '3 hours') RETURNING id`,
        [USERS.op1],
      );
      expect(await deny({ performerSessionId: other.rows[0]!.id })).toBe('PERFORMER_NOT_ALLOWED');
      // 晚于当前会话开始（会话区间外）
      const later = await k.owner.query<{ id: string }>(
        `INSERT INTO device_sessions (device_id, user_id, started_at) VALUES ('dev-test-0001', $1, now() - interval '1 minute') RETURNING id`,
        [USERS.op1],
      );
      expect(await deny({ performerSessionId: later.rows[0]!.id })).toBe('PERFORMER_NOT_ALLOWED');
      // 超过 72 小时
      const old = await k.owner.query<{ id: string }>(
        `INSERT INTO device_sessions (device_id, user_id, started_at) VALUES ('dev-test-0001', $1, now() - interval '73 hours') RETURNING id`,
        [USERS.op1],
      );
      expect(await deny({ performerSessionId: old.rows[0]!.id })).toBe('PERFORMER_NOT_ALLOWED');
      // A 账号停用
      await k.owner.query(`UPDATE users SET is_active = false WHERE id = $1`, [USERS.op1]);
      try {
        expect(await deny({ performerSessionId: a })).toBe('PERFORMER_NOT_ALLOWED');
      } finally {
        await k.owner.query(`UPDATE users SET is_active = true WHERE id = $1`, [USERS.op1]);
      }
    });
  });

  it('停用 SKU 后禁止入库 / 移入（CR1 #7）', async () => {
    const loc = fresh();
    await k.owner.query(`UPDATE skus SET is_active = false WHERE id = $1`, [S(4)]);
    try {
      const inbound = await k.txn(
        'op1',
        cmd('INBOUND', [{ locationId: loc, skuId: S(4), qty: 1 }]),
      );
      expect(inbound.statusCode).toBe(422);
      expect(code(inbound)).toBe('SKU_INACTIVE');
      const inboundFirst = await k.txn(
        'op1',
        cmd('INBOUND', [{ locationId: loc, skuId: S(0), qty: 2 }]),
      );
      expect([200, 201]).toContain(inboundFirst.statusCode);
      const xfer = await k.txn(
        'op1',
        cmd('TRANSFER', [{ fromLocationId: loc, toLocationId: RCV, skuId: S(4), qty: 1 }]),
      );
      expect(xfer.statusCode).toBe(422);
      expect(code(xfer)).toBe('SKU_INACTIVE');
    } finally {
      await k.owner.query(`UPDATE skus SET is_active = true WHERE id = $1`, [S(4)]);
    }
  });

  it('加锁后仓位编码已变 → LAYOUT_STALE（CR1 #6）', async () => {
    const loc = fresh();
    const row = await k.db.pool.query<{ code: string }>(
      `SELECT code FROM locations WHERE id = $1`,
      [loc],
    );
    await expect(
      withTx(k.db.pool, (c) =>
        applyTxn(c, {
          warehouseId: WH1,
          type: 'INBOUND',
          requestHash: randomUUID().replace(/-/g, ''),
          performedBy: USERS.op1,
          submittedBy: USERS.op1,
          deviceId: 'dev-test-0001',
          idempotencyKey: randomUUID(),
          createdOffline: false,
          clientCreatedAt: null,
          plan: {
            lockLocations: [loc],
            hasInbound: true,
            deltas: [{ locationId: loc, skuId: S(0), lotNo: '', delta: 1 }],
          },
          enforceCapacity: true,
          expectedLocationCodes: new Map([[loc, row.rows[0]!.code + '-STALE']]),
        }),
      ),
    ).rejects.toMatchObject({ code: 'LAYOUT_STALE' });
  });
});
