import type { LayoutDoc, LayoutRack, RackTypeSpec, RotationDeg, Side } from '@wms3d/contracts';
import {
  aisleAxis,
  deriveSide,
  pickFaceLine,
  rackFootprint,
  rackLengthM,
  round6,
  type Vec2,
} from '../core/geometry.ts';
import { pointInPolygon } from './geom2d.ts';

/**
 * 布局编排工具（05 §2.1，02 §3.1）：沿巷道行进方向的区间、阵列复制、巷道重新编号、放置建议。
 * 全部是纯函数（不修改入参），设计器与测试共用。
 */

/** 货架沿巷道行进方向占据的区间 [start, end]（水平巷道为 x，竖直巷道为 z）。 */
export function travelSpan(
  rack: Pick<LayoutRack, 'x' | 'z' | 'rotationDeg'>,
  t: Pick<RackTypeSpec, 'bays' | 'bayWidthM' | 'uprightM'>,
): [number, number] {
  const L = rackLengthM(t);
  switch (rack.rotationDeg) {
    case 0:
      return [rack.x, round6(rack.x + L)];
    case 180:
      return [round6(rack.x - L), rack.x];
    case 90:
      return [rack.z, round6(rack.z + L)];
    case 270:
      return [round6(rack.z - L), rack.z];
  }
}

/** 行进方向单位向量（世界 x,z）。 */
export function travelVector(rotationDeg: RotationDeg): Vec2 {
  return aisleAxis(rotationDeg) === 'x' ? [1, 0] : [0, 1];
}

/** 该侧的 bayStart 起始号：L 奇（1）、R 偶（2）。 */
export function firstBay(side: Side): number {
  return side === 'L' ? 1 : 2;
}

export interface ArrayCopyOptions {
  /** 复制个数（不含源货架），1–200 */
  count: number;
  /** 相邻货架间隙（米，沿行进方向），默认 0（首尾相接） */
  gapM?: number;
  /** 生成新 key；默认 `${src.key}-c${k}`，冲突时追加序号 */
  makeKey?: (k: number) => string;
}

/**
 * 阵列复制（05 §2.1）：沿**行进方向**按间距复制 N 个；第 k 个副本 `rackNo = src.rackNo + k`、
 * `bayStart = src.bayStart + 2·bays·k`（奇偶自然保持，side 由旋转推导不变）。返回新增的货架（不含源）。
 */
export function arrayCopyRacks(
  doc: LayoutDoc,
  srcKey: string,
  opts: ArrayCopyOptions,
): LayoutRack[] {
  const src = doc.racks.find((r) => r.key === srcKey);
  if (!src) throw new Error(`货架 ${srcKey} 不存在`);
  const t = doc.rackTypes.find((x) => x.key === src.type);
  if (!t) throw new Error(`未知货架模板 ${src.type}`);
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 200)
    throw new RangeError('复制个数必须是 1–200 的整数');
  const gap = opts.gapM ?? 0;
  if (!(gap >= 0)) throw new RangeError('间隙不能为负');
  const step = rackLengthM(t) + gap;
  const [vx, vz] = travelVector(src.rotationDeg);
  const used = new Set(doc.racks.map((r) => r.key));
  const out: LayoutRack[] = [];
  for (let k = 1; k <= opts.count; k++) {
    let key = opts.makeKey ? opts.makeKey(k) : `${src.key}-c${k}`.slice(0, 32);
    for (let n = 2; used.has(key); n++) key = `${src.key.slice(0, 24)}-c${k}-${n}`;
    used.add(key);
    out.push({
      ...src,
      key,
      rackNo: src.rackNo + k,
      bayStart: src.bayStart + 2 * t.bays * k,
      x: round6(src.x + vx * step * k),
      z: round6(src.z + vz * step * k),
    });
  }
  return out;
}

/**
 * 巷道重新编号：同 (zone, aisle) 的每一侧按行进方向排序，`rackNo` 从 1 连续、`bayStart` 从 1（L）/2（R）起
 * 依次 `+2·bays`。返回新文档（未知模板的货架保持不变）。**会改变编码**：已发布仓位改码需在发布时确认。
 */
export function renumberAisle(doc: LayoutDoc, zone: string, aisle: number): LayoutDoc {
  const types = new Map(doc.rackTypes.map((t) => [t.key, t]));
  const patch = new Map<string, Pick<LayoutRack, 'rackNo' | 'bayStart'>>();
  for (const side of ['L', 'R'] as const) {
    const rs = doc.racks
      .filter(
        (r) =>
          r.zone === zone &&
          r.aisle === aisle &&
          deriveSide(r.rotationDeg) === side &&
          types.has(r.type),
      )
      .map((r) => ({ r, t: types.get(r.type)!, s: travelSpan(r, types.get(r.type)!)[0] }))
      .sort((a, b) => a.s - b.s || (a.r.key < b.r.key ? -1 : 1));
    let bay = firstBay(side);
    rs.forEach(({ r, t }, idx) => {
      patch.set(r.key, { rackNo: idx + 1, bayStart: bay });
      bay += 2 * t.bays;
    });
  }
  return {
    ...doc,
    racks: doc.racks.map((r) => (patch.has(r.key) ? { ...r, ...patch.get(r.key)! } : r)),
  };
}

