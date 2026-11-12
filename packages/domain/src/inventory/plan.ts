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

/**
 * 计划纯函数（02 §6.1）。**签名在 contract-v1 冻结；实现由 WS-A2 在 M1 完成**（含单测与属性测试）。
 * 规则：TRANSFER 展开为 (from,−q)/(to,+q)；同键合并，合并后为 0 → PlanError(VALIDATION_FAILED)；输出排序如上。
 */
export function planMovements(cmd: ResolvedCommand): MovementPlan {
  void cmd;
  throw new Error('NOT_IMPLEMENTED: planMovements 由 WS-A2 实现（docs/workstreams/ws-a2.md）');
}

export type { TxnCommand };
