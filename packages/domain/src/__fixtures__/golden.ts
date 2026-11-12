import { compilePattern, rackCode, toPayload } from '../core/coding.ts';
import { cellWorld, deriveSide, rackFootprint, type Vec2 } from '../core/geometry.ts';
import { expandLayout } from '../layout/expand.ts';
import { goldenLayout, goldenPatterns, goldenType } from './golden-input.ts';

/** 由当前实现计算黄金样例；gen-golden 写入 JSON，测试比对 JSON 与此结果。 */
export function computeGolden() {
  const rotations = ([0, 90, 180, 270] as const).map((rotationDeg) => {
    const rack = { x: 10, z: 10, rotationDeg };
    const c = cellWorld(rack, goldenType, 0, 1, 1);
    return {
      rotationDeg,
      side: deriveSide(rotationDeg),
      bay1LevelAPos1: { center: c.center, corners: c.corners },
      footprint: rackFootprint(rack, goldenType),
    };
  });
  const { locations, racks } = expandLayout(
    goldenLayout,
    '{Zone}{Aisle:2}-{Bay:2}-{Level:A}{Pos:2}',
  );
  const rackByKey = new Map(goldenLayout.racks.map((r) => [r.key, r]));
  const bays = locations
    .filter((l) => l.level === 1 && l.position === 1)
    .map((l) => {
      const r = rackByKey.get(l.rackKey!)!;
      const bc = cellWorld(r, goldenType, l.rackBayIndex!, 1, 1);
      const bc2 = cellWorld(r, goldenType, l.rackBayIndex!, 1, 2);
      const center: Vec2 = [
        Number(((bc.center[0] + bc2.center[0]) / 2).toFixed(6)),
        Number(((bc.center[2] + bc2.center[2]) / 2).toFixed(6)),
      ];
      return {
        rackKey: l.rackKey,
        side: deriveSide(r.rotationDeg),
        aisle: `${r.zone}${String(r.aisle).padStart(2, '0')}`,
        bay: l.bay,
        code: l.code,
        bayCenterXZ: center,
      };
    });
  const codes = goldenPatterns.map((g) => ({
    pattern: g.pattern,
    parts: g.parts,
    code: compilePattern(g.pattern).format(g.parts),
  }));
  return {
    description:
      'wms3d 坐标/编码黄金样例（02 §2/§3）。contract-v1 冻结；由 scripts/gen-golden.ts 生成，2D 设计器/3D/标签测试共用。',
    rackType: goldenType,
    rotations,
    aisles: { racks: racks.map((r) => ({ key: r.key, code: r.code, side: r.side })), bays },
    codes,
    rackCodes: [{ zone: 'A', aisle: 3, side: 'L', rackNo: 2, code: rackCode('A', 3, 'L', 2) }],
    payloads: [
      {
        warehouseCode: 'WH1',
        code: 'A03-17-C02',
        prefix: true,
        payload: toPayload('WH1', 'A03-17-C02', true),
      },
      {
        warehouseCode: 'WH1',
        code: 'A03-17-C02',
        prefix: false,
        payload: toPayload('WH1', 'A03-17-C02', false),
      },
    ],
  };
}
