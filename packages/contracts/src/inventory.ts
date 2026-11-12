import { z } from 'zod';
import {
  AdjustReason,
  Barcode,
  Id,
  IdempotencyKey,
  ListQuery,
  Qty,
  StructCode,
  Timestamp,
  TxnType,
} from './common.ts';

/**
 * 库存交易命令（02 §6、03 §5）。客户端可提交的类型只有四种；COUNT_ADJUST / REVERSAL 只由服务端生成。
 * - 幂等键在请求头 `Idempotency-Key`（UUIDv7），不在 body。
 * - 设备 ID **取自 access token 的 `did`**（R3），body 中没有 deviceId。
 * - `performedBy` ≠ 令牌用户时（换班代交，02 §6.6）必须带 `performerSessionId`。
 * - `locationCode` 接受载荷形式（`WH1.A03-17-C02`）与裸编码；`skuBarcode` 原样匹配。
 */
const Meta = {
  warehouseId: Id,
  refNo: z.string().max(64).optional(),
  note: z.string().max(500).optional(),
  performedBy: Id,
  performerSessionId: Id.optional().describe('performedBy 在本设备上的 device_sessions.id'),
  clientCreatedAt: Timestamp,
  createdOffline: z.boolean().default(false),
};
const LocRef = { locationId: Id.optional(), locationCode: z.string().max(40).optional() };
const SkuRef = { skuId: Id.optional(), skuBarcode: Barcode.optional() };
const hasLoc = (l: { locationId?: string | undefined; locationCode?: string | undefined }) =>
  (l.locationId ? 1 : 0) + (l.locationCode ? 1 : 0) === 1;
const hasSku = (l: { skuId?: string | undefined; skuBarcode?: string | undefined }) =>
  (l.skuId ? 1 : 0) + (l.skuBarcode ? 1 : 0) === 1;

export const MoveLine = z
  .object({ ...LocRef, ...SkuRef, qty: Qty })
  .refine(hasLoc, { message: 'locationId 与 locationCode 必须且只能给一个' })
  .refine(hasSku, { message: 'skuId 与 skuBarcode 必须且只能给一个' });
export const TransferLine = z
  .object({ fromLocationId: Id, toLocationId: Id, skuId: Id, qty: Qty })
  .refine((l) => l.fromLocationId !== l.toLocationId, { message: 'from 与 to 不能相同' });
export const AdjustLine = z
  .object({ locationId: Id, skuId: Id, qtyDelta: z.number().int().min(-1_000_000).max(1_000_000) })
  .refine((l) => l.qtyDelta !== 0, { message: 'qtyDelta 不能为 0' });

export const InboundCmd = z.object({
  type: z.literal('INBOUND'),
  ...Meta,
  force: z.boolean().default(false).describe('MANAGER+ 越过容量（审计）'),
  lines: z.array(MoveLine).min(1).max(200),
});
export const OutboundCmd = z.object({
  type: z.literal('OUTBOUND'),
  ...Meta,
  lines: z.array(MoveLine).min(1).max(200),
});
export const TransferCmd = z.object({
  type: z.literal('TRANSFER'),
  ...Meta,
  force: z.boolean().default(false),
  lines: z.array(TransferLine).min(1).max(200),
});
export const AdjustCmd = z
  .object({
    type: z.literal('ADJUST'),
    ...Meta,
    reason: AdjustReason,
    lines: z.array(AdjustLine).min(1).max(200),
  })
  .refine((c) => c.reason !== 'OTHER' || !!c.note, {
    message: 'reason=OTHER 必须填 note',
    path: ['note'],
  })
  .refine((c) => c.reason !== 'DATA_FIX' || !!c.refNo, {
    message: 'reason=DATA_FIX 必须填 refNo',
    path: ['refNo'],
  });

export const TxnCommand = z
  .discriminatedUnion('type', [InboundCmd, OutboundCmd, TransferCmd, AdjustCmd])
  .meta({ id: 'TxnCommand' });
