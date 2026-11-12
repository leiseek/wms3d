import type { LabelKind, LabelTemplate, LabelTemplateKey } from '@wms3d/contracts';

export const MAX_LABELS_PER_JOB = 5000;

export const KIND_LABELS: Record<LabelKind, string> = {
  LOCATION: '仓位标签',
  RACK: '货架标签',
  SKU: 'SKU 标签',
};

/** 只列出支持该对象类型的模板（避免把货架码印到仓位模板上）。 */
export function templatesFor(all: readonly LabelTemplate[], kind: LabelKind): LabelTemplate[] {
  return all.filter((t) => t.kinds.includes(kind));
}

/** 切换对象类型后，若当前模板不兼容则换成第一个兼容模板。 */
export function pickTemplate(
  all: readonly LabelTemplate[],
  kind: LabelKind,
  current: LabelTemplateKey | null,
): LabelTemplateKey | null {
  const ok = templatesFor(all, kind);
  if (current && ok.some((t) => t.key === current)) return current;
  return ok[0]?.key ?? null;
}

export interface OffsetMm {
  x: number;
  y: number;
}
const OFFSET_KEY = 'wms3d.labelOffsets';

export function clampOffset(o: OffsetMm): OffsetMm {
  const c = (n: number) => Math.max(-10, Math.min(10, Math.round((Number(n) || 0) * 10) / 10));
  return { x: c(o.x), y: c(o.y) };
}

/** 每个模板一组偏移（用户偏好，07 §2 “A4 模板支持起始格与偏移校准”）。 */
export function loadOffset(template: string, storage: Pick<Storage, 'getItem'> = localStorage) {
  try {
    const all = JSON.parse(storage.getItem(OFFSET_KEY) ?? '{}') as Record<string, OffsetMm>;
    return clampOffset(all[template] ?? { x: 0, y: 0 });
  } catch {
    return { x: 0, y: 0 };
  }
}
export function saveOffset(
  template: string,
  o: OffsetMm,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
) {
  let all: Record<string, OffsetMm> = {};
  try {
    all = JSON.parse(storage.getItem(OFFSET_KEY) ?? '{}') as Record<string, OffsetMm>;
  } catch {
    /* 损坏则重置 */
  }
  all[template] = clampOffset(o);
  storage.setItem(OFFSET_KEY, JSON.stringify(all));
}

export interface RenderInput {
  template: LabelTemplateKey;
  kind: LabelKind;
  warehouseId: string;
  ids: string[];
  dpi: 203 | 300;
  offset: OffsetMm;
  startCell?: number | null;
  reprintRequestIds?: string[];
  isSheet: boolean;
}

/** 构造 POST /labels/render 请求体（ids 模式；A4 才带 startCell；偏移为 0 时省略）。 */
export function buildRenderBody(i: RenderInput) {
  if (!i.ids.length) throw new Error('请先选择要打印的对象');
  if (i.ids.length > MAX_LABELS_PER_JOB)
    throw new Error(`单次最多 ${MAX_LABELS_PER_JOB} 张，请分批打印`);
  const o = clampOffset(i.offset);
  return {
    template: i.template,
    kind: i.kind,
    warehouseId: i.warehouseId, // v1.2：SKU 标签也必填（作用域 / 审计 / 补打归属）
    ids: i.ids,
    format: 'PDF' as const,
    dpi: i.dpi,
    ...(i.isSheet && i.startCell && i.startCell > 1 ? { startCell: i.startCell } : {}),
    ...(o.x || o.y ? { offsetMm: o } : {}),
    ...(i.reprintRequestIds?.length ? { reprintRequestIds: i.reprintRequestIds } : {}),
  };
}

/** A4 多联的每页张数 */
export const perSheet = (t: Pick<LabelTemplate, 'sheet'>) =>
  t.sheet ? t.sheet.cols * t.sheet.rows : 1;
