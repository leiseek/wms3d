import type { ScanEvent, Scanner, ScannerStatus, ScanSource } from './types.ts';

/**
 * 推送式 Scanner：由外部（原生事件桥、键盘监听、手输框、测试）调用 push()。
 * HID/SPP/CAMERA/MANUAL 在 JS 侧都用它适配成 Scanner 接口。
 */
export class ManualScanner implements Scanner {
  private cbs = new Set<(e: ScanEvent) => void>();
  private st: ScannerStatus = 'idle';
  constructor(
    readonly source: ScanSource,
    private readonly hooks: { start?: () => Promise<void>; stop?: () => Promise<void> } = {},
  ) {}
  async start(): Promise<void> {
    this.st = 'connecting';
    try {
      await this.hooks.start?.();
      this.st = 'ready';
    } catch (e) {
      this.st = 'error';
      throw e;
    }
  }
  async stop(): Promise<void> {
    await this.hooks.stop?.();
    this.st = 'idle';
  }
  setStatus(s: ScannerStatus): void {
    this.st = s;
  }
  status(): ScannerStatus {
    return this.st;
  }
  onScan(cb: (e: ScanEvent) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  push(text: string, at = Date.now(), extra: Partial<Omit<ScanEvent, 'text' | 'source'>> = {}): void {
    const e: ScanEvent = { text, source: this.source, at, ...extra };
    for (const cb of [...this.cbs]) cb(e);
  }
}
