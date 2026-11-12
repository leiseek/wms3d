import type { Occupancy } from '@wms3d/contracts';
import { EMPTY, HIDDEN, OPAQUE, type SlotMesh } from './slots.ts';

/** 着色模式（06 §4）。'zone' = 不看库存，按货架所属库区色（静态/设计器预览）。 */
export type ColorMode = 'occupancy' | 'skuCount' | 'zone';

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const PALETTE = {
  empty: '#D9D9D9',
  neutral: '#8FA3B8',
  inactive: '#7A1F1F',
  fillLow: '#52C41A',
  fillMid: '#FADB14',
  fillHigh: '#FA8C16',
  sku1: '#1677FF',
  sku2: '#9254DE',
  dim: '#BFBFBF',
  highlight: '#FF4D4F',
  frame: '#5C6B7A',
  floor: '#F0F2F5',
} as const;

const C = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, hexToRgb(v)])) as Record<
  keyof typeof PALETTE,
  RGB
>;

function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** fill ∈ [0,1] → 绿→黄→橙（02 §4 / 06 §4）。 */
export function fillColor(fill: number): RGB {
  const f = Math.max(0, Math.min(1, fill));
  return f <= 0.5
    ? lerp3(C.fillLow, C.fillMid, f / 0.5)
    : lerp3(C.fillMid, C.fillHigh, (f - 0.5) / 0.5);
}

export interface BinStyle {
  mesh: SlotMesh;
  color: RGB;
}

/**
 * 单个仓位的归属与颜色。occ 为 null（尚未加载 / 版本不符）时一律不透明中性色。
 * 停用仓位不论有无库存都是暗红不透明；空仓位进透明 mesh。
 */
export function binStyle(
  mode: ColorMode,
  occ: Occupancy | null,
  i: number,
  zoneColor: RGB | null,
): BinStyle {
  if (!occ || mode === 'zone') return { mesh: OPAQUE, color: zoneColor ?? C.neutral };
  if (occ.isActive[i] === 0) return { mesh: OPAQUE, color: C.inactive };
  const qty = occ.qty[i] ?? 0;
  if (qty <= 0) return { mesh: EMPTY, color: C.empty };
  if (mode === 'skuCount')
    return { mesh: OPAQUE, color: (occ.skuCount[i] ?? 0) >= 2 ? C.sku2 : C.sku1 };
  return { mesh: OPAQUE, color: fillColor(occ.fill[i] ?? 1) };
}

/** 定位高亮时其余实例混向灰色（仍不透明，不改透明度）。 */
export function dimColor(c: RGB, amount = 0.75): RGB {
  return lerp3(c, C.dim, amount);
}

export const COLORS = C;
export { HIDDEN };

export interface LegendItem {
  color: string;
  label: string;
}

export function legendFor(mode: ColorMode): LegendItem[] {
  switch (mode) {
    case 'occupancy':
      return [
        { color: PALETTE.empty, label: '空' },
        { color: PALETTE.fillLow, label: '低（≤50%）' },
        { color: PALETTE.fillMid, label: '中（50%）' },
        { color: PALETTE.fillHigh, label: '满' },
        { color: PALETTE.inactive, label: '停用' },
      ];
    case 'skuCount':
      return [
        { color: PALETTE.empty, label: '空' },
        { color: PALETTE.sku1, label: '单 SKU' },
        { color: PALETTE.sku2, label: '混放（2+）' },
        { color: PALETTE.inactive, label: '停用' },
      ];
    case 'zone':
      return [{ color: PALETTE.neutral, label: '仓位（按库区色）' }];
  }
}
