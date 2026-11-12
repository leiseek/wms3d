/**
 * 基于模型的属性测试（09 §2、ws-a2 验收）：fast-check commands 随机执行
 * INBOUND / OUTBOUND / TRANSFER / ADJUST / REVERSAL / 同键重放，内存 oracle 预测结果与错误码，
 * 每步比对真库余额；全部运行结束后跑全量对账（0 不一致）。
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TxnResult } from '@wms3d/contracts';
import { reconcile } from '../../jobs/reconcile.ts';
import { cmd, createKit, fresh, SKUS, type Kit } from './testkit.ts';

const CAP = 200;
const NL = 4;
const NS = 3;

interface Line {
  l: number;
  s: number;
  d: number;
}
interface Model {
  bal: Map<string, number>;
  txns: Array<{ id: string; lines: Line[]; reversal: boolean; reversed: boolean }>;
  sent: Array<{ token: string; key: string; body: Record<string, unknown>; txnId: string }>;
}
interface Real {
  k: Kit;
  locs: string[];
}

const key = (l: number, s: number) => `${l}|${s}`;
const get = (m: Model, l: number, s: number) => m.bal.get(key(l, s)) ?? 0;
const locTotal = (m: Model, l: number) => {
  let n = 0;
  for (let s = 0; s < NS; s++) n += get(m, l, s);
  return n;
};

/** 预测：先容量（目标仓位，INBOUND/TRANSFER），再余额不足；成功则返回新余额 */
function predict(
  m: Model,
  lines: Line[],
  capacity: boolean,
): { ok: true } | { ok: false; code: string } {
  if (capacity) {
    const net = new Map<number, number>();
    for (const x of lines) net.set(x.l, (net.get(x.l) ?? 0) + x.d);
    for (const [l, d] of net)
      if (d > 0 && locTotal(m, l) + d > CAP)
        return { ok: false, code: 'LOCATION_CAPACITY_EXCEEDED' };
  }
  for (const x of lines)
    if (x.d < 0 && get(m, x.l, x.s) + x.d < 0) return { ok: false, code: 'INSUFFICIENT_STOCK' };
  return { ok: true };
}
const apply = (m: Model, lines: Line[]) => {
  for (const x of lines) m.bal.set(key(x.l, x.s), get(m, x.l, x.s) + x.d);
};

async function compare(m: Model, r: Real) {
  const q = await r.k.db.pool.query<{ location_id: string; sku_id: string; on_hand: number }>(
    `SELECT location_id, sku_id, on_hand FROM stock_balances WHERE location_id = ANY($1::uuid[])`,
    [r.locs],
  );
  const real = new Map<string, number>();
  for (const b of q.rows) {
    const s = SKUS.findIndex((x) => x.id === b.sku_id);
    if (s >= 0 && s < NS) real.set(key(r.locs.indexOf(b.location_id), s), b.on_hand);
  }
  for (let l = 0; l < NL; l++)
    for (let s = 0; s < NS; s++)
      expect(real.get(key(l, s)) ?? 0, `bal ${l}/${s}`).toBe(get(m, l, s));
}

type Kind = 'INBOUND' | 'OUTBOUND' | 'TRANSFER' | 'ADJUST';

class TxnCmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly kind: Kind,
    readonly a: number,
    readonly b: number,
    readonly s: number,
    readonly q: number,
  ) {}
  check = () => true;
  lines(): Line[] {
    switch (this.kind) {
      case 'INBOUND':
        return [{ l: this.a, s: this.s, d: this.q }];
      case 'OUTBOUND':
        return [{ l: this.a, s: this.s, d: -this.q }];
      case 'TRANSFER':
        return [
          { l: this.a, s: this.s, d: -this.q },
          { l: this.b, s: this.s, d: this.q },
        ];
      case 'ADJUST':
        return [{ l: this.a, s: this.s, d: this.q }];
    }
  }
  async run(m: Model, r: Real) {
    const L = r.locs;
    const sku = SKUS[this.s]!.id;
    const token = this.kind === 'ADJUST' ? 'manager' : 'op1';
    const line =
      this.kind === 'TRANSFER'
        ? { fromLocationId: L[this.a], toLocationId: L[this.b], skuId: sku, qty: this.q }
        : this.kind === 'ADJUST'
          ? { locationId: L[this.a], skuId: sku, qtyDelta: this.q }
          : { locationId: L[this.a], skuId: sku, qty: this.q };
    const body = cmd(this.kind, [line], {}, token);
    const k = randomUUID();
    const res = await r.k.txn(token, body, k);
    const lines = this.lines();
    const p = predict(m, lines, this.kind === 'INBOUND' || this.kind === 'TRANSFER');
    if (p.ok) {
      expect(res.statusCode, res.body).toBe(201);
      const t = TxnResult.parse(res.json());
      apply(m, lines);
      m.txns.push({ id: t.txn.id, lines, reversal: false, reversed: false });
      m.sent.push({ token, key: k, body, txnId: t.txn.id });
    } else {
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().code).toBe(p.code);
    }
    await compare(m, r);
  }
  toString = () => `${this.kind}(${this.a},${this.b},s${this.s},${this.q})`;
}

