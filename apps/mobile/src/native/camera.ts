import type { DetectedBarcode } from '@wms3d/scanner';
import { isNative } from './bridge.ts';

/**
 * 相机驱动（04 §2.3）：原生 = @capacitor-mlkit/barcode-scanning 的 startScan()（相机画在 WebView 下方，
 * 需要 DOM 透明）+ @capawesome/capacitor-torch；浏览器 = 模拟驱动（e2e 用 window.__wms3d.camera(...) 注入事件）。
 * 待真机验证：首帧延迟（10-vote ≈ 0.5s）、密集标签误读、torch 可用性。
 */
export interface CameraDriver {
  start(onBarcodes: (b: DetectedBarcode[]) => void): Promise<void>;
  stop(): Promise<void>;
  setTorch(on: boolean): Promise<boolean>;
}

export const SCANNER_ACTIVE_CLASS = 'barcode-scanner-active';

/** 进入扫码：html/body/#root 加透明类（上半区祖先由 CSS 规则透明） */
export function setScannerActive(on: boolean): void {
  for (const el of [document.documentElement, document.body, document.getElementById('root')])
    el?.classList.toggle(SCANNER_ACTIVE_CLASS, on);
}

class NativeCamera implements CameraDriver {
  private off: (() => Promise<void>) | null = null;
  async start(cb: (b: DetectedBarcode[]) => void): Promise<void> {
    const { BarcodeScanner, BarcodeFormat, LensFacing } =
      await import('@capacitor-mlkit/barcode-scanning');
    const perm = await BarcodeScanner.requestPermissions();
    if (perm.camera !== 'granted' && perm.camera !== 'limited') throw new Error('未授予相机权限');
    const h = await BarcodeScanner.addListener('barcodesScanned', (e) =>
      cb(
        e.barcodes.map((b) => ({
          rawValue: b.rawValue ?? '',
          format: b.format,
          cornerPoints: b.cornerPoints,
        })),
      ),
    );
    this.off = () => h.remove();
    await BarcodeScanner.startScan({
      formats: [
        BarcodeFormat.Code128,
        BarcodeFormat.Ean13,
        BarcodeFormat.Ean8,
        BarcodeFormat.UpcA,
        BarcodeFormat.QrCode,
        BarcodeFormat.DataMatrix,
      ],
      lensFacing: LensFacing.Back,
    });
  }
  async stop(): Promise<void> {
    const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
    await this.off?.();
    this.off = null;
    await BarcodeScanner.stopScan();
  }
  async setTorch(on: boolean): Promise<boolean> {
    const { Torch } = await import('@capawesome/capacitor-torch');
    if (!(await Torch.isAvailable()).available) return false;
    if (on) await Torch.enable();
    else await Torch.disable();
    return true;
  }
}

/** 浏览器模拟：事件由 e2e/测试页注入 */
export class SimulatedCamera implements CameraDriver {
  static current: SimulatedCamera | null = null;
  private cb: ((b: DetectedBarcode[]) => void) | null = null;
  torch = false;
  async start(cb: (b: DetectedBarcode[]) => void): Promise<void> {
    this.cb = cb;
    SimulatedCamera.current = this;
  }
  async stop(): Promise<void> {
    this.cb = null;
    if (SimulatedCamera.current === this) SimulatedCamera.current = null;
  }
  async setTorch(on: boolean): Promise<boolean> {
    this.torch = on;
    return true;
  }
  emit(b: DetectedBarcode[]): boolean {
    if (!this.cb) return false;
    this.cb(b);
    return true;
  }
}

export function createCamera(): CameraDriver {
  return isNative ? new NativeCamera() : new SimulatedCamera();
}
