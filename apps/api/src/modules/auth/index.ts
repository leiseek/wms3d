import { routes, type LoginResponse } from '@wms3d/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { writeAudit, auditCtx } from '../../lib/audit.ts';
import { iso, poolOf, withTx } from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import { REFRESH_GRACE_S, REFRESH_TTL_S, sha256Hex } from '../../lib/tokens.ts';
import { loadMe } from '../../lib/views.ts';
import type { ApiModule } from '../types.ts';
import { LoginLimiter } from './limiter.ts';
import {
  ACCESS_TTL_S,
  accessFor,
  endSessions,
  endUserSessions,
  hashPassword,
  insertRefresh,
  revokeFamily,
  verifyPassword,
} from './service.ts';

export const REFRESH_COOKIE = 'wms_rt';
const COOKIE_PATH = '/api/v1/auth';

function readCookie(req: FastifyRequest): string | undefined {
  const v = (req.cookies as Record<string, string | undefined> | undefined)?.[REFRESH_COOKIE];
  return v || undefined;
}

/**
 * auth 模块（03 §2、08 §2）：argon2id 登录、JWT access（15 分钟，kid）、刷新轮换 + 同设备 60s 宽限兄弟 token（B-N13）、
 * 不同设备/超出宽限重用 → 撤销 family、登出、me、改密；登录限流/锁定与失败审计聚合。
 * Web：refresh 放 HttpOnly + SameSite=Strict cookie（Path=/api/v1/auth）；请求体必须是 JSON（表单无法跨站构造，充当 CSRF 防护）。
 */
