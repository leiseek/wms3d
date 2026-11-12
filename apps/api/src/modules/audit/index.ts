import { routes, type AuditResult } from '@wms3d/contracts';
import type { z } from 'zod';
import { canAccessWarehouse } from '../../lib/auth.ts';
import { ApiError } from '../../lib/problem.ts';
import type { ApiModule } from '../types.ts';
import { decodeCursor, encodeCursor, isRecord, iso, type Queryable } from '../inventory/util.ts';

interface AuditRow {
  id: string;
  at: Date;
  user_id: string | null;
  warehouse_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  result: z.output<typeof AuditResult>;
  before: unknown;
  after: unknown;
  ip: string | null;
  device_id: string | null;
  trace_id: string | null;
}

const isIdCursor = (v: unknown): v is { id: number } =>
  isRecord(v) && typeof v.id === 'number' && Number.isSafeInteger(v.id);

export async function listAuditLogs(
  q: Queryable,
  query: {
    warehouseId?: string | undefined;
    userId?: string | undefined;
    action?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const cur = decodeCursor(query.cursor, isIdCursor);
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (query.warehouseId) add('warehouse_id = ?', query.warehouseId);
  if (query.userId) add('user_id = ?', query.userId);
  if (query.action) add('action = ?', query.action);
  if (query.from) add('at >= ?::timestamptz', query.from);
  if (query.to) add('at < ?::timestamptz', query.to);
  if (cur) add('id < ?::bigint', cur.id);
  args.push(query.limit + 1);
  const r = await q.query<AuditRow>(
    `SELECT id, at, user_id, warehouse_id, action, entity, entity_id, result, before, after, ip, device_id, trace_id
       FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT $${args.length}`,
    args,
  );
  const rows = r.rows.slice(0, query.limit);
  const items = rows.map((a) => ({
    id: Number(a.id),
    at: iso(a.at),
    userId: a.user_id,
    warehouseId: a.warehouse_id,
    action: a.action,
    entity: a.entity,
    entityId: a.entity_id,
    result: a.result,
    before: a.before ?? null,
    after: a.after ?? null,
    ip: a.ip,
    deviceId: a.device_id,
    traceId: a.trace_id,
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: r.rows.length > query.limit && last ? encodeCursor({ id: last.id }) : null,
  };
}

/**
 * audit 模块（tag 'audit'，ws-a2）。policy auditRead：ADMIN 全部；MANAGER 必须传已授权的 warehouseId（否则 404，不泄露存在性）。
 * shim（docs/contract-requests/ws-a2-1.md）：无数据库时不注册。
 */
export const auditModule: ApiModule = ({ routes: r, services }) => {
  const db = services.db;
  if (!db) return;
  const pool = db.pool;
  r.register(routes.auditLogs, async ({ query, auth }) => {
    if (
      auth.role !== 'ADMIN' &&
      (!query.warehouseId || !canAccessWarehouse(auth, query.warehouseId))
    )
      throw new ApiError('NOT_FOUND');
    return listAuditLogs(pool, query);
  });
};
