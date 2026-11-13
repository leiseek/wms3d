/**
 * @wms3d/labels — 标签模板、矢量 PDF 与实验性 ZPL（WS-E）。
 * 供 WS-A1 的 /labels 端点调用；变更对外接口请走 contract request。
 */
export const PACKAGE_NAME = '@wms3d/labels' as const;

export {
  labelTemplates,
  getLabelTemplate,
  xDimension,
  maxModulesFor,
  isPrefixedPayload,
  assertItemKind,
  LabelKindMismatchError,
} from './templates.ts';
export type { TemplateSpec, XDimension } from './templates.ts';
export { checkCapacity, assertCapacity, LabelCapacityError } from './capacity.ts';
export { renderLabelsPdf, renderCalibrationPdf } from './render-pdf.ts';
export { renderLabelsZpl, zplEscape, zplFd } from './render-zpl.ts';
export {
  countCode128Modules,
  countEan13Modules,
  isValidEan13,
  skuSymbology,
} from './barcode-metrics.ts';
export type {
  LabelItem,
  LabelRenderInput,
  CalibrationInput,
  ZplRenderInput,
  CapacityResult,
  Dpi,
  LabelKind,
  LabelTemplate,
} from './types.ts';
export { MAX_LABELS_PER_RENDER } from './types.ts';
export { mmToPt, ptToMm, dotsToMm, dotsToPt } from './units.ts';
export { LabelFontError } from './fonts.ts';

export { decodePdf, ensureZXing, matchDecoded, verifyLabelPdf } from './verify.ts';
export type { LabelVerifyHit, LabelVerifyOutcome } from './verify.ts';
