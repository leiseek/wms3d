import { z } from 'zod';
import { AuditResult, Id, ListQuery, Timestamp } from './common.ts';

export const Dashboard = z
  .object({
    warehouseId: Id,
    asOf: Timestamp,
    locations: z.object({
      total: z.number().int(),
      occupied: z.number().int(),
      inactive: z.number().int(),
    }),
    skusInStock: z.number().int(),
    totalOnHand: z.number().int(),
    today: z
      .object({
        inbound: z.number().int(),
        outbound: z.number().int(),
        transfer: z.number().int(),
        adjust: z.number().int(),
      })
      .describe('按仓库时区（D31）'),
    lowStockCount: z.number().int(),
    pendingSync: z.object({ devices: z.number().int(), records: z.number().int() }),
    reconcile: z.object({
      lastRunAt: Timestamp.nullable(),
      mismatches: z.number().int().nullable(),
    }),
    backup: z.object({
      lastLocalAt: Timestamp.nullable(),
      lastRemoteAt: Timestamp.nullable(),
      remoteConfigured: z.boolean(),
    }),
    pendingReprints: z.number().int(),
  })
  .meta({ id: 'Dashboard' });

export const AuditLog = z
  .object({
    id: z.number().int(),
    at: Timestamp,
    userId: Id.nullable(),
    userName: z.string().nullable().optional().describe('v1.3（WS-B-2）：显示名，可选'),
    warehouseId: Id.nullable(),
    action: z.string(),
    entity: z.string(),
    entityId: z.string().nullable(),
    result: AuditResult,
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    ip: z.string().nullable(),
    deviceId: z.string().nullable(),
    traceId: z.string().nullable(),
  })
  .meta({ id: 'AuditLog' });
export const AuditQuery = ListQuery.extend({
  warehouseId: Id.optional().describe('ADMIN 可不传；MANAGER 必传且须授权'),
  userId: Id.optional(),
  action: z.string().max(64).optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
});

export const Health = z
  .object({ status: z.literal('ok'), service: z.string(), contractVersion: z.string() })
  .meta({ id: 'Health' });
export const Ready = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    database: z.string().optional(),
    reason: z.string().optional(),
  })
  .meta({ id: 'Ready' });