export type TxnCommand = z.infer<typeof TxnCommand>;
export type TxnCommandInput = z.input<typeof TxnCommand>;
/** 请求哈希时去掉的传输层字段（03 §4.1）。 */
export const TXN_HASH_EXCLUDED_FIELDS = [
  'clientCreatedAt',
  'createdOffline',
  'performerSessionId',
] as const;

export const Txn = z
  .object({
    id: Id,
    warehouseId: Id,
    type: TxnType,
    idempotencyKey: z.string(),
    reason: AdjustReason.nullable(),
    refNo: z.string().nullable(),
    note: z.string().nullable(),
    reversesTxnId: Id.nullable(),
    reversedByTxnId: Id.nullable(),
    performedBy: Id,
    submittedBy: Id,
    deviceId: z.string().nullable(),
    createdOffline: z.boolean(),
    clientCreatedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    lines: z.array(
      z.object({
        locationId: Id,
        locationCode: StructCode,
        skuId: Id,
        skuCode: z.string(),
        lotNo: z.string(),
        qtyDelta: z.number().int(),
        balanceAfter: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'Txn' });
export type Txn = z.infer<typeof Txn>;

export const BalanceAfter = z
  .object({ locationId: Id, skuId: Id, lotNo: z.string(), onHand: z.number().int() })
  .meta({ id: 'BalanceAfter' });
export const TxnResult = z
  .object({ txn: Txn, balancesAfter: z.array(BalanceAfter), replayed: z.boolean() })
  .meta({ id: 'TxnResult' });
export type TxnResult = z.infer<typeof TxnResult>;

export const ReverseRequest = z
  .object({ note: z.string().max(500).optional(), clientCreatedAt: Timestamp.optional() })
  .meta({ id: 'ReverseRequest' });

export const TxnsQuery = ListQuery.extend({
  warehouseId: Id,
  type: TxnType.optional(),
  performedBy: Id.optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  refNo: z.string().max(64).optional(),
});

export const Balance = z
  .object({
    warehouseId: Id,
    locationId: Id,
    locationCode: StructCode,
    skuId: Id,
    skuCode: z.string(),
    skuName: z.string(),
    lotNo: z.string(),
    onHand: z.number().int(),
    updatedAt: Timestamp,
  })
  .meta({ id: 'Balance' });
export const BalancesQuery = ListQuery.extend({
  warehouseId: Id,
  skuId: Id.optional(),
  locationId: Id.optional(),
  zone: z.string().max(4).optional(),
});

export const Movement = z
  .object({
    id: z.number().int(),
    txnId: Id,
    txnType: TxnType,
    warehouseId: Id,
    locationId: Id,
    locationCode: StructCode,
    skuId: Id,
    skuCode: z.string(),
    lotNo: z.string(),
    qtyDelta: z.number().int(),
    balanceAfter: z.number().int(),
    performedBy: Id,
    createdAt: Timestamp,
  })
  .meta({ id: 'Movement' });
export const MovementsQuery = ListQuery.extend({
  warehouseId: Id,
  skuId: Id.optional(),
  locationId: Id.optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
});

export const LocateQuery = z.object({
  warehouseId: Id,
  q: z.string().min(1).max(64).describe('SKU 编码/名称/条码'),
});
export const LocateResult = z
  .object({
    layoutVersion: z.number().int(),
    skus: z.array(z.object({ id: Id, code: z.string(), name: z.string() })),
    items: z.array(
      z.object({ locationId: Id, code: StructCode, skuId: Id, qty: z.number().int() }),
    ),
  })
  .meta({
    id: 'LocateResult',
    description: '只返回 locationId，客户端用 TwinModel 的 id→index 映射（D16）',
  });

export const LowStockItem = z
  .object({
    skuId: Id,
    skuCode: z.string(),
    skuName: z.string(),
    onHand: z.number().int(),
    safetyStock: z.number().int(),
  })
  .meta({ id: 'LowStockItem' });
export const IdempotencyHeaders = z.object({ 'idempotency-key': IdempotencyKey });