/** 恰好填满 / 超出 1 的入库（容量边界） */
class FillCmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly a: number,
    readonly s: number,
    readonly over: boolean,
  ) {}
  check = (m: Readonly<Model>) => CAP - locTotal(m as Model, this.a) + (this.over ? 1 : 0) > 0;
  run(m: Model, r: Real) {
    const q = CAP - locTotal(m, this.a) + (this.over ? 1 : 0);
    return new TxnCmd('INBOUND', this.a, this.a, this.s, q).run(m, r);
  }
  toString = () => `FILL(${this.a},s${this.s},${this.over ? '+1' : '=cap'})`;
}

class ReverseCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly i: number) {}
  check = (m: Readonly<Model>) => m.txns.length > 0;
  async run(m: Model, r: Real) {
    const t = m.txns[this.i % m.txns.length]!;
    const res = await r.k.req('manager', {
      method: 'POST',
      url: `/api/v1/inventory/transactions/${t.id}/reverse`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { note: 'model' },
    });
    const inv = t.lines.map((x) => ({ ...x, d: -x.d }));
    if (t.reversal) {
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().code).toBe('REVERSAL_NOT_ALLOWED');
    } else if (t.reversed) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('TXN_ALREADY_REVERSED');
    } else {
      const p = predict(m, inv, false);
      if (p.ok) {
        expect(res.statusCode, res.body).toBe(201);
        apply(m, inv);
        t.reversed = true;
        m.txns.push({
          id: TxnResult.parse(res.json()).txn.id,
          lines: inv,
          reversal: true,
          reversed: false,
        });
      } else {
        expect(res.statusCode, res.body).toBe(422);
        expect(res.json().code).toBe(p.code);
      }
    }
    await compare(m, r);
  }
  toString = () => `REVERSE(${this.i})`;
}

class ReplayCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly i: number) {}
  check = (m: Readonly<Model>) => m.sent.length > 0;
  async run(m: Model, r: Real) {
    const s = m.sent[this.i % m.sent.length]!;
    const res = await r.k.txn(s.token, s.body, s.key);
    expect(res.statusCode, res.body).toBe(200);
    const t = TxnResult.parse(res.json());
    expect(t.replayed).toBe(true);
    expect(t.txn.id).toBe(s.txnId);
    await compare(m, r);
  }
  toString = () => `REPLAY(${this.i})`;
}

describe('基于模型的库存属性测试（PG 真库）', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await createKit();
  });
  afterAll(async () => k?.close());

  it('随机命令序列：每步余额与 oracle 一致；结束全量对账 0 不一致', async () => {
    const li = fc.integer({ min: 0, max: NL - 1 });
    const si = fc.integer({ min: 0, max: NS - 1 });
    const cmds = [
      fc
        .tuple(li, si, fc.integer({ min: 1, max: 90 }))
        .map(([a, s, q]) => new TxnCmd('INBOUND', a, a, s, q)),
      fc
        .tuple(li, si, fc.integer({ min: 1, max: 40 }))
        .map(([a, s, q]) => new TxnCmd('OUTBOUND', a, a, s, q)),
      fc
        .tuple(li, fc.integer({ min: 1, max: NL - 1 }), si, fc.integer({ min: 1, max: 60 }))
        .map(([a, off, s, q]) => new TxnCmd('TRANSFER', a, (a + off) % NL, s, q)),
      fc
        .tuple(
          li,
          si,
          fc.integer({ min: -25, max: 25 }).filter((x) => x !== 0),
        )
        .map(([a, s, q]) => new TxnCmd('ADJUST', a, a, s, q)),
      fc.tuple(li, si, fc.boolean()).map(([a, s, o]) => new FillCmd(a, s, o)),
      fc.nat(50).map((i) => new ReverseCmd(i)),
      fc.nat(50).map((i) => new ReplayCmd(i)),
    ];
    await fc.assert(
      fc.asyncProperty(fc.commands(cmds, { maxCommands: 60, size: 'large' }), async (cs) => {
        const locs = Array.from({ length: NL }, () => fresh());
        const model: Model = { bal: new Map(), txns: [], sent: [] };
        await fc.asyncModelRun(() => ({ model, real: { k, locs } }), cs);
      }),
      { numRuns: 15, endOnFailure: true },
    );
    const rec = await reconcile(k.db.pool, { full: true, record: false });
    expect(rec.mismatches).toEqual([]);
    expect(rec.checkedKeys).toBeGreaterThan(0);
    const n = await k.db.pool.query<{ n: number; r: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE type = 'REVERSAL')::int AS r FROM inv_txns`,
    );
    expect(n.rows[0]!.n).toBeGreaterThan(50);
    expect(n.rows[0]!.r).toBeGreaterThan(0);
  }, 240_000);
});
