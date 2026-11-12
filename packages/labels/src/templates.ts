import type { LabelKind, LabelTemplate, LabelTemplateKey } from '@wms3d/contracts';
import { dotsToMm } from './units.ts';
import type { Dpi } from './types.ts';

/** 契约 `LabelTemplate` + 库内渲染参数。 */
export interface TemplateSpec extends LabelTemplate {
  /** Code128 可用宽度（含左右静区），mm。rack 无线性条码。 */
  usableWidthMm: number | null;
  /** 70×30 在裸编码时改用更宽 X 维。 */
  bareUsableWidthMm?: number;
  /** 默认（带前缀）X 维的点数：203 / 300。 */
  xDots: { dpi203: number; dpi300: number };
  /** 裸编码 X 维点数（仅 loc-70x30）。 */
  bareXDots?: { dpi203: number; dpi300: number };
  /** A4 多联时的单元尺寸（与 sheet 配套）。 */
  cellMm?: { width: number; height: number };
}

/**
 * 内置模板（07 §2）。maxModules 与设计文档一致；
 * loc-70x30 的裸编码档位由 {@link xDimension} / {@link maxModulesFor} 在运行时切换。
 */
export const labelTemplates: readonly TemplateSpec[] = [
  {
    key: 'loc-100x50',
    name: '仓位 100×50',
    kinds: ['LOCATION'],
    widthMm: 100,
    heightMm: 50,
    sheet: null,
    maxModules: { dpi203: 253, dpi300: 281 },
    supportsBarePayload: true,
    usableWidthMm: 94.875,
    xDots: { dpi203: 3, dpi300: 4 },
  },
  {
    key: 'loc-60x40',
    name: '仓位 60×40',
    kinds: ['LOCATION'],
    widthMm: 60,
    heightMm: 40,
    sheet: null,
    maxModules: { dpi203: 230, dpi300: 230 },
    supportsBarePayload: true,
    usableWidthMm: 57.5,
    xDots: { dpi203: 2, dpi300: 3 },
  },
  {
    key: 'loc-70x30',
    name: '横梁窄标 70×30',
    kinds: ['LOCATION'],
    widthMm: 70,
    heightMm: 30,
    sheet: null,
    maxModules: { dpi203: 264, dpi300: 259 },
    supportsBarePayload: true,
    usableWidthMm: 66,
    bareUsableWidthMm: 66,
    xDots: { dpi203: 2, dpi300: 3 },
    bareXDots: { dpi203: 3, dpi300: 4 },
  },
  {
    key: 'rack-100x150',
    name: '货架端头 100×150',
    kinds: ['RACK'],
    widthMm: 100,
    heightMm: 150,
    sheet: null,
    maxModules: null,
    supportsBarePayload: true,
    usableWidthMm: null,
    xDots: { dpi203: 3, dpi300: 4 },
  },
  {
    key: 'a4-3x8',
    name: 'A4 3×8（70×37mm）',
    kinds: ['LOCATION', 'SKU'],
    widthMm: 210,
    heightMm: 297,
    sheet: { cols: 3, rows: 8 },
    maxModules: { dpi203: 270, dpi300: 270 },
    supportsBarePayload: true,
    usableWidthMm: 67.5,
    xDots: { dpi203: 2, dpi300: 3 },
    cellMm: { width: 70, height: 37 },
  },
  {
    key: 'a4-2x7',
    name: 'A4 2×7（99×38mm）',
    kinds: ['LOCATION', 'SKU'],
    widthMm: 210,
    heightMm: 297,
    sheet: { cols: 2, rows: 7 },
    // 设计给了 0.33mm / 290；按 dpi 取整后用 floor(95.7 / X_snapped)。
    maxModules: { dpi203: 254, dpi300: 282 },
    supportsBarePayload: true,
    usableWidthMm: 95.7,
    xDots: { dpi203: 3, dpi300: 4 },
    cellMm: { width: 99, height: 38 },
  },
  {
    key: 'sku-60x40',
    name: 'SKU 60×40',
    kinds: ['SKU'],
    widthMm: 60,
    heightMm: 40,
    sheet: null,
    maxModules: { dpi203: 230, dpi300: 230 },
    supportsBarePayload: false,
    usableWidthMm: 57.5,
    xDots: { dpi203: 2, dpi300: 3 },
  },
];

const BY_KEY = new Map(labelTemplates.map((t) => [t.key, t]));

export function getLabelTemplate(key: LabelTemplateKey): TemplateSpec {
  const t = BY_KEY.get(key);
  if (!t) throw new Error(`未知标签模板：${key}`);
  return t;
}

/** 载荷是否带仓库前缀（02 §3.2）。 */
export function isPrefixedPayload(payload: string): boolean {
  return /^[A-Z0-9]{2,4}\./.test(payload);
}

export interface XDimension {
  dots: number;
  mm: number;
  pt: number;
}

/** 按模板、dpi、是否裸编码，把 X 维取整到整数打印点。 */
export function xDimension(key: LabelTemplateKey, dpi: Dpi, barePayload = false): XDimension {
  const spec = getLabelTemplate(key);
  const table = barePayload && spec.bareXDots ? spec.bareXDots : spec.xDots;
  const dots = dpi === 203 ? table.dpi203 : table.dpi300;
  return { dots, mm: dotsToMm(dots, dpi), pt: (dots * 72) / dpi };
}

/**
 * 容量上限。loc-70x30 裸编码使用 0.375 档（176 @203 / 195 @300）。
 * 其余模板取模板表中对应 dpi 的值，并与 floor(可用宽 / X) 取更严者。
 */
export function maxModulesFor(key: LabelTemplateKey, dpi: Dpi, barePayload = false): number | null {
  const spec = getLabelTemplate(key);
  if (spec.usableWidthMm == null) return null;
  const x = xDimension(key, dpi, barePayload);
  const usable =
    barePayload && spec.bareUsableWidthMm != null ? spec.bareUsableWidthMm : spec.usableWidthMm;
  // 设计文档的 maxModules 按标称 X（0.25 / 0.375 / 0.338）计算；
  // 取整到点后的 X 会有 0.001mm 级误差，这里以公布值为准。
  if (key === 'loc-70x30' && barePayload) return dpi === 203 ? 176 : 195;
  const published = dpi === 203 ? spec.maxModules?.dpi203 : spec.maxModules?.dpi300;
  if (published != null) return published;
  return Math.floor(usable / x.mm + 1e-9);
}

export class LabelKindMismatchError extends Error {
  readonly template: LabelTemplateKey;
  readonly kind: LabelKind;
  readonly allowed: readonly LabelKind[];

  constructor(opts: {
    template: LabelTemplateKey;
    kind: LabelKind;
    allowed: readonly LabelKind[];
  }) {
    const allowed = opts.allowed.join('/');
    super(
      `模板 ${opts.template} 只支持 ${allowed}，不能用于 ${opts.kind}。` +
        (opts.kind === 'RACK' ? '货架标签请使用 rack-100x150。' : ''),
    );
    this.name = 'LabelKindMismatchError';
    this.template = opts.template;
    this.kind = opts.kind;
    this.allowed = opts.allowed;
  }
}

export function assertItemKind(template: LabelTemplateKey, kind: LabelKind): void {
  const spec = getLabelTemplate(template);
  if (!spec.kinds.includes(kind)) {
    throw new LabelKindMismatchError({ template, kind, allowed: spec.kinds });
  }
}
