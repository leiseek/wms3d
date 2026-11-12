import { describe, expect, it, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import type { LayoutDoc, Occupancy, RotationDeg, WmsEvent } from '@wms3d/contracts';
import { cellWorld, validateLayout } from '@wms3d/domain';
import golden from '@wms3d/domain/geometry-golden.json';
import { goldenLayout, goldenType } from '../../domain/src/__fixtures__/golden-input.ts';
import { buildTwinIndex, indicesOf } from './twinIndex.ts';
import { BIN_SCALE, buildSceneData, boundsOf, rackToWorld } from './model.ts';
import { CompactSlots, EMPTY, HIDDEN, OPAQUE, type SlotMesh } from './slots.ts';
import { pick, rayAabb } from './pick.ts';
import { initialLod, nextLod } from './lod.ts';
import { binStyle, fillColor, COLORS } from './colors.ts';
import { createOccupancySync } from './occupancySync.ts';
import {
  BENCH_PATTERN,
  benchLayout,
  benchTwinModel,
  demoOccupancy,
  demoTwinModel,
  twinModelFrom,
  syntheticOccupancy,
} from './fixtures.ts';
import { PACKAGE_NAME } from './index.ts';

const WID = '00000000-0000-4000-8000-000000000001';

function single(rotationDeg: RotationDeg): LayoutDoc {
  return {
    schemaVersion: 2,
    warehouse: { widthM: 60, depthM: 40, heightM: 8 },
    zones: [
      {
        code: 'A',
        kind: 'STORAGE',
        polygon: [
          [0, 0],
          [60, 0],
          [60, 40],
          [0, 40],
        ],
      },
    ],
    rackTypes: [goldenType],
    racks: [
      {
        key: 'r',
        zone: 'A',
        type: goldenType.key,
        aisle: 1,
        rackNo: 1,
        bayStart: rotationDeg === 0 || rotationDeg === 90 ? 1 : 2,
        x: 10,
        z: 10,
        rotationDeg,
      },
    ],
    floorAreas: [],
  };
}
const modelOf = (layout: LayoutDoc) =>
  twinModelFrom(layout, { warehouseId: WID, warehouseCode: 'WH1', layoutVersion: 3 });

describe('包', () => {
  it('导出包名', () => expect(PACKAGE_NAME).toBe('@wms3d/twin3d'));
});

describe('黄金样例坐标一致（02 §2）', () => {
  for (const g of golden.rotations) {
    it(`rotation ${g.rotationDeg}°：bay1 level A pos1 中心与四角`, () => {
      const m = modelOf(single(g.rotationDeg as RotationDeg));
      const d = buildSceneData(m);
      const k = m.locations.code.findIndex(
        (_c, i) =>
          m.locations.rackBayIndex[i] === 0 &&
          m.locations.level[i] === 1 &&
          m.locations.pos[i] === 1,
      );
      expect(k).toBeGreaterThanOrEqual(0);
      // 实例平移 = cellWorld 中心
      const mat = d.matrices.subarray(16 * k, 16 * k + 16);
      expect([mat[12], mat[13], mat[14]].map((v) => +v!.toFixed(4))).toEqual(
        g.bay1LevelAPos1.center.map((v) => +v.toFixed(4)),
      );
      // 把单位盒四个底角按实例矩阵变换、去掉留缝缩放，应与黄金四角一致（顺序：前左、前右、后右、后左）
      const corners = [
        [-0.5, 0.5],
        [0.5, 0.5],
        [0.5, -0.5],
        [-0.5, -0.5],
      ].map(([ux, uz]) => {
        const x = (mat[0]! * ux!) / BIN_SCALE.w + (mat[8]! * uz!) / BIN_SCALE.d + mat[12]!;
        const z = (mat[2]! * ux!) / BIN_SCALE.w + (mat[10]! * uz!) / BIN_SCALE.d + mat[14]!;
        return [+x.toFixed(4), +z.toFixed(4)];
      });
      expect(corners).toEqual(g.bay1LevelAPos1.corners.map((c) => c.map((v) => +v.toFixed(4))));
      // 货架占地
      const r = d.racks[0]!;
      const fp = [
        rackToWorld(r, 0, 0),
        rackToWorld(r, r.lengthM, 0),
        rackToWorld(r, r.lengthM, -goldenType.depthM),
        rackToWorld(r, 0, -goldenType.depthM),
      ];
      expect(fp.map((p) => p.map((v) => +v.toFixed(4)))).toEqual(
        g.footprint.map((p) => p.map((v) => +v.toFixed(4))),
      );
    });
  }

  it('巷道 bay 中心与编码（golden aisles）', () => {
    const m = modelOf(goldenLayout);
    const d = buildSceneData(m);
    for (const b of golden.aisles.bays) {
      const k = m.locations.code.indexOf(b.code);
      expect(k, b.code).toBeGreaterThanOrEqual(0);
      const k2 = m.locations.code.findIndex(
        (_c, i) =>
          m.locations.rackKey[i] === b.rackKey &&
          m.locations.rackBayIndex[i] === m.locations.rackBayIndex[k] &&
          m.locations.level[i] === 1 &&
          m.locations.pos[i] === 2,
      );
      const cx = (d.centers[3 * k]! + d.centers[3 * k2]!) / 2;
      const cz = (d.centers[3 * k + 2]! + d.centers[3 * k2 + 2]!) / 2;
      expect([+cx.toFixed(4), +cz.toFixed(4)]).toEqual(b.bayCenterXZ.map((v) => +v.toFixed(4)));
    }
  });

  it('演示仓：每个仓位都有几何，中心 = cellWorld', () => {
    const m = demoTwinModel();
    const d = buildSceneData(m);
    expect(d.n).toBe(386);
    expect([...d.locChunk].every((c) => c >= 0)).toBe(true);
    const lay = m.layout;
    for (let k = 0; k < d.n; k += 17) {
      const rk = m.locations.rackKey[k];
      if (!rk) continue;
      const r = lay.racks.find((x) => x.key === rk)!;
      const c = cellWorld(
        r,
        lay.rackTypes[0]!,
        m.locations.rackBayIndex[k]!,
        m.locations.level[k]!,
        m.locations.pos[k]!,
      ).center;
      expect(
        [d.centers[3 * k], d.centers[3 * k + 1], d.centers[3 * k + 2]].map((v) => +v!.toFixed(4)),
      ).toEqual(c.map((v) => +v.toFixed(4)));
    }
    // 分块：A 区 3 条巷道 + B 区 1 条 + 地面
    expect(d.chunks.map((c) => c.key).sort()).toEqual(['A|1', 'A|2', 'A|3', 'B|1', 'floor']);
    expect(d.chunks.reduce((s, c) => s + c.locs.length, 0)).toBe(386);
  });
});

describe('twinIndex', () => {
  it('idToIndex / indexToId 互逆，忽略未知 id', () => {
    const m = demoTwinModel();
    const ix = buildTwinIndex(m);
    expect(ix.indexToId.length).toBe(m.locations.id.length);
    m.locations.id.forEach((id, i) => expect(ix.idToIndex.get(id)).toBe(i));
    expect(indicesOf(ix, [m.locations.id[5]!, 'nope', m.locations.id[0]!])).toEqual([5, 0]);
    expect(ix.layoutVersion).toBe(m.layoutVersion);
  });
});

describe('紧凑槽位（空/有货切换不重建）', () => {
  it('随机序列后两表互逆、计数守恒、无重复无遗漏', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.array(fc.tuple(fc.nat(), fc.constantFrom<SlotMesh>(OPAQUE, EMPTY, HIDDEN)), {
          maxLength: 300,
        }),
        (n, ops) => {
          const s = new CompactSlots(n);
          for (let l = 0; l < n; l++) s.assign(l, l % 2 ? EMPTY : OPAQUE);
          s.check();
          for (const [x, m] of ops) {
            s.assign(x % n, m);
            s.check();
          }
          const vis = [...s.meshOf].filter((m) => m !== HIDDEN).length;
          expect(s.count[0] + s.count[1]).toBe(vis);
        },
      ),
    );
  });

  it('空↔有货切换只写受影响槽位（swap-remove）', () => {
    const s = new CompactSlots(5);
    for (let l = 0; l < 5; l++) s.assign(l, EMPTY);
    s.takeDirty(1);
    const writes: string[] = [];
    s.assign(1, OPAQUE, (w) => writes.push(`${w.mesh}:${w.slot}:${w.local}`));
    // 空 mesh：末尾 4 搬到槽 1；不透明 mesh：追加到槽 0
    expect(writes).toEqual(['1:1:4', '0:0:1']);
    expect(s.count).toEqual([1, 4]);
    expect(s.takeDirty(1)).toEqual([1, 1]);
    expect(s.takeDirty(0)).toEqual([0, 0]);
    expect(s.assign(1, OPAQUE)).toBe(false);
    s.check();
  });
});

