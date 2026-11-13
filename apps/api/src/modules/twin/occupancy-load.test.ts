/**
 * 占用刷新负载（01 §7 / M-N3）：20,000 仓位合成计算预算；
 * OccupancyCache 在 2 次标脏/秒 + 50 个并发读取下合并重算（CI 缩时，不跑 50 客户端真机浸泡）。
 */
import { describe, expect, it } from 'vitest';
import { OccupancyCache, occupancyEtag, type OccupancySnapshot } from './service.ts';

const N = 20_000;

function synth(gen: number): OccupancySnapshot {
  const qty = new Array<number>(N);
  const skuCount = new Array<number>(N);
  const fill = new Array<number>(N);
  const isActive = new Array<0 | 1>(N);
  const effectiveMax = new Array<number | null>(N);
  for (let i = 0; i < N; i++) {
    const qv = (i + gen) % 11;
    const eff = 10;
    qty[i] = qv;
    skuCount[i] = qv > 0 ? 1 : 0;
    effectiveMax[i] = eff;
    isActive[i] = 1;
    fill[i] = Math.min(1, qv / eff);
  }
  const core = { layoutVersion: 1, qty, skuCount, fill, isActive, effectiveMax };
  return { body: { ...core, asOf: new Date().toISOString() }, etag: occupancyEtag(core) };
}

describe('occupancy 负载（M-N3）', () => {
  it('2 万仓位一次重算低于 200ms', () => {
    synth(0); // warmup
    const t0 = performance.now();
    const snap = synth(1);
    const ms = performance.now() - t0;
    expect(snap.body.qty).toHaveLength(N);
    expect(snap.body.fill[0]).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(200);
  });

  it('50 个读取方 + 2 次/秒标脏：重算被缓存合并，且低于每秒一次的量级', async () => {
    let computes = 0;
    const cache = new OccupancyCache(
      async () => {
        computes++;
        return synth(computes);
      },
      { minIntervalMs: 200, ttlMs: 60_000 },
    );
    const started = Date.now();
    const dirty = setInterval(() => cache.markDirty('wh'), 500);
    const clients: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      clients.push(
        (async () => {
          while (Date.now() - started < 1200) {
            const v = await cache.get('wh');
            expect(v?.body.qty).toHaveLength(N);
            await new Promise((r) => setTimeout(r, 80));
          }
        })(),
      );
    }
    await Promise.all(clients);
    clearInterval(dirty);
    // 1.2s、minInterval 200ms → 理论上限约 7 次；合并后应远小于 50×轮询
    expect(computes).toBeGreaterThanOrEqual(1);
    expect(computes).toBeLessThanOrEqual(8);
  }, 15_000);
});
