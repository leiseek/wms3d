import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { LayoutDoc, LayoutRack, RackTypeSpec, RotationDeg } from '@wms3d/contracts';
import golden from '../__fixtures__/geometry-golden.json' with { type: 'json' };
import { goldenLayout, goldenType } from '../__fixtures__/golden-input.ts';
import {
  arrayCopyRacks,
  cellWorld,
  compilePattern,
  convexOverlap,
  DEFAULT_PATTERN,
  expandLayout,
  overlappingPairs,
  pointInPolygon,
  polygonContains,
  rackFootprint,
  rackLengthM,
  renumberAisle,
  suggestPlacement,
  travelSpan,
  validateLayout,
  type Vec2,
} from '../index.ts';

const sq = (x: number, z: number, w: number, d = w): Vec2[] => [
  [x, z],
  [x + w, z],
  [x + w, z + d],
  [x, z + d],
];
const codesOf = (doc: LayoutDoc, opts: Partial<Parameters<typeof validateLayout>[1]> = {}) =>
  validateLayout(doc, { pattern: DEFAULT_PATTERN, ...opts }).map((i) => i.code);

const big = (racks: LayoutRack[], types: RackTypeSpec[] = [goldenType]): LayoutDoc => ({
  schemaVersion: 2,
  warehouse: { widthM: 100, depthM: 100, heightM: 10 },
  zones: [{ code: 'A', kind: 'STORAGE', polygon: sq(0, 0, 100) as [number, number][] }],
  rackTypes: types,
  racks,
  floorAreas: [],
});
const rack = (p: Partial<LayoutRack> & Pick<LayoutRack, 'key' | 'x' | 'z'>): LayoutRack => ({
  zone: 'A',
  type: goldenType.key,
  aisle: 1,
  rackNo: 1,
  bayStart: 1,
  rotationDeg: 0,
  ...p,
});

describe('geom2d：分离轴 / 多边形包含', () => {
  it('相交、贴边、贴角、分离', () => {
    expect(convexOverlap(sq(0, 0, 2), sq(1, 1, 2))).toBe(true);
    expect(convexOverlap(sq(0, 0, 2), sq(2, 0, 2))).toBe(false); // 共边
    expect(convexOverlap(sq(0, 0, 2), sq(2, 2, 2))).toBe(false); // 共角
    expect(convexOverlap(sq(0, 0, 2), sq(5, 5, 1))).toBe(false);
    expect(convexOverlap(sq(0, 0, 4), sq(1, 1, 1))).toBe(true); // 包含
  });
  it('AABB 相交但 OBB 分离（菱形对正方形角）', () => {
    const diamond: Vec2[] = [
      [3, 1.5],
      [4.5, 3],
      [3, 4.5],
      [1.5, 3],
    ];
    expect(convexOverlap(sq(0, 0, 2), diamond)).toBe(false);
    expect(convexOverlap(sq(0, 0, 2.6), diamond)).toBe(true);
  });
  it('点在多边形内（边界算内）', () => {
    expect(pointInPolygon([1, 1], sq(0, 0, 2))).toBe(true);
    expect(pointInPolygon([2, 1], sq(0, 0, 2))).toBe(true);
    expect(pointInPolygon([2.0001, 1], sq(0, 0, 2))).toBe(false);
  });
  it('凹多边形（L 形）：跨缺口不算包含，贴边算包含', () => {
    const L: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    expect(polygonContains(L, sq(0, 0, 10, 4))).toBe(true);
    expect(polygonContains(L, sq(0, 0, 4, 10))).toBe(true);
    expect(polygonContains(L, sq(2, 2, 6, 6))).toBe(false); // 角伸进缺口
    expect(polygonContains(L, sq(3, 3, 2, 2))).toBe(false);
  });
  it('overlappingPairs 与暴力结果一致', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            x: fc.integer({ min: 0, max: 40 }),
            z: fc.integer({ min: 0, max: 40 }),
            w: fc.integer({ min: 1, max: 8 }),
            d: fc.integer({ min: 1, max: 8 }),
          }),
          { maxLength: 30 },
        ),
        (bs) => {
          const qs = bs.map((b) => sq(b.x, b.z, b.w, b.d) as never);
          const brute: Array<[number, number]> = [];
          for (let i = 0; i < qs.length; i++)
            for (let j = i + 1; j < qs.length; j++)
              if (convexOverlap(qs[i]!, qs[j]!)) brute.push([i, j]);
          expect(overlappingPairs(qs)).toEqual(brute);
        },
      ),
    );
  });
});