describe('着色', () => {
  const m = demoTwinModel();
  const occ = demoOccupancy(m);
  it('空 → 透明 mesh；有货 → 不透明按 fill；停用 → 暗红不透明', () => {
    const empty = occ.qty.findIndex((q) => q === 0);
    const used = occ.qty.findIndex((q) => q > 0);
    expect(binStyle('occupancy', occ, empty, null).mesh).toBe(EMPTY);
    expect(binStyle('occupancy', occ, used, null)).toEqual({
      mesh: OPAQUE,
      color: fillColor(occ.fill[used]!),
    });
    const off: Occupancy = { ...occ, isActive: occ.isActive.map((v, i) => (i === empty ? 0 : v)) };
    expect(binStyle('occupancy', off, empty, null)).toEqual({
      mesh: OPAQUE,
      color: COLORS.inactive,
    });
    expect(binStyle('occupancy', null, used, null).mesh).toBe(OPAQUE);
    expect(
      binStyle('skuCount', { ...occ, skuCount: occ.skuCount.map(() => 2) }, used, null).color,
    ).toEqual(COLORS.sku2);
  });
  it('fill 0 / 0.5 / 1 → 绿 / 黄 / 橙', () => {
    expect(fillColor(0)).toEqual(COLORS.fillLow);
    fillColor(0.5).forEach((v, i) => expect(v).toBeCloseTo(COLORS.fillMid[i]!, 6));
    expect(fillColor(1)).toEqual(COLORS.fillHigh);
    expect(fillColor(7)).toEqual(COLORS.fillHigh);
  });
});

