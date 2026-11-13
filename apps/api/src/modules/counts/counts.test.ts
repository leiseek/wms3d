/** 盘点集成测试（真 PG）：09 §2 #7、#8、#14；variance 提交时固定、整体覆盖、needs_review、盲盘、状态机。 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CountCloseResult, CountSubmissionResult, CountTask, TxnResult } from '@wms3d/contracts';
import { pgAvailable } from '../../test/pg.ts';
import { cmd, createKit, fresh, onHand, SKUS, WH1, type Kit } from '../inventory/testkit.ts';

const S = (i: number) => SKUS[i]!.id;
const code = (r: { json(): unknown }) => (r.json() as { code?: string }).code;

describe.skipIf(!pgAvailable)('盘点（02 §8）', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await createKit({ poolMax: 30 });
  }, 60_000);
  afterAll(async () => k?.close());
  const pool = () => k.db.pool;

  const post = (
    token: string,
    url: string,
    payload: unknown = {},
    headers: Record<string, string> = {},
  ) => k.req(token, { method: 'POST', url: `/api/v1${url}`, payload: payload as object, headers });
  const createTask = async (locationIds: string[], blind = true) => {
    const r = await post('manager', '/counts', { warehouseId: WH1, scope: { locationIds }, blind });
    expect(r.statusCode).toBe(201);
    const t = CountTask.parse(r.json());
    expect((await post('manager', `/counts/${t.id}/start`)).statusCode).toBe(200);
    return t;
  };
  const submit = (
    token: string,
    taskId: string,
    locationId: string,
    lines: Array<{ skuId: string; countedQty: number }>,
    clientCountedAt = new Date().toISOString(),
  ) =>
    post(token, `/counts/${taskId}/submissions`, {
      submissionId: randomUUID(),
      locationId,
      clientCountedAt,
      lines,
    });
  const stock = async (L: string, sku: string, qty: number) =>
    expect(
      (await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: sku, qty }]))).statusCode,
    ).toBe(201);

  it('完整流程：创建（快照）→ 提交（未扫到计 0、新 SKU 新增）→ 审核 → 关闭生成一笔 delta 型 COUNT_ADJUST', async () => {
    const L = fresh();
    await stock(L, S(0), 10);
    await stock(L, S(1), 4);
    const t = await createTask([L]);
    expect(t.progress).toEqual({ locationsTotal: 1, locationsSubmitted: 0, linesNeedingReview: 0 });
    const sub = await submit('op1', t.id, L, [
      { skuId: S(0), countedQty: 8 },
      { skuId: S(2), countedQty: 3 },
    ]);
    expect(sub.statusCode).toBe(200);
    const res = CountSubmissionResult.parse(sub.json());
    expect(res.needsReview).toBe(false);
    // 盲盘：OPERATOR 看不到系统数与差异
    expect(
      res.lines.every(
        (l) => l.systemQtyAtCount === null && l.variance === null && l.snapshotQty === null,
      ),
    ).toBe(true);
    const lines = await k.req('manager', { method: 'GET', url: `/api/v1/counts/${t.id}/lines` });
    const byS = new Map(
      (
        lines.json() as {
          items: Array<{
            skuId: string;
            variance: number;
            systemQtyAtCount: number;
            snapshotQty: number | null;
          }>;
        }
      ).items.map((x) => [x.skuId, x]),
    );
    expect(byS.get(S(0))).toMatchObject({ systemQtyAtCount: 10, variance: -2, snapshotQty: 10 });
    expect(byS.get(S(1))).toMatchObject({ systemQtyAtCount: 4, variance: -4 });
    expect(byS.get(S(2))).toMatchObject({ systemQtyAtCount: 0, variance: 3, snapshotQty: null });
    expect((await post('manager', `/counts/${t.id}/review`)).statusCode).toBe(200);
    const cl = await post('manager', `/counts/${t.id}/close`, {});
    expect(cl.statusCode).toBe(200);
    const closed = CountCloseResult.parse(cl.json());
    expect(closed.task.status).toBe('CLOSED');
    expect(closed.task.closedTxnId).toBe(closed.adjustTxnId);
    expect(await onHand(pool(), L, S(0))).toBe(8);
    expect(await onHand(pool(), L, S(1))).toBe(0);
    expect(await onHand(pool(), L, S(2))).toBe(3);
    const txn = await k.req('manager', {
      method: 'GET',
      url: `/api/v1/inventory/transactions/${closed.adjustTxnId}`,
    });
    expect(TxnResult.shape.txn.parse(txn.json())).toMatchObject({
      type: 'COUNT_ADJUST',
      refNo: closed.task.code,
    });
  });

  it('variance 在提交时固定：之后的正常出入库不改变差异，关闭按 delta 调整', async () => {
    const L = fresh();
    await stock(L, S(3), 10);
    const t = await createTask([L]);
    await submit('op1', t.id, L, [{ skuId: S(3), countedQty: 9 }]); // variance -1
    // 提交后又入库 5、出库 2（与盘点无关的正常作业）
    await stock(L, S(3), 5);
    await k.txn('op1', cmd('OUTBOUND', [{ locationId: L, skuId: S(3), qty: 2 }]));
    const v = await pool().query(
      `SELECT variance, system_qty_at_count FROM count_lines WHERE task_id = $1`,
      [t.id],
    );
    expect(v.rows[0]).toEqual({ variance: -1, system_qty_at_count: 10 });
    await post('manager', `/counts/${t.id}/review`);
    expect((await post('manager', `/counts/${t.id}/close`)).statusCode).toBe(200);
    expect(await onHand(pool(), L, S(3))).toBe(10 + 5 - 2 - 1);
  });

  it('同 (task, location) 再次提交 = 整体覆盖（重新读取当时余额）', async () => {
    const L = fresh();
    await stock(L, S(4), 6);
    const t = await createTask([L]);
    await submit('op1', t.id, L, [
      { skuId: S(4), countedQty: 1 },
      { skuId: S(5), countedQty: 2 },
    ]);
    await stock(L, S(4), 1);
    const again = CountSubmissionResult.parse(
      (await submit('manager', t.id, L, [{ skuId: S(4), countedQty: 7 }])).json(),
    );
    expect(again.lines).toHaveLength(1);
    expect(again.lines[0]).toMatchObject({ systemQtyAtCount: 7, countedQty: 7, variance: 0 });
    const task = CountTask.parse(
      (await k.req('manager', { method: 'GET', url: `/api/v1/counts/${t.id}` })).json(),
    );
    expect(task.progress.locationsSubmitted).toBe(1);
  });

  it('#8 提交与出库并发：variance 与提交时刻余额一致', async () => {
    for (let round = 0; round < 5; round++) {
      const L = fresh();
      await stock(L, S(6), 40);
      const t = await createTask([L]);
      const outs = Array.from({ length: 10 }, () =>
        k.txn('op1', cmd('OUTBOUND', [{ locationId: L, skuId: S(6), qty: 1 }])),
      );
      const sub = submit('manager', t.id, L, [{ skuId: S(6), countedQty: 35 }]);
      const [s] = await Promise.all([sub, ...outs]);
      const line = CountSubmissionResult.parse(s.json()).lines[0]!;
      // 提交锁仓位 FOR UPDATE，出库锁 FOR SHARE → 二者串行：系统数必是某一时刻的真实余额
      expect(line.systemQtyAtCount).toBeGreaterThanOrEqual(30);
      expect(line.systemQtyAtCount).toBeLessThanOrEqual(40);
      expect(line.variance).toBe(35 - line.systemQtyAtCount!);
      const ledger = await pool().query<{ a: number }>(
        `SELECT balance_after AS a FROM stock_movements WHERE location_id = $1 AND sku_id = $2 ORDER BY id`,
        [L, S(6)],
      );
      expect(ledger.rows.map((x) => x.a)).toContain(line.systemQtyAtCount);
      expect(await onHand(pool(), L, S(6))).toBe(30);
      await post('manager', `/counts/${t.id}/review`);
      expect((await post('manager', `/counts/${t.id}/close`)).statusCode).toBe(200);
      expect(await onHand(pool(), L, S(6))).toBe(30 + line.variance!);
    }
  }, 30_000);

  it('#7 close 双击/重试：并发 10 次只生成一笔 COUNT_ADJUST；重复调用返回同一调整单', async () => {
    const L = fresh();
    await stock(L, S(7), 5);
    const t = await createTask([L]);
    await submit('op1', t.id, L, [{ skuId: S(7), countedQty: 3 }]);
    await post('manager', `/counts/${t.id}/review`);
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => post('manager', `/counts/${t.id}/close`)),
    );
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    const ids = new Set(rs.map((r) => CountCloseResult.parse(r.json()).adjustTxnId));
    expect(ids.size).toBe(1);
    const n = await pool().query(
      `SELECT count(*)::int n FROM inv_txns WHERE idempotency_key = $1`,
      [`count-close:${t.id}`],
    );
    expect(n.rows[0].n).toBe(1);
    expect(await onHand(pool(), L, S(7))).toBe(3);
    const later = CountCloseResult.parse((await post('manager', `/counts/${t.id}/close`)).json());
    expect(later.adjustTxnId).toBe([...ids][0]);
  });

  it('#14 关闭时余额已不足：整体回滚、任务仍为 REVIEW、COUNT_RECOUNT_REQUIRED、无部分调整；重盘后可关闭', async () => {
    const L1 = fresh();
    const L2 = fresh();
    await stock(L1, S(8), 10);
    await stock(L2, S(8), 10);
    const t = await createTask([L1, L2]);
    await submit('op1', t.id, L1, [{ skuId: S(8), countedQty: 12 }]); // +2（可执行）
    await submit('op1', t.id, L2, [{ skuId: S(8), countedQty: 4 }]); // −6
    await k.txn('op1', cmd('OUTBOUND', [{ locationId: L2, skuId: S(8), qty: 8 }])); // L2 只剩 2 < 6
    await post('manager', `/counts/${t.id}/review`);
    const m0 = await pool().query(`SELECT count(*)::int n FROM stock_movements`);
    const r = await post('manager', `/counts/${t.id}/close`);
    expect(r.statusCode).toBe(422);
    expect(code(r)).toBe('COUNT_RECOUNT_REQUIRED');
    const ctx = (
      r.json() as { context: { locationIds: string[]; lines: Array<{ available: number }> } }
    ).context;
    expect(ctx.locationIds).toEqual([L2]);
    expect(ctx.lines[0]!.available).toBe(2);
    const m1 = await pool().query(`SELECT count(*)::int n FROM stock_movements`);
    expect(m1.rows[0].n).toBe(m0.rows[0].n);
    expect(await onHand(pool(), L1, S(8))).toBe(10);
    const task = CountTask.parse(
      (await k.req('manager', { method: 'GET', url: `/api/v1/counts/${t.id}` })).json(),
    );
    expect(task).toMatchObject({ status: 'REVIEW', closedTxnId: null });
    expect(task.progress.linesNeedingReview).toBe(1);
    // 有 needs_review 时再次关闭仍被拒；重盘 L2 后可关闭
    expect(code(await post('manager', `/counts/${t.id}/close`))).toBe('COUNT_RECOUNT_REQUIRED');
    await submit('manager', t.id, L2, [{ skuId: S(8), countedQty: 1 }]);
    const ok = await post('manager', `/counts/${t.id}/close`);
    expect(ok.statusCode).toBe(200);
    expect(await onHand(pool(), L1, S(8))).toBe(12);
    expect(await onHand(pool(), L2, S(8))).toBe(1);
  });

  it('离线计数 > 5 分钟 → 该仓位所有行 needs_review（关闭前须重盘）', async () => {
    const L = fresh();
    await stock(L, S(9), 3);
    await stock(L, S(10), 3);
    const t = await createTask([L], false);
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    const res = CountSubmissionResult.parse(
      (await submit('op1', t.id, L, [{ skuId: S(9), countedQty: 3 }], old)).json(),
    );
    expect(res.needsReview).toBe(true);
    expect(res.lines.every((l) => l.needsReview)).toBe(true);
    // 非盲盘：OPERATOR 可见系统数
    expect(res.lines.find((l) => l.skuId === S(10))).toMatchObject({
      systemQtyAtCount: 3,
      countedQty: 0,
      variance: -3,
    });
    const flt = await k.req('op1', {
      method: 'GET',
      url: `/api/v1/counts/${t.id}/lines?needsReview=true`,
    });
    expect((flt.json() as { items: unknown[] }).items).toHaveLength(2);
  });

  it('状态机：未开始不能提交、范围外仓位 400、已关闭不能提交/取消、OPERATOR 不能创建/关闭', async () => {
    const L = fresh();
    const r = await post('manager', '/counts', { warehouseId: WH1, scope: { locationIds: [L] } });
    const t = CountTask.parse(r.json());
    expect(code(await submit('op1', t.id, L, []))).toBe('CONFLICT');
    expect(
      (await post('op1', '/counts', { warehouseId: WH1, scope: { locationIds: [L] } })).statusCode,
    ).toBe(403);
    await post('manager', `/counts/${t.id}/start`);
    expect((await post('manager', `/counts/${t.id}/start`)).statusCode).toBe(200); // 幂等
    expect((await submit('op1', t.id, fresh(), [])).statusCode).toBe(400);
    expect(code(await post('manager', `/counts/${t.id}/close`))).toBe('CONFLICT'); // 未审核
    expect((await post('op1', `/counts/${t.id}/close`)).statusCode).toBe(403);
    expect((await submit('op1', t.id, L, [])).statusCode).toBe(200); // 空仓位、计 0
    await post('manager', `/counts/${t.id}/review`);
    const closed = CountCloseResult.parse((await post('manager', `/counts/${t.id}/close`)).json());
    expect(closed.adjustTxnId).toBeNull();
    expect(closed.task.progress.locationsSubmitted).toBe(1);
    expect(code(await submit('op1', t.id, L, []))).toBe('CONFLICT');
    expect(code(await post('manager', `/counts/${t.id}/cancel`))).toBe('CONFLICT');
  });

  it('设备有待同步单据：未确认 → COUNT_OUTBOX_PENDING，确认后可关闭', async () => {
    const L = fresh();
    const t = await createTask([L]);
    await submit('op1', t.id, L, []);
    await post('manager', `/counts/${t.id}/review`);
    await k.owner.query(
      `UPDATE devices SET pending_outbox = 3, pending_warehouse_id = $1 WHERE id = 'dev-test-0002'`,
      [WH1],
    );
    try {
      const r = await post('manager', `/counts/${t.id}/close`, {});
      expect(code(r)).toBe('COUNT_OUTBOX_PENDING');
      expect((r.json() as { context: unknown }).context).toEqual({ devices: 1, records: 3 });
      expect(
        (await post('manager', `/counts/${t.id}/close`, { confirmPendingOutbox: true })).statusCode,
      ).toBe(200);
    } finally {
      await k.owner.query(`UPDATE devices SET pending_outbox = 0 WHERE id = 'dev-test-0002'`);
    }
  });

  it('创建：Idempotency-Key 重放返回同一任务；范围按库区/货架解析；跨仓任务 404', async () => {
    const key = randomUUID();
    const body = { warehouseId: WH1, scope: { zones: ['b'] }, blind: true };
    const a = CountTask.parse(
      (await post('manager', '/counts', body, { 'idempotency-key': key })).json(),
    );
    const b = CountTask.parse(
      (await post('manager', '/counts', body, { 'idempotency-key': key })).json(),
    );
    expect(b.id).toBe(a.id);
    expect(a.progress.locationsTotal).toBe(96); // B 区 4 个货架 × 4 列 × 3 层 × 2 位
    expect(a.code).toMatch(/^CT-\d{8}-\d{4}$/);
    const diff = await post(
      'manager',
      '/counts',
      { ...body, blind: false },
      { 'idempotency-key': key },
    );
    expect(code(diff)).toBe('IDEMPOTENCY_KEY_REUSED');
    const list = await k.req('op1', {
      method: 'GET',
      url: `/api/v1/counts?warehouseId=${WH1}&limit=1`,
    });
    expect(
      (list.json() as { items: unknown[]; nextCursor: string | null }).nextCursor,
    ).not.toBeNull();
    // 跨仓：只授权 WH1 的 manager 访问 WH2 的任务 → 404
    const wh2 = await post('admin', '/counts', {
      warehouseId: (await import('../inventory/testkit.ts')).WH2,
      scope: { locationIds: k.wh2Locs },
    });
    const id2 = CountTask.parse(wh2.json()).id;
    expect(
      (await k.req('manager', { method: 'GET', url: `/api/v1/counts/${id2}` })).statusCode,
    ).toBe(404);
    expect((await post('manager', `/counts/${id2}/start`)).statusCode).toBe(404);
  });

  it('审计完整性：创建/开始/审核/关闭/取消均落审计日志', async () => {
    const actions = async (id: string) =>
      (
        await pool().query<{ action: string }>(
          `SELECT action FROM audit_logs WHERE entity = 'count_task' AND entity_id = $1 ORDER BY id`,
          [id],
        )
      ).rows.map((r) => r.action);

    const L = fresh();
    await stock(L, S(0), 2);
    const created = CountTask.parse(
      (await post('manager', '/counts', { warehouseId: WH1, scope: { locationIds: [L] } })).json(),
    );
    expect(await actions(created.id)).toEqual(['count.create']);
    await post('manager', `/counts/${created.id}/start`);
    await submit('op1', created.id, L, [{ skuId: S(0), countedQty: 1 }]);
    await post('manager', `/counts/${created.id}/review`);
    const closed = CountCloseResult.parse(
      (
        await post('manager', `/counts/${created.id}/close`, { confirmPendingOutbox: false })
      ).json(),
    );
    expect(closed.adjustTxnId).toBeTruthy();
    expect(await actions(created.id)).toEqual([
      'count.create',
      'count.counting',
      'count.review',
      'count.close',
    ]);
    expect(
      (
        await pool().query<{ action: string }>(
          `SELECT action FROM audit_logs WHERE action = 'inventory.count_adjust' AND entity_id = $1`,
          [closed.adjustTxnId],
        )
      ).rows.map((r) => r.action),
    ).toEqual(['inventory.count_adjust']);

    const other = CountTask.parse(
      (
        await post('manager', '/counts', { warehouseId: WH1, scope: { locationIds: [fresh()] } })
      ).json(),
    );
    await post('manager', `/counts/${other.id}/cancel`);
    expect(await actions(other.id)).toEqual(['count.create', 'count.cancelled']);
  });
});
