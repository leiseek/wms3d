/**
 * 紧凑槽位（06 §4，v2.1 M-N4）：一个块的 N 个仓位分属两个 InstancedMesh（0 = 不透明/有货，1 = 空/透明），
 * 或被隐藏（−1，层过滤）。每个 mesh 的实例紧凑排列在 [0, count)，移出用 swap-remove，移入追加到末尾。
 * 维护 slotOf[mesh][local] 与 locOf[mesh][slot] 两张互逆表；只报告被写过的槽位，引擎据此做局部上传。
 */
export type SlotMesh = -1 | 0 | 1;
export const OPAQUE = 0 as const;
export const EMPTY = 1 as const;
export const HIDDEN = -1 as const;

export interface SlotWrite {
  mesh: 0 | 1;
  slot: number;
  local: number;
}

export class CompactSlots {
  readonly n: number;
  readonly meshOf: Int8Array;
  readonly slotOf: Int32Array;
  readonly locOf: [Int32Array, Int32Array];
  readonly count: [number, number] = [0, 0];
  /** 每个 mesh 自上次 takeDirty() 以来被写过的槽位范围 [min, max]（含） */
  private dirty: [number, number][] = [
    [Infinity, -Infinity],
    [Infinity, -Infinity],
  ];

  constructor(n: number) {
    this.n = n;
    this.meshOf = new Int8Array(n).fill(HIDDEN);
    this.slotOf = new Int32Array(n).fill(-1);
    this.locOf = [new Int32Array(n).fill(-1), new Int32Array(n).fill(-1)];
  }

  private mark(mesh: 0 | 1, slot: number, onWrite?: (w: SlotWrite) => void): void {
    const d = this.dirty[mesh]!;
    if (slot < d[0]) d[0] = slot;
    if (slot > d[1]) d[1] = slot;
    onWrite?.({ mesh, slot, local: this.locOf[mesh][slot]! });
  }

  /** 把块内局部仓位 local 放到 target（不变则无操作）。返回是否发生移动。 */
  assign(local: number, target: SlotMesh, onWrite?: (w: SlotWrite) => void): boolean {
    const cur = this.meshOf[local] as SlotMesh;
    if (cur === target) return false;
    if (cur !== HIDDEN) {
      const slot = this.slotOf[local]!;
      const last = --this.count[cur];
      const tbl = this.locOf[cur];
      if (slot !== last) {
        const moved = tbl[last]!;
        tbl[slot] = moved;
        this.slotOf[moved] = slot;
        this.mark(cur, slot, onWrite);
      }
      tbl[last] = -1;
    }
    this.meshOf[local] = target;
    if (target === HIDDEN) {
      this.slotOf[local] = -1;
    } else {
      const slot = this.count[target]++;
      this.locOf[target][slot] = local;
      this.slotOf[local] = slot;
      this.mark(target, slot, onWrite);
    }
    return true;
  }

  /** 取出并清空脏区间；无写入返回 null。 */
  takeDirty(mesh: 0 | 1): [number, number] | null {
    const d = this.dirty[mesh]!;
    if (d[0] > d[1]) return null;
    const r: [number, number] = [d[0], d[1]];
    this.dirty[mesh] = [Infinity, -Infinity];
    return r;
  }

  /** 自检（测试用）：两表互逆、无重复无遗漏。 */
  check(): void {
    let hidden = 0;
    for (let l = 0; l < this.n; l++) {
      const m = this.meshOf[l]!;
      if (m === HIDDEN) {
        hidden++;
        if (this.slotOf[l] !== -1) throw new Error(`hidden ${l} has slot`);
        continue;
      }
      const s = this.slotOf[l]!;
      if (s < 0 || s >= this.count[m as 0 | 1]) throw new Error(`slot out of range for ${l}`);
      if (this.locOf[m as 0 | 1][s] !== l) throw new Error(`locOf/slotOf mismatch for ${l}`);
    }
    if (this.count[0] + this.count[1] + hidden !== this.n) throw new Error('count mismatch');
  }
}
