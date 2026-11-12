/**
 * Wms3dScanner 原生插件的 JS 接口（Kotlin 实现：android/src/main/kotlin/com/wms3d/scanner/ScannerPlugin.kt）。
 * 只含类型，无运行时依赖：App 在 apps/mobile/src/native/bridge.ts 用 @capacitor/core 的 registerPlugin 注册，
 * 浏览器调试用同文件的 web 实现（e2e 用它模拟 HID/SPP）。
 */
export interface ScanFrameEvent {
  text: string;
  /** HID：descriptor|vid:pid；SPP：MAC */
  deviceKey: string;
  at: number;
}

export interface HidDevice {
  key: string;
  name: string;
  vendorId: number;
  productId: number;
}

export interface HidStatus {
  /** pre-IME 拦截层是否已插入根布局（R3：失败时提示改用 SPP 或无焦点模式） */
  installed: boolean;
  installError: string | null;
  overflowCount: number;
  interceptedKeys: number;
  treatSoftKeyboardAsScanner: boolean;
  enabled: boolean;
  whitelist: HidDevice[];
}

export type SppTerminator = 'CR' | 'LF' | 'CRLF' | 'ANY';
export type SppState = 'idle' | 'connecting' | 'ready' | 'error';

export interface PinResult {
  ok: boolean;
  reason?: string;
  serverPins?: string[];
}

export interface Wms3dScannerPlugin {
  getHidStatus(): Promise<HidStatus>;
  setHidConfig(o: {
    enabled?: boolean;
    /** 仅 debug 包生效：把软键盘（虚拟设备）视为白名单扫码枪，手工联调用 */
    treatSoftKeyboardAsScanner?: boolean;
    /** “测试扫码”：下一台发出按键的字母键盘设备自动记入白名单 */
    captureNext?: boolean;
    removeDeviceKey?: string;
  }): Promise<void>;
  listPairedDevices(): Promise<{ devices: { name: string; address: string }[] }>;
  connectSpp(o: {
    address: string;
    terminator?: SppTerminator;
    charset?: 'UTF-8' | 'GBK';
    allowReflectionFallback?: boolean;
  }): Promise<void>;
  disconnectSpp(): Promise<void>;
  sppStatus(): Promise<{ state: SppState }>;
  feedback(o: { type: 'ok' | 'warn' | 'error' }): Promise<void>;
  /** 首次配置与每次启动时校验 SPKI 指纹（pin 可为逗号分隔的多个 sha256/…） */
  verifyServerPin(o: { url: string; pin: string }): Promise<PinResult>;
  showSoftInput(): Promise<{ shown: boolean }>;
  openHardKeyboardSettings(): Promise<void>;
  secureSet(o: { key: string; value: string }): Promise<void>;
  secureGet(o: { key: string }): Promise<{ value: string | null }>;
  secureRemove(o: { key: string }): Promise<void>;
  addListener(
    event: 'hidScan' | 'sppScan',
    cb: (e: ScanFrameEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: 'sppState',
    cb: (e: { state: SppState; detail: string | null }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: 'hidDeviceCaptured',
    cb: (e: HidDevice) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}
