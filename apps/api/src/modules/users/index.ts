import { routes } from '@wms3d/contracts';
import { auditCtx, writeAudit } from '../../lib/audit.ts';
import {
  decodeCursor,
  encodeCursor,
  isUniqueViolation,
  isoOrNull,
  poolOf,
  withTx,
  type Queryable,
} from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import { USER_COLS, loadUser, usersView, type UserRow } from '../../lib/views.ts';
import { endUserSessions, hashPassword } from '../auth/service.ts';
import type { ApiModule } from '../types.ts';

interface DeviceRow {
  id: string;
  name: string | null;
  model: string | null;
  last_user_id: string | null;
  last_seen_at: Date | null;
  app_version: string | null;
  pending_outbox: number;
  disabled_at: Date | null;
}
const DEVICE_COLS = `id, name, model, last_user_id, last_seen_at, app_version, pending_outbox, disabled_at`;
const deviceView = (d: DeviceRow) => ({
  id: d.id,
  name: d.name,
  model: d.model,
  lastUserId: d.last_user_id,
  lastSeenAt: isoOrNull(d.last_seen_at),
  appVersion: d.app_version,
  pendingOutbox: d.pending_outbox,
  disabledAt: isoOrNull(d.disabled_at),
});

async function assertWarehousesExist(q: Queryable, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM warehouses WHERE id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  if (r.rows[0]!.n !== new Set(ids).size)
    throw new ApiError('VALIDATION_FAILED', '仓库不存在', {
      errors: [{ path: 'warehouseIds', message: '包含不存在的仓库' }],
    });
}