/** 包含该点的库区（优先 STORAGE；都不含返回 null）。 */
export function zoneAt(doc: LayoutDoc, p: Vec2): string | null {
  const hits = doc.zones.filter((z) => pointInPolygon(p, z.polygon));
  return (hits.find((z) => z.kind === 'STORAGE') ?? hits[0])?.code ?? null;
}

/** 货架占地中心（世界 x,z）。 */
export function rackCenter(
  rack: Pick<LayoutRack, 'x' | 'z' | 'rotationDeg'>,
  t: RackTypeSpec,
): Vec2 {
  const f = rackFootprint(rack, t);
  return [round6((f[0][0] + f[2][0]) / 2), round6((f[0][1] + f[2][1]) / 2)];
}

export interface PlacementSuggestion {
  zone: string | null;
  aisle: number;
  rackNo: number;
  bayStart: number;
  side: Side;
}

/**
 * 放置建议（02 §3.1"货架放置时按所在巷道、推导侧别自动建议 aisle 与 bayStart"）：
 * 1. 同库区、同侧、取货面共线的货架 → 同巷道；
 * 2. 否则对侧取货面在 `maxAisleWidthM` 内且方向正确（两取货面之间是巷道）→ 同巷道；
 * 3. 否则新巷道 = 库区内最大巷道号 + 1。
 * bayStart = 该侧已有最大 bay + 2（保持奇偶），rackNo = 该侧最大 rackNo + 1。
 */
export function suggestPlacement(
  doc: LayoutDoc,
  rack: Pick<LayoutRack, 'x' | 'z' | 'rotationDeg' | 'type'> & { zone?: string; key?: string },
  maxAisleWidthM = 6,
): PlacementSuggestion {
  const types = new Map(doc.rackTypes.map((t) => [t.key, t]));
  const t = types.get(rack.type);
  const side = deriveSide(rack.rotationDeg);
  const zone = rack.zone ?? (t ? zoneAt(doc, rackCenter(rack, t)) : null);
  const axis = aisleAxis(rack.rotationDeg);
  const face = pickFaceLine(rack);
  const peers = doc.racks.filter(
    (r) => r.key !== rack.key && r.zone === zone && aisleAxis(r.rotationDeg) === axis,
  );
  let aisle: number | null = null;
  const same = peers.find(
    (r) => deriveSide(r.rotationDeg) === side && Math.abs(pickFaceLine(r) - face) < 1e-6,
  );
  if (same) aisle = same.aisle;
  else {
    let best: { a: number; w: number } | null = null;
    for (const r of peers) {
      if (deriveSide(r.rotationDeg) === side) continue;
      const other = pickFaceLine(r);
      // 水平巷道：z_face(R) > z_face(L)；竖直巷道：x_face(L) > x_face(R)
      const lFace = side === 'L' ? face : other;
      const rFace = side === 'L' ? other : face;
      const w = axis === 'x' ? rFace - lFace : lFace - rFace;
      if (w > 0 && w <= maxAisleWidthM && (!best || w < best.w)) best = { a: r.aisle, w };
    }
    if (best) aisle = best.a;
  }
  if (aisle === null)
    aisle = Math.min(
      99,
      Math.max(0, ...doc.racks.filter((r) => r.zone === zone).map((r) => r.aisle)) + 1,
    );
  const sameSide = doc.racks.filter(
    (r) =>
      r.key !== rack.key &&
      r.zone === zone &&
      r.aisle === aisle &&
      deriveSide(r.rotationDeg) === side,
  );
  let hi = firstBay(side) - 2;
  for (const r of sameSide) {
    const rt = types.get(r.type);
    if (rt) hi = Math.max(hi, r.bayStart + 2 * (rt.bays - 1));
  }
  return {
    zone,
    aisle,
    side,
    rackNo: Math.min(99, Math.max(0, ...sameSide.map((r) => r.rackNo)) + 1),
    bayStart: hi + 2,
  };
}

/** 货架覆盖的巷道级 bay 区间 [lo, hi]（同侧步长 2）。 */
export function rackBayRange(rack: Pick<LayoutRack, 'bayStart'>, t: Pick<RackTypeSpec, 'bays'>) {
  return [rack.bayStart, rack.bayStart + 2 * (t.bays - 1)] as const;
}
