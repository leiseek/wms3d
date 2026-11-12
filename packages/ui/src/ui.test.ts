import { describe, expect, it } from 'vitest';
import {
  ago,
  applyKey,
  applyQtyKey,
  pauseCountdown,
  remainingMs,
  restartCountdown,
  resumeCountdown,
  startCountdown,
  visualize,
} from './logic.ts';

describe('@wms3d/ui logic', () => {
  it('应用内键盘：大小写、退格、清空、上限', () => {
    let s = { value: '', lower: false };
    for (const k of ['W', 'H', '1', '.', 'A']) s = applyKey(s, k);
    expect(s.value).toBe('WH1.A');
    s = applyKey(applyKey(s, 'SHIFT'), 'B');
    expect(s).toEqual({ value: 'WH1.Ab', lower: true });
    expect(applyKey(s, 'BACK').value).toBe('WH1.A');
    expect(applyKey(s, 'CLEAR').value).toBe('');
    expect(applyKey({ value: 'abc', lower: false }, 'X', 3).value).toBe('abc');
    expect(applyKey(s, 'OK')).toBe(s);
    expect(applyKey({ value: 'a', lower: false }, 'SPACE').value).toBe('a ');
  });
  it('数量键盘：正整数、前导 0、上限', () => {
    expect(['1', '2', 'x', '0'].reduce((v, k) => applyQtyKey(v, k), '')).toBe('120');
    expect(applyQtyKey('0', '5')).toBe('5');
    expect(applyQtyKey('99', '9', 100)).toBe('99');
    expect(applyQtyKey('12', 'BACK')).toBe('1');
    expect(applyQtyKey('12', 'CLEAR')).toBe('');
  });
  it('倒计时：暂停期间不走；恢复后继续；重启重新计时', () => {
    let c = startCountdown(3000, 0);
    expect(remainingMs(c, 1000)).toBe(2000);
    c = pauseCountdown(c, 1000);
    expect(remainingMs(c, 5000)).toBe(2000);
    expect(pauseCountdown(c, 6000)).toBe(c);
    c = resumeCountdown(c, 5000);
    expect(remainingMs(c, 5500)).toBe(1500);
    expect(remainingMs(c, 99999)).toBe(0);
    expect(remainingMs(restartCountdown(c, 6000), 6000)).toBe(3000);
    expect(resumeCountdown(c, 1)).toBe(c);
  });
  it('ago / visualize', () => {
    expect(ago(0, 30_000)).toBe('刚刚');
    expect(ago(0, 5 * 60_000)).toBe('5 分钟前');
    expect(ago(0, 3 * 3600_000)).toBe('3 小时前');
    expect(visualize('A B\r\n\t')).toBe('A·B⏎␊⇥');
  });
});
