import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import golden from './__fixtures__/geometry-golden.json' with { type: 'json' };
import { computeGolden } from './__fixtures__/golden.ts';
import { goldenLayout } from './__fixtures__/golden-input.ts';
import {
  bayNumber,
  compilePattern,
  deriveSide,
  expandLayout,
  rackBayIndex,
  threeRotationY,
  validateLayout,
  DEFAULT_PATTERN,
  splitPayload,
} from './index.ts';

describe('黄金样例（冻结）', () => {
  it('当前实现与 geometry-golden.json 完全一致（修改 = 契约变更，需 Lead 批准后 pnpm --filter @wms3d/domain gen:golden）', () => {
    expect(JSON.parse(JSON.stringify(computeGolden()))).toEqual(golden);
  });

  it('四个旋转下 bay1/A/pos1 中心（手算值）', () => {
    const c = Object.fromEntries(
      golden.rotations.map((r) => [r.rotationDeg, r.bay1LevelAPos1.center]),
    );
    // 局部中心 (0.755, y=0.7, -0.5)，货架基点 (10, 10)
    expect(c[0]).toEqual([10.755, 0.7, 9.5]);
    expect(c[90]).toEqual([10.5, 0.7, 10.755]);
    expect(c[180]).toEqual([9.245, 0.7, 10.5]);
    expect(c[270]).toEqual([9.5, 0.7, 9.245]);
  });

  it('侧别推导：0/90 → L，180/270 → R', () => {
    expect(golden.rotations.map((r) => r.side)).toEqual(['L', 'L', 'R', 'R']);
  });

  for (const aisle of ['A03', 'B04']) {
    describe(`巷道 ${aisle}`, () => {
      const bays = golden.aisles.bays.filter((b) => b.aisle === aisle);
      const travel = (b: (typeof bays)[number]) =>
        aisle === 'A03' ? b.bayCenterXZ[0]! : b.bayCenterXZ[1]!;
      it('L 侧全奇数、R 侧全偶数', () => {
        for (const b of bays) expect(b.bay! % 2).toBe(b.side === 'L' ? 1 : 0);
      });
      it('两侧 bay 沿行进方向单调递增', () => {
        for (const side of ['L', 'R']) {
          const s = bays.filter((b) => b.side === side).sort((a, b) => travel(a) - travel(b));
          expect(s.map((b) => b.bay)).toEqual([...s.map((b) => b.bay!)].sort((x, y) => x - y));
          expect(s.length).toBe(8);
        }
      });
      it('bay 2k−1 与 bay 2k 隔巷道正对（行进坐标相同）', () => {
        for (let k = 1; k <= 8; k++) {
          const odd = bays.find((b) => b.bay === 2 * k - 1)!;
          const even = bays.find((b) => b.bay === 2 * k)!;
          expect(travel(odd)).toBeCloseTo(travel(even), 6);
        }
      });
    });
  }

  it('黄金布局通过校验（无 ERROR）', () => {
    expect(
      validateLayout(goldenLayout, { pattern: DEFAULT_PATTERN }).filter(
        (i) => i.severity === 'ERROR',
      ),
    ).toEqual([]);
  });

  it('three.js rotation.y = −deg', () => {
    expect(threeRotationY(90)).toBeCloseTo(-Math.PI / 2);
  });
});

describe('编码模式', () => {
  it('golden 编码与解析往返', () => {
    for (const c of golden.codes) {
      const p = compilePattern(c.pattern);
      expect(p.format(c.parts as never)).toBe(c.code);
      expect(p.parse(c.code)).toEqual(c.parts);
    }
  });
  it('默认模式最大长度 10（标签容量）', () => {
    expect(compilePattern(DEFAULT_PATTERN).maxLength).toBe(10);
  });
  it('非法模式与越界值', () => {
    expect(() => compilePattern('{Zone}{Bay:2}')).toThrow();
    expect(() => compilePattern('{Zone}{Aisle:2}.{Bay:2}{Level:A}{Pos:2}')).toThrow();
    expect(() =>
      compilePattern(DEFAULT_PATTERN).format({
        zone: 'A',
        aisle: 100,
        bay: 1,
        level: 1,
        position: 1,
      }),
    ).toThrow();
  });
  it('属性：任意合法部件 format → parse 往返', () => {
    const p = compilePattern(DEFAULT_PATTERN);
    fc.assert(
      fc.property(
        fc.constantFrom('A', 'B', 'Z'),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 26 }),
        fc.integer({ min: 1, max: 99 }),
        (zone, aisle, bay, level, position) => {
          const parts = { zone, aisle, bay, level, position };
          expect(p.parse(p.format(parts))).toEqual(parts);
        },
      ),
    );
  });
  it('载荷前缀拆分', () => {
    expect(splitPayload('WH1.A03-17-C02')).toEqual({ warehouseCode: 'WH1', code: 'A03-17-C02' });
    expect(splitPayload('A03-17-C02')).toBeNull();
  });
});