describe('validateLayout：RACK_OVERLAP / RACK_OUTSIDE_ZONE', () => {
  const Lm = rackLengthM(goldenType);
  it('首尾相接（相切）不报，交叠 1cm 报', () => {
    const a = rack({ key: 'a', x: 10, z: 10 });
    expect(
      codesOf(big([a, rack({ key: 'b', x: 10 + Lm, z: 10, rackNo: 2, bayStart: 9 })])),
    ).toEqual([]);
    const issues = validateLayout(
      big([a, rack({ key: 'b', x: 10 + Lm - 0.01, z: 10, rackNo: 2, bayStart: 9 })]),
      { pattern: DEFAULT_PATTERN },
    );
    expect(issues.map((i) => i.code)).toEqual(['RACK_OVERLAP']);
    expect(issues[0]!.rackKeys).toEqual(['a', 'b']);
  });
  it('背靠背（各属不同巷道）贴合不报', () => {
    // a: rot0 取货面 z=10，向北延伸到 z=9；b: rot180 取货面 z=8，向南延伸到 z=9
    const a = rack({ key: 'a', x: 10, z: 10, aisle: 2 });
    const b = rack({ key: 'b', x: 10 + Lm, z: 8, rotationDeg: 180, bayStart: 2, aisle: 1 });
    expect(codesOf(big([a, b]))).toEqual([]);
  });
  it('90° 货架与 0° 货架交叉报重叠', () => {
    const a = rack({ key: 'a', x: 10, z: 10 });
    const b = rack({ key: 'b', x: 14, z: 5, rotationDeg: 90, aisle: 2 });
    expect(codesOf(big([a, b]))).toContain('RACK_OVERLAP');
  });
  it('货架越出库区报 RACK_OUTSIDE_ZONE，贴库区边不报', () => {
    const doc = big([rack({ key: 'a', x: 0, z: 1 })]);
    doc.zones = [{ code: 'A', kind: 'STORAGE', polygon: sq(0, 0, 20, 20) as [number, number][] }];
    expect(codesOf(doc)).toEqual([]); // x=0、z∈[0,1] 贴左上边
    doc.racks = [rack({ key: 'a', x: 10, z: 1 })]; // x 到 21.2 > 20
    expect(codesOf(doc)).toEqual(['RACK_OUTSIDE_ZONE']);
  });
  it('黄金样例 0/90/180/270°：单货架占地与仓位角点与 golden 一致', () => {
    for (const r of golden.rotations) {
      const rk = rack({
        key: `g${r.rotationDeg}`,
        x: 10,
        z: 10,
        rotationDeg: r.rotationDeg as RotationDeg,
        bayStart: r.side === 'L' ? 1 : 2,
      });
      expect(rackFootprint(rk, goldenType)).toEqual(r.footprint);
      expect(cellWorld(rk, goldenType, 0, 1, 1)).toEqual(r.bay1LevelAPos1);
    }
  });
  it('黄金布局、阵列复制后仍无 ERROR（0/90/180/270 混合）', () => {
    expect(codesOf(goldenLayout)).toEqual([]);
  });
});

describe('validateLayout：bay 区间与编码长度', () => {
  it('bay 超出 2 位 → CODE_TOO_LONG（指名货架），其余货架照常校验', () => {
    const issues = validateLayout(
      big([
        rack({ key: 'a', x: 10, z: 10, bayStart: 95 }),
        rack({ key: 'b', x: 10, z: 30, aisle: 2 }),
      ]),
      { pattern: DEFAULT_PATTERN },
    );
    expect(issues.map((i) => [i.code, i.rackKeys])).toEqual([['CODE_TOO_LONG', ['a']]]);
    // 3 位 bay 模式下合法
    expect(
      codesOf(big([rack({ key: 'a', x: 10, z: 10, bayStart: 95 })]), {
        pattern: '{Zone}{Aisle:2}-{Bay:3}-{Level:A}{Pos:2}',
      }),
    ).toEqual([]);
  });
  it('同侧 bay 区间重叠与奇偶错误', () => {
    const Lm = rackLengthM(goldenType);
    expect(
      codesOf(
        big([rack({ key: 'a', x: 10, z: 10 }), rack({ key: 'b', x: 10 + Lm, z: 10, bayStart: 7 })]),
      ),
    ).toContain('BAY_RANGE_OVERLAP');
    expect(codesOf(big([rack({ key: 'a', x: 10, z: 10, bayStart: 2 })]))).toEqual(['BAY_PARITY']);
  });
  it('编码长度超过标签容量', () => {
    expect(codesOf(big([rack({ key: 'a', x: 10, z: 10 })]), { maxCodeLength: 8 })).toEqual([
      'CODE_TOO_LONG',
    ]);
  });
  it('无效编码模式 → OTHER 而不是抛异常', () => {
    expect(codesOf(big([rack({ key: 'a', x: 10, z: 10 })]), { pattern: '{Zone}' })).toEqual([
      'OTHER',
    ]);
  });
});

