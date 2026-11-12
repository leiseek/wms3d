import { Capacitor, registerPlugin, WebPlugin } from '@capacitor/core';
import type {
  HidStatus,
  PinResult,
  ScanFrameEvent,
  SppState,
  Wms3dScannerPlugin,
} from '../../../../native/capacitor-scanner/src/definitions.ts';

export type { HidStatus, ScanFrameEvent, SppState, Wms3dScannerPlugin };

/**
 * 浏览器实现（开发/e2e）：没有 pre-IME 与 SPP；扫码枪在浏览器里走 JS HID 判定（scan-input.ts）。
 * e2e 通过 window.__wms3d.emitHid / emitSpp 模拟原生事件桥。安全存储退化为 localStorage（仅调试）。
 */
class Wms3dScannerWeb extends WebPlugin {
  private spp: SppState = 'idle';
  private treatSoft = false;
  async getHidStatus(): Promise<HidStatus> {
    return {
      installed: false,
      installError: '浏览器环境：无 pre-IME Hook（使用 JS 兜底判定）',
      overflowCount: 0,
      interceptedKeys: 0,
      treatSoftKeyboardAsScanner: this.treatSoft,
      enabled: true,
      whitelist: [],
    };
  }
  async setHidConfig(o: { treatSoftKeyboardAsScanner?: boolean }): Promise<void> {
    if (o.treatSoftKeyboardAsScanner !== undefined) this.treatSoft = o.treatSoftKeyboardAsScanner;
  }
  async listPairedDevices() {
    return { devices: [{ name: '模拟 SPP 扫码枪（web）', address: '00:11:22:33:44:55' }] };
  }
  async connectSpp(): Promise<void> {
    this.spp = 'ready';
    this.notifyListeners('sppState', { state: 'ready', detail: 'web 模拟' });
  }
  async disconnectSpp(): Promise<void> {
    this.spp = 'idle';
    this.notifyListeners('sppState', { state: 'idle', detail: null });
  }
  async sppStatus() {
    return { state: this.spp };
  }
  async feedback(o: { type: 'ok' | 'warn' | 'error' }): Promise<void> {
    webBeep(o.type);
  }
  async verifyServerPin(): Promise<PinResult> {
    return { ok: true, reason: '浏览器环境跳过（证书由浏览器校验）' };
  }
  async showSoftInput() {
    return { shown: false };
  }
  async openHardKeyboardSettings(): Promise<void> {}
  async secureSet(o: { key: string; value: string }): Promise<void> {
    localStorage.setItem(`wms3d.secure.${o.key}`, o.value);
  }
  async secureGet(o: { key: string }) {
    return { value: localStorage.getItem(`wms3d.secure.${o.key}`) };
  }
  async secureRemove(o: { key: string }): Promise<void> {
    localStorage.removeItem(`wms3d.secure.${o.key}`);
  }
  /** e2e / 测试页：模拟原生事件 */
  emit(event: 'hidScan' | 'sppScan', e: ScanFrameEvent): void {
    this.notifyListeners(event, e);
  }
}

let ctx: AudioContext | null = null;
function webBeep(type: 'ok' | 'warn' | 'error') {
  try {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = type === 'ok' ? 1760 : type === 'warn' ? 988 : 330;
    g.gain.value = 0.05;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (type === 'error' ? 0.4 : 0.08));
  } catch {
    /* 无音频设备 */
  }
}

export const isNative = Capacitor.isNativePlatform();
export const webScanner = new Wms3dScannerWeb();
export const Scanner = registerPlugin<Wms3dScannerPlugin>('Wms3dScanner', {
  web: () => webScanner,
});
