import { describe, expect, it } from 'vitest';
import {
  CAMERA,
  CameraAimFilter,
  clampCountdown,
  centerCss,
  DEDUPE,
  JsHidDetector,
  ManualScanner,
  PACKAGE_NAME,
  pickInBox,
  ScanHub,
  type DetectedBarcode,
  type ScanEvent,
} from './index.ts';

describe('package', () => {
  it('exports its package name', () => expect(PACKAGE_NAME).toBe('@wms3d/scanner'));
});

describe('config（04 §2.4 去重表）', () => {
  it('HID/SPP 80ms 相同帧去重 + 累加；相机/手输不按时间去重', () => {
    expect(DEDUPE.HID).toEqual({ identicalFrameWindowMs: 80, accumulateSameSku: true });
    expect(DEDUPE.SPP).toEqual({ identicalFrameWindowMs: 80, accumulateSameSku: true });
    expect(DEDUPE.CAMERA.identicalFrameWindowMs).toBe(0);
    expect(DEDUPE.CAMERA.accumulateSameSku).toBe(false);
    expect(DEDUPE.MANUAL.identicalFrameWindowMs).toBe(0);
  });
  it('倒计时 1–10s 夹取', () => {
    expect(clampCountdown(500)).toBe(1000);
    expect(clampCountdown(3000)).toBe(3000);
    expect(clampCountdown(99999)).toBe(10000);
    expect(clampCountdown(Number.NaN)).toBe(3000);
  });
});

describe('ScanHub', () => {
  const collect = (hub: ScanHub) => {
    const got: ScanEvent[] = [];
    hub.onScan((e) => got.push(e));
    return got;
  };
  it('规范化：去 CR/LF/TAB、trim、AIM 前缀', () => {
    const hub = new ScanHub();
    const got = collect(hub);
    hub.dispatch({ text: '  ]C1WH1.A03-17-C02\r\n', source: 'HID', at: 0 });
    hub.dispatch({ text: '  \r\n', source: 'HID', at: 500 });
    expect(got.map((e) => e.text)).toEqual(['WH1.A03-17-C02']);
    expect(hub.counters()).toEqual({ accepted: 1, dropped: 1 });
  });
  it('HID：< 80ms 的完全相同帧丢弃，≥ 80ms 保留（累加场景）', () => {
    const hub = new ScanHub();
    const got = collect(hub);
    hub.dispatch({ text: '6900010000004', source: 'HID', at: 1000 });
    hub.dispatch({ text: '6900010000004', source: 'HID', at: 1050 });
    hub.dispatch({ text: '6900010000004', source: 'HID', at: 1130 });
    hub.dispatch({ text: 'OTHER', source: 'HID', at: 1131 });
    expect(got.map((e) => e.at)).toEqual([1000, 1130, 1131]);
  });
  it('去重按来源独立；相机不按时间去重', () => {
    const hub = new ScanHub();
    const got = collect(hub);
    hub.dispatch({ text: 'X1', source: 'HID', at: 0 });
    hub.dispatch({ text: 'X1', source: 'SPP', at: 10 });
    hub.dispatch({ text: 'X1', source: 'CAMERA', at: 20 });
    hub.dispatch({ text: 'X1', source: 'CAMERA', at: 21 });
    expect(got.map((e) => e.source)).toEqual(['HID', 'SPP', 'CAMERA', 'CAMERA']);
  });
  it('register 接入 Scanner，注销后不再分发', () => {
    const hub = new ScanHub();
    const got = collect(hub);
    const s = new ManualScanner('SPP');
    const off = hub.register(s);
    s.push('A', 0);
    off();
    s.push('B', 1000);
    expect(got.map((e) => e.text)).toEqual(['A']);
    expect(hub.registered()).toEqual([]);
  });
  it('ManualScanner 状态机', async () => {
    const s = new ManualScanner('HID', {
      start: async () => {
        throw new Error('x');
      },
    });
    await expect(s.start()).rejects.toThrow('x');
    expect(s.status()).toBe('error');
    await s.stop();
    expect(s.status()).toBe('idle');
  });
});

