import type { Box3Data } from './model.ts';

/** 按块距离 LOD（06 §2）：近景 进入 <18m / 退出 >22m；远景 进入 >45m / 退出 <40m（滞回）。 */
export type Lod = 'near' | 'mid' | 'far';
export const LOD_THRESHOLDS = { nearIn: 18, nearOut: 22, farIn: 45, farOut: 40 } as const;

export function distanceToBox(p: readonly [number, number, number], b: Box3Data): number {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const v = p[a]!;
    const d = v < b.min[a]! ? b.min[a]! - v : v > b.max[a]! ? v - b.max[a]! : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

export function nextLod(prev: Lod, dist: number, th = LOD_THRESHOLDS): Lod {
  switch (prev) {
    case 'near':
      if (dist <= th.nearOut) return 'near';
      return dist > th.farIn ? 'far' : 'mid';
    case 'mid':
      if (dist < th.nearIn) return 'near';
      if (dist > th.farIn) return 'far';
      return 'mid';
    case 'far':
      if (dist >= th.farOut) return 'far';
      return dist < th.nearIn ? 'near' : 'mid';
  }
}

/** 初始 LOD（无历史，取中点阈值）。 */
export function initialLod(dist: number, th = LOD_THRESHOLDS): Lod {
  if (dist < (th.nearIn + th.nearOut) / 2) return 'near';
  if (dist > (th.farIn + th.farOut) / 2) return 'far';
  return 'mid';
}
