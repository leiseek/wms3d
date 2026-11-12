/** 库存数据整形（纯函数，便于单测）。 */
export interface BalanceLike {
  locationId: string;
  locationCode: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  onHand: number;
}

export interface SkuStockSummary {
  skuId: string;
  skuCode: string;
  skuName: string;
  total: number;
  locations: { locationId: string; locationCode: string; onHand: number }[];
}

/** SKU 视图：按 SKU 汇总总量，并按仓位编码排序展开明细（零库存行忽略）。 */
export function summarizeBySku(rows: readonly BalanceLike[]): SkuStockSummary[] {
  const m = new Map<string, SkuStockSummary>();
  for (const r of rows) {
    if (r.onHand === 0) continue;
    let s = m.get(r.skuId);
    if (!s) {
      s = { skuId: r.skuId, skuCode: r.skuCode, skuName: r.skuName, total: 0, locations: [] };
      m.set(r.skuId, s);
    }
    s.total += r.onHand;
    const loc = s.locations.find((l) => l.locationId === r.locationId);
    if (loc) loc.onHand += r.onHand;
    else
      s.locations.push({
        locationId: r.locationId,
        locationCode: r.locationCode,
        onHand: r.onHand,
      });
  }
  const out = [...m.values()];
  for (const s of out) s.locations.sort((a, b) => a.locationCode.localeCompare(b.locationCode));
  return out.sort((a, b) => a.skuCode.localeCompare(b.skuCode));
}

/** 定位结果 → 高亮的 locationId（去重，保持出现顺序）。 */
export function highlightIds(items: readonly { locationId: string }[]): string[] {
  return [...new Set(items.map((i) => i.locationId))];
}

export const TXN_TYPE_LABELS: Record<string, string> = {
  INBOUND: '入库',
  OUTBOUND: '出库',
  TRANSFER: '移库',
  ADJUST: '调整',
  COUNT_ADJUST: '盘点调整',
  REVERSAL: '冲正',
};

export const ADJUST_REASON_LABELS: Record<string, string> = {
  DAMAGE: '破损',
  LOST: '丢失',
  FOUND: '盘盈/找到',
  EXPIRED: '过期',
  DATA_FIX: '数据修正',
  OTHER: '其他',
};

/** 冲正可用性（前端提示用；服务端 reverse 策略为准，02 §6.4）。 */
export function reversalBlockedReason(
  txn: { type: string; reversedByTxnId: string | null },
  role: string,
): string | null {
  if (txn.type === 'REVERSAL') return '冲正单不可再冲正';
  if (txn.reversedByTxnId) return '该交易已冲正';
  if (txn.type === 'COUNT_ADJUST' && role !== 'ADMIN' && role !== 'MANAGER')
    return '盘点调整仅主管可冲正';
  if (role === 'VIEWER') return '只读用户不能冲正';
  return null;
}
