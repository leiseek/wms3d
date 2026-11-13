import { z } from 'zod';
import { CountStatus, Id, ListQuery, StructCode, Timestamp } from './common.ts';

export const CountScope = z
  .object({
    zones: z.array(z.string()).default([]),
    rackIds: z.array(Id).default([]),
    locationIds: z.array(Id).default([]),
  })
  .refine((s) => s.zones.length + s.rackIds.length + s.locationIds.length > 0, {
    message: '范围不能为空',
  })
  .meta({ id: 'CountScope' });

export const CountTask = z
  .object({
    id: Id,
    warehouseId: Id,
    code: z.string(),
    scope: CountScope,
    blind: z.boolean(),
    status: CountStatus,
    createdBy: Id,
    createdAt: Timestamp,
    closedTxnId: Id.nullable(),
    closedAt: Timestamp.nullable(),
    progress: z.object({
      locationsTotal: z.number().int(),
      locationsSubmitted: z.number().int(),
      linesNeedingReview: z.number().int(),
    }),
  })
  .meta({ id: 'CountTask' });

export const CountCreate = z
  .object({
    warehouseId: Id,
    scope: CountScope,
    blind: z.boolean().default(true),
    note: z.string().max(200).optional(),
  })
  .meta({ id: 'CountCreate' });
export const CountsQuery = ListQuery.extend({ warehouseId: Id, status: CountStatus.optional() });

export const CountLine = z
  .object({
    id: Id,
    taskId: Id,
    locationId: Id,
    locationCode: StructCode,
    skuId: Id,
    skuCode: z.string(),
    lotNo: z.string(),
    snapshotQty: z.number().int().nullable().describe('盲盘时对 OPERATOR 隐藏（null）'),
    systemQtyAtCount: z.number().int().nullable().describe('盲盘时对 OPERATOR 隐藏（null）'),
    countedQty: z.number().int(),
    variance: z.number().int().nullable(),
    countedBy: Id,
    countedAt: Timestamp,
    clientCountedAt: Timestamp.nullable(),
    needsReview: z.boolean(),
  })
  .meta({ id: 'CountLine' });
export const CountLinesQuery = ListQuery.extend({
  location: Id.optional(),
  needsReview: z.enum(['true', 'false']).optional(),
});

/** 按仓位整体提交（02 §8 step 2）：未列出的已有 (sku, lot) 计 0；同 (task, location) 再次提交整体覆盖。 */
export const CountSubmission = z
  .object({
    submissionId: Id.describe('客户端幂等键（审计用）'),
    locationId: Id,
    clientCountedAt: Timestamp,
    lines: z
      .array(
        z.object({
          skuId: Id,
          countedQty: z.number().int().nonnegative(),
          lotNo: z.string().optional(),
        }),
      )
      .max(500),
  })
  .meta({ id: 'CountSubmission' });
export const CountSubmissionResult = z
  .object({ taskId: Id, locationId: Id, lines: z.array(CountLine), needsReview: z.boolean() })
  .meta({ id: 'CountSubmissionResult' });
export const CountClose = z
  .object({ confirmPendingOutbox: z.boolean().default(false) })
  .meta({ id: 'CountClose' });
export const CountCloseResult = z
  .object({ task: CountTask, adjustTxnId: Id.nullable() })
  .meta({ id: 'CountCloseResult' });