describe('arrange：阵列复制 / 重新编号 / 放置建议（以黄金布局为准）', () => {
  const byKey = (k: string) => goldenLayout.racks.find((r) => r.key === k)!;
  const pick = (r: LayoutRack) => ({
    x: r.x,
    z: r.z,
    rackNo: r.rackNo,
    bayStart: r.bayStart,
    rotationDeg: r.rotationDeg,
    aisle: r.aisle,
  });
  for (const [src, dst] of [
    ['hL1', 'hL2'],
    ['hR1', 'hR2'],
    ['vL1', 'vL2'],
    ['vR1', 'vR2'],
  ] as const)
    it(`${src} 阵列复制 1 个 = ${dst}（沿行进方向，bayStart + 2·bays）`, () => {
      const doc = { ...goldenLayout, racks: goldenLayout.racks.filter((r) => r.key !== dst) };
      const [c] = arrayCopyRacks(doc, src, { count: 1 });
      expect(pick(c!)).toEqual(pick(byKey(dst)));
    });
  it('复制 N 个：key 唯一、bay 连续、无重叠', () => {
    const doc = big([rack({ key: 'a', x: 1, z: 10 })]);
    const copies = arrayCopyRacks(doc, 'a', { count: 5, gapM: 0.2 });
    const all = { ...doc, racks: [...doc.racks, ...copies] };
    expect(new Set(all.racks.map((r) => r.key)).size).toBe(6);
    expect(copies.map((r) => r.bayStart)).toEqual([9, 17, 25, 33, 41]);
    expect(codesOf(all)).toEqual([]);
  });
  it('renumberAisle 把打乱的编号恢复为黄金值', () => {
    const scrambled: LayoutDoc = {
      ...goldenLayout,
      racks: goldenLayout.racks.map((r) => ({ ...r, rackNo: 7, bayStart: r.bayStart + 40 })),
    };
    const fixed = renumberAisle(renumberAisle(scrambled, 'A', 3), 'B', 4);
    expect(fixed.racks).toEqual(goldenLayout.racks);
  });
  it('suggestPlacement：同侧共线 → 同巷道下一个 bayStart；对侧 → 同巷道起始号', () => {
    const doc = {
      ...goldenLayout,
      racks: goldenLayout.racks.filter((r) => !['hL2', 'hR1', 'hR2'].includes(r.key)),
    };
    expect(suggestPlacement(doc, { ...byKey('hL2'), key: undefined })).toEqual({
      zone: 'A',
      aisle: 3,
      side: 'L',
      rackNo: 2,
      bayStart: 9,
    });
    expect(suggestPlacement(doc, { x: 20, z: 8, rotationDeg: 180, type: 'g-4x3' })).toEqual({
      zone: 'A',
      aisle: 3,
      side: 'R',
      rackNo: 1,
      bayStart: 2,
    });
    expect(suggestPlacement(doc, { x: 2, z: 30, rotationDeg: 0, type: 'g-4x3' }).aisle).toBe(4);
  });
  it('travelSpan 四个方向', () => {
    expect(travelSpan({ x: 10, z: 5, rotationDeg: 0 }, goldenType)).toEqual([10, 21.2]);
    expect(travelSpan({ x: 10, z: 5, rotationDeg: 180 }, goldenType)).toEqual([-1.2, 10]);
    expect(travelSpan({ x: 10, z: 5, rotationDeg: 90 }, goldenType)).toEqual([5, 16.2]);
    expect(travelSpan({ x: 10, z: 5, rotationDeg: 270 }, goldenType)).toEqual([-6.2, 5]);
  });
});

