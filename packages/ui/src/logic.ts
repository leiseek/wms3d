/** 纯逻辑（单测覆盖）：应用内键盘、数量键盘、倒计时。 */

export const KEYBOARD_ROWS: readonly (readonly string[])[] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', '-'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '.', '_', '/'],
];
export const SPECIAL_KEYS = ['SHIFT', 'BACK', 'CLEAR', 'SPACE', '#', '@', 'OK'] as const;
export type SpecialKey = (typeof SPECIAL_KEYS)[number];

export interface KeyboardState {
  value: string;
  lower: boolean;
}

/** 应用内字母数字键盘（04 §2.1 v2.1 M-N6）：不依赖系统软键盘 */
export function applyKey(s: KeyboardState, key: string, maxLen = 64): KeyboardState {
  switch (key) {
    case 'SHIFT':
      return { ...s, lower: !s.lower };
    case 'BACK':
      return { ...s, value: s.value.slice(0, -1) };
    case 'CLEAR':
      return { ...s, value: '' };
    case 'SPACE':
      return s.value.length >= maxLen ? s : { ...s, value: s.value + ' ' };
    case 'OK':
      return s;
    default: {
      if (key.length !== 1 || s.value.length >= maxLen) return s;
      const ch = s.lower ? key.toLowerCase() : key;
      return { ...s, value: s.value + ch };
    }
  }
}

/** 数量键盘：只允许正整数，上限 max */
export function applyQtyKey(value: string, key: string, max = 1_000_000): string {
  if (key === 'BACK') return value.slice(0, -1);
  if (key === 'CLEAR') return '';
  if (!/^[0-9]$/.test(key)) return value;
  const next = value === '0' ? key : value + key;
  return Number(next) > max ? value : next;
}

/** 倒计时（连续模式）：支持暂停（数量键盘打开时）；返回剩余毫秒 */
export interface Countdown {
  durationMs: number;
  startedAt: number;
  /** 暂停开始时间；null = 运行中 */
  pausedAt: number | null;
  /** 已累计暂停时长 */
  pausedTotal: number;
}

export function startCountdown(durationMs: number, now: number): Countdown {
  return { durationMs, startedAt: now, pausedAt: null, pausedTotal: 0 };
}
export function pauseCountdown(c: Countdown, now: number): Countdown {
  return c.pausedAt === null ? { ...c, pausedAt: now } : c;
}
export function resumeCountdown(c: Countdown, now: number): Countdown {
  return c.pausedAt === null
    ? c
    : { ...c, pausedAt: null, pausedTotal: c.pausedTotal + (now - c.pausedAt) };
}
/** v2.1 M-N10：数量键盘关闭后“重新计时” */
export function restartCountdown(c: Countdown, now: number): Countdown {
  return startCountdown(c.durationMs, now);
}
export function remainingMs(c: Countdown, now: number): number {
  const ref = c.pausedAt ?? now;
  return Math.max(0, c.durationMs - (ref - c.startedAt - c.pausedTotal));
}

/** “x 分钟前” */
export function ago(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

/** 扫码原文可视化（测试页）：显示不可见字符 */
export function visualize(raw: string): string {
  return raw.replace(/\r/g, '⏎').replace(/\n/g, '␊').replace(/\t/g, '⇥').replace(/ /g, '·');
}
