/** 纯函数相机适配：不依赖 three，可在 node 单测。 */

export interface Box3 {
  min: [number, number, number];
  max: [number, number, number];
}

export type Vec3 = [number, number, number];

const hypot3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = hypot3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** 等轴默认方位：从平面图右下（+X / +Z）看向原点，与 2D「+X 右、+Z 向下」一致。 */
export const ISO_DIR: Vec3 = norm([0.62, 0.72, 0.62]);
/** 俯视略偏 +Z，避免 up 与视线重合。 */
export const TOP_DIR: Vec3 = norm([0, 1, 0.02]);

export function boxCenter(b: Box3): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function boxCorners(b: Box3): Vec3[] {
  const { min, max } = b;
  const xs = [min[0], max[0]];
  const ys = [min[1], max[1]];
  const zs = [min[2], max[2]];
  const out: Vec3[] = [];
  for (const x of xs) for (const y of ys) for (const z of zs) out.push([x, y, z]);
  return out;
}

export function inflateBox(b: Box3, pad: number): Box3 {
  return {
    min: [b.min[0] - pad, b.min[1], b.min[2] - pad],
    max: [b.max[0] + pad, b.max[1] + pad, b.max[2] + pad],
  };
}

/**
 * 把 AABB 完整纳入透视视野：相机位于 target + dir * dist。
 * dir 指向相机（从目标看向镜头）。padding > 1 为边距。
 */
export function fitCameraToBox(
  box: Box3,
  aspect: number,
  fovDeg: number,
  dir: Vec3,
  padding = 1.08,
): { pos: Vec3; target: Vec3 } {
  const target = boxCenter(box);
  // 俯视时看向地面中心，避免目标浮在半空
  const look: Vec3 = [target[0], Math.min(target[1], box.min[1] + 0.2), target[2]];
  const nd = hypot3(dir) < 1e-6 ? ISO_DIR : norm(dir);
  const fov = (fovDeg * Math.PI) / 180;
  const halfV = Math.tan(fov / 2);
  const halfH = halfV * Math.max(aspect, 0.05);
  const zc = nd;
  let xc = cross([0, 1, 0], zc);
  if (hypot3(xc) < 1e-6) xc = cross([0, 0, 1], zc);
  xc = norm(xc);
  const yc = norm(cross(zc, xc));
  let dist = 2;
  for (const p of boxCorners(box)) {
    const rel = sub(p, look);
    const along = dot(rel, nd);
    const x = dot(rel, xc);
    const y = dot(rel, yc);
    dist = Math.max(dist, Math.abs(x) / halfH + along, Math.abs(y) / halfV + along);
  }
  dist = Math.max(2, dist * padding);
  return { pos: add(look, scale(nd, dist)), target: look };
}

/** 一点是否落在以 pos 看向 target 的透视锥内（含少量容差）。 */
export function inFrustum(
  p: Vec3,
  pos: Vec3,
  target: Vec3,
  aspect: number,
  fovDeg: number,
  slop = 1.02,
): boolean {
  const nd = norm(sub(pos, target));
  let xc = cross([0, 1, 0], nd);
  if (hypot3(xc) < 1e-6) xc = cross([0, 0, 1], nd);
  xc = norm(xc);
  const yc = norm(cross(nd, xc));
  const rel = sub(p, pos);
  const depth = -dot(rel, nd);
  if (depth <= 1e-4) return false;
  const fov = (fovDeg * Math.PI) / 180;
  const halfV = Math.tan(fov / 2) * slop;
  const halfH = halfV * Math.max(aspect, 0.05);
  return Math.abs(dot(rel, xc)) <= depth * halfH && Math.abs(dot(rel, yc)) <= depth * halfV;
}
