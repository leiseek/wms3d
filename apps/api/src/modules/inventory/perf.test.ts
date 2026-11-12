/**
 * 性能（ws-a2 验收）：本机 1k 次交易 p95 < 150ms。默认跳过；在 perf 锁下运行：
 *   WMS_PERF=1 flock /tmp/wms3d-perf.lock npx vitest run apps/api/src/modules/inventory/perf.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcile } from '../../jobs/reconcile.ts';
import { cmd, createKit, LOCS, SKUS, type Kit } from './testkit.ts';

const N = 1000;
const CONCURRENCY = 4;

describe.skipIf(process.env.WMS_PERF !== '1')('性能：1k 交易 p95 < 150ms', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await createKit({ poolMax: 10 });
  });
  afterAll(async () => k?.close());

  it('混合 INBOUND / TRANSFER / OUTBOUND（4 并发），p95 < 150ms，结束对账一致', async () => {
    const locs = LOCS.filter((l) => l.rackKey).map((l) => l.id);
    const lat: number[] = [];
    let next = 0;
    const one = async (i: number) => {
      const a = locs[i % 200]!;
      const b = locs[(i * 7 + 3) % locs.length]!;
      const sku = SKUS[(i % 200) % SKUS.length]!.id;
      const kind = i % 3;
      const body =
        i < 200 || kind === 0
          ? cmd('INBOUND', [{ locationId: a, skuId: sku, qty: 10 }])
          : kind === 1
            ? cmd('TRANSFER', [
                {
                  fromLocationId: locs[(i - 200) % 200]!,
                  toLocationId: b,
                  skuId: SKUS[((i - 200) % 200) % SKUS.length]!.id,
                  qty: 1,
                },
              ])
            : cmd('OUTBOUND', [
                {
                  locationId: locs[(i - 200) % 200]!,
                  skuId: SKUS[((i - 200) % 200) % SKUS.length]!.id,
                  qty: 1,
                },
              ]);
      const t0 = performance.now();
      const r = await k.txn('op1', body, randomUUID());
      lat.push(performance.now() - t0);
      return r.statusCode;
    };
    const codes: number[] = [];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < N) codes.push(await one(next++));
      }),
    );
    lat.sort((x, y) => x - y);
    const p50 = lat[Math.floor(N * 0.5)]!;
    const p95 = lat[Math.floor(N * 0.95)]!;
    console.log(
      `perf: n=${N} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${lat[N - 1]!.toFixed(1)}ms`,
    );
    expect(codes.filter((c) => c === 201).length).toBeGreaterThan(N * 0.95);
    expect(codes.every((c) => c === 201 || c === 422)).toBe(true);
    expect(p95).toBeLessThan(150);
    expect((await reconcile(k.db.pool, { full: true, record: false })).mismatches).toEqual([]);
  }, 300_000);
});
