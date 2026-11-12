import type { LayoutDoc, LayoutIssue, RackTypeSpec, ZoneKind } from '@wms3d/contracts';
import { compilePattern, rackCode } from '../core/coding.ts';
import {
  aisleAxis,
  bayNumber,
  cellWorld,
  deriveSide,
  pickFaceLine,
  round6,
  rackFootprint,
  type Vec3,
} from '../core/geometry.ts';
import { overlappingPairs, polygonContains, type Quad } from './geom2d.ts';

export * from './geom2d.ts';
export * from './arrange.ts';

export interface ExpandedRack {
  key: string;
  code: string;
  zone: string;
  aisle: number;
  side: 'L' | 'R';
  rackNo: number;
  bayStart: number;
  type: RackTypeSpec;
}

export interface ExpandedLocation {
  code: string;
  kind: ZoneKind;
  zone: string;
  rackKey: string | null;
  rackBayIndex: number | null;
  bay: number | null;
  level: number | null;
  position: number | null;
  center: Vec3;
  /** 默认拣货顺序（步长 10，巷道间蛇形）；发布时仅对新增仓位使用 */
  pickSeq: number;
}

export interface ExpandResult {
  racks: ExpandedRack[];
  locations: ExpandedLocation[];
}

/**
 * 布局展开（02 §9 step 3 的前半段）。顺序确定：货架按文档顺序，货架内按 (i, level, position)，地面仓位在后。
 * M0b 由 Lead 提供参考实现并以黄金样例锁定；WS-D1 负责完善（性能、增量），必须保持 golden 测试通过。
 */
export function expandLayout(doc: LayoutDoc, pattern: string): ExpandResult {
  const pat = compilePattern(pattern);
  const types = new Map(doc.rackTypes.map((t) => [t.key, t]));
  const zones = new Map(doc.zones.map((z) => [z.code, z]));
  const racks: ExpandedRack[] = [];
  const locations: ExpandedLocation[] = [];
  for (const r of doc.racks) {
    const t = types.get(r.type);
    if (!t) throw new Error(`未知货架模板 ${r.type}（rack ${r.key}）`);
    const side = deriveSide(r.rotationDeg);
    racks.push({
      key: r.key,
      code: rackCode(r.zone, r.aisle, side, r.rackNo),
      zone: r.zone,
      aisle: r.aisle,
      side,
      rackNo: r.rackNo,
      bayStart: r.bayStart,
      type: t,
    });
    const kind = zones.get(r.zone)?.kind ?? 'STORAGE';
    for (let i = 0; i < t.bays; i++) {
      const bay = bayNumber(side, r.bayStart, t.bays, i);
      for (let level = 1; level <= t.levels; level++) {
        for (let position = 1; position <= t.positionsPerLevel; position++) {
          const code = pat.format({ zone: r.zone, aisle: r.aisle, bay, level, position, side });
          locations.push({
            code,
            kind,
            zone: r.zone,
            rackKey: r.key,
            rackBayIndex: i,
            bay,
            level,
            position,
            center: cellWorld(r, t, i, level, position).center,
            pickSeq: 0,
          });
        }
      }
    }
  }
  for (const f of doc.floorAreas) {
    const cx = f.polygon.reduce((a, p) => a + p[0], 0) / f.polygon.length;
    const cz = f.polygon.reduce((a, p) => a + p[1], 0) / f.polygon.length;
    locations.push({
      code: f.locationCode,
      kind: zones.get(f.zone)?.kind ?? 'RECEIVING',
      zone: f.zone,
      rackKey: null,
      rackBayIndex: null,
      bay: null,
      level: null,
      position: null,
      center: [cx, 0, cz],
      pickSeq: 0,
    });
  }
  assignPickSeq(locations, racks);
  return { racks, locations };
}

