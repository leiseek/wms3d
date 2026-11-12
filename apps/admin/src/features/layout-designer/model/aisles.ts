import type { LayoutDoc, LayoutIssue } from '@wms3d/contracts';
import { aisleAxis, deriveSide, pickFaceLine, travelSpan } from '@wms3d/domain';
import { typeOf } from './ops';

export interface AisleGuide {
  id: string;
  zone: string;
  aisle: number;
  axis: 'x' | 'z';
  /** 巷道中线（水平巷道为 z，竖直巷道为 x）；只有一侧货架时为该侧取货面外 0.6m */
  mid: number;
  /** 两侧取货面（缺侧为 null） */
  faceL: number | null;
  faceR: number | null;
  from: number;
  to: number;
  width: number | null;
  narrow: boolean;
}

/** 由货架推导巷道（画布绘制行进方向箭头、窄巷道标黄）。 */
export function aisleGuides(
  doc: LayoutDoc,
  issues: readonly LayoutIssue[],
  minWidthM = 1.2,
): AisleGuide[] {
  const groups = new Map<string, LayoutDoc['racks']>();
  for (const r of doc.racks) {
    const k = `${r.zone}|${r.aisle}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const narrowKeys = new Set(
    issues.filter((i) => i.code === 'AISLE_TOO_NARROW').flatMap((i) => i.rackKeys),
  );
  const out: AisleGuide[] = [];
  for (const [id, rs] of groups) {
    const axis = aisleAxis(rs[0]!.rotationDeg);
    if (rs.some((r) => aisleAxis(r.rotationDeg) !== axis)) continue;
    const L = rs.filter((r) => deriveSide(r.rotationDeg) === 'L');
    const R = rs.filter((r) => deriveSide(r.rotationDeg) === 'R');
    const faceL = L.length ? pickFaceLine(L[0]!) : null;
    const faceR = R.length ? pickFaceLine(R[0]!) : null;
    let from = Infinity;
    let to = -Infinity;
    for (const r of rs) {
      const t = typeOf(doc, r);
      if (!t) continue;
      const [a, b] = travelSpan(r, t);
      from = Math.min(from, a);
      to = Math.max(to, b);
    }
    if (!Number.isFinite(from)) continue;
    // 水平巷道：L 在北（取货面朝 +Z），R 在南；竖直巷道：L 在东（取货面朝 −X），R 在西
    const sign = axis === 'x' ? 1 : -1;
    const mid =
      faceL !== null && faceR !== null
        ? (faceL + faceR) / 2
        : faceL !== null
          ? faceL + sign * 0.6
          : faceR! - sign * 0.6;
    const width =
      faceL !== null && faceR !== null ? (axis === 'x' ? faceR - faceL : faceL - faceR) : null;
    out.push({
      id,
      zone: rs[0]!.zone,
      aisle: rs[0]!.aisle,
      axis,
      mid,
      faceL,
      faceR,
      from,
      to,
      width,
      narrow:
        rs.some((r) => narrowKeys.has(r.key)) || (width !== null && width > 0 && width < minWidthM),
    });
  }
  return out;
}
