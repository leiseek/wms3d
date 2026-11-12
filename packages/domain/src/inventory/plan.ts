import type { TxnCommand } from '@wms3d/contracts';

/** 已解析（locationCode/skuBarcode → id）后的命令行，由服务端在调用 planMovements 前完成解析。 */
export type ResolvedCommand =
  | {
      type: 'INBOUND' | 'OUTBOUND';
      lines: Array<{ locationId: string; skuId: string; qty: number; lotNo?: string }>;
    }
  | {
      type: 'TRANSFER';
      lines: Array<{
        fromLocationId: string;
        toLocationId: string;
        skuId: string;
        qty: number;
        lotNo?: string;
      }>;
    }
  | {
      type: 'ADJUST' | 'COUNT_ADJUST' | 'REVERSAL';
      lines: Array<{ locationId: string; skuId: string; qtyDelta: number; lotNo?: string }>;
    };

export interface MovementDelta {
  locationId: string;
  skuId: string;
  lotNo: string;
  delta: number;
}

export interface MovementPlan {
  /** 需加锁的仓位 id，升序（全局锁顺序第一段，02 §6.2） */
  lockLocations: string[];
  /** 余额变更，按 (locationId, skuId, lotNo) 升序；同键已合并；不含 0 */
  deltas: MovementDelta[];
  /** 是否含入库方向（决定 FOR UPDATE 还是 FOR SHARE） */
  hasInbound: boolean;
}

export class PlanError extends Error {
  readonly code = 'VALIDATION_FAILED' as const;
}

/** 每命令行数上限（02 §6.1）。 */
export const MAX_COMMAND_LINES = 200;

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (locationId: string, skuId: string, lotNo: string) =>
  `${locationId}\u0000${skuId}\u0000${lotNo}`;

/**
 * 计划纯函数（02 §6.1）。签名在 contract-v1 冻结；实现：WS-A2（M1）。
 * 规则：TRANSFER 展开为 (from,−q)/(to,+q)；同键合并，合并后为 0 → PlanError(VALIDATION_FAILED)；
 * 输出 `lockLocations` 升序、`deltas` 按 (locationId, skuId, lotNo) 升序（全局锁顺序，ADR-0003 §4）。
 * id 一律小写比较：PG 的 uuid 排序与小写十六进制字符串的字典序一致。
 */
export function planMovements(cmd: ResolvedCommand): MovementPlan {
  if (cmd.lines.length === 0) throw new PlanError('命令至少需要一行');
  if (cmd.lines.length > MAX_COMMAND_LINES)
    throw new PlanError(`每个命令最多 ${MAX_COMMAND_LINES} 行`);
  const raw: MovementDelta[] = [];
  const push = (locationId: string, skuId: string, lotNo: string | undefined, delta: number) => {
    if (!Number.isSafeInteger(delta) || delta === 0) throw new PlanError('数量必须是非 0 整数');
    raw.push({
      locationId: locationId.toLowerCase(),
      skuId: skuId.toLowerCase(),
      lotNo: lotNo ?? '',
      delta,
    });
  };
  switch (cmd.type) {
    case 'INBOUND':
    case 'OUTBOUND':
      for (const l of cmd.lines) {
        if (!(l.qty > 0)) throw new PlanError('qty 必须为正');
        push(l.locationId, l.skuId, l.lotNo, cmd.type === 'INBOUND' ? l.qty : -l.qty);
      }
      break;
    case 'TRANSFER':
      for (const l of cmd.lines) {
        if (!(l.qty > 0)) throw new PlanError('qty 必须为正');
        if (l.fromLocationId.toLowerCase() === l.toLocationId.toLowerCase())
          throw new PlanError('from 与 to 不能相同');
        push(l.fromLocationId, l.skuId, l.lotNo, -l.qty);
        push(l.toLocationId, l.skuId, l.lotNo, l.qty);
      }
      break;
    default:
      for (const l of cmd.lines) push(l.locationId, l.skuId, l.lotNo, l.qtyDelta);
  }
  const merged = new Map<string, MovementDelta>();
  for (const d of raw) {
    const k = keyOf(d.locationId, d.skuId, d.lotNo);
    const prev = merged.get(k);
    if (prev) prev.delta += d.delta;
    else merged.set(k, { ...d });
  }
  const deltas = [...merged.values()];
  const zero = deltas.find((d) => d.delta === 0);
  if (zero)
    throw new PlanError(`同一仓位/SKU 的数量合并后为 0（${zero.locationId} / ${zero.skuId}）`);
  deltas.sort(
    (a, b) =>
      cmpStr(a.locationId, b.locationId) || cmpStr(a.skuId, b.skuId) || cmpStr(a.lotNo, b.lotNo),
  );
  const lockLocations = [...new Set(deltas.map((d) => d.locationId))].sort(cmpStr);
  return { lockLocations, deltas, hasInbound: deltas.some((d) => d.delta > 0) };
}

export type { TxnCommand };
