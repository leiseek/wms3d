/**
 * 孪生数据（03 §7、06）：TwinModel（ETag = layoutVersion）与 occupancy（ETag = 内容哈希，v2.1 N2）。
 * occupancy 服务端按仓库缓存：事件（stock.changed / locations.changed / layout.published）到来标脏，
 * 最多每秒重算一次、所有客户端共享（M-N3）；另设 TTL 兜底进程外写入。
 */
import type pg from 'pg';
import type { z } from 'zod';
import type { LayoutDoc, Occupancy, TwinModel } from '@wms3d/contracts';
import { expandLayout } from '@wms3d/domain';
import { ApiError } from '../../lib/problem.ts';
import { sha256, type Queryable } from '../inventory/util.ts';

type OccupancyBody = z.output<typeof Occupancy>;
type TwinBody = z.output<typeof TwinModel>;

export interface TwinIndex {
  warehouseId: string;
  layoutVersion: number;
  model: TwinBody;
}

/** TwinModel：下标 = twinIndex（expandLayout 顺序），仅在该 layoutVersion 内有效。按 (仓库, 版本) 缓存。 */
export class TwinIndexCache {
  private readonly byKey = new Map<string, Promise<TwinIndex>>();
  private readonly q: Queryable;
  constructor(q: Queryable) {
    this.q = q;
  }

  async publishedVersion(wh: string): Promise<number | null> {
    const r = await this.q.query<{ v: number | null }>(
      `SELECT published_layout_version AS v FROM warehouses WHERE id = $1`,
      [wh],
    );
    if (!r.rows[0]) throw new ApiError('NOT_FOUND');
    return r.rows[0].v;
  }

  async get(wh: string, version: number): Promise<TwinIndex> {
    const key = `${wh}:${version}`;
    let p = this.byKey.get(key);
    if (!p) {
      p = this.build(wh, version);
      this.byKey.set(key, p);
      p.catch(() => this.byKey.delete(key));
    }
    return p;
  }

  invalidate(wh: string): void {
    for (const k of [...this.byKey.keys()]) if (k.startsWith(`${wh}:`)) this.byKey.delete(k);
  }

  private async build(wh: string, version: number): Promise<TwinIndex> {
    const r = await this.q.query<{
      doc: z.output<typeof LayoutDoc>;
      code: string;
      pattern: string;
    }>(
      `SELECT lv.doc, w.code, w.location_code_pattern AS pattern
         FROM warehouses w JOIN layout_versions lv ON lv.warehouse_id = w.id AND lv.version = $2
        WHERE w.id = $1`,
      [wh, version],
    );
    const row = r.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', '没有已发布的布局');
    const exp = expandLayout(row.doc, row.pattern);
    const locs = await this.q.query<{ id: string; code: string }>(
      `SELECT id, code FROM locations WHERE warehouse_id = $1`,
      [wh],
    );
    const byCode = new Map(locs.rows.map((l) => [l.code, l.id]));
    const items = exp.locations.filter((l) => byCode.has(l.code));
    return {
      warehouseId: wh,
      layoutVersion: version,
      model: {
        warehouseId: wh,
        warehouseCode: row.code,
        layoutVersion: version,
        layout: row.doc,
        locations: {
          id: items.map((l) => byCode.get(l.code)!),
          code: items.map((l) => l.code),
          rackKey: items.map((l) => l.rackKey),
          rackBayIndex: items.map((l) => l.rackBayIndex),
          level: items.map((l) => l.level),
          pos: items.map((l) => l.position),
        },
      },
    };
  }
}

export interface OccupancySnapshot {
  body: OccupancyBody;
  etag: string;
}

/** 内容哈希 ETag：layoutVersion + 各数组内容（不含 asOf）。 */
export function occupancyEtag(b: Omit<OccupancyBody, 'asOf'>): string {
  const h = sha256(
    JSON.stringify([b.layoutVersion, b.qty, b.skuCount, b.fill, b.isActive, b.effectiveMax]),
  );
  return `"occ-${h.slice(0, 32)}"`;
}

