import type pg from 'pg';
import type { Role } from '@wms3d/contracts';
import type { AuthContext, DeviceGuard, TokenVerifier } from './auth.ts';
import { verifyAccess, type JwtKeyring } from './tokens.ts';

/**
 * 真实 verifier（WS-A1）：JWT HS256 校验 + 以 DB 为准加载角色/仓库授权/改密标记（权限变更即时生效）。
 * 会话已结束（登出）或账号停用 → 拒绝（401）。
 */
export function createDbVerifier(pool: pg.Pool, ring: JwtKeyring): TokenVerifier {
  return async (token) => {
    const claims = await verifyAccess(ring, token);
    if (!claims) return null;
    const r = await pool.query<{
      role: Role;
      all_warehouses: boolean;
      must_change_password: boolean;
      is_active: boolean;
      ended_at: Date | null;
      wh: string[];
    }>(
      `SELECT u.role, u.all_warehouses, u.must_change_password, u.is_active, s.ended_at,
              COALESCE(array_agg(uw.warehouse_id::text) FILTER (WHERE uw.warehouse_id IS NOT NULL), '{}') AS wh
         FROM users u
         JOIN device_sessions s ON s.id = $2 AND s.user_id = u.id AND s.device_id = $3
         LEFT JOIN user_warehouses uw ON uw.user_id = u.id
        WHERE u.id = $1
        GROUP BY u.id, s.ended_at`,
      [claims.sub, claims.sid, claims.did],
    );
    const row = r.rows[0];
    if (!row || !row.is_active || row.ended_at) return null;
    const ctx: AuthContext = {
      userId: claims.sub,
      role: row.role,
      warehouseIds: row.all_warehouses ? 'all' : row.wh,
      deviceId: claims.did,
      sessionId: claims.sid,
      mustChangePassword: row.must_change_password,
    };
    return ctx;
  };
}

/** 设备禁用检查（03 §2）：60s 缓存；本进程内禁用/启用时调用 invalidate 立即生效。 */
export interface CachedDeviceGuard {
  guard: DeviceGuard;
  invalidate(deviceId?: string): void;
}
export function createDeviceGuard(pool: pg.Pool, ttlMs = 60_000): CachedDeviceGuard {
  const cache = new Map<string, { disabled: boolean; at: number }>();
  return {
    guard: async (deviceId) => {
      const hit = cache.get(deviceId);
      const now = Date.now();
      if (hit && now - hit.at < ttlMs) return hit.disabled ? 'disabled' : 'ok';
      const r = await pool.query<{ disabled: boolean }>(
        `SELECT disabled_at IS NOT NULL AS disabled FROM devices WHERE id = $1`,
        [deviceId],
      );
      const disabled = r.rows[0]?.disabled ?? false;
      cache.set(deviceId, { disabled, at: now });
      if (cache.size > 10_000) cache.clear();
      return disabled ? 'disabled' : 'ok';
    },
    invalidate: (deviceId) => (deviceId ? cache.delete(deviceId) : cache.clear(), undefined),
  };
}

/** scope resolver：资源 → 仓库 id（03 §1.2）。 */
export function tableResolver(pool: pg.Pool, table: 'locations' | 'label_reprint_requests') {
  return async (id: string): Promise<string | null> => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await pool.query<{ warehouse_id: string }>(
      `SELECT warehouse_id FROM ${table} WHERE id = $1`,
      [id],
    );
    return r.rows[0]?.warehouse_id ?? null;
  };
}
