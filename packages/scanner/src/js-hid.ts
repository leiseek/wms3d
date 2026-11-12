import { JS_HID } from './config.ts';

export interface KeyInput {
  /** KeyboardEvent.key */
  key: string;
  /** 时间戳（ms） */
  at: number;
}

export type JsHidResult =
  | { kind: 'none' }
  /** 判定为扫码枪的一帧 */
  | { kind: 'scan'; text: string }
  /** Enter 结束但节奏像人手输入：放行给输入框 */
  | { kind: 'human'; text: string };

/**
 * JS 兜底 HID 判定（docs/04-mobile.md §2.1）：平均字符间隔 < 30ms 且最大间隔 < 120ms 且长度 ≥ 4，
 * 以 Enter 结束 → 扫码；否则放行。用于 PC 浏览器 USB 枪、Android 上未白名单的设备与 web 调试。
 * 原生白名单设备的按键在 pre-IME 已被 Kotlin 吞掉，不会到达这里。
 */
export class JsHidDetector {
  private chars: string[] = [];
  private times: number[] = [];
  constructor(private readonly t = JS_HID) {}

  feed(k: KeyInput): JsHidResult {
    if (k.key === 'Enter' || k.key === 'Tab') return this.finish();
    if (k.key.length !== 1) return { kind: 'none' };
    // 间隔过大：前面的字符属于人工输入，从当前字符重新开始
    const lastAt = this.times[this.times.length - 1];
    if (lastAt !== undefined && k.at - lastAt > this.t.maxIntervalMs) this.reset();
    if (this.chars.length >= this.t.maxLength) this.reset();
    this.chars.push(k.key);
    this.times.push(k.at);
    return { kind: 'none' };
  }

  /** 当前缓冲看起来像扫码（供调用方决定是否 preventDefault 字符输入） */
  looksLikeScan(): boolean {
    return this.chars.length >= 2 && this.avgInterval() < this.t.maxAvgIntervalMs;
  }

  reset(): void {
    this.chars = [];
    this.times = [];
  }

  private avgInterval(): number {
    if (this.times.length < 2) return Infinity;
    return (this.times[this.times.length - 1]! - this.times[0]!) / (this.times.length - 1);
  }

  private maxInterval(): number {
    let m = 0;
    for (let i = 1; i < this.times.length; i++) m = Math.max(m, this.times[i]! - this.times[i - 1]!);
    return m;
  }

  private finish(): JsHidResult {
    const text = this.chars.join('');
    const ok =
      this.chars.length >= this.t.minLength &&
      this.avgInterval() < this.t.maxAvgIntervalMs &&
      this.maxInterval() < this.t.maxIntervalMs;
    this.reset();
    if (!text) return { kind: 'none' };
    return ok ? { kind: 'scan', text } : { kind: 'human', text };
  }
}
