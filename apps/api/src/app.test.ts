import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, Problem, routeList } from '@wms3d/contracts';
import { buildApp } from './app.ts';
import type { AuthContext } from './lib/auth.ts';

const WH = '00000000-0000-4000-8000-000000000001';
const OTHER_WH = '00000000-0000-4000-8000-000000000002';
const operator: AuthContext = {
  userId: 'u1',
  role: 'OPERATOR',
  warehouseIds: [WH],
  deviceId: 'dev-1',
  sessionId: 's1',
  mustChangePassword: false,
};

function appWith(auth: AuthContext | null = operator, env: NodeJS.ProcessEnv = {}) {
  return buildApp({
    env,
    configure: (s) => {
      s.verifyToken = async (t) => (t === 'good' ? auth : null);
    },
  });
}
const H = { authorization: 'Bearer good' };

describe('API 外壳', () => {
  it('health 含契约版本；ready 无库时 503', async () => {
    const app = buildApp({ env: {} });
    const h = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({
      status: 'ok',
      service: 'wms3d-api',
      contractVersion: CONTRACT_VERSION,
    });
    const r = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(r.statusCode).toBe(503);
    await app.close();
  });

  it.skipIf(!process.env.DATABASE_URL)('ready 有库时 200', async () => {
    const app = buildApp({ databaseUrl: process.env.DATABASE_URL, env: {} });
    expect((await app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode).toBe(200);
    await app.close();
  });

  it('所有契约路由均已注册（实现或 501 桩）', async () => {
    const app = buildApp({ env: {} });
    await app.ready();
    expect(app.stubRoutes.length + 2).toBe(routeList.length); // health/ready 已实现
    await app.close();
  });

  it('未知路径 → 404 problem+json', async () => {
    const app = buildApp({ env: {} });
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(Problem.parse(res.json()).code).toBe('NOT_FOUND');
    await app.close();
  });

  it('无 token → 401；角色不足 → 403；越权仓库 → 404；授权后未实现 → 501', async () => {
    const app = appWith();
    const me = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(me.statusCode).toBe(401);
    expect(me.json().code).toBe('UNAUTHENTICATED');
    const users = await app.inject({ method: 'GET', url: '/api/v1/users', headers: H });
    expect(users.json().code).toBe('FORBIDDEN');
    const bal = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/balances?warehouseId=${OTHER_WH}`,
      headers: H,
    });
    expect(bal.statusCode).toBe(404);
    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/balances?warehouseId=${WH}`,
      headers: H,
    });
    expect(ok.statusCode).toBe(501);
    expect(ok.json().code).toBe('NOT_IMPLEMENTED');
    await app.close();
  });

  it('需改密时仅放行 allowWhenPasswordChangeRequired 路由', async () => {
    const app = appWith({ ...operator, mustChangePassword: true });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/inventory/balances?warehouseId=${WH}`,
          headers: H,
        })
      ).json().code,
    ).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: H })).statusCode).toBe(
      501,
    );
    await app.close();
  });

  it('请求校验失败 → 400 VALIDATION_FAILED（带 errors）；缺幂等键 → 400', async () => {
    const app = appWith();
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/balances?warehouseId=not-a-uuid',
      headers: H,
    });
    expect(bad.statusCode).toBe(400);
    const p = Problem.parse(bad.json());
    expect(p.code).toBe('VALIDATION_FAILED');
    expect(p.errors?.length).toBeGreaterThan(0);
    const txn = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transactions',
      headers: H,
      payload: {
        type: 'INBOUND',
        warehouseId: WH,
        lines: [{ locationCode: 'A01-01-A01', skuBarcode: '6901234567892', qty: 1 }],
      },
    });
    expect(txn.statusCode).toBe(400);
    expect(txn.json().detail).toMatch(/Idempotency-Key/);
    await app.close();
  });

  it('OpenAPI 与 Swagger UI 可访问', async () => {
    const app = buildApp({ env: {} });
    const doc = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(doc.json().info.version).toBe(CONTRACT_VERSION);
    const ui = await app.inject({ method: 'GET', url: '/api/v1/docs/' });
    expect(ui.statusCode).toBe(200);
    await app.close();
  });

  it('CORS：只放行 allowlist', async () => {
    const app = buildApp({ env: { PORT_ADMIN: '4010', PORT_MOBILE: '4020' } });
    const pre = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/api/v1/health',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
    expect((await pre('https://localhost')).headers['access-control-allow-origin']).toBe(
      'https://localhost',
    );
    expect((await pre('http://127.0.0.1:4020')).headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:4020',
    );
    expect(
      (await pre('https://evil.example')).headers['access-control-allow-origin'],
    ).toBeUndefined();
    await app.close();
  });

  it('事件总线按仓库投递', () => {
    const app = buildApp({ env: {} });
    const got: string[] = [];
    const off = app.services.bus.subscribe(WH, (e) => got.push(e.event));
    app.services.bus.publish(OTHER_WH, { event: 'ping', data: {} } as never);
    app.services.bus.publish(WH, { event: 'ping', data: {} } as never);
    off();
    app.services.bus.publish(WH, { event: 'ping', data: {} } as never);
    expect(got).toEqual(['ping']);
  });
});
