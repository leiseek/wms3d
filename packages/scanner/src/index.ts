/**
 * @wms3d/scanner — 扫码抽象（WS-C，docs/04-mobile.md §2）：ScanHub、来源去重表、JS HID 判定、相机瞄准框过滤。
 */
export const PACKAGE_NAME = '@wms3d/scanner' as const;
export * from './types.ts';
export * from './config.ts';
export { ScanHub, type ScanHubOptions } from './hub.ts';
export { JsHidDetector, type JsHidResult, type KeyInput } from './js-hid.ts';
export {
  CameraAimFilter,
  centerCss,
  inBox,
  pickInBox,
  type AimBox,
  type DetectedBarcode,
} from './camera.ts';
export { ManualScanner } from './manual.ts';
