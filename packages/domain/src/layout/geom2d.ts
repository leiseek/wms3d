import type { Vec2 } from '../core/geometry.ts';

/**
 * 2D 几何工具（俯视 x,z；米）。供 validateLayout 的 RACK_OVERLAP（OBB 分离轴）与 RACK_OUTSIDE_ZONE（多边形包含）使用，
 * 设计器画布也直接复用。约定：**边界相切不算重叠/越区**（容差 GEOM_EPS）。
 */
export const GEOM_EPS = 1e-6;

export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

export interface Aabb {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function aabbOf(pts: readonly Vec2[]): Aabb {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

function project(pts: readonly Vec2[], ax: number, az: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, z] of pts) {
    const d = x * ax + z * az;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/**
 * 两个凸多边形（OBB）是否**内部相交**（分离轴定理）。投影区间重叠长度 ≤ eps 视为分离（相切不报）。
 * 轴取两多边形各边法向（已归一化，eps 以米为单位）。
 */
export function convexOverlap(a: readonly Vec2[], b: readonly Vec2[], eps = GEOM_EPS): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const ex = q[0] - p[0];
      const ez = q[1] - p[1];
      const len = Math.hypot(ex, ez);
      if (len < 1e-12) continue;
      const ax = -ez / len;
      const az = ex / len;
      const [a0, a1] = project(a, ax, az);
      const [b0, b1] = project(b, ax, az);
      if (Math.min(a1, b1) - Math.max(a0, b0) <= eps) return false;
    }
  }
  return true;
}

function onSegment(p: Vec2, a: Vec2, b: Vec2, eps: number): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (Math.abs(cross) > eps * Math.max(len, 1)) return false;
  return (
    p[0] >= Math.min(a[0], b[0]) - eps &&
    p[0] <= Math.max(a[0], b[0]) + eps &&
    p[1] >= Math.min(a[1], b[1]) - eps &&
    p[1] <= Math.max(a[1], b[1]) + eps
  );
}

/** 点是否在简单多边形内（**边界算在内**）。射线法 + 边界判定。 */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[], eps = GEOM_EPS): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (onSegment(p, a, b, eps)) return true;
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** 两线段是否**严格穿越**（端点接触/共线重合不算）。 */
export function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2, eps = GEOM_EPS): boolean {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return (
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
    ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
  );
}

/**
 * 凸多边形 `inner` 是否完全落在简单多边形 `outer` 内（允许贴边）。
 * 条件：inner 全部顶点在 outer 内（含边界）、各边中点在内（凹多边形贴边时防止"跨缺口"）、且 inner 的边不与 outer 的边严格穿越。
 */
export function polygonContains(outer: readonly Vec2[], inner: readonly Vec2[], eps = GEOM_EPS) {
  for (const p of inner) if (!pointInPolygon(p, outer, eps)) return false;
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i]!;
    const b = inner[(i + 1) % inner.length]!;
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!pointInPolygon(mid, outer, eps)) return false;
    for (let j = 0; j < outer.length; j++)
      if (segmentsCross(a, b, outer[j]!, outer[(j + 1) % outer.length]!, eps)) return false;
  }
  // outer 的顶点严格落在 inner 内部 → outer 有凹口伸入 inner
  for (const p of outer) if (strictlyInsideConvex(p, inner, eps)) return false;
  return true;
}

function strictlyInsideConvex(p: Vec2, poly: readonly Vec2[], eps: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const o = orient(poly[i]!, poly[(i + 1) % poly.length]!, p);
    if (Math.abs(o) <= eps) return false;
    const s = Math.sign(o);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 多边形面积（带符号的鞋带公式取绝对值）。 */
export function polygonArea(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/**
 * 扫描线求所有内部相交的四边形对（按 minX 排序后剪枝），返回下标对 [i, j]（i < j）。
 * 5000 个货架时比 O(n²) 快两个数量级。
 */
export function overlappingPairs(quads: readonly Quad[], eps = GEOM_EPS): Array<[number, number]> {
  const boxes = quads.map((q, i) => ({ i, b: aabbOf(q) }));
  boxes.sort((p, q) => p.b.minX - q.b.minX);
  const out: Array<[number, number]> = [];
  for (let a = 0; a < boxes.length; a++) {
    const A = boxes[a]!;
    for (let c = a + 1; c < boxes.length; c++) {
      const C = boxes[c]!;
      if (C.b.minX >= A.b.maxX - eps) break;
      if (C.b.minZ >= A.b.maxZ - eps || A.b.minZ >= C.b.maxZ - eps) continue;
      if (convexOverlap(quads[A.i]!, quads[C.i]!, eps))
        out.push(A.i < C.i ? [A.i, C.i] : [C.i, A.i]);
    }
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}
