import type { LayoutDoc, LayoutRack } from '@wms3d/contracts';
import { aabbOf, rackFootprint, type Aabb } from '@wms3d/domain';
import { typeOf } from './ops';

export interface SnapOptions {
  /** 网格步长（米），默认 0.1 */
  grid?: number;
  /** 邻近货架边缘吸附阈值（米），默认 0.3 */
  edgeThresholdM?: number;
  /** Shift 关闭吸附 */
  disabled?: boolean;
}

export interface SnapResult {
  x: number;
  z: number;
  /** 命中的吸附线（世界坐标），供画布绘制参考线 */
  guides: Array<{ axis: 'x' | 'z'; value: number }>;
}

const roundTo = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(6));

function best(cands: Array<{ delta: number; value: number }>, th: number) {
  let b: { delta: number; value: number } | null = null;
  for (const c of cands)
    if (Math.abs(c.delta) <= th && (!b || Math.abs(c.delta) < Math.abs(b.delta))) b = c;
  return b;
}

/**
 * 货架拖动吸附（05 §2.1）：优先吸附邻近货架边缘（AABB 四边对齐 / 首尾相接），否则吸附 0.1m 网格。
 * x、z 两轴独立判定。返回基点坐标。
 */
export function snapRack(
  doc: LayoutDoc,
  rack: LayoutRack,
  x: number,
  z: number,
  opts: SnapOptions = {},
): SnapResult {
  if (opts.disabled) return { x: Number(x.toFixed(6)), z: Number(z.toFixed(6)), guides: [] };
  const grid = opts.grid ?? 0.1;
  const th = opts.edgeThresholdM ?? 0.3;
  const t = typeOf(doc, rack);
  if (!t) return { x: roundTo(x, grid), z: roundTo(z, grid), guides: [] };
  const me = aabbOf(rackFootprint({ ...rack, x, z }, t));
  const others: Aabb[] = [];
  for (const r of doc.racks) {
    if (r.key === rack.key) continue;
    const ot = typeOf(doc, r);
    if (!ot) continue;
    const b = aabbOf(rackFootprint(r, ot));
    // 只考虑附近的货架（任一轴距离 < 阈值 + 尺寸）
    if (
      b.minX > me.maxX + 2 ||
      b.maxX < me.minX - 2 ||
      b.minZ > me.maxZ + 2 ||
      b.maxZ < me.minZ - 2
    )
      continue;
    others.push(b);
  }
  const cx: Array<{ delta: number; value: number }> = [];
  const cz: Array<{ delta: number; value: number }> = [];
  for (const b of others) {
    for (const v of [b.minX, b.maxX])
      for (const m of [me.minX, me.maxX]) cx.push({ delta: v - m, value: v });
    for (const v of [b.minZ, b.maxZ])
      for (const m of [me.minZ, me.maxZ]) cz.push({ delta: v - m, value: v });
  }
  // 仓库边界也是吸附线
  cx.push(
    { delta: 0 - me.minX, value: 0 },
    { delta: doc.warehouse.widthM - me.maxX, value: doc.warehouse.widthM },
  );
  cz.push(
    { delta: 0 - me.minZ, value: 0 },
    { delta: doc.warehouse.depthM - me.maxZ, value: doc.warehouse.depthM },
  );
  const bx = best(cx, th);
  const bz = best(cz, th);
  const guides: SnapResult['guides'] = [];
  let nx: number;
  let nz: number;
  if (bx) {
    nx = Number((x + bx.delta).toFixed(6));
    guides.push({ axis: 'x', value: bx.value });
  } else nx = roundTo(x, grid);
  if (bz) {
    nz = Number((z + bz.delta).toFixed(6));
    guides.push({ axis: 'z', value: bz.value });
  } else nz = roundTo(z, grid);
  return { x: nx, z: nz, guides };
}

export const snapPoint = (x: number, z: number, grid = 0.1): [number, number] => [
  roundTo(x, grid),
  roundTo(z, grid),
];
