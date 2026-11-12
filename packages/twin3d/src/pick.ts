import type { SceneData } from './model.ts';
import { worldToRack } from './model.ts';

/**
 * 解析式拾取（06 §5，M23）：射线先与各货架 OBB 求交（O(货架数)），命中后在货架局部系按 bay/level/position
 * 网格直接算出仓位；地面仓位按多边形判定。与 LOD / 层过滤一致：远景块只返回货架；层过滤隐藏的层不可拾取。
 */
export type PickResult =
  { kind: 'location'; twinIndex: number; t: number } | { kind: 'rack'; rack: number; t: number };

export interface PickOptions {
  /** 只看第 N 层及以下（含）；undefined = 全部 */
  maxLevel?: number;
  /** 块是否处于远景（远景只拾取到货架） */
  isFar?: (chunk: number) => boolean;
}

type V3 = readonly [number, number, number];

/** 射线与轴对齐盒求交（slab），返回进入距离；不相交返回 null。起点在盒内返回 0。 */
export function rayAabb(o: V3, d: V3, min: V3, max: V3): number | null {
  let t0 = 0;
  let t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / d[a]!;
    let tn = (min[a]! - o[a]!) * inv;
    let tf = (max[a]! - o[a]!) * inv;
    if (Number.isNaN(tn) || Number.isNaN(tf)) {
      // 方向分量为 0 且起点恰在边界上
      if (o[a]! < min[a]! || o[a]! > max[a]!) return null;
      continue;
    }
    if (tn > tf) [tn, tf] = [tf, tn];
    if (tn > t0) t0 = tn;
    if (tf < t1) t1 = tf;
    if (t0 > t1) return null;
  }
  return t0;
}

export function pointInPolygon(
  x: number,
  z: number,
  poly: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** 货架局部 x → 列序号 i 与位置 pos（1 起）；落在立柱上就近归入相邻列。 */
export function locateInRack(
  t: { bays: number; bayWidthM: number; uprightM: number; positionsPerLevel: number },
  lx: number,
): { i: number; pos: number } {
  const pitch = t.bayWidthM + t.uprightM;
  let i = Math.floor((lx - t.uprightM) / pitch);
  i = Math.max(0, Math.min(t.bays - 1, i));
  const x0 = t.uprightM * (i + 1) + i * t.bayWidthM;
  let pos = Math.floor(((lx - x0) / t.bayWidthM) * t.positionsPerLevel) + 1;
  pos = Math.max(1, Math.min(t.positionsPerLevel, pos));
  return { i, pos };
}

export function levelAt(levelTop: readonly number[], y: number): number {
  for (let k = 0; k < levelTop.length; k++) if (y < levelTop[k]!) return k + 1;
  return levelTop.length;
}

export function pick(
  data: SceneData,
  origin: V3,
  dir: V3,
  opts: PickOptions = {},
): PickResult | null {
  let best: PickResult | null = null;
  for (const r of data.racks) {
    const t = r.type;
    const visLevels = opts.maxLevel !== undefined ? Math.min(opts.maxLevel, t.levels) : t.levels;
    if (visLevels < 1) continue;
    const top = r.levelTop[visLevels - 1]!;
    // 射线变换到货架局部系（旋转只绕 Y）
    const [ox, oz] = worldToRack(r, origin[0], origin[2]);
    const dx = dir[0] * r.cos + dir[2] * r.sin;
    const dz = -dir[0] * r.sin + dir[2] * r.cos;
    const tHit = rayAabb(
      [ox, origin[1], oz],
      [dx, dir[1], dz],
      [0, 0, -t.depthM],
      [r.lengthM, top, 0],
    );
    if (tHit === null || (best && tHit >= best.t)) continue;
    if (opts.isFar?.(r.chunk)) {
      best = { kind: 'rack', rack: r.index, t: tHit };
      continue;
    }
    const e = tHit + 1e-4;
    const lx = ox + dx * e;
    const ly = origin[1] + dir[1] * e;
    const { i, pos } = locateInRack(t, lx);
    const level = Math.min(levelAt(r.levelTop, ly), visLevels);
    const k = data.cellToIndex.get(`${r.index}|${i}|${level}|${pos}`);
    best =
      k === undefined
        ? { kind: 'rack', rack: r.index, t: tHit }
        : { kind: 'location', twinIndex: k, t: tHit };
  }
  // 地面仓位：射线与 y=0 平面交点
  if (dir[1] < 0 && data.floors.length) {
    const tf = -origin[1] / dir[1];
    if (!best || tf < best.t) {
      const x = origin[0] + dir[0] * tf;
      const z = origin[2] + dir[2] * tf;
      for (const f of data.floors)
        if (pointInPolygon(x, z, f.polygon)) {
          best = { kind: 'location', twinIndex: f.twinIndex, t: tf };
          break;
        }
    }
  }
  return best;
}
