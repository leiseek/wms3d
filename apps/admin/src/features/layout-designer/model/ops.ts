import type {
  FloorArea,
  LayoutDoc,
  LayoutRack,
  LayoutZone,
  RackTypeSpec,
  RotationDeg,
} from '@wms3d/contracts';
import {
  arrayCopyRacks,
  compilePattern,
  deriveSide,
  rackCenter,
  rackCode,
  rackFootprint,
  renumberAisle,
  round6,
  suggestPlacement,
  type Vec2,
} from '@wms3d/domain';

/** 设计器对 LayoutDoc 的纯函数操作（不修改入参）。所有坐标单位米，约定见 02 §2。 */

export const emptyDoc = (w = 60, d = 40, h = 8): LayoutDoc => ({
  schemaVersion: 2,
  warehouse: { widthM: w, depthM: d, heightM: h },
  zones: [],
  rackTypes: [],
  racks: [],
  floorAreas: [],
});

export const r6 = round6;

export function typeOf(doc: LayoutDoc, rack: Pick<LayoutRack, 'type'>): RackTypeSpec | undefined {
  return doc.rackTypes.find((t) => t.key === rack.type);
}

export function uniqueKey(existing: Iterable<string>, prefix: string): string {
  const s = new Set(existing);
  for (let n = 1; ; n++) {
    const k = `${prefix}${n}`.slice(0, 32);
    if (!s.has(k)) return k;
  }
}

/** 模板按值快照进文档（02 §4）；同 key 已存在且参数不同 → 以 `-2`、`-3` 后缀另存。返回文档内 key。 */
export function ensureRackType(doc: LayoutDoc, t: RackTypeSpec): { doc: LayoutDoc; key: string } {
  const { id: _id, ...spec } = t as RackTypeSpec & { id?: string };
  const same = doc.rackTypes.find((x) => JSON.stringify(x) === JSON.stringify(spec));
  if (same) return { doc, key: same.key };
  let key = spec.key;
  for (let n = 2; doc.rackTypes.some((x) => x.key === key); n++)
    key = `${spec.key.slice(0, 28)}-${n}`;
  return { doc: { ...doc, rackTypes: [...doc.rackTypes, { ...spec, key }] }, key };
}

export interface PlaceInput {
  type: RackTypeSpec;
  x: number;
  z: number;
  rotationDeg?: RotationDeg;
}

/** 放置货架：模板快照 + 按所在巷道/侧别自动建议 zone、aisle、rackNo、bayStart。 */
export function placeRack(doc: LayoutDoc, p: PlaceInput): { doc: LayoutDoc; key: string } {
  const { doc: d1, key: typeKey } = ensureRackType(doc, p.type);
  const rotationDeg = p.rotationDeg ?? 0;
  const s = suggestPlacement(d1, { x: p.x, z: p.z, rotationDeg, type: typeKey });
  const key = uniqueKey(
    d1.racks.map((r) => r.key),
    'r',
  );
  const rack: LayoutRack = {
    key,
    zone: s.zone ?? d1.zones[0]?.code ?? 'A',
    type: typeKey,
    aisle: s.aisle,
    rackNo: s.rackNo,
    bayStart: s.bayStart,
    x: r6(p.x),
    z: r6(p.z),
    rotationDeg,
  };
  return { doc: { ...d1, racks: [...d1.racks, rack] }, key };
}

export function patchRack(doc: LayoutDoc, key: string, patch: Partial<LayoutRack>): LayoutDoc {
  return { ...doc, racks: doc.racks.map((r) => (r.key === key ? { ...r, ...patch } : r)) };
}

export function moveRacks(doc: LayoutDoc, keys: readonly string[], dx: number, dz: number) {
  const ks = new Set(keys);
  return {
    ...doc,
    racks: doc.racks.map((r) => (ks.has(r.key) ? { ...r, x: r6(r.x + dx), z: r6(r.z + dz) } : r)),
  };
}

export const nextRotation = (deg: RotationDeg): RotationDeg => ((deg + 90) % 360) as RotationDeg;

/**
 * 绕占地中心旋转 90°（R 键）：MVP 只允许 0/90/180/270；基点随之移动使中心不变，再吸附到 0.1m 网格。
 * 侧别由旋转推导而变化时，bayStart 奇偶自动修正（+1 / −1），以免立即出现 BAY_PARITY。
 */
export function rotateRack(doc: LayoutDoc, key: string): LayoutDoc {
  const r = doc.racks.find((x) => x.key === key);
  const t = r && typeOf(doc, r);
  if (!r || !t) return doc;
  const [cx, cz] = rackCenter(r, t);
  const rot = nextRotation(r.rotationDeg);
  const probe = { ...r, rotationDeg: rot };
  const [nx, nz] = rackCenter(probe, t);
  const x = Math.round((r.x + cx - nx) * 10) / 10;
  const z = Math.round((r.z + cz - nz) * 10) / 10;
  const side = deriveSide(rot);
  const odd = r.bayStart % 2 === 1;
  const bayStart =
    side === 'L' ? (odd ? r.bayStart : r.bayStart - 1 || 1) : odd ? r.bayStart + 1 : r.bayStart;
  return patchRack(doc, key, { rotationDeg: rot, x: r6(x), z: r6(z), bayStart });
}