/** 随机布局：若干平行巷道，每侧一个源货架 + 阵列复制；可整体为水平或竖直巷道。 */
const arbLayout = fc
  .record({
    vertical: fc.boolean(),
    type: fc.record({
      bays: fc.integer({ min: 1, max: 5 }),
      levels: fc.integer({ min: 1, max: 5 }),
      positionsPerLevel: fc.integer({ min: 1, max: 3 }),
      bayWidthM: fc.integer({ min: 8, max: 30 }).map((v) => v / 10),
      depthM: fc.integer({ min: 5, max: 12 }).map((v) => v / 10),
    }),
    aisles: fc.array(
      fc.record({
        width: fc.integer({ min: 15, max: 40 }).map((v) => v / 10),
        nL: fc.integer({ min: 0, max: 4 }),
        nR: fc.integer({ min: 0, max: 4 }),
        offL: fc.integer({ min: 0, max: 30 }).map((v) => v / 10),
        offR: fc.integer({ min: 0, max: 30 }).map((v) => v / 10),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  })
  .map(({ vertical, type, aisles }) => {
    const t: RackTypeSpec = {
      key: 'rnd',
      ...type,
      levelHeightsM: Array.from({ length: type.levels }, () => 1.2),
      beamM: 0.1,
      uprightM: 0.08,
      defaultMaxQty: null,
    };
    const D = t.depthM;
    let doc: LayoutDoc = { ...big([], [t]), warehouse: { widthM: 400, depthM: 400, heightM: 10 } };
    doc.zones = [{ code: 'A', kind: 'STORAGE', polygon: sq(0, 0, 400) as [number, number][] }];
    let cursor = 1;
    aisles.forEach((a, idx) => {
      const aisle = idx + 1;
      // 水平：L 取货面 z = cursor + D（rot0 向北延伸），R 取货面 z = faceL + width（rot180 向南）
      // 竖直：R 取货面 x = cursor + D（rot270 向西延伸），L 取货面 x = faceR + width（rot90 向东）
      const first = cursor + D;
      const second = first + a.width;
      const sides = vertical
        ? ([
            ['R', 270, first, a.nR, a.offR],
            ['L', 90, second, a.nL, a.offL],
          ] as const)
        : ([
            ['L', 0, first, a.nL, a.offL],
            ['R', 180, second, a.nR, a.offR],
          ] as const);
      for (const [side, rot, face, n, off] of sides) {
        if (n === 0) continue;
        const start = 1 + off + (rot === 180 || rot === 270 ? rackLengthM(t) : 0);
        const src: LayoutRack = {
          key: `a${aisle}${side}1`,
          zone: 'A',
          type: 'rnd',
          aisle,
          rackNo: 1,
          bayStart: side === 'L' ? 1 : 2,
          rotationDeg: rot,
          x: vertical ? face : start,
          z: vertical ? start : face,
        };
        doc = { ...doc, racks: [...doc.racks, src] };
        if (n > 1)
          doc = {
            ...doc,
            racks: [...doc.racks, ...arrayCopyRacks(doc, src.key, { count: n - 1 })],
          };
      }
      cursor = second + D + 0.5;
    });
    return doc;
  });

describe('fast-check：随机布局', () => {
  it('展开后编码唯一、校验无 ERROR、解析往返', () => {
    fc.assert(
      fc.property(arbLayout, (doc) => {
        const errs = validateLayout(doc, { pattern: DEFAULT_PATTERN }).filter(
          (i) => i.severity === 'ERROR',
        );
        expect(errs).toEqual([]);
        const { locations } = expandLayout(doc, DEFAULT_PATTERN);
        const codes = locations.map((l) => l.code);
        expect(new Set(codes).size).toBe(codes.length);
        const pat = compilePattern(DEFAULT_PATTERN);
        for (const l of locations)
          expect(pat.parse(l.code)).toMatchObject({
            bay: l.bay,
            level: l.level,
            position: l.position,
          });
      }),
      { numRuns: 150 },
    );
  });
  it('expand ∘ 坐标 与 cellWorld 一致；bay 沿行进方向单调递增', () => {
    fc.assert(
      fc.property(arbLayout, (doc) => {
        const t = doc.rackTypes[0]!;
        const racks = new Map(doc.racks.map((r) => [r.key, r]));
        const { locations } = expandLayout(doc, DEFAULT_PATTERN);
        for (const l of locations) {
          const r = racks.get(l.rackKey!)!;
          expect(l.center).toEqual(cellWorld(r, t, l.rackBayIndex!, l.level!, l.position!).center);
        }
        const groups = new Map<string, Array<{ bay: number; s: number }>>();
        for (const l of locations) {
          if (l.level !== 1 || l.position !== 1) continue;
          const r = racks.get(l.rackKey!)!;
          const g = `${r.aisle}|${r.rotationDeg}`;
          const s = r.rotationDeg % 180 === 0 ? l.center[0] : l.center[2];
          groups.set(g, [...(groups.get(g) ?? []), { bay: l.bay!, s }]);
        }
        for (const arr of groups.values()) {
          const bySpace = [...arr].sort((a, b) => a.s - b.s).map((x) => x.bay);
          expect(bySpace).toEqual([...bySpace].sort((a, b) => a - b));
        }
      }),
      { numRuns: 100 },
    );
  });
});
