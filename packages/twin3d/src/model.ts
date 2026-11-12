import type { LayoutRack, RackTypeSpec, TwinModel } from '@wms3d/contracts';
import { cellBoxLocal, cellWorld, rackLengthM, threeRotationY, type Vec2 } from '@wms3d/domain';

/**
 * 纯数据层（无 three 依赖，可在 node 单测）：把 TwinModel 展开成按巷道分块的实例数据。
 * 几何一律走 @wms3d/domain（cellWorld 等），与发布仓位 / 2D 设计器 / 标签同一套函数（06 §1，02 §2）。
 */

/** 仓位盒相对单元格的缩放（留缝便于区分相邻仓位）。中心与 cellWorld.center 严格一致。 */
export const BIN_SCALE = { w: 0.9, h: 0.88, d: 0.9 } as const;
export const FLOOR_BIN_HEIGHT = 0.06;

export interface RackGeo {
  key: string;
  index: number;
  chunk: number;
  rack: LayoutRack;
  type: RackTypeSpec;
  lengthM: number;
  heightM: number;
  /** rotationDeg 的 cos/sin（与 localToWorld 一致） */
  cos: number;
  sin: number;
  rotY: number;
  /** 层顶累计高度（level k 顶部 = levelTop[k-1]） */
  levelTop: number[];
  /** 该货架的 twinIndex 列表（用于远景汇总色） */
  locs: number[];
}