export async function computeOccupancy(
  q: Queryable,
  index: TwinIndexCache,
  wh: string,
): Promise<OccupancySnapshot | null> {
  const version = await index.publishedVersion(wh);
  if (version === null) return null;
  const idx = await index.get(wh, version);
  const r = await q.query<{
    id: string;
    is_active: boolean;
    eff: number | null;
    qty: number;
    skus: number;
  }>(
    `SELECT l.id, l.is_active, COALESCE(l.max_qty, (r.rack_type->>'defaultMaxQty')::int) AS eff,
            COALESCE(SUM(b.on_hand) FILTER (WHERE b.on_hand > 0), 0)::int AS qty,
            COUNT(b.sku_id) FILTER (WHERE b.on_hand > 0)::int AS skus
       FROM locations l LEFT JOIN racks r ON r.id = l.rack_id
       LEFT JOIN stock_balances b ON b.location_id = l.id
      WHERE l.warehouse_id = $1 GROUP BY l.id, r.rack_type`,
    [wh],
  );
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  const ids = idx.model.locations.id;
  const qty: number[] = [];
  const skuCount: number[] = [];
  const fill: number[] = [];
  const isActive: Array<0 | 1> = [];
  const effectiveMax: Array<number | null> = [];
  for (const id of ids) {
    const x = byId.get(id);
    const qv = x?.qty ?? 0;
    const eff = x?.eff ?? null;
    qty.push(qv);
    skuCount.push(x?.skus ?? 0);
    effectiveMax.push(eff);
    isActive.push(x?.is_active === false ? 0 : 1);
    fill.push(eff ? Math.min(1, qv / eff) : qv > 0 ? 1 : 0);
  }
  const core = { layoutVersion: version, qty, skuCount, fill, isActive, effectiveMax };
  return { body: { ...core, asOf: new Date().toISOString() }, etag: occupancyEtag(core) };
}

interface Entry {
  gen: number;
  value: OccupancySnapshot | null | undefined;
  valueGen: number;
  valueAt: number;
  lastStart: number;
  inflight: Promise<void> | null;
}

/** 按仓库的 occupancy 缓存：标脏 → 单飞重算（两次重算间隔 ≥ minIntervalMs）；请求保证拿到“不早于其到达时脏标记”的结果。 */
export class OccupancyCache {
  private readonly entries = new Map<string, Entry>();
  private readonly compute: (wh: string) => Promise<OccupancySnapshot | null>;
  private readonly opts: { minIntervalMs: number; ttlMs: number };
  constructor(
    compute: (wh: string) => Promise<OccupancySnapshot | null>,
    opts: { minIntervalMs: number; ttlMs: number } = { minIntervalMs: 1000, ttlMs: 15_000 },
  ) {
    this.compute = compute;
    this.opts = opts;
  }

  private entry(wh: string): Entry {
    let e = this.entries.get(wh);
    if (!e)
      this.entries.set(
        wh,
        (e = { gen: 1, value: undefined, valueGen: 0, valueAt: 0, lastStart: 0, inflight: null }),
      );
    return e;
  }

  markDirty(wh: string): void {
    this.entry(wh).gen++;
  }

  async get(wh: string): Promise<OccupancySnapshot | null> {
    const e = this.entry(wh);
    if (
      e.value !== undefined &&
      e.valueGen >= e.gen &&
      !e.inflight &&
      Date.now() - e.valueAt >= this.opts.ttlMs
    )
      e.gen++;
    const want = e.gen;
    for (;;) {
      if (e.value !== undefined && e.valueGen >= want) return e.value;
      if (!e.inflight) {
        e.inflight = (async () => {
          const wait = e.lastStart + this.opts.minIntervalMs - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          e.lastStart = Date.now();
          const startGen = e.gen;
          const v = await this.compute(wh);
          e.value = v;
          e.valueGen = startGen;
          e.valueAt = Date.now();
        })().finally(() => {
          e.inflight = null;
        });
      }
      await e.inflight;
    }
  }
}

export type { pg };
