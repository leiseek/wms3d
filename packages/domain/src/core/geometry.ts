import type { LayoutRack, RackTypeSpec, RotationDeg, Side } from '@wms3d/contracts';

/**
 * 坐标与方向约定（02 §2）。contract-v1 冻结，黄金样例锁定（__fixtures__/geometry-golden.json）。
 * - 米；Y 向上；俯视 +X 向右、+Z 向屏幕下方；原点 = 平面图左上角地面
 * - rotationDeg 俯视顺时针；three.js rotation.y = −rotationDeg·π/180
 * - 货架局部系：原点 = 面对取货面时货架的左-前-下角；局部 +x = 操作员右手；局部 −z = 向货架深处
 */
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

const EPS = 1e-6;
/** 统一 6 位小数并消除 −0，保证 2D/3D/标签三端比较稳定。 */
export function round6(v: number): number {
  const r = Math.round(v / EPS) * EPS;
  const s = Number(r.toFixed(6));
  return Object.is(s, -0) ? 0 : s;
}

export function deriveSide(rotationDeg: RotationDeg): Side {
  return rotationDeg === 0 || rotationDeg === 90 ? 'L' : 'R';
}

/** 巷道行进轴：水平巷道（0/180）沿 +X，竖直巷道（90/270）沿 +Z。 */
export function aisleAxis(rotationDeg: RotationDeg): 'x' | 'z' {
  return rotationDeg % 180 === 0 ? 'x' : 'z';
}

export function threeRotationY(rotationDeg: number): number {
  return (-rotationDeg * Math.PI) / 180;
}

export function rackLengthM(t: Pick<RackTypeSpec, 'bays' | 'bayWidthM' | 'uprightM'>): number {
  return t.bays * t.bayWidthM + (t.bays + 1) * t.uprightM;
}

/** 局部 (x, z) → 世界 (x, z)。 */
export function localToWorld(
  rack: Pick<LayoutRack, 'x' | 'z' | 'rotationDeg'>,
  lx: number,
  lz: number,
): Vec2 {
  const th = (rack.rotationDeg * Math.PI) / 180;
  const c = round6(Math.cos(th));
  const s = round6(Math.sin(th));
  return [round6(rack.x + lx * c - lz * s), round6(rack.z + lx * s + lz * c)];
}

/** 巷道级 bay 号（02 §3.1）：i = 面对取货面从左到右的列序号（0 起）。 */
export function bayNumber(side: Side, bayStart: number, bays: number, i: number): number {
  if (i < 0 || i >= bays) throw new RangeError(`列序号越界：${i}`);
  return side === 'L' ? bayStart + 2 * i : bayStart + 2 * (bays - 1 - i);
}

/** 由巷道级 bay 反求货架内列序号；不属于该货架返回 null。 */
export function rackBayIndex(
  side: Side,
  bayStart: number,
  bays: number,
  bay: number,
): number | null {
  const d = bay - bayStart;
  if (d < 0 || d % 2 !== 0 || d / 2 >= bays) return null;
  return side === 'L' ? d / 2 : bays - 1 - d / 2;
}

export interface CellBox {
  /** 局部 x 区间、y 区间（z 恒为 [−depth, 0]） */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** 仓位单元（局部系）：level 1 起，position 1 起。y1 = 该层顶部横梁下沿。 */
export function cellBoxLocal(t: RackTypeSpec, i: number, level: number, position: number): CellBox {
  if (level < 1 || level > t.levels) throw new RangeError(`level 越界：${level}`);
  if (position < 1 || position > t.positionsPerLevel)
    throw new RangeError(`position 越界：${position}`);
  const w = t.bayWidthM / t.positionsPerLevel;
  const x0 = t.uprightM * (i + 1) + i * t.bayWidthM + (position - 1) * w;
  let y0 = 0;
  for (let k = 0; k < level - 1; k++) y0 += t.levelHeightsM[k]!;
  const y1 = y0 + t.levelHeightsM[level - 1]! - t.beamM;
  return { x0: round6(x0), x1: round6(x0 + w), y0: round6(y0), y1: round6(y1) };
}

export interface CellWorld {
  center: Vec3;
  /** 俯视四角（世界 x,z），顺序：前左、前右、后右、后左（面对取货面） */
  corners: readonly [Vec2, Vec2, Vec2, Vec2];
}

export function cellWorld(
  rack: Pick<LayoutRack, 'x' | 'z' | 'rotationDeg'>,
  t: RackTypeSpec,
  i: number,
  level: number,
  position: number,
): CellWorld {
  const b = cellBoxLocal(t, i, level, position);
  const cxz = localToWorld(rack, (b.x0 + b.x1) / 2, -t.depthM / 2);
  return {
    center: [cxz[0], round6((b.y0 + b.y1) / 2), cxz[1]],
    corners: [
      localToWorld(rack, b.x0, 0),
      localToWorld(rack, b.x1, 0),
      localToWorld(rack, b.x1, -t.depthM),
      localToWorld(rack, b.x0, -t.depthM),
    ],
  };
}

/** 货架占地四角（世界 x,z）：前左、前右、后右、后左。用于 OBB 重叠与拾取。 */
export function rackFootprint(
  rack: Pick<LayoutRack, 'x' | 'z' | 'rotationDeg'>,
  t: RackTypeSpec,
): readonly [Vec2, Vec2, Vec2, Vec2] {
  const L = rackLengthM(t);
  return [
    localToWorld(rack, 0, 0),
    localToWorld(rack, L, 0),
    localToWorld(rack, L, -t.depthM),
    localToWorld(rack, 0, -t.depthM),
  ];
}

/** 取货面所在直线的坐标：水平巷道返回 z，竖直巷道返回 x（02 §3.1 几何一致性校验）。 */
export function pickFaceLine(rack: Pick<LayoutRack, 'x' | 'z' | 'rotationDeg'>): number {
  return aisleAxis(rack.rotationDeg) === 'x' ? rack.z : rack.x;
}
