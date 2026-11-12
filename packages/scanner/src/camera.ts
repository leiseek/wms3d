import { CAMERA } from './config.ts';

/** ML Kit barcodesScanned 事件中的一个码（cornerPoints 为物理像素） */
export interface DetectedBarcode {
  rawValue: string;
  format?: string;
  cornerPoints?: ReadonlyArray<readonly [number, number]> | undefined;
}

/** CSS 像素坐标的瞄准框 */
export interface AimBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function centerCss(
  b: DetectedBarcode,
  dpr: number,
): { x: number; y: number } | null {
  const pts = b.cornerPoints;
  if (!pts || pts.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const [px, py] of pts) {
    x += px;
    y += py;
  }
  const d = dpr > 0 ? dpr : 1;
  return { x: x / pts.length / d, y: y / pts.length / d };
}

export function inBox(p: { x: number; y: number }, box: AimBox): boolean {
  return (
    p.x >= box.left && p.x <= box.left + box.width && p.y >= box.top && p.y <= box.top + box.height
  );
}

/** 框内多个码取离中心最近者；没有返回 null */
export function pickInBox(
  barcodes: readonly DetectedBarcode[],
  box: AimBox,
  dpr: number,
): DetectedBarcode | null {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  let best: DetectedBarcode | null = null;
  let bestD = Infinity;
  for (const b of barcodes) {
    const c = centerCss(b, dpr);
    if (!c || !inBox(c, box)) continue;
    const d = (c.x - cx) ** 2 + (c.y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * 相机瞄准框 + 双次确认 + 离框再触发（04 §2.3，v2.1 M-N5）。
 * - cornerPoints 先除以 devicePixelRatio 再与 CSS 瞄准框比较；只接受中心在框内的码。
 * - 连续 2 次事件读到同一码才触发。
 * - 已触发的码要在事件流中“消失”（没有任何事件包含它且中心在框内）≥ 400ms 才能再次触发。
 */
export class CameraAimFilter {
  private candidate: { text: string; hits: number } | null = null;
  /** 码 → 最近一次在框内被看到的时间 */
  private lastSeen = new Map<string, number>();
  /** 已触发、等待离框的码 */
  private locked = new Set<string>();

  constructor(
    private box: AimBox,
    private dpr: number,
    private readonly opts: { confirmEvents: number; retriggerAbsentMs: number } = CAMERA,
  ) {}

  setBox(box: AimBox, dpr: number): void {
    this.box = box;
    this.dpr = dpr;
  }

  /** 处理一次 barcodesScanned 事件；返回确认的码或 null */
  onEvent(barcodes: readonly DetectedBarcode[], now: number): DetectedBarcode | null {
    // 解锁：离框足够久的码
    for (const code of [...this.locked]) {
      const seen = this.lastSeen.get(code) ?? -Infinity;
      if (now - seen >= this.opts.retriggerAbsentMs) this.locked.delete(code);
    }
    const inside = barcodes.filter((b) => {
      const c = centerCss(b, this.dpr);
      return c !== null && inBox(c, this.box);
    });
    for (const b of inside) {
      // 仍在框内的已锁定码刷新“最近看到”时间（持续对准不会重复触发）
      if (this.locked.has(b.rawValue)) this.lastSeen.set(b.rawValue, now);
    }
    const pick = pickInBox(
      inside.filter((b) => !this.locked.has(b.rawValue)),
      this.box,
      this.dpr,
    );
    for (const b of inside) if (!this.locked.has(b.rawValue)) this.lastSeen.set(b.rawValue, now);
    if (!pick) {
      this.candidate = null;
      return null;
    }
    if (this.candidate?.text === pick.rawValue) this.candidate.hits++;
    else this.candidate = { text: pick.rawValue, hits: 1 };
    if (this.candidate.hits >= this.opts.confirmEvents) {
      this.candidate = null;
      this.locked.add(pick.rawValue);
      return pick;
    }
    return null;
  }
}