export const authModule: ApiModule = ({ routes: r, services }) => {
  const limiter = new LoginLimiter();
  const secureCookie = services.config.nodeEnv === 'production';
  const setRefreshCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie,
      path: COOKIE_PATH,
      maxAge: REFRESH_TTL_S,
    });

  r.register(routes.authLogin, async ({ body, req, reply }) => {
    const pool = poolOf(services);
    const ip = req.ip ?? '';
    const gate = limiter.check(body.username, ip);
    if (gate.reason) {
      reply.header('Retry-After', String(gate.retryAfterS));
      throw new ApiError(
        'RATE_LIMITED',
        gate.reason === 'locked' ? '登录失败次数过多，账号已临时锁定' : '登录过于频繁，请稍后再试',
        { context: { retryAfterS: gate.retryAfterS } },
      );
    }
    const found = await pool.query<{
      id: string;
      password_hash: string;
      is_active: boolean;
      role: LoginResponse['user']['role'];
      all_warehouses: boolean;
    }>(`SELECT id, password_hash, is_active, role, all_warehouses FROM users WHERE username = $1`, [
      body.username,
    ]);
    const u = found.rows[0];
    const ok = await verifyPassword(u?.password_hash ?? null, body.password);
    if (!u || !ok || !u.is_active) {
      const locked = limiter.fail(body.username);
      if (limiter.shouldAuditFailure(body.username, ip) || locked)
        await writeAudit(pool, {
          userId: u?.id ?? null,
          action: locked ? 'auth.login.locked' : 'auth.login',
          entity: 'user',
          entityId: u?.id ?? null,
          result: 'FAILED',
          after: {
            username: body.username.slice(0, 64),
            reason: !u || !ok ? 'BAD_CREDENTIALS' : 'INACTIVE',
          },
          ip,
          deviceId: body.deviceId,
          traceId: req.id,
        });
      throw new ApiError('UNAUTHENTICATED', '用户名或密码错误');
    }
    const out = await withTx(pool, async (c) => {
      const dev = await c.query<{ disabled: boolean }>(
        `INSERT INTO devices (id, name, model, app_version, last_user_id, last_seen_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, devices.name),
           model = COALESCE(EXCLUDED.model, devices.model),
           app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
           last_user_id = EXCLUDED.last_user_id,
           last_seen_at = now()
         RETURNING disabled_at IS NOT NULL AS disabled`,
        [
          body.deviceId,
          body.deviceName ?? null,
          body.deviceModel ?? null,
          body.appVersion ?? null,
          u.id,
        ],
      );
      if (dev.rows[0]!.disabled) return null;
      // 一台设备同一时刻只有一个登录会话：结束前一位用户的会话（单据归属按 performerSessionId，不受影响，02 §6.6）
      const prev = await c.query<{ id: string }>(
        `SELECT id FROM device_sessions WHERE device_id = $1 AND ended_at IS NULL`,
        [body.deviceId],
      );
      await endSessions(
        c,
        prev.rows.map((x) => x.id),
      );
      const sess = await c.query<{ id: string; started_at: Date }>(
        `INSERT INTO device_sessions (device_id, user_id) VALUES ($1,$2) RETURNING id, started_at`,
        [body.deviceId, u.id],
      );
      const session = sess.rows[0]!;
      const rt = await insertRefresh(c, {
        userId: u.id,
        deviceId: body.deviceId,
        sessionId: session.id,
        familyId: session.id,
      });
      await writeAudit(c, {
        userId: u.id,
        action: 'auth.login',
        entity: 'user',
        entityId: u.id,
        after: { sessionId: session.id, client: body.client },
        ip,
        deviceId: body.deviceId,
        traceId: req.id,
      });
      const accessToken = await accessFor(c, services.jwt, u, body.deviceId, session.id);
      const me = (await loadMe(c, u.id))!;
      return { session, rt, accessToken, me };
    });
    if (!out) throw new ApiError('DEVICE_DISABLED');
    limiter.succeed(body.username);
    if (body.client === 'web') setRefreshCookie(reply, out.rt.token);
    return {
      accessToken: out.accessToken,
      expiresIn: ACCESS_TTL_S,
      ...(body.client === 'mobile' ? { refreshToken: out.rt.token } : {}),
      serverTime: new Date().toISOString(),
      user: out.me,
      session: {
        id: out.session.id,
        deviceId: body.deviceId,
        userId: u.id,
        startedAt: iso(out.session.started_at),
        endedAt: null,
      },
    };
  });

  r.register(routes.authRefresh, async ({ body, req, reply }) => {
    const pool = poolOf(services);
    const fromBody = body.refreshToken;
    const token = fromBody ?? readCookie(req);
    if (!token) throw new ApiError('UNAUTHENTICATED', '缺少刷新令牌');
    type Outcome =
      | { kind: 'ok'; token: string; access: string }
      | { kind: 'deny'; code: 'UNAUTHENTICATED' | 'DEVICE_DISABLED'; detail: string };
    const res = await withTx<Outcome>(pool, async (c) => {
      const t = await c.query<{
        id: string;
        user_id: string;
        device_id: string;
        session_id: string | null;
        family_id: string;
        replaced_by: string | null;
        in_grace: boolean;
        revoked: boolean;
        expired: boolean;
      }>(
        `SELECT id, user_id, device_id, session_id, family_id, replaced_by,
                (replaced_at IS NOT NULL AND replaced_at > now() - make_interval(secs => $2)) AS in_grace,
                revoked_at IS NOT NULL AS revoked, expires_at <= now() AS expired
           FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [sha256Hex(token), REFRESH_GRACE_S],
      );
      const old = t.rows[0];
      if (!old || old.revoked || old.expired || !old.session_id)
        return { kind: 'deny', code: 'UNAUTHENTICATED', detail: '刷新令牌无效或已过期' };
      const audit = (action: string, after: unknown) =>
        writeAudit(c, {
          userId: old.user_id,
          action,
          entity: 'refresh_token',
          entityId: old.family_id,
          result: 'DENIED',
          after,
          ip: req.ip,
          deviceId: body.deviceId,
          traceId: req.id,
        });
      if (old.device_id !== body.deviceId) {
        await revokeFamily(c, old.family_id);
        await audit('auth.refresh.reuse', { reason: 'OTHER_DEVICE' });
        return { kind: 'deny', code: 'UNAUTHENTICATED', detail: '刷新令牌被其他设备使用，已撤销' };
      }
      const ctx = await c.query<{
        role: 'ADMIN' | 'MANAGER' | 'OPERATOR' | 'VIEWER';
        all_warehouses: boolean;
        is_active: boolean;
        ended: boolean;
        disabled: boolean;
      }>(
        `SELECT u.role, u.all_warehouses, u.is_active, s.ended_at IS NOT NULL AS ended,
                COALESCE(d.disabled_at IS NOT NULL, false) AS disabled
           FROM users u JOIN device_sessions s ON s.id = $2
           LEFT JOIN devices d ON d.id = s.device_id
          WHERE u.id = $1`,
        [old.user_id, old.session_id],
      );
      const u = ctx.rows[0];
      if (!u || !u.is_active || u.ended)
        return { kind: 'deny', code: 'UNAUTHENTICATED', detail: '会话已结束' };
      if (u.disabled) {
        await revokeFamily(c, old.family_id);
        return { kind: 'deny', code: 'DEVICE_DISABLED', detail: '设备已被禁用' };
      }
      let siblingOf: string | null = null;
      if (old.replaced_by) {
        if (!old.in_grace) {
          await revokeFamily(c, old.family_id);
          await audit('auth.refresh.reuse', { reason: 'REPLAYED_AFTER_GRACE' });
          return { kind: 'deny', code: 'UNAUTHENTICATED', detail: '刷新令牌已被使用，已撤销' };
        }
        siblingOf = old.replaced_by;
      }
      const next = await insertRefresh(c, {
        userId: old.user_id,
        deviceId: old.device_id,
        sessionId: old.session_id,
        familyId: old.family_id,
        parentId: old.id,
        siblingOf,
      });
      if (!old.replaced_by)
        await c.query(
          `UPDATE refresh_tokens SET replaced_by = $2, replaced_at = now() WHERE id = $1`,
          [old.id, next.id],
        );
      const access = await accessFor(
        c,
        services.jwt,
        { id: old.user_id, role: u.role, all_warehouses: u.all_warehouses },
        old.device_id,
        old.session_id,
      );
      return { kind: 'ok', token: next.token, access };
    });
    if (res.kind === 'deny') {
      if (!fromBody) reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      throw new ApiError(res.code, res.detail);
    }
    if (!fromBody) setRefreshCookie(reply, res.token);
    return {
      accessToken: res.access,
      expiresIn: ACCESS_TTL_S,
      ...(fromBody ? { refreshToken: res.token } : {}),
      serverTime: new Date().toISOString(),
    };
  });

  r.register(routes.authLogout, async ({ body, auth, req, reply }) => {
    const pool = poolOf(services);
    const token = body.refreshToken ?? readCookie(req);
    await withTx(pool, async (c) => {
      if (token) {
        const t = await c.query<{ family_id: string }>(
          `SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2`,
          [sha256Hex(token), auth.userId],
        );
        if (t.rows[0]) await revokeFamily(c, t.rows[0].family_id);
      }
      await endSessions(c, [auth.sessionId]);
      await writeAudit(c, {
        ...auditCtx(req),
        action: 'auth.logout',
        entity: 'user',
        entityId: auth.userId,
        after: { sessionId: auth.sessionId },
      });
    });
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return undefined;
  });

  r.register(routes.me, async ({ auth }) => {
    const me = await loadMe(poolOf(services), auth.userId);
    if (!me) throw new ApiError('UNAUTHENTICATED');
    return me;
  });

  r.register(routes.changePassword, async ({ body, auth, req }) => {
    const pool = poolOf(services);
    const cur = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [auth.userId],
    );
    if (!(await verifyPassword(cur.rows[0]?.password_hash ?? null, body.currentPassword)))
      // 不用 401：避免客户端把它当成令牌过期而触发刷新（见 contract request ws-a1-1）
      throw new ApiError('VALIDATION_FAILED', '当前密码不正确', {
        errors: [{ path: 'currentPassword', message: '当前密码不正确' }],
      });
    if (body.newPassword === body.currentPassword)
      throw new ApiError('VALIDATION_FAILED', '新密码不能与当前密码相同', {
        errors: [{ path: 'newPassword', message: '新密码不能与当前密码相同' }],
      });
    const hash = await hashPassword(body.newPassword);
    await withTx(pool, async (c) => {
      await c.query(
        `UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`,
        [auth.userId, hash],
      );
      await endUserSessions(c, auth.userId, auth.sessionId);
      await writeAudit(c, {
        ...auditCtx(req),
        action: 'user.password.change',
        entity: 'user',
        entityId: auth.userId,
      });
    });
    return undefined;
  });
};
