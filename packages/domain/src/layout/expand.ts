import type { LayoutDoc, LayoutIssue, RackTypeSpec, ZoneKind } from '@wms3d/contracts';
import { compilePattern, rackCode } from '../core/coding.ts';
import {
  aisleAxis,
  bayNumber,
  cellWorld,
  deriveSide,
  pickFaceLine,
  rackFootprint,
  type Vec3,
} from '../core/geometry.ts';

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

export interface ValidateOptions {
  pattern: string;
  /** 标签模板容量折算的最大编码长度（M30）；不传则不校验 */
  maxCodeLength?: number;
  minAisleWidthM?: number;
}

/**
 * 布局校验（02 §3.1、§9 step 2）。M0b 参考实现覆盖：未知库区/模板、bay 奇偶、bay 区间重叠、编码重复/超长、
 * 巷道取货面共线与宽度、越界。**OBB 重叠（RACK_OVERLAP）与 RACK_OUTSIDE_ZONE 由 WS-D1 在 M2D 补齐。**
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
      ...new Set(rs.filter((r) => deriveSide(r.rotationDeg) === side).map((r) => pickFaceLine(r))),
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
  // 编码
  try {
    const { locations } = expandLayout({ ...doc, racks: valid }, opts.pattern);
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
