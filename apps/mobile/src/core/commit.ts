import type { TxnCommandInput } from '@wms3d/contracts';
import type { EnqueueInput } from './outbox.ts';
import type { CommitLine } from './workflow.ts';

const VERB = { PUTAWAY: '上架', PICK: '出库', TRANSFER: '移库' } as const;

/** 状态机提交 → outbox 入队参数（qty 为基本单位；离线原文条码按“扫码次数 × 包装数”由服务端换算） */
export function toEnqueue(
  c: CommitLine,
  ctx: { warehouseId: string; performedBy: string; performerSessionId: string; online: boolean },
): EnqueueInput {
  const skuLabel = c.line.sku?.code ?? `条码 ${c.line.rawBarcode}`;
  let type: EnqueueInput['type'];
  let lines: TxnCommandInput['lines'];
  let label: string;
  if (c.mode === 'TRANSFER') {
    if (!c.target || !c.line.sku) throw new Error('移库需要目标仓位与已识别 SKU');
    type = 'TRANSFER';
    lines = [
      {
        fromLocationId: c.location.id,
        toLocationId: c.target.id,
        skuId: c.line.sku.id,
        qty: c.line.qty,
      },
    ];
    label = `${VERB.TRANSFER} ${c.location.code} → ${c.target.code} · ${skuLabel} ×${c.line.qty}`;
  } else {
    type = c.mode === 'PUTAWAY' ? 'INBOUND' : 'OUTBOUND';
    lines = [
      c.line.sku
        ? { locationId: c.location.id, skuId: c.line.sku.id, qty: c.line.qty }
        : { locationId: c.location.id, skuBarcode: c.line.rawBarcode!, qty: c.line.qty },
    ];
    label = `${VERB[c.mode]} ${c.location.code} · ${skuLabel} ×${c.line.qty}${c.line.sku ? '' : '（包）'}`;
  }
  return {
    type,
    warehouseId: ctx.warehouseId,
    performedBy: ctx.performedBy,
    performerSessionId: ctx.performerSessionId,
    lines,
    createdOffline: !ctx.online,
    label,
  };
}