export function deleteRacks(doc: LayoutDoc, keys: readonly string[]): LayoutDoc {
  const ks = new Set(keys);
  return { ...doc, racks: doc.racks.filter((r) => !ks.has(r.key)) };
}

export function arrayCopy(
  doc: LayoutDoc,
  key: string,
  count: number,
  gapM = 0,
): { doc: LayoutDoc; keys: string[] } {
  const copies = arrayCopyRacks(doc, key, { count, gapM });
  return { doc: { ...doc, racks: [...doc.racks, ...copies] }, keys: copies.map((c) => c.key) };
}

export { renumberAisle };

export function addZone(doc: LayoutDoc, zone: LayoutZone): LayoutDoc {
  return { ...doc, zones: [...doc.zones.filter((z) => z.code !== zone.code), zone] };
}

/** 改库区（含改 code：同步更新货架与地面区的 zone 引用）。 */
export function patchZone(doc: LayoutDoc, code: string, patch: Partial<LayoutZone>): LayoutDoc {
  const nextCode = patch.code ?? code;
  return {
    ...doc,
    zones: doc.zones.map((z) => (z.code === code ? { ...z, ...patch } : z)),
    racks:
      nextCode === code
        ? doc.racks
        : doc.racks.map((r) => (r.zone === code ? { ...r, zone: nextCode } : r)),
    floorAreas:
      nextCode === code
        ? doc.floorAreas
        : doc.floorAreas.map((f) => (f.zone === code ? { ...f, zone: nextCode } : f)),
  };
}

export function deleteZone(doc: LayoutDoc, code: string): LayoutDoc {
  return { ...doc, zones: doc.zones.filter((z) => z.code !== code) };
}

export function addFloorArea(doc: LayoutDoc, f: FloorArea): LayoutDoc {
  return {
    ...doc,
    floorAreas: [...doc.floorAreas.filter((x) => x.locationCode !== f.locationCode), f],
  };
}

export function deleteFloorArea(doc: LayoutDoc, code: string): LayoutDoc {
  return { ...doc, floorAreas: doc.floorAreas.filter((f) => f.locationCode !== code) };
}

export const ZONE_COLORS = [
  '#5B8FF9',
  '#5AD8A6',
  '#F6BD16',
  '#E86452',
  '#6DC8EC',
  '#945FB9',
  '#FF9845',
];

/** 下一个可用库区编码：A、B、C… */
export function nextZoneCode(doc: LayoutDoc): string {
  for (let c = 65; c <= 90; c++) {
    const s = String.fromCharCode(c);
    if (!doc.zones.some((z) => z.code === s)) return s;
  }
  return 'Z1';
}

export interface RackCodePreview {
  rackCode: string;
  side: 'L' | 'R';
  /** 如 `A03-01…07-C02` */
  range: string;
  first: string;
  last: string;
  bays: number[];
  count: number;
  error: string | null;
}

/** 货架码与仓位码范围预览（05 §2.1 属性面板）。 */
export function rackCodePreview(
  doc: LayoutDoc,
  rack: LayoutRack,
  pattern: string,
): RackCodePreview {
  const t = typeOf(doc, rack);
  const side = deriveSide(rack.rotationDeg);
  const base = { side, bays: [] as number[], count: 0 };
  let rc: string;
  try {
    rc = rackCode(rack.zone, rack.aisle, side, rack.rackNo);
  } catch (e) {
    return { ...base, rackCode: '', range: '', first: '', last: '', error: (e as Error).message };
  }
  if (!t)
    return {
      ...base,
      rackCode: rc,
      range: '',
      first: '',
      last: '',
      error: `模板 ${rack.type} 不存在`,
    };
  const bays = Array.from({ length: t.bays }, (_, i) => rack.bayStart + 2 * i);
  try {
    const pat = compilePattern(pattern);
    const f = (bay: number, level: number, position: number) =>
      pat.format({ zone: rack.zone, aisle: rack.aisle, bay, level, position, side });
    const first = f(bays[0]!, 1, 1);
    const last = f(bays[bays.length - 1]!, t.levels, t.positionsPerLevel);
    return {
      rackCode: rc,
      side,
      bays,
      first,
      last,
      range: compactRange(first, last),
      count: t.bays * t.levels * t.positionsPerLevel,
      error: null,
    };
  } catch (e) {
    return {
      ...base,
      bays,
      rackCode: rc,
      range: '',
      first: '',
      last: '',
      error: (e as Error).message,
    };
  }
}

/** `A03-01-A01` + `A03-07-C02` → `A03-01…07-C02`（按 '-' 段合并公共前缀）。 */
export function compactRange(first: string, last: string): string {
  if (first === last) return first;
  const a = first.split('-');
  const b = last.split('-');
  if (a.length !== b.length) return `${first}…${last}`;
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  const head = a.slice(0, k).join('-');
  return `${head ? `${head}-` : ''}${a.slice(k).join('-')}…${b.slice(k).join('-')}`;
}

/** 货架占地多边形（世界），用于画布命中与 3D 预览。 */
export function footprintOf(doc: LayoutDoc, rack: LayoutRack): readonly Vec2[] | null {
  const t = typeOf(doc, rack);
  return t ? rackFootprint(rack, t) : null;
}