describe('解析式拾取', () => {
  for (const rot of [0, 90, 180, 270] as const) {
    it(`rotation ${rot}°：从取货面外侧射向每个仓位中心，命中该仓位`, () => {
      const m = modelOf(single(rot));
      const d = buildSceneData(m);
      const r = d.racks[0]!;
      for (let k = 0; k < d.n; k++) {
        const c = [d.centers[3 * k]!, d.centers[3 * k + 1]!, d.centers[3 * k + 2]!] as const;
        // 取货面外侧 3m（局部 +z 方向 = (−sin, cos)），略高 0.2m
        const o = [c[0] - r.sin * 3, c[1] + 0.2, c[2] + r.cos * 3] as const;
        const dir = [c[0] - o[0], c[1] - o[1], c[2] - o[2]] as const;
        const len = Math.hypot(...dir);
        const res = pick(d, o, [dir[0] / len, dir[1] / len, dir[2] / len]);
        expect(res, m.locations.code[k]).toMatchObject({ kind: 'location', twinIndex: k });
      }
    });
  }

  it('俯视点击命中最高可见层；层过滤后命中过滤层', () => {
    const m = modelOf(single(0));
    const d = buildSceneData(m);
    const k = m.locations.code.findIndex(
      (_c, i) =>
        m.locations.rackBayIndex[i] === 2 && m.locations.level[i] === 3 && m.locations.pos[i] === 2,
    );
    const c = [d.centers[3 * k]!, 20, d.centers[3 * k + 2]!] as const;
    expect(pick(d, c, [0, -1, 0])).toMatchObject({ kind: 'location', twinIndex: k });
    const r = pick(d, c, [0, -1, 0], { maxLevel: 1 });
    expect(r?.kind).toBe('location');
    expect(m.locations.level[(r as { twinIndex: number }).twinIndex]).toBe(1);
  });

  it('远景块只返回货架；未命中返回 null；地面仓位按多边形', () => {
    const m = demoTwinModel();
    const d = buildSceneData(m);
    const k = 0;
    const c = [d.centers[3 * k]!, 30, d.centers[3 * k + 2]!] as const;
    expect(pick(d, c, [0, -1, 0], { isFar: () => true })).toMatchObject({
      kind: 'rack',
      rack: d.locRack[k],
    });
    expect(pick(d, [30, 30, -50], [0, 1, 0])).toBeNull();
    const rcv = m.locations.code.indexOf('RCV-01');
    expect(pick(d, [56, 10, 5], [0, -1, 0])).toMatchObject({ kind: 'location', twinIndex: rcv });
  });

  it('rayAabb', () => {
    expect(rayAabb([0, 0, -5], [0, 0, 1], [-1, -1, -1], [1, 1, 1])).toBeCloseTo(4);
    expect(rayAabb([0, 5, -5], [0, 0, 1], [-1, -1, -1], [1, 1, 1])).toBeNull();
    expect(rayAabb([0, 0, 0], [1, 0, 0], [-1, -1, -1], [1, 1, 1])).toBe(0);
  });
});

describe('LOD 滞回', () => {
  it('近 18/22，远 45/40', () => {
    expect(initialLod(10)).toBe('near');
    expect(initialLod(30)).toBe('mid');
    expect(initialLod(60)).toBe('far');
    expect(nextLod('mid', 19)).toBe('mid');
    expect(nextLod('mid', 17.9)).toBe('near');
    expect(nextLod('near', 21)).toBe('near');
    expect(nextLod('near', 22.1)).toBe('mid');
    expect(nextLod('mid', 44)).toBe('mid');
    expect(nextLod('mid', 45.1)).toBe('far');
    expect(nextLod('far', 41)).toBe('far');
    expect(nextLod('far', 39)).toBe('mid');
    expect(nextLod('far', 5)).toBe('near');
  });
});

