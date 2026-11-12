import type { LabelTemplateKey } from '@wms3d/contracts';

/** 与 contracts `LabelKind` 一致（该 schema 尚未 export type，见 contract-requests）。 */
export type LabelKind = 'LOCATION' | 'RACK' | 'SKU';

export type Dpi = 203 | 300;

/** 一张标签的渲染输入（库级；HTTP 请求由 WS-A1 组装）。 */
export interface LabelItem {
  kind: LabelKind;
  /** 人眼大号文字，不含仓库前缀，如 `A03-17-C02`、`RA03-L02`。 */
  code: string;
  /** 条码 / QR 载荷，如 `WH1.A03-17-C02`；裸编码时与 `code` 相同。 */
  payload: string;
  /** 主标题（SKU 名称等）。 */
  title?: string;
  /** 副标题（仓库名称等）。 */
  subtitle?: string;
}

export interface LabelRenderInput {
  template: LabelTemplateKey;
  dpi: Dpi;
  /** A4 起始格，从 1 起。 */
  startCell?: number;
  /** A4 / 页面整体偏移（校准），单位 mm。 */
  offsetMm?: { x: number; y: number };
  items: LabelItem[];
}

export interface CalibrationInput {
  template: LabelTemplateKey;
  dpi: Dpi;
}

export interface ZplRenderInput {
  template: LabelTemplateKey;
  dpi: Dpi;
  items: LabelItem[];
}

export interface CapacityResult {
  ok: boolean;
  modules: number;
  max: number;
}

export const MAX_LABELS_PER_RENDER = 5000;
