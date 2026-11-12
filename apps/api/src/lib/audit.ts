import type { FastifyRequest } from 'fastify';
import type { Queryable } from './db.ts';

export interface AuditEntry {
  userId: string | null;
  warehouseId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  result?: 'SUCCESS' | 'DENIED' | 'FAILED';
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  deviceId?: string | null;
  traceId?: string | null;
}

/** 审计（08 §3，D34）：传入事务 client 即与业务同事务写入。 */
export async function writeAudit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (user_id, warehouse_id, action, entity, entity_id, result, before, after, ip, device_id, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      e.userId,
      e.warehouseId ?? null,
      e.action,
      e.entity,
      e.entityId ?? null,
      e.result ?? 'SUCCESS',
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.ip ?? null,
      e.deviceId ?? null,
      e.traceId ?? null,
    ],
  );
}

/** 从请求取审计上下文（user/device/ip/trace）。 */
export function auditCtx(
  req: FastifyRequest,
): Pick<AuditEntry, 'userId' | 'ip' | 'deviceId' | 'traceId'> {
  return {
    userId: req.auth?.userId ?? null,
    ip: req.ip ?? null,
    deviceId: req.auth?.deviceId ?? null,
    traceId: String(req.id ?? '') || null,
  };
}