describe('基准布局', () => {
  it('5k / 20k 档：仓位数、块数、布局校验无 ERROR', () => {
    for (const [aisles, n] of [
      [10, 5200],
      [40, 20800],
    ] as const) {
      const lay = benchLayout(aisles);
      expect(
        validateLayout(lay, { pattern: BENCH_PATTERN }).filter((i) => i.severity === 'ERROR'),
      ).toEqual([]);
      const m = benchTwinModel(aisles);
      expect(m.locations.id.length).toBe(n);
      expect(new Set(m.locations.id).size).toBe(n);
      const d = buildSceneData(m);
      expect(d.chunks.length).toBe(aisles);
      const occ = syntheticOccupancy(m);
      expect(occ.qty.length).toBe(n);
    }
  });
  it('boundsOf', () => {
    const d = buildSceneData(demoTwinModel());
    expect(boundsOf(d, [])).toBeNull();
    const b = boundsOf(d, [0, 1])!;
    expect(b.min[0]).toBeLessThan(b.max[0]);
  });
});

describe('occupancySync（06 §6）', () => {
  afterEach(() => vi.useRealTimers());
  const occ = (v: number) => ({ layoutVersion: v }) as Occupancy;
  const ev = (event: 'stock.changed' | 'layout.published', v: number) =>
    (event === 'stock.changed'
      ? { event, data: { layoutVersion: v, locationIds: [], txnId: WID } }
      : { event, data: { layoutVersion: v } }) as WmsEvent;

  it('防抖 500ms 合并、最小间隔、版本不一致重载', async () => {
    vi.useFakeTimers();
    let t = 0;
    const fetchOccupancy = vi.fn(async (v: number) => occ(v));
    const onOccupancy = vi.fn();
    const reloadTwin = vi.fn();
    const s = createOccupancySync({
      getLayoutVersion: () => 7,
      fetchOccupancy,
      onOccupancy,
      reloadTwin,
      platform: 'mobile',
      now: () => t,
      isVisible: () => true,
    });
    for (let i = 0; i < 5; i++) s.handleEvent(ev('stock.changed', 7));
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchOccupancy).not.toHaveBeenCalled();
    t = 500;
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchOccupancy).toHaveBeenCalledTimes(1);
    expect(onOccupancy).toHaveBeenCalledTimes(1);
    // 移动端最小间隔 2s
    s.handleEvent(ev('stock.changed', 7));
    t = 1100;
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchOccupancy).toHaveBeenCalledTimes(1);
    t = 2600;
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchOccupancy).toHaveBeenCalledTimes(2);
    s.handleEvent(ev('stock.changed', 8));
    expect(reloadTwin).toHaveBeenCalledWith('version-mismatch');
    s.handleEvent(ev('layout.published', 9));
    expect(reloadTwin).toHaveBeenCalledWith('layout.published');
    s.dispose();
  });

  it('LAYOUT_STALE → reloadTwin；不可见时积压，可见后补拉', async () => {
    vi.useFakeTimers();
    let visible = false;
    const fetchOccupancy = vi.fn(async () => {
      throw Object.assign(new Error('stale'), { code: 'LAYOUT_STALE' });
    });
    const reloadTwin = vi.fn();
    const s = createOccupancySync({
      getLayoutVersion: () => 1,
      fetchOccupancy,
      onOccupancy: () => {},
      reloadTwin,
      isVisible: () => visible,
    });
    s.onConnected();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchOccupancy).not.toHaveBeenCalled();
    visible = true;
    s.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchOccupancy).toHaveBeenCalledTimes(1);
    expect(reloadTwin).toHaveBeenCalledWith('LAYOUT_STALE');
    s.dispose();
  });

  it('断线后 60s 轮询，重连停止轮询', async () => {
    vi.useFakeTimers();
    let t = 0;
    const fetchOccupancy = vi.fn(async (v: number) => occ(v));
    const s = createOccupancySync({
      getLayoutVersion: () => 1,
      fetchOccupancy,
      onOccupancy: () => {},
      reloadTwin: () => {},
      now: () => t,
      isVisible: () => true,
    });
    s.onDisconnected();
    t = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchOccupancy).toHaveBeenCalledTimes(1);
    s.onConnected();
    t = 60_001;
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchOccupancy).toHaveBeenCalledTimes(1); // 最小间隔内，排到 gate
    t = 61_100;
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchOccupancy).toHaveBeenCalledTimes(2);
    t = 200_000;
    await vi.advanceTimersByTimeAsync(130_000);
    expect(fetchOccupancy).toHaveBeenCalledTimes(2);
    s.dispose();
  });
});
