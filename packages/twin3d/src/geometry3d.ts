import * as THREE from 'three';
import type { RackGeo } from './model.ts';
import { rackToWorld } from './model.ts';

/** 单位立方体去底面（10 三角形，06 §3），中心在原点。 */
export function unitBinGeometry(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const idx = box.getIndex()!;
  // BoxGeometry 面顺序：+x, −x, +y, −y, +z, −z；每面 6 个索引。去掉 −y（第 4 面）。
  const keep: number[] = [];
  for (let i = 0; i < idx.count; i++) if (i < 18 || i >= 24) keep.push(idx.getX(i));
  box.setIndex(keep);
  box.clearGroups();
  return box;
}

export function unitBoxGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.clearGroups();
  return g;
}

/** 远景实心盒：底面中心在原点（便于按货架长/高/深缩放）。 */
export function unitFarBoxGeometry(): THREE.BufferGeometry {
  const g = unitBoxGeometry();
  g.translate(0.5, 0.5, -0.5);
  return g;
}

/** 把若干"局部系轴对齐盒"合并成一个几何（货架近景框架：立柱 + 前后横梁）。 */
export class BoxMerger {
  private pos: number[] = [];
  private nor: number[] = [];
  private idx: number[] = [];
  private static readonly FACES: Array<{
    n: [number, number, number];
    c: [number, number, number][];
  }> = [
    {
      n: [1, 0, 0],
      c: [
        [1, 0, 1],
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
      ],
    },
    {
      n: [-1, 0, 0],
      c: [
        [0, 0, 0],
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 0],
      ],
    },
    {
      n: [0, 1, 0],
      c: [
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 0],
        [0, 1, 0],
      ],
    },
    {
      n: [0, -1, 0],
      c: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ],
    },
    {
      n: [0, 0, 1],
      c: [
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ],
    },
    {
      n: [0, 0, -1],
      c: [
        [1, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
      ],
    },
  ];

  get triangles(): number {
    return this.idx.length / 3;
  }

  /** 货架局部系的盒 [x0,x1]×[y0,y1]×[z0,z1] → 世界坐标写入。 */
  addRackBox(
    r: RackGeo,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
  ): void {
    for (const f of BoxMerger.FACES) {
      const base = this.pos.length / 3;
      for (const [cx, cy, cz] of f.c) {
        const [wx, wz] = rackToWorld(r, cx ? x1 : x0, cz ? z1 : z0);
        this.pos.push(wx, cy ? y1 : y0, wz);
        const [nx, nz] = [f.n[0] * r.cos - f.n[2] * r.sin, f.n[0] * r.sin + f.n[2] * r.cos];
        this.nor.push(nx, f.n[1], nz);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** 近景货架框架（06 §3）：4 根角立柱 + 每层前后横梁 → 48 + 24·levels 三角形。 */
  addRackFrame(r: RackGeo): void {
    const t = r.type;
    const u = Math.max(t.uprightM, 0.05);
    const D = t.depthM;
    const L = r.lengthM;
    const H = r.heightM;
    for (const [x0, z0] of [
      [0, -u],
      [L - u, -u],
      [0, -D],
      [L - u, -D],
    ] as const)
      this.addRackBox(r, x0, x0 + u, 0, H, z0, z0 + u);
    const bm = Math.max(t.beamM, 0.04);
    const bd = Math.min(0.08, D / 4);
    for (const top of r.levelTop) {
      this.addRackBox(r, 0, L, top - bm, top, -bd, 0);
      this.addRackBox(r, 0, L, top - bm, top, -D, -D + bd);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setIndex(
      this.pos.length / 3 > 65535
        ? new THREE.Uint32BufferAttribute(this.idx, 1)
        : new THREE.Uint16BufferAttribute(this.idx, 1),
    );
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
