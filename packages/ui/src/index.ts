/**
 * @wms3d/ui — 移动端共享组件（WS-C）：大按钮、应用内字母数字键盘、数量键盘、倒计时条、打断式拒绝遮罩。
 * 样式类名以 ui- 开头，样式表在 apps/mobile/src/styles.css。
 */
export const PACKAGE_NAME = '@wms3d/ui' as const;
export * from './logic.ts';
export {
  AppKeyboard,
  BigButton,
  CountdownBar,
  QtyPad,
  RejectOverlay,
  StatusChip,
  useNow,
} from './components.tsx';
