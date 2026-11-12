import type { LayoutDiff, LayoutDoc, LayoutIssue } from '@wms3d/contracts';
import {
  expandLayout,
  validateLayout,
  type ExpandResult,
  type ExpandedLocation,
} from '@wms3d/domain';

/** locations.code 列宽（varchar(32)）即编码长度上限；标签容量由渲染前校验（07 §2）。 */
export const MAX_CODE_LENGTH = 32;

export interface ExistingLoc {
  id: string;
  code: string;
  rackId: string | null;
  /** 所属货架行的 layout_key（地面仓位为 null） */
  rackKey: string | null;
  rackBayIndex: number | null;
  level: number | null;
  position: number | null;
  isActive: boolean;
  /** 在登记表中 = 在当前布局中结构存在（运行时停用仍登记；被发布停用的已释放） */
  inRegistry: boolean;
  onHand: number;
}

export interface Match {
  /** 新展开仓位下标 */
  idx: number;
  existing: ExistingLoc;
  round: 1 | 2;
  isActive: boolean;
}

export interface PublishPlan {
  expanded: ExpandResult;
  matches: Match[];
  added: number[];
  deactivated: ExistingLoc[];
  diff: LayoutDiff;
}

const cellKey = (
  rackKey: string | null,
  i: number | null,
  lv: number | null,
  p: number | null,
  code: string,
) => (rackKey === null ? `@floor|${code}` : `${rackKey}|${i}|${lv}|${p}`);

/** 服务端额外校验：货架 key / 货架码 / 库区编码重复（domain.validateLayout 未覆盖）。 */
export function extraIssues(doc: LayoutDoc, expanded: ExpandResult | null): LayoutIssue[] {
  const out: LayoutIssue[] = [];
  const dup = (vals: string[]) => {
    const seen = new Set<string>();
    const d = new Set<string>();
    for (const v of vals) (seen.has(v) ? d : seen).add(v);
    return [...d];
  };
  const keys = dup(doc.racks.map((r) => r.key));
  if (keys.length)
    out.push({
      severity: 'ERROR',
      code: 'OTHER',
      message: `货架 key 重复：${keys.join(', ')}`,
      rackKeys: keys,
      codes: [],
    });
  const zones = dup(doc.zones.map((z) => z.code));
  if (zones.length)
    out.push({
      severity: 'ERROR',
      code: 'OTHER',
      message: `库区编码重复：${zones.join(', ')}`,
      rackKeys: [],
      codes: zones,
    });
  if (expanded) {
    const codes = dup(expanded.racks.map((r) => r.code));
    if (codes.length)
      out.push({
        severity: 'ERROR',
        code: 'CODE_DUPLICATE',
        message: `货架码重复：${codes.join(', ')}（同巷道同侧 rackNo 重复）`,
        rackKeys: expanded.racks.filter((r) => codes.includes(r.code)).map((r) => r.key),
        codes,
      });
  }
  return out;
}

export function validateDoc(
  doc: LayoutDoc,
  pattern: string,
): { issues: LayoutIssue[]; expanded: ExpandResult | null } {
  const issues = validateLayout(doc, { pattern, maxCodeLength: MAX_CODE_LENGTH });
  let expanded: ExpandResult | null = null;
  if (!issues.some((i) => i.severity === 'ERROR')) {
    try {
      expanded = expandLayout(doc, pattern);
    } catch (e) {
      issues.push({
        severity: 'ERROR',
        code: 'OTHER',
        message: (e as Error).message,
        rackKeys: [],
        codes: [],
      });
    }
  }
  issues.push(...extraIssues(doc, expanded));
  return { issues, expanded: issues.some((i) => i.severity === 'ERROR') ? null : expanded };
}

/**
 * 发布两轮匹配（02 §9 step 3，B-N3）：
 * 1. 按 (rack.layout_key, rack_bay_index, level, position)（地面仓位按 code）匹配现有仓位（含已停用）；
 * 2. 剩余新仓位按 code 匹配剩余现有仓位（已停用或本次待停用），命中则复用其 id 并改绑到新货架。
 * 其余新仓位 = 新增；其余仍启用的现有仓位 = 停用。
 */
export function planPublish(expanded: ExpandResult, existing: ExistingLoc[]): PublishPlan {
  const byCell = new Map<string, ExistingLoc>();
  for (const e of existing)
    byCell.set(cellKey(e.rackKey, e.rackBayIndex, e.level, e.position, e.code), e);
  const used = new Set<string>();
  const matches: Match[] = [];
  const pending: number[] = [];
  const activeFor = (e: ExistingLoc) => (e.inRegistry ? e.isActive : true);
  expanded.locations.forEach((l: ExpandedLocation, idx) => {
    const e = byCell.get(cellKey(l.rackKey, l.rackBayIndex, l.level, l.position, l.code));
    if (e && !used.has(e.id)) {
      used.add(e.id);
      matches.push({ idx, existing: e, round: 1, isActive: activeFor(e) });
    } else pending.push(idx);
  });
  const byCode = new Map<string, ExistingLoc>();
  for (const e of existing) if (!used.has(e.id)) byCode.set(e.code, e);
  const added: number[] = [];
  const reused: LayoutDiff['reused'] = [];
  for (const idx of pending) {
    const l = expanded.locations[idx]!;
    const e = byCode.get(l.code);
    if (e && !used.has(e.id)) {
      used.add(e.id);
      matches.push({ idx, existing: e, round: 2, isActive: activeFor(e) });
      reused.push({ locationId: e.id, code: l.code });
    } else added.push(idx);
  }
  const deactivated = existing.filter((e) => !used.has(e.id) && (e.isActive || e.inRegistry));
  let kept = 0;
  const recoded: LayoutDiff['recoded'] = [];
  for (const m of matches) {
    if (m.round !== 1) continue;
    const to = expanded.locations[m.idx]!.code;
    if (to === m.existing.code) kept++;
    else
      recoded.push({
        locationId: m.existing.id,
        from: m.existing.code,
        to,
        onHand: m.existing.onHand,
      });
  }
  return {
    expanded,
    matches,
    added,
    deactivated,
    diff: {
      added: added.map((i) => ({ code: expanded.locations[i]!.code })),
      kept,
      recoded,
      deactivated: deactivated.map((e) => ({ locationId: e.id, code: e.code, onHand: e.onHand })),
      reused,
    },
  };
}