describe('巷道 bay 规则', () => {
  it('bayNumber / rackBayIndex 互逆（属性测试）', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'L' | 'R'>('L', 'R'),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 12 }),
        (side, k, bays) => {
          const bayStart = side === 'L' ? 2 * k + 1 : 2 * k + 2;
          for (let i = 0; i < bays; i++)
            expect(rackBayIndex(side, bayStart, bays, bayNumber(side, bayStart, bays, i))).toBe(i);
        },
      ),
    );
  });
  it('R 侧：面对取货面最左列号最大', () => {
    expect(bayNumber('R', 2, 4, 0)).toBe(8);
    expect(bayNumber('R', 2, 4, 3)).toBe(2);
    expect(deriveSide(180)).toBe('R');
  });
  it('属性：随机阵列复制生成的编码全部唯一', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 5 }),
        (perSide, bays, aisles) => {
          const t = {
            key: 't',
            bays,
            levels: 2,
            positionsPerLevel: 2,
            bayWidthM: 2,
            depthM: 1,
            levelHeightsM: [1.5, 1.5],
            beamM: 0.1,
            uprightM: 0.1,
            defaultMaxQty: null,
          };
          const len = bays * 2 + (bays + 1) * 0.1;
          const racks = [];
          for (let a = 1; a <= aisles; a++) {
            const zL = 2 + (a - 1) * 6;
            for (let n = 0; n < perSide; n++) {
              racks.push({
                key: `a${a}l${n}`,
                zone: 'A',
                type: 't',
                aisle: a,
                rackNo: n + 1,
                bayStart: 1 + 2 * bays * n,
                x: n * len,
                z: zL,
                rotationDeg: 0 as const,
              });
              racks.push({
                key: `a${a}r${n}`,
                zone: 'A',
                type: 't',
                aisle: a,
                rackNo: n + 1,
                bayStart: 2 + 2 * bays * n,
                x: (n + 1) * len,
                z: zL + 3,
                rotationDeg: 180 as const,
              });
            }
          }
          const doc = {
            schemaVersion: 2 as const,
            warehouse: { widthM: 500, depthM: 500, heightM: 10 },
            zones: [
              {
                code: 'A',
                kind: 'STORAGE' as const,
                polygon: [
                  [0, 0],
                  [500, 0],
                  [500, 500],
                  [0, 500],
                ] as [number, number][],
              },
            ],
            rackTypes: [t],
            racks,
            floorAreas: [],
          };
          const pattern =
            bays * perSide * 2 > 99 ? '{Zone}{Aisle:2}-{Bay:3}-{Level:A}{Pos:2}' : DEFAULT_PATTERN;
          const codes = expandLayout(doc, pattern).locations.map((l) => l.code);
          expect(new Set(codes).size).toBe(codes.length);
          expect(validateLayout(doc, { pattern }).filter((i) => i.severity === 'ERROR')).toEqual(
            [],
          );
        },
      ),
      { numRuns: 60 },
    );
  });
  it('校验能发现奇偶错误、区间重叠与巷道左右颠倒', () => {
    const doc = structuredClone(goldenLayout);
    doc.racks[0]!.bayStart = 2;
    doc.racks[3]!.bayStart = 2;
    doc.racks[4]!.x = 30; // vL1 取货面移到 R 侧之外
    const codes = validateLayout(doc, { pattern: DEFAULT_PATTERN }).map((i) => i.code);
    expect(codes).toContain('BAY_PARITY');
    expect(codes).toContain('BAY_RANGE_OVERLAP');
    expect(codes).toContain('AISLE_FACE_MISALIGNED');
  });
});
