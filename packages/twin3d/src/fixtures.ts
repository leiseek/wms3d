import type { LayoutDoc, Occupancy, RackTypeSpec, TwinModel } from '@wms3d/contracts';
import { DEFAULT_PATTERN, demo, demoId, expandLayout } from '@wms3d/domain';

/**
 * 测试 / playground / 基准用数据。演示仓直接取 @wms3d/domain 的 demo（与 mock 同源）；
 * 大规模布局（5k/20k）在包内用 expandLayout 生成（不改 demo 数据，ws-d2 简报）。
 */

export function twinModelFrom(
  layout: LayoutDoc,
  opts: {
    warehouseId: string;
    warehouseCode: string;
    layoutVersion: number;
    pattern?: string;
    idOf?: (code: string) => string;
  },
): TwinModel {
  const exp = expandLayout(layout, opts.pattern ?? DEFAULT_PATTERN);
  const idOf = opts.idOf ?? ((code: string) => demoId(`location:${opts.warehouseCode}:${code}`));
  const locs = exp.locations;
  return {
    warehouseId: opts.warehouseId,
    warehouseCode: opts.warehouseCode,
    layoutVersion: opts.layoutVersion,
    layout,
    locations: {
      id: locs.map((l) => idOf(l.code)),
      code: locs.map((l) => l.code),
      rackKey: locs.map((l) => l.rackKey),
      rackBayIndex: locs.map((l) => l.rackBayIndex),
      level: locs.map((l) => l.level),
      pos: locs.map((l) => l.position),
    },
  };
}

export function demoTwinModel(layoutVersion = 1): TwinModel {
  return twinModelFrom(demo.demoLayout, {
    warehouseId: demo.demoWarehouse.id,
    warehouseCode: demo.demoWarehouse.code,
    layoutVersion,
  });
}

/** 演示仓的 occupancy（与 mock 种子库存一致：约 65% 货架仓位有货）。 */
export function demoOccupancy(model: TwinModel): Occupancy {
  const byLoc = new Map<string, { q: number; n: number }>();
  for (const b of demo.demoBalances) {
    const e = byLoc.get(b.locationId) ?? { q: 0, n: 0 };
    e.q += b.onHand;
    e.n += 1;
    byLoc.set(b.locationId, e);
  }
  const max = 200;
  const qty = model.locations.id.map((id) => byLoc.get(id)?.q ?? 0);
  return {
    layoutVersion: model.layoutVersion,
    asOf: '2026-11-12T09:00:00.000Z',
    qty,
    skuCount: model.locations.id.map((id) => byLoc.get(id)?.n ?? 0),
    fill: qty.map((q) => Math.min(1, q / max)),
    isActive: model.locations.id.map(() => 1 as const),
    effectiveMax: model.locations.id.map(() => max),
  };
}

const BENCH_TYPE: RackTypeSpec = {
  key: 'bench-4x5',
  name: '基准架 4 列 5 层',
  bays: 4,
  levels: 5,
  positionsPerLevel: 1,
  bayWidthM: 2.7,
  depthM: 1.0,
  levelHeightsM: [1.4, 1.4, 1.4, 1.4, 1.4],
  beamM: 0.1,
  uprightM: 0.08,
  defaultMaxQty: 100,
};

/** 基准布局每侧 bay 超过 99，编码用 3 位 bay。 */
export const BENCH_PATTERN = '{Zone}{Aisle:2}-{Bay:3}-{Level:A}{Pos:2}';

/**
 * 基准布局：每巷道两侧各 13 个货架（26 架 × 20 仓位 = 520 仓位/巷道）。
 * aisles=10 → 5,200 仓位（5k 档）；aisles=40 → 20,800 仓位（20k 档，两个库区各 20 条巷道 = 40 块）。
 */
export function benchLayout(aisles: number, racksPerSide = 13): LayoutDoc {
  const t = BENCH_TYPE;
  const L = t.bays * t.bayWidthM + (t.bays + 1) * t.uprightM;
  const aisleW = 3;
  const pitch = aisleW + 2 * t.depthM + 0.2;
  const perZone = aisles > 20 ? Math.ceil(aisles / 2) : aisles;
  const zones = Math.ceil(aisles / perZone);
  const blockW = racksPerSide * L + 6;
  const depth = perZone * pitch + 6;
  const racks: LayoutDoc['racks'] = [];
  const zoneDefs: LayoutDoc['zones'] = [];
  const colors = ['#5B8FF9', '#5AD8A6'];
  for (let zi = 0; zi < zones; zi++) {
    const code = String.fromCharCode(65 + zi);
    const x0 = zi * blockW;
    zoneDefs.push({
      code,
      name: `${code} 区`,
      kind: 'STORAGE',
      polygon: [
        [x0, 0],
        [x0 + blockW, 0],
        [x0 + blockW, depth],
        [x0, depth],
      ],
      color: colors[zi % 2],
    });
    for (let a = 1; a <= perZone && zi * perZone + a <= aisles; a++) {
      const zL = 3 + t.depthM + (a - 1) * pitch;
      const zR = zL + aisleW;
      for (let j = 0; j < racksPerSide; j++) {
        racks.push({
          key: `${code.toLowerCase()}${a}l${j + 1}`,
          zone: code,
          type: t.key,
          aisle: a,
          rackNo: j + 1,
          bayStart: 1 + 2 * t.bays * j,
          x: x0 + 3 + j * L,
          z: zL,
          rotationDeg: 0,
        });
        racks.push({
          key: `${code.toLowerCase()}${a}r${j + 1}`,
          zone: code,
          type: t.key,
          aisle: a,
          rackNo: j + 1,
          bayStart: 2 + 2 * t.bays * j,
          x: x0 + 3 + (j + 1) * L,
          z: zR,
          rotationDeg: 180,
        });
      }
    }
  }
  return {
    schemaVersion: 2,
    warehouse: { widthM: zones * blockW, depthM: depth, heightM: 10 },
    zones: zoneDefs,
    rackTypes: [t],
    racks,
    floorAreas: [],
  };
}

/** 确定性伪随机 occupancy：约 45% 有货、2% 停用。 */
export function syntheticOccupancy(model: TwinModel, seed = 1): Occupancy {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
  const n = model.locations.id.length;
  const qty: number[] = [];
  const skuCount: number[] = [];
  const fill: number[] = [];
  const isActive: (0 | 1)[] = [];
  const effectiveMax: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const active = rnd() > 0.02;
    const used = rnd() < 0.45;
    const q = used ? 1 + Math.floor(rnd() * 100) : 0;
    qty.push(q);
    skuCount.push(used ? (rnd() < 0.8 ? 1 : 2) : 0);
    fill.push(Math.min(1, q / 100));
    isActive.push(active ? 1 : 0);
    effectiveMax.push(100);
  }
  return {
    layoutVersion: model.layoutVersion,
    asOf: '2026-11-12T09:00:00.000Z',
    qty,
    skuCount,
    fill,
    isActive,
    effectiveMax,
  };
}

export function benchTwinModel(aisles: number): TwinModel {
  let n = 0;
  return twinModelFrom(benchLayout(aisles), {
    warehouseId: demoId('warehouse:BENCH'),
    warehouseCode: 'BEN',
    layoutVersion: 1,
    pattern: BENCH_PATTERN,
    // 基准只需唯一 id，避免 2 万次哈希
    idOf: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
  });
}
