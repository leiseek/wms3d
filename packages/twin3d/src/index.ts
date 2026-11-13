/**
 * @wms3d/twin3d — 3D 数字孪生（WS-D2，docs/06-3d-twin.md）。
 * 对外接口：<TwinView/>、buildTwinIndex、detectWebGL2、Twin2DFallback；其余为高级/测试用导出。
 */
export const PACKAGE_NAME = '@wms3d/twin3d' as const;

export {
  TwinView,
  type TwinViewProps,
  type TwinViewHandle,
  type TwinRenderMode,
  type FallbackReason,
} from './TwinView.tsx';
export { Twin2DFallback, type Twin2DProps } from './Twin2DFallback.tsx';
export { buildTwinIndex, indicesOf, type TwinIndex } from './twinIndex.ts';
export { detectWebGL2 } from './detect.ts';
export {
  TwinEngine,
  type CameraPreset,
  type EngineOptions,
  type LocationInfo,
  type PerfReport,
  type TwinStats,
} from './engine.ts';
export {
  legendFor,
  PALETTE,
  fillColor,
  binStyle,
  type ColorMode,
  type LegendItem,
} from './colors.ts';
export {
  createOccupancySync,
  type OccupancySync,
  type OccupancySyncOptions,
} from './occupancySync.ts';
export { buildSceneData, boundsOf, type SceneData } from './model.ts';
export { pick, type PickResult } from './pick.ts';
export { CompactSlots } from './slots.ts';

export { fitCameraToBox, inFrustum, ISO_DIR, TOP_DIR, inflateBox } from './camera.ts';