export interface Box3Data {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ChunkGeo {
  key: string;
  index: number;
  /** 'aisle' = 一条巷道（zone+aisle）；'floor' = 地面仓位 */
  kind: 'aisle' | 'floor';
  racks: number[];
  /** 本块仓位的 twinIndex（块内局部下标 = 数组下标） */
  locs: Int32Array;
  bbox: Box3Data;
}

export interface FloorGeo {
  twinIndex: number;
  zone: string;
  polygon: readonly Vec2[];
}

export interface SceneData {
  layoutVersion: number;
  n: number;
  racks: RackGeo[];
  rackByKey: Map<string, number>;
  chunks: ChunkGeo[];
  floors: FloorGeo[];
  /** 每个 twinIndex 所在块（−1 = 无几何，例如货架键不在布局里） */
  locChunk: Int32Array;
  /** 每个 twinIndex 在块内的局部下标 */
  locLocal: Int32Array;
  /** 每个 twinIndex 的货架下标（地面仓位 −1） */
  locRack: Int32Array;
  /** 层号（地面仓位 0） */
  locLevel: Int16Array;
  /** 实例矩阵（列主序 16×n，可直接喂 InstancedMesh） */
  matrices: Float32Array;
  /** 仓位中心（3×n，世界坐标） */
  centers: Float32Array;
  /** 仓位盒半尺寸（3×n，局部 w/h/d 的一半，未旋转） */
  halfSizes: Float32Array;
  /** `${rackIdx}|${bayIndex}|${level}|${pos}` → twinIndex（解析式拾取用） */
  cellToIndex: Map<string, number>;
  maxLevel: number;
  bounds: Box3Data;
}

export function cellKey(rack: number, i: number, level: number, pos: number): string {
  return `${rack}|${i}|${level}|${pos}`;
}

function emptyBox(): Box3Data {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}
function grow(b: Box3Data, x: number, y: number, z: number): void {
  if (x < b.min[0]) b.min[0] = x;
  if (y < b.min[1]) b.min[1] = y;
  if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x;
  if (y > b.max[1]) b.max[1] = y;
  if (z > b.max[2]) b.max[2] = z;
}

/** 写入列主序 TRS 矩阵（仅绕 Y 旋转）。 */
export function writeMatrix(
  out: Float32Array,
  o: number,
  x: number,
  y: number,
  z: number,
  rotY: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  // three: rotation.y=θ → [c 0 s; 0 1 0; −s 0 c]
  out[o + 0] = c * sx;
  out[o + 1] = 0;
  out[o + 2] = -s * sx;
  out[o + 3] = 0;
  out[o + 4] = 0;
  out[o + 5] = sy;
  out[o + 6] = 0;
  out[o + 7] = 0;
  out[o + 8] = s * sz;
  out[o + 9] = 0;
  out[o + 10] = c * sz;
  out[o + 11] = 0;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
}

export function rackGeoOf(
  rack: LayoutRack,
  type: RackTypeSpec,
  index: number,
  chunk: number,
): RackGeo {
  const th = (rack.rotationDeg * Math.PI) / 180;
  const levelTop: number[] = [];
  let acc = 0;
  for (const h of type.levelHeightsM) levelTop.push((acc += h));
  return {
    key: rack.key,
    index,
    chunk,
    rack,
    type,
    lengthM: rackLengthM(type),
    heightM: acc,
    cos: Math.round(Math.cos(th)),
    sin: Math.round(Math.sin(th)),
    rotY: threeRotationY(rack.rotationDeg),
    levelTop,
    locs: [],
  };
}

/** 货架局部 (lx, lz) → 世界 (x, z)。与 domain.localToWorld 一致，但不做 round6（热路径）。 */
export function rackToWorld(r: RackGeo, lx: number, lz: number): [number, number] {
  return [r.rack.x + lx * r.cos - lz * r.sin, r.rack.z + lx * r.sin + lz * r.cos];
}
/** 世界 (x, z) → 货架局部 (lx, lz)。 */
export function worldToRack(r: RackGeo, x: number, z: number): [number, number] {
  const dx = x - r.rack.x;
  const dz = z - r.rack.z;
  return [dx * r.cos + dz * r.sin, -dx * r.sin + dz * r.cos];
}

export function buildSceneData(model: TwinModel): SceneData {
  const { layout, locations: L } = model;
  const n = L.id.length;
  const types = new Map(layout.rackTypes.map((t) => [t.key, t]));
  const chunkKeyOf = new Map<string, number>();
  const chunks: ChunkGeo[] = [];
  const chunkLocs: number[][] = [];
  const chunkBox: Box3Data[] = [];
  const racks: RackGeo[] = [];
  const rackByKey = new Map<string, number>();
  const ensureChunk = (key: string, kind: ChunkGeo['kind']): number => {
    let c = chunkKeyOf.get(key);
    if (c === undefined) {
      c = chunks.length;
      chunkKeyOf.set(key, c);
      chunks.push({ key, index: c, kind, racks: [], locs: new Int32Array(0), bbox: emptyBox() });
      chunkLocs.push([]);
      chunkBox.push(emptyBox());
    }
    return c;
  };
  let maxLevel = 1;
  for (const r of layout.racks) {
    const t = types.get(r.type);
    if (!t) continue; // 发布前已校验；容错：未知模板不渲染
    const c = ensureChunk(`${r.zone}|${r.aisle}`, 'aisle');
    const g = rackGeoOf(r, t, racks.length, c);
    rackByKey.set(r.key, g.index);
    racks.push(g);
    chunks[c]!.racks.push(g.index);
    for (const [lx, lz] of [
      [0, 0],
      [g.lengthM, 0],
      [g.lengthM, -t.depthM],
      [0, -t.depthM],
    ] as const) {
      const [x, z] = rackToWorld(g, lx, lz);
      grow(chunkBox[c]!, x, 0, z);
      grow(chunkBox[c]!, x, g.heightM, z);
    }
    if (t.levels > maxLevel) maxLevel = t.levels;
  }
  const floorByCode = new Map(layout.floorAreas.map((f) => [f.locationCode, f]));
  const floors: FloorGeo[] = [];
  const locChunk = new Int32Array(n).fill(-1);
  const locLocal = new Int32Array(n).fill(-1);
  const locRack = new Int32Array(n).fill(-1);
  const locLevel = new Int16Array(n);
  const matrices = new Float32Array(16 * n);
  const centers = new Float32Array(3 * n);
  const halfSizes = new Float32Array(3 * n);
  const cellToIndex = new Map<string, number>();
  for (let k = 0; k < n; k++) {
    const rk = L.rackKey[k];
    if (rk) {
      const ri = rackByKey.get(rk);
      const i = L.rackBayIndex[k];
      const level = L.level[k];
      const pos = L.pos[k];
      if (ri === undefined || i == null || level == null || pos == null) continue;
      const g = racks[ri]!;
      const t = g.type;
      if (i < 0 || i >= t.bays || level < 1 || level > t.levels || pos < 1) continue;
      if (pos > t.positionsPerLevel) continue;
      const cw = cellWorld(g.rack, t, i, level, pos);
      const b = cellBoxLocal(t, i, level, pos);
      const w = (b.x1 - b.x0) * BIN_SCALE.w;
      const h = (b.y1 - b.y0) * BIN_SCALE.h;
      const d = t.depthM * BIN_SCALE.d;
      const [cx, cy, cz] = cw.center;
      writeMatrix(matrices, 16 * k, cx, cy, cz, g.rotY, w, h, d);
      centers.set([cx, cy, cz], 3 * k);
      halfSizes.set([w / 2, h / 2, d / 2], 3 * k);
      locChunk[k] = g.chunk;
      locRack[k] = ri;
      locLevel[k] = level;
      g.locs.push(k);
      cellToIndex.set(cellKey(ri, i, level, pos), k);
      locLocal[k] = chunkLocs[g.chunk]!.push(k) - 1;
    } else {
      const f = floorByCode.get(L.code[k]!);
      if (!f) continue;
      const c = ensureChunk('floor', 'floor');
      let x0 = Infinity,
        x1 = -Infinity,
        z0 = Infinity,
        z1 = -Infinity;
      for (const [x, z] of f.polygon) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      // 地面仓位：多边形外接矩形内缩 0.3m 的薄板
      const inset = Math.min(0.3, (x1 - x0) / 4, (z1 - z0) / 4);
      const w = x1 - x0 - 2 * inset;
      const d = z1 - z0 - 2 * inset;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      writeMatrix(matrices, 16 * k, cx, FLOOR_BIN_HEIGHT / 2, cz, 0, w, FLOOR_BIN_HEIGHT, d);
      centers.set([cx, FLOOR_BIN_HEIGHT / 2, cz], 3 * k);
      halfSizes.set([w / 2, FLOOR_BIN_HEIGHT / 2, d / 2], 3 * k);
      grow(chunkBox[c]!, x0, 0, z0);
      grow(chunkBox[c]!, x1, FLOOR_BIN_HEIGHT, z1);
      floors.push({ twinIndex: k, zone: f.zone, polygon: f.polygon });
      locChunk[k] = c;
      locLevel[k] = 0;
      locLocal[k] = chunkLocs[c]!.push(k) - 1;
    }
  }
  const bounds: Box3Data = {
    min: [0, 0, 0],
    max: [layout.warehouse.widthM, layout.warehouse.heightM, layout.warehouse.depthM],
  };
  chunks.forEach((c, i) => {
    c.locs = Int32Array.from(chunkLocs[i]!);
    c.bbox = chunkBox[i]!;
  });
  return {
    layoutVersion: model.layoutVersion,
    n,
    racks,
    rackByKey,
    chunks,
    floors,
    locChunk,
    locLocal,
    locRack,
    locLevel,
    matrices,
    centers,
    halfSizes,
    cellToIndex,
    maxLevel,
    bounds,
  };
}

/** 一组仓位的世界包围盒（飞行聚焦用）；空集返回 null。 */
export function boundsOf(data: SceneData, indices: Iterable<number>): Box3Data | null {
  const b = emptyBox();
  let any = false;
  for (const k of indices) {
    if (data.locChunk[k]! < 0) continue;
    any = true;
    const cx = data.centers[3 * k]!;
    const cy = data.centers[3 * k + 1]!;
    const cz = data.centers[3 * k + 2]!;
    const r = Math.max(data.halfSizes[3 * k]!, data.halfSizes[3 * k + 2]!);
    grow(b, cx - r, cy - data.halfSizes[3 * k + 1]!, cz - r);
    grow(b, cx + r, cy + data.halfSizes[3 * k + 1]!, cz + r);
  }
  return any ? b : null;
}