async function setWarehouses(q: Queryable, userId: string, ids: string[]): Promise<void> {
  await q.query(`DELETE FROM user_warehouses WHERE user_id = $1`, [userId]);
  if (ids.length)
    await q.query(
      `INSERT INTO user_warehouses (user_id, warehouse_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [userId, [...new Set(ids)]],
    );
}

/** users 模块（03 §5、08 §1）：用户 CRUD、重置密码、设备列表/禁用、心跳。 */
export const usersModule: ApiModule = ({ routes: r, services }) => {
  r.register(routes.listUsers, async ({ query }) => {
    const pool = poolOf(services);
    const after = decodeCursor<string>(query.cursor);
    const q = query.q ? `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await pool.query<UserRow>(
      `SELECT ${USER_COLS} FROM users
        WHERE ($1::text IS NULL OR username::text > $1)
          AND ($2::text IS NULL OR username::text ILIKE $2 OR display_name ILIKE $2)
        ORDER BY username::text LIMIT $3`,
      [after, q, query.limit + 1],
    );
    const more = rows.rows.length > query.limit;
    const page = rows.rows.slice(0, query.limit);
    return {
      items: await usersView(pool, page),
      nextCursor: more ? encodeCursor(page[page.length - 1]!.username) : null,
    };
  });

  r.register(routes.createUser, async ({ body, req, reply }) => {
    const pool = poolOf(services);
    const hash = await hashPassword(body.temporaryPassword);
    try {
      const user = await withTx(pool, async (c) => {
        await assertWarehousesExist(c, body.warehouseIds);
        const ins = await c.query<{ id: string }>(
          `INSERT INTO users (username, display_name, password_hash, role, all_warehouses, must_change_password)
           VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
          [body.username, body.displayName, hash, body.role, body.allWarehouses],
        );
        const id = ins.rows[0]!.id;
        await setWarehouses(c, id, body.warehouseIds);
        const u = (await loadUser(c, id))!;
        await writeAudit(c, {
          ...auditCtx(req),
          action: 'user.create',
          entity: 'user',
          entityId: id,
          after: { ...u, warehouses: u.warehouses.map((w) => w.code) },
        });
        return u;
      });
      reply.code(201);
      return user;
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError('CONFLICT', '用户名已存在');
      throw e;
    }
  });

  r.register(routes.getUser, async ({ params }) => {
    const u = await loadUser(poolOf(services), params.id);
    if (!u) throw new ApiError('NOT_FOUND', '用户不存在');
    return u;
  });

  r.register(routes.patchUser, async ({ params, body, auth, req }) => {
    const pool = poolOf(services);
    if (params.id === auth.userId) {
      if (body.isActive === false) throw new ApiError('CONFLICT', '不能停用自己');
      if (body.role && body.role !== 'ADMIN') throw new ApiError('CONFLICT', '不能降低自己的角色');
    }
    return withTx(pool, async (c) => {
      const before = await loadUser(c, params.id);
      if (!before) throw new ApiError('NOT_FOUND', '用户不存在');
      await c.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [params.id]);
      if (body.warehouseIds) await assertWarehousesExist(c, body.warehouseIds);
      await c.query(
        `UPDATE users SET
           display_name = COALESCE($2, display_name),
           role = COALESCE($3, role),
           all_warehouses = COALESCE($4, all_warehouses),
           is_active = COALESCE($5, is_active)
         WHERE id = $1`,
        [
          params.id,
          body.displayName ?? null,
          body.role ?? null,
          body.allWarehouses ?? null,
          body.isActive ?? null,
        ],
      );
      if (body.warehouseIds) await setWarehouses(c, params.id, body.warehouseIds);
      if (body.isActive === false) await endUserSessions(c, params.id);
      const after = (await loadUser(c, params.id))!;
      await writeAudit(c, {
        ...auditCtx(req),
        action: 'user.update',
        entity: 'user',
        entityId: params.id,
        before: { ...before, warehouses: before.warehouses.map((w) => w.code) },
        after: { ...after, warehouses: after.warehouses.map((w) => w.code) },
      });
      return after;
    });
  });

  r.register(routes.resetPassword, async ({ params, body, req }) => {
    const pool = poolOf(services);
    const hash = await hashPassword(body.temporaryPassword);
    await withTx(pool, async (c) => {
      const u = await c.query(
        `UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1 RETURNING id`,
        [params.id, hash],
      );
      if (!u.rowCount) throw new ApiError('NOT_FOUND', '用户不存在');
      await endUserSessions(c, params.id);
      await writeAudit(c, {
        ...auditCtx(req),
        action: 'user.password.reset',
        entity: 'user',
        entityId: params.id,
      });
    });
    return undefined;
  });

  r.register(routes.listDevices, async () => {
    const rows = await poolOf(services).query<DeviceRow>(
      `SELECT ${DEVICE_COLS} FROM devices ORDER BY last_seen_at DESC NULLS LAST, id`,
    );
    return { items: rows.rows.map(deviceView) };
  });

  r.register(routes.patchDevice, async ({ params, body, req }) => {
    const pool = poolOf(services);
    const out = await withTx(pool, async (c) => {
      const before = await c.query<DeviceRow>(
        `SELECT ${DEVICE_COLS} FROM devices WHERE id = $1 FOR UPDATE`,
        [params.id],
      );
      if (!before.rows[0]) throw new ApiError('NOT_FOUND', '设备不存在');
      const upd = await c.query<DeviceRow>(
        `UPDATE devices SET
           name = CASE WHEN $2::boolean THEN $3 ELSE name END,
           disabled_at = CASE WHEN $4::boolean IS NULL THEN disabled_at
                              WHEN $4 THEN COALESCE(disabled_at, now()) ELSE NULL END
         WHERE id = $1 RETURNING ${DEVICE_COLS}`,
        [params.id, body.name !== undefined, body.name ?? null, body.disabled ?? null],
      );
      if (body.disabled === true) {
        // 立即使该设备 refresh 失效（08 §2）；access token 在 60s 缓存内失效于库存写接口
        await c.query(
          `UPDATE refresh_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`,
          [params.id],
        );
      }
      await writeAudit(c, {
        ...auditCtx(req),
        action:
          body.disabled === true
            ? 'device.disable'
            : body.disabled === false
              ? 'device.enable'
              : 'device.update',
        entity: 'device',
        entityId: params.id,
        before: deviceView(before.rows[0]),
        after: deviceView(upd.rows[0]!),
      });
      return deviceView(upd.rows[0]!);
    });
    services.invalidateDevice(params.id);
    return out;
  });

  r.register(routes.heartbeat, async ({ body, auth }) => {
    if (body.deviceId !== auth.deviceId)
      throw new ApiError('VALIDATION_FAILED', 'deviceId 与登录设备不一致', {
        errors: [{ path: 'deviceId', message: '与令牌 did 不一致' }],
      });
    const pool = poolOf(services);
    const whOk =
      body.warehouseId &&
      (auth.warehouseIds === 'all' || auth.warehouseIds.includes(body.warehouseId));
    const r2 = await pool.query<{ disabled: boolean; now: Date }>(
      `UPDATE devices SET last_seen_at = now(), app_version = $2, pending_outbox = $3, last_user_id = $4,
              pending_warehouse_id = COALESCE((SELECT id FROM warehouses WHERE id = $5::uuid), pending_warehouse_id)
        WHERE id = $1 RETURNING disabled_at IS NOT NULL AS disabled, now() AS now`,
      [
        auth.deviceId,
        body.appVersion,
        body.pendingOutbox,
        auth.userId,
        whOk ? body.warehouseId : null,
      ],
    );
    const row = r2.rows[0];
    return {
      serverTime: (row?.now ?? new Date()).toISOString(),
      disabled: row?.disabled ?? false,
    };
  });
};