describe('JsHidDetector（04 §2.1 JS 兜底）', () => {
  const type = (d: JsHidDetector, s: string, t0: number, gap: number) => {
    let r = d.feed({ key: 'x', at: 0 });
    d.reset();
    for (let i = 0; i < s.length; i++) r = d.feed({ key: s[i]!, at: t0 + i * gap });
    return d.feed({ key: 'Enter', at: t0 + s.length * gap });
  };
  it('快速键入 + Enter → 扫码', () => {
    expect(type(new JsHidDetector(), 'WH1.A01-01-A01', 0, 5)).toEqual({
      kind: 'scan',
      text: 'WH1.A01-01-A01',
    });
  });
  it('人手节奏（平均 ≥ 30ms）→ 放行', () => {
    expect(type(new JsHidDetector(), 'abcd', 0, 60).kind).toBe('human');
  });
  it('长度 < 4 → 放行', () => {
    expect(type(new JsHidDetector(), 'abc', 0, 5).kind).toBe('human');
  });
  it('单次间隔 ≥ 120ms：之前的字符丢弃，从新字符重新计', () => {
    const d = new JsHidDetector();
    d.feed({ key: 'a', at: 0 });
    d.feed({ key: 'b', at: 300 });
    for (const [i, c] of [...'CDEF'].entries()) d.feed({ key: c, at: 305 + i * 5 });
    expect(d.feed({ key: 'Enter', at: 330 })).toEqual({ kind: 'scan', text: 'bCDEF' });
  });
  it('平均快但有一次 100ms 停顿仍算扫码；非字符键忽略', () => {
    const d = new JsHidDetector();
    d.feed({ key: 'Shift', at: 0 });
    d.feed({ key: 'A', at: 1 });
    d.feed({ key: 'B', at: 2 });
    d.feed({ key: 'C', at: 3 });
    d.feed({ key: 'D', at: 4 });
    expect(d.looksLikeScan()).toBe(true);
    expect(d.feed({ key: 'Enter', at: 6 }).kind).toBe('scan');
    expect(d.feed({ key: 'Enter', at: 7 })).toEqual({ kind: 'none' });
  });
});

describe('相机瞄准框（04 §2.3）', () => {
  const box = { left: 100, top: 100, width: 200, height: 100 };
  const at = (raw: string, cx: number, cy: number, dpr = 2): DetectedBarcode => {
    const x = cx * dpr;
    const y = cy * dpr;
    return {
      rawValue: raw,
      cornerPoints: [
        [x - 10, y - 10],
        [x + 10, y - 10],
        [x + 10, y + 10],
        [x - 10, y + 10],
      ],
    };
  };
  it('cornerPoints 物理像素 ÷ dpr', () => {
    expect(centerCss(at('A', 150, 120, 3), 3)).toEqual({ x: 150, y: 120 });
    expect(centerCss({ rawValue: 'x' }, 2)).toBeNull();
  });
  it('只接受框内；多个取离中心最近', () => {
    const p = pickInBox([at('OUT', 50, 50), at('FAR', 110, 110), at('NEAR', 195, 148)], box, 2);
    expect(p?.rawValue).toBe('NEAR');
    expect(pickInBox([at('OUT', 50, 50)], box, 2)).toBeNull();
  });
  it('dpr 未换算时会错判（回归：M-N5）', () => {
    // 物理坐标 (400,240) 若不除 dpr 会落在框外
    expect(pickInBox([at('A', 200, 120)], box, 1)?.rawValue).toBeUndefined();
    expect(pickInBox([at('A', 200, 120)], box, 2)?.rawValue).toBe('A');
  });
  it('双次确认：连续 2 次事件同一码才触发', () => {
    const f = new CameraAimFilter(box, 2);
    expect(f.onEvent([at('A', 200, 150)], 0)).toBeNull();
    expect(f.onEvent([at('A', 200, 150)], 50)?.rawValue).toBe('A');
  });
  it('中间换码会重置确认', () => {
    const f = new CameraAimFilter(box, 2);
    f.onEvent([at('A', 200, 150)], 0);
    f.onEvent([at('B', 200, 150)], 50);
    expect(f.onEvent([at('A', 200, 150)], 100)).toBeNull();
    expect(f.onEvent([at('A', 200, 150)], 150)?.rawValue).toBe('A');
  });
  it('持续对准不重复触发；离框 ≥ 400ms 才能再触发', () => {
    const f = new CameraAimFilter(box, 2);
    f.onEvent([at('A', 200, 150)], 0);
    expect(f.onEvent([at('A', 200, 150)], 50)).not.toBeNull();
    for (let t = 100; t <= 2000; t += 100) expect(f.onEvent([at('A', 200, 150)], t)).toBeNull();
    // 离框 300ms：仍锁定
    f.onEvent([], 2300);
    expect(f.onEvent([at('A', 200, 150)], 2300)).toBeNull();
    // 消失 ≥ 400ms（2300 那次又看到了 → 从 2300 起算）
    f.onEvent([], 2750);
    f.onEvent([at('A', 200, 150)], 2760);
    expect(f.onEvent([at('A', 200, 150)], 2800)?.rawValue).toBe('A');
  });
  it('框外出现的同码不算“仍在”，不阻止解锁', () => {
    const f = new CameraAimFilter(box, 2, CAMERA);
    f.onEvent([at('A', 200, 150)], 0);
    f.onEvent([at('A', 200, 150)], 10);
    f.onEvent([at('A', 20, 20)], 500);
    f.onEvent([at('A', 200, 150)], 520);
    expect(f.onEvent([at('A', 200, 150)], 540)?.rawValue).toBe('A');
  });
});
