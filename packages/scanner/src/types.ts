/** 扫码抽象（docs/04-mobile.md §2，ADR-0004 v2）。 */
export type ScanSource = 'HID' | 'SPP' | 'CAMERA' | 'MANUAL';
export type ScannerStatus = 'idle' | 'connecting' | 'ready' | 'error';

export interface ScanEvent {
  /** 规范化后的文本（trim、去 \r\n\t、去 AIM 前缀） */
  text: string;
  source: ScanSource;
  symbology?: string;
  /** 事件时间（ms，单调或 epoch 均可，同一来源内一致即可） */
  at: number;
  /** HID：InputDevice.descriptor；SPP：MAC */
  deviceKey?: string;
}

export interface Scanner {
  readonly source: ScanSource;
  start(): Promise<void>;
  stop(): Promise<void>;
  onScan(cb: (e: ScanEvent) => void): () => void;
  status(): ScannerStatus;
}