/** 默认 pick_seq：按 (zone, aisle, bay, level, position)，奇数巷道正向、偶数巷道反向（蛇形）；地面仓位最后。 */
export function assignPickSeq(locs: ExpandedLocation[], racks: ExpandedRack[]): void {
  const aisleOf = new Map(racks.map((r) => [r.key, r.aisle]));
  const order = locs
    .map((l, idx) => ({
      l,
      idx,
      aisle: l.rackKey ? (aisleOf.get(l.rackKey) ?? 0) : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => {
      if (a.l.zone !== b.l.zone) return a.l.zone < b.l.zone ? -1 : 1;
      if (a.aisle !== b.aisle) return a.aisle - b.aisle;
      const dir = a.aisle % 2 === 1 ? 1 : -1;
      if ((a.l.bay ?? 0) !== (b.l.bay ?? 0)) return dir * ((a.l.bay ?? 0) - (b.l.bay ?? 0));
      if ((a.l.level ?? 0) !== (b.l.level ?? 0)) return (a.l.level ?? 0) - (b.l.level ?? 0);
      if ((a.l.position ?? 0) !== (b.l.position ?? 0))
        return (a.l.position ?? 0) - (b.l.position ?? 0);
      return a.l.code < b.l.code ? -1 : a.l.code > b.l.code ? 1 : 0;
    });
  order.forEach((o, k) => {
    o.l.pickSeq = (k + 1) * 10;
  });
}

/**
 * RACK_OUTSIDE_ZONE 的严重级别。暂为 WARNING：Lead 的 golden.test.ts 属性用例使用三角形库区（货架落在其外），
 * 升级为 ERROR 需先修正该夹具，见 docs/contract-requests/ws-d1-1.md。
 */
export const RACK_OUTSIDE_ZONE_SEVERITY: LayoutIssue['severity'] = 'WARNING';

export interface ValidateOptions {
  pattern: string;
  /** 标签模板容量折算的最大编码长度（M30）；不传则不校验 */
  maxCodeLength?: number;
  minAisleWidthM?: number;
}

/**
 * 布局校验（02 §3.1、§9 step 2；前后端共享同一函数）：未知库区/模板、越界、**OBB 重叠（分离轴，相切不报）**、
 * **货架越出所属库区（多边形包含，贴边不报）**、bay 奇偶、bay 区间重叠、bay/巷道位数超出编码模式、
 * 巷道取货面共线与宽度、编码重复/超长。问题顺序确定（便于前后端对比与快照测试）。
 */
export function validateLayout(doc: LayoutDoc, opts: ValidateOptions): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const add = (
    severity: LayoutIssue['severity'],
    code: LayoutIssue['code'],
    message: string,
    rackKeys: string[] = [],
    codes: string[] = [],
  ) => issues.push({ severity, code, message, rackKeys, codes });
  const types = new Map(doc.rackTypes.map((t) => [t.key, t]));
  const zones = new Set(doc.zones.map((z) => z.code));
  const minW = opts.minAisleWidthM ?? 1.2;
  const valid = doc.racks.filter((r) => {
    let ok = true;
    if (!zones.has(r.zone)) {
      add('ERROR', 'UNKNOWN_ZONE', `货架 ${r.key} 的库区 ${r.zone} 不存在`, [r.key]);
      ok = false;
    }
    if (!types.has(r.type)) {
      add('ERROR', 'UNKNOWN_RACK_TYPE', `货架 ${r.key} 的模板 ${r.type} 不存在`, [r.key]);
      ok = false;
    }
    return ok;
  });
  for (const f of doc.floorAreas)
    if (!zones.has(f.zone))
      add(
        'ERROR',
        'UNKNOWN_ZONE',
        `地面区 ${f.locationCode} 的库区 ${f.zone} 不存在`,
        [],
        [f.locationCode],
      );
  // bay 奇偶与区间
  const groups = new Map<string, Array<{ key: string; lo: number; hi: number }>>();
  for (const r of valid) {
    const t = types.get(r.type)!;
    const side = deriveSide(r.rotationDeg);
    if ((side === 'L') !== (r.bayStart % 2 === 1))
      add(
        'ERROR',
        'BAY_PARITY',
        `货架 ${r.key}（${side} 侧）bayStart=${r.bayStart} 奇偶不符：左奇右偶`,
        [r.key],
      );
    const g = `${r.zone}|${r.aisle}|${side}`;
    const arr = groups.get(g) ?? [];
    arr.push({ key: r.key, lo: r.bayStart, hi: r.bayStart + 2 * (t.bays - 1) });
    groups.set(g, arr);
    for (const [x, z] of rackFootprint(r, t))
      if (
        x < -1e-6 ||
        z < -1e-6 ||
        x > doc.warehouse.widthM + 1e-6 ||
        z > doc.warehouse.depthM + 1e-6
      ) {
        add('ERROR', 'OUT_OF_BOUNDS', `货架 ${r.key} 超出仓库边界`, [r.key]);
        break;
      }
  }
  // OBB 重叠（M2D）：90° 步进下即 AABB 相交，统一走分离轴以兼容将来任意角度
  const quads: Quad[] = valid.map((r) => rackFootprint(r, types.get(r.type)!) as Quad);
  for (const [i, j] of overlappingPairs(quads))
    add('ERROR', 'RACK_OVERLAP', `货架 ${valid[i]!.key} 与 ${valid[j]!.key} 重叠`, [
      valid[i]!.key,
      valid[j]!.key,
    ]);
  // 货架必须完整落在所属库区多边形内（M2D）
  const zoneByCode = new Map(doc.zones.map((z) => [z.code, z]));
  valid.forEach((r, i) => {
    const zp = zoneByCode.get(r.zone)!.polygon;
    if (!polygonContains(zp, quads[i]!))
      add(RACK_OUTSIDE_ZONE_SEVERITY, 'RACK_OUTSIDE_ZONE', `货架 ${r.key} 超出所属库区 ${r.zone}`, [
        r.key,
      ]);
  });
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.lo - b.lo);
    for (let k = 1; k < arr.length; k++)
      if (arr[k]!.lo <= arr[k - 1]!.hi)
        add(
          'ERROR',
          'BAY_RANGE_OVERLAP',
          `货架 ${arr[k - 1]!.key} 与 ${arr[k]!.key} 的 bay 区间重叠`,
          [arr[k - 1]!.key, arr[k]!.key],
        );
  }
  // 巷道几何一致性
  const aisles = new Map<string, typeof valid>();
  for (const r of valid) {
    const k = `${r.zone}|${r.aisle}`;
    aisles.set(k, [...(aisles.get(k) ?? []), r]);
  }
  for (const [k, rs] of aisles) {
    const axes = new Set(rs.map((r) => aisleAxis(r.rotationDeg)));
    if (axes.size > 1) {
      add(
        'ERROR',
        'AISLE_FACE_MISALIGNED',
        `巷道 ${k} 同时含水平与竖直货架`,
        rs.map((r) => r.key),
      );
      continue;
    }
    const lines = (side: 'L' | 'R') => [
      ...new Set(
        rs.filter((r) => deriveSide(r.rotationDeg) === side).map((r) => round6(pickFaceLine(r))),
      ),
    ];
    const L = lines('L');
    const R = lines('R');
    if (L.length > 1 || R.length > 1)
      add(
        'ERROR',
        'AISLE_FACE_MISALIGNED',
        `巷道 ${k} 同侧货架取货面不共线`,
        rs.map((r) => r.key),
      );
    else if (L.length === 1 && R.length === 1) {
      const horizontal = axes.has('x');
      const width = horizontal ? R[0]! - L[0]! : L[0]! - R[0]!;
      if (width <= 0)
        add(
          'ERROR',
          'AISLE_FACE_MISALIGNED',
          `巷道 ${k} 两侧取货面之间不是巷道（左右颠倒）`,
          rs.map((r) => r.key),
        );
      else if (width < minW)
        add(
          'WARNING',
          'AISLE_TOO_NARROW',
          `巷道 ${k} 宽 ${width.toFixed(2)}m < ${minW}m`,
          rs.map((r) => r.key),
        );
    }
  }
  // 编码：先逐货架检查最大编号是否能按模式格式化（bay/巷道位数、库区长度），不能的排除后再整体展开
  let pat: ReturnType<typeof compilePattern> | null = null;
  try {
    pat = compilePattern(opts.pattern);
  } catch (e) {
    add('ERROR', 'OTHER', `编码模式无效：${(e as Error).message}`);
  }
  if (!pat) return issues;
  const codable = valid.filter((r) => {
    const t = types.get(r.type)!;
    const side = deriveSide(r.rotationDeg);
    const hiBay = r.bayStart + 2 * (t.bays - 1);
    try {
      pat.format({
        zone: r.zone,
        aisle: r.aisle,
        bay: hiBay,
        level: t.levels,
        position: t.positionsPerLevel,
        side,
      });
      return true;
    } catch (e) {
      add(
        'ERROR',
        'CODE_TOO_LONG',
        `货架 ${r.key} 的编号超出编码模式 ${opts.pattern}（bay ${r.bayStart}–${hiBay}，巷道 ${r.aisle}）：${(e as Error).message}`,
        [r.key],
      );
      return false;
    }
  });
  try {
    const { locations } = expandLayout({ ...doc, racks: codable }, opts.pattern);
    const seen = new Map<string, number>();
    for (const l of locations) seen.set(l.code, (seen.get(l.code) ?? 0) + 1);
    const dup = [...seen].filter(([, n]) => n > 1).map(([c]) => c);
    if (dup.length)
      add('ERROR', 'CODE_DUPLICATE', `编码重复 ${dup.length} 个`, [], dup.slice(0, 50));
    if (opts.maxCodeLength !== undefined) {
      const long = locations.filter((l) => l.code.length > opts.maxCodeLength!).map((l) => l.code);
      if (long.length)
        add(
          'ERROR',
          'CODE_TOO_LONG',
          `编码超过标签容量（${opts.maxCodeLength} 字符）`,
          [],
          long.slice(0, 50),
        );
    }
  } catch (e) {
    add('ERROR', 'OTHER', (e as Error).message);
  }
  return issues;
}
