import type { ScanSource } from './types.ts';

/**
 * 扫码参数（docs/04-mobile.md §2.1–§2.4）。所有阈值集中在这里，均有单测。
 */
export interface SourceDedupe {
  /** 完全相同帧在该窗口内视为同一次扳机（ms）；0 = 不去重 */
  identicalFrameWindowMs: number;
  /** 再扫同 SKU 是否 qty += packQty */
  accumulateSameSku: boolean;
}

export const DEDUPE: Record<ScanSource, SourceDedupe> = {
  HID: { identicalFrameWindowMs: 80, accumulateSameSku: true },
  SPP: { identicalFrameWindowMs: 80, accumulateSameSku: true },
  // 相机由 CameraAimFilter 做“离框再触发”，这里不再按时间去重；累加默认关闭（用数量键盘）
  CAMERA: { identicalFrameWindowMs: 0, accumulateSameSku: false },
  MANUAL: { identicalFrameWindowMs: 0, accumulateSameSku: false },
};

/** JS 兜底 HID 判定（PC 浏览器 USB 枪、未白名单设备）：§2.1 */
export const JS_HID = {
  maxAvgIntervalMs: 30,
  maxIntervalMs: 120,
  minLength: 4,
  maxLength: 256,
} as const;

/** 原生 HID 缓冲（与 Kotlin HidWedgeBuffer 保持一致） */
export const NATIVE_HID = { idleFlushMs: 150, maxLength: 256 } as const;

/** SPP 帧切分（与 Kotlin SppFrameSplitter 保持一致） */
export const SPP = { idleFlushMs: 80, maxBytes: 512, reconnectMaxBackoffMs: 3000 } as const;

/** 相机（§2.3） */
export const CAMERA = {
  /** 连续 N 次 barcodesScanned 事件读到同一码才算有效 */
  confirmEvents: 2,
  /** 同一码在事件流中消失 ≥ 该时长才能再次触发 */
  retriggerAbsentMs: 400,
  formats: ['QR_CODE', 'CODE_128', 'EAN_13', 'EAN_8', 'UPC_A', 'DATA_MATRIX'] as const,
} as const;

/** 连续模式（§3.1） */
export const CONTINUOUS = {
  defaultCountdownMs: 3000,
  minCountdownMs: 1000,
  maxCountdownMs: 10000,
  undoVisibleMs: 10000,
} as const;

export function clampCountdown(ms: number): number {
  if (!Number.isFinite(ms)) return CONTINUOUS.defaultCountdownMs;
  return Math.min(CONTINUOUS.maxCountdownMs, Math.max(CONTINUOUS.minCountdownMs, Math.round(ms)));
}
