import { normalizeScan } from '@wms3d/domain';
import { DEDUPE } from './config.ts';
import type { ScanEvent, ScanSource, Scanner } from './types.ts';

type Listener = (e: ScanEvent) => void;

export interface ScanHubOptions {
  /** 每个来源的去重窗口覆盖（测试/设置页） */
  dedupe?: Partial<Record<ScanSource, number>>;
}

/**
 * ScanHub：汇聚所有扫码来源，规范化文本，按来源去重（04 §2.4），分发给订阅者。
 * - HID/SPP：仅丢弃 < 80ms 的完全相同帧（枪一次扳机一帧）；不做长时间去重（再扫同 SKU = 累加）。
 * - CAMERA：去重由 CameraAimFilter 的“离框再触发”完成，这里不再按时间去重。
 * - 空文本丢弃。
 */
export class ScanHub {
  private listeners = new Set<Listener>();
  private scanners = new Map<ScanSource, { scanner: Scanner; off: () => void }>();
  private last = new Map<ScanSource, { text: string; at: number }>();
  private windows: Record<ScanSource, number>;
  private stats = { accepted: 0, dropped: 0 };

  constructor(opts: ScanHubOptions = {}) {
    this.windows = {
      HID: opts.dedupe?.HID ?? DEDUPE.HID.identicalFrameWindowMs,
      SPP: opts.dedupe?.SPP ?? DEDUPE.SPP.identicalFrameWindowMs,
      CAMERA: opts.dedupe?.CAMERA ?? DEDUPE.CAMERA.identicalFrameWindowMs,
      MANUAL: opts.dedupe?.MANUAL ?? DEDUPE.MANUAL.identicalFrameWindowMs,
    };
  }

  register(s: Scanner): () => void {
    this.scanners.get(s.source)?.off();
    const off = s.onScan((e) => this.dispatch(e));
    this.scanners.set(s.source, { scanner: s, off });
    return () => {
      const cur = this.scanners.get(s.source);
      if (cur?.scanner === s) {
        cur.off();
        this.scanners.delete(s.source);
      }
    };
  }

  registered(): Scanner[] {
    return [...this.scanners.values()].map((x) => x.scanner);
  }

  onScan(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 直接注入一帧（手输、测试页、原生事件桥）。返回是否被接受。 */
  dispatch(e: ScanEvent): boolean {
    const text = normalizeScan(e.text);
    if (!text) {
      this.stats.dropped++;
      return false;
    }
    const win = this.windows[e.source];
    const prev = this.last.get(e.source);
    if (win > 0 && prev && prev.text === text && e.at - prev.at >= 0 && e.at - prev.at < win) {
      this.stats.dropped++;
      return false;
    }
    this.last.set(e.source, { text, at: e.at });
    this.stats.accepted++;
    const ev: ScanEvent = { ...e, text };
    for (const l of [...this.listeners]) l(ev);
    return true;
  }

  counters(): { accepted: number; dropped: number } {
    return { ...this.stats };
  }
}
