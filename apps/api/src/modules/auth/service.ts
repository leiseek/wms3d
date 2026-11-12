import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type pg from 'pg';
import type { AccessClaims } from '@wms3d/contracts';
import type { Queryable } from '../../lib/db.ts';
import {
  ACCESS_TTL_S,
  REFRESH_TTL_S,
  newRefreshToken,
  sha256Hex,
  signAccess,
  type JwtKeyring,
} from '../../lib/tokens.ts';

export const ARGON2_OPTS = { type: argon2.argon2id } as const;
export const hashPassword = (pw: string) => argon2.hash(pw, ARGON2_OPTS);

let dummyHash: Promise<string> | null = null;
/** 用户不存在时也做一次 argon2 校验，避免按耗时枚举用户名。 */
export async function verifyPassword(hash: string | null, pw: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= argon2.hash('dummy-password-for-timing', ARGON2_OPTS);
    await argon2.verify(await dummyHash, pw).catch(() => false);
    return false;
  }
  return argon2.verify(hash, pw).catch(() => false);
}

export async function accessFor(
  q: Queryable,
  ring: JwtKeyring,
  user: { id: string; role: AccessClaims['role']; all_warehouses: boolean },
  deviceId: string,
  sessionId: string,
): Promise<string> {
  let wh: AccessClaims['wh'] = 'all';
  if (!user.all_warehouses) {
    const r = await q.query<{ id: string }>(
      `SELECT warehouse_id::text AS id FROM user_warehouses WHERE user_id = $1 ORDER BY 1`,
      [user.id],
    );
    wh = r.rows.map((x) => x.id);
  }
  return signAccess(ring, { sub: user.id, role: user.role, wh, did: deviceId, sid: sessionId });
}

export interface IssuedRefresh {
  id: string;
  token: string;
}

/** 写入一条刷新令牌（只存哈希）。 */
export async function insertRefresh(
  c: Queryable,
  o: {
    userId: string;
    deviceId: string;
    sessionId: string;
    familyId: string;
    parentId?: string | null;
    siblingOf?: string | null;
  },
): Promise<IssuedRefresh> {
  const id = randomUUID();
  const token = newRefreshToken();
  await c.query(
    `INSERT INTO refresh_tokens (id, user_id, device_id, session_id, family_id, token_hash, parent_id, sibling_of, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9))`,
    [
      id,
      o.userId,
      o.deviceId,
      o.sessionId,
      o.familyId,
      sha256Hex(token),
      o.parentId ?? null,
      o.siblingOf ?? null,
      REFRESH_TTL_S,
    ],
  );
  return { id, token };
}

export async function revokeFamily(c: Queryable, familyId: string): Promise<void> {
  await c.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
}

/** 结束会话并撤销其全部刷新令牌。 */
export async function endSessions(c: Queryable, sessionIds: string[]): Promise<void> {
  if (!sessionIds.length) return;
  await c.query(
    `UPDATE device_sessions SET ended_at = now() WHERE id = ANY($1::uuid[]) AND ended_at IS NULL`,
    [sessionIds],
  );
  await c.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
    [sessionIds],
  );
}

/** 撤销某用户全部会话（停用账号、重置密码、改密时其他设备）。 */
export async function endUserSessions(
  c: Queryable,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  const r = await c.query<{ id: string }>(
    `SELECT id FROM device_sessions WHERE user_id = $1 AND ended_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId ?? null],
  );
  await endSessions(
    c,
    r.rows.map((x) => x.id),
  );
  await c.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR session_id IS DISTINCT FROM $2::uuid)`,
    [userId, exceptSessionId ?? null],
  );
}

export { ACCESS_TTL_S };
export type PoolLike = pg.Pool;
