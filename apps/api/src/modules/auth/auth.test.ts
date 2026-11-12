import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeProtectedHeader, decodeJwt } from 'jose';
import { LoginResponse, Me, TokenResponse } from '@wms3d/contracts';
import { pgAvailable } from '../../test/pg.ts';
import { devId, login, PW, setupKit, WH1, type Kit } from '../../lib/testkit.ts';

describe.skipIf(!pgAvailable)('auth（03 §2，09 §2 #11）', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await setupKit();
  }, 60_000);
  afterAll(async () => k?.close());

  const refresh = (refreshToken: string, deviceId: string) =>
    k.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken, deviceId },
    });

  it('mobile 登录：refreshToken 在响应体；JWT HS256 + kid + 声明', async () => {
    const deviceId = devId();
    const res = await k.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'op1', password: PW, deviceId, client: 'mobile', appVersion: '0.1.0' },
    });
    expect(res.statusCode).toBe(200);
    const b = LoginResponse.parse(res.json());
    expect(b.refreshToken).toBeTruthy();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(decodeProtectedHeader(b.accessToken)).toMatchObject({ alg: 'HS256', kid: 'k1' });
    const c = decodeJwt(b.accessToken);
    expect(c).toMatchObject({
      sub: b.user.id,
      role: 'OPERATOR',
      wh: [WH1],
      did: deviceId,
      sid: b.session.id,
    });
    expect(b.session.deviceId).toBe(deviceId);
    const me = await k.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(Me.parse(me.json()).username).toBe('op1');
  });

  it('web 登录：HttpOnly cookie wms_rt，响应体无 refreshToken；cookie 刷新轮换', async () => {
    const deviceId = devId('web');
    const res = await k.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: PW, deviceId, client: 'web' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).toBeUndefined();
    const ck = res.cookies.find((c) => c.name === 'wms_rt')!;
    expect(ck.httpOnly).toBe(true);
    expect(ck.sameSite).toBe('Strict');
    expect(ck.path).toBe('/api/v1/auth');
    const r2 = await k.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { deviceId },
      cookies: { wms_rt: ck.value },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().refreshToken).toBeUndefined();
    expect(r2.cookies.find((c) => c.name === 'wms_rt')!.value).not.toBe(ck.value);
  });

  it('错误口令 401；不存在用户 401（同一错误）；登录失败审计聚合', async () => {
    const bad = await k.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'viewer', password: 'nope-nope', deviceId: devId(), client: 'mobile' },
      remoteAddress: '10.9.9.1',
    });
    expect(bad.statusCode).toBe(401);
    const ghost = await k.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ghost', password: 'nope-nope', deviceId: devId(), client: 'mobile' },
      remoteAddress: '10.9.9.1',
    });
    expect(ghost.statusCode).toBe(401);
    expect(ghost.json().detail).toBe(bad.json().detail);
    for (let i = 0; i < 2; i++)
      await k.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'viewer', password: 'nope-nope', deviceId: devId(), client: 'mobile' },
        remoteAddress: '10.9.9.1',
      });
    const a = await k.pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.login' AND result = 'FAILED' AND ip = '10.9.9.1'`,
    );
    expect(a.rows[0].n).toBe(2); // viewer、ghost 各一条（1 分钟聚合）
  });

  it('同一用户名+IP 每分钟 5 次 → 429 + Retry-After', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await k.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'op2', password: 'wrong-pass', deviceId: devId(), client: 'mobile' },
        remoteAddress: '10.9.9.2',
      });
      codes.push(r.statusCode);
      if (r.statusCode === 429) expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
    // 其他 IP 不受影响
    await expect(login(k.app, 'op2', { ip: '10.9.9.3' })).resolves.toBeTruthy();
  });

  it('#11 并发刷新：同设备 60s 宽限内返回兄弟令牌，均可用；随后串行轮换', async () => {
    const s = await login(k.app, 'op1');
    const rs = await Promise.all([
      refresh(s.refreshToken, s.deviceId),
      refresh(s.refreshToken, s.deviceId),
      refresh(s.refreshToken, s.deviceId),
    ]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const toks = rs.map((r) => TokenResponse.parse(r.json()).refreshToken!);
    expect(new Set(toks).size).toBe(3);
    for (const t of toks) expect((await refresh(t, s.deviceId)).statusCode).toBe(200);
    const fam = await k.pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE sibling_of IS NOT NULL)::int AS sib, count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS rev
         FROM refresh_tokens WHERE family_id = $1`,
      [s.sessionId],
    );
    expect(fam.rows[0]).toMatchObject({ n: 7, sib: 2, rev: 0 });
  });

  it('跨设备重用 → 撤销整个家族并审计；宽限过期后重放 → 撤销', async () => {
    const s = await login(k.app, 'op1');
    const r1 = TokenResponse.parse(
      (await refresh(s.refreshToken, s.deviceId)).json(),
    ).refreshToken!;
    const other = await refresh(s.refreshToken, devId('thief'));
    expect(other.statusCode).toBe(401);
    expect((await refresh(r1, s.deviceId)).statusCode).toBe(401);
    const rev = await k.pool.query(
      `SELECT bool_and(revoked_at IS NOT NULL) AS all FROM refresh_tokens WHERE family_id = $1`,
      [s.sessionId],
    );
    expect(rev.rows[0].all).toBe(true);
    const au = await k.pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.refresh.reuse' AND entity_id = $1`,
      [s.sessionId],
    );
    expect(au.rows[0].n).toBe(1);

    const s2 = await login(k.app, 'op1');
    await refresh(s2.refreshToken, s2.deviceId);
    await k.pool.query(
      `UPDATE refresh_tokens SET replaced_at = now() - interval '61 seconds' WHERE family_id = $1 AND replaced_at IS NOT NULL`,
      [s2.sessionId],
    );
    expect((await refresh(s2.refreshToken, s2.deviceId)).statusCode).toBe(401);
    const rev2 = await k.pool.query(
      `SELECT bool_and(revoked_at IS NOT NULL) AS all FROM refresh_tokens WHERE family_id = $1`,
      [s2.sessionId],
    );
    expect(rev2.rows[0].all).toBe(true);
  });

  it('登出：会话结束，access 立即失效，refresh 失效', async () => {
    const s = await login(k.app, 'viewer');
    const out = await k.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: s.h,
      payload: { refreshToken: s.refreshToken },
    });
    expect(out.statusCode).toBe(204);
    expect(
      (await k.app.inject({ method: 'GET', url: '/api/v1/me', headers: s.h })).statusCode,
    ).toBe(401);
    expect((await refresh(s.refreshToken, s.deviceId)).statusCode).toBe(401);
  });

  it('同设备重新登录 → 旧会话结束', async () => {
    const a = await login(k.app, 'op1');
    await login(k.app, 'op2', { deviceId: a.deviceId });
    expect(
      (await k.app.inject({ method: 'GET', url: '/api/v1/me', headers: a.h })).statusCode,
    ).toBe(401);
  });

  it('改密：错误当前口令 400；成功后其他会话失效、当前保留；新口令可登录', async () => {
    const uname = 'pwuser';
    const admin = await login(k.app, 'admin');
    const cu = await k.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: admin.h,
      payload: {
        username: uname,
        displayName: 'PW',
        role: 'VIEWER',
        warehouseIds: [WH1],
        temporaryPassword: 'Temp#12345',
      },
    });
    expect(cu.statusCode).toBe(201);
    const s1 = await login(k.app, uname, { password: 'Temp#12345' });
    expect(
      (await k.app.inject({ method: 'GET', url: `/api/v1/warehouses`, headers: s1.h })).json().code,
    ).toBe('PASSWORD_CHANGE_REQUIRED');
    const s2 = await login(k.app, uname, { password: 'Temp#12345' });
    const wrong = await k.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: s1.h,
      payload: { currentPassword: 'bad-bad-bad', newPassword: 'NewPass#2026' },
    });
    expect(wrong.statusCode).toBe(400);
    const ok = await k.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: s1.h,
      payload: { currentPassword: 'Temp#12345', newPassword: 'NewPass#2026' },
    });
    expect(ok.statusCode).toBe(204);
    expect(
      (await k.app.inject({ method: 'GET', url: '/api/v1/warehouses', headers: s1.h })).statusCode,
    ).toBe(200);
    expect(
      (await k.app.inject({ method: 'GET', url: '/api/v1/me', headers: s2.h })).statusCode,
    ).toBe(401);
    await expect(login(k.app, uname, { password: 'NewPass#2026' })).resolves.toBeTruthy();
  });

  it('停用用户 → 现有 access 立即 401；禁用设备 → refresh 403 DEVICE_DISABLED', async () => {
    const admin = await login(k.app, 'admin');
    const s = await login(k.app, 'op2');
    const dis = await k.app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${s.deviceId}`,
      headers: admin.h,
      payload: { disabled: true },
    });
    expect(dis.statusCode).toBe(200);
    const r = await refresh(s.refreshToken, s.deviceId);
    expect(r.statusCode).toBe(401); // 禁用设备时已撤销该设备全部 refresh
    const relog = await k.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'op2', password: PW, deviceId: s.deviceId, client: 'mobile' },
    });
    expect(relog.json().code).toBe('DEVICE_DISABLED');
    const v = await login(k.app, 'viewer');
    const vid = (await k.pool.query(`SELECT id FROM users WHERE username='viewer'`)).rows[0].id;
    await k.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${vid}`,
      headers: admin.h,
      payload: { isActive: false },
    });
    expect(
      (await k.app.inject({ method: 'GET', url: '/api/v1/me', headers: v.h })).statusCode,
    ).toBe(401);
    await k.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${vid}`,
      headers: admin.h,
      payload: { isActive: true },
    });
  });

  it('kid 轮换：旧密钥签发的 token 在 JWT_PREVIOUS_KEYS 中仍有效', async () => {
    const s = await login(k.app, 'admin');
    const { buildApp } = await import('../../app.ts');
    const { TEST_ENV } = await import('../../lib/testkit.ts');
    const app2 = buildApp({
      databaseUrl: k.tdb.appUrl,
      env: {
        ...TEST_ENV,
        JWT_SECRET: 'rotated-secret-rotated-secret-rotated-02',
        JWT_KID: 'k2',
        JWT_PREVIOUS_KEYS: `k1:${TEST_ENV.JWT_SECRET}`,
      },
    });
    expect((await app2.inject({ method: 'GET', url: '/api/v1/me', headers: s.h })).statusCode).toBe(
      200,
    );
    const app3 = buildApp({
      databaseUrl: k.tdb.appUrl,
      env: { ...TEST_ENV, JWT_SECRET: 'rotated-secret-rotated-secret-rotated-02', JWT_KID: 'k2' },
    });
    expect((await app3.inject({ method: 'GET', url: '/api/v1/me', headers: s.h })).statusCode).toBe(
      401,
    );
    await app2.close();
    await app3.close();
  });
});
