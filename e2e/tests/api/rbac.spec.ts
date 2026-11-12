/**
 * RBAC / 越权回归（09 §1：矩阵由路由元数据自动生成）。HTTP 层、对 mock 与真实 API 同一套用例：
 *  1. 每个非 public 端点：无 token → 401；
 *  2. 每个端点 × 每个不在 roles 里的演示角色 → 403 FORBIDDEN（角色在校验前判定，与 body 无关，无副作用）；
 *  3. 允许的角色 GET 本仓（WH1）→ 不是 401/403；
 *  4. 仅授权 WH1 的账号（op1、viewer）GET 他仓（WH2）→ 404（03 §1.2：作用域失败一律 404，不泄露存在性）。
 * 进程内的细粒度矩阵（policy、resource resolver、写接口正向）在 apps/api 的 vitest 里（ws-a1/ws-a2），
 * 由 scripts/ci-local.sh 以 DB 模式一并运行。
 */
import { expect, test } from '@playwright/test';
import { routeList, type RouteSpec } from '../../../packages/contracts/src/index.ts';
import { DEMO_USERS, call, state, type DemoUser } from '../../lib/api.ts';
import { WH1, WH2 } from '../../lib/fixtures.ts';

const ROLE_OF: Record<DemoUser, string> = {
  admin: 'ADMIN',
  manager: 'MANAGER',
  op1: 'OPERATOR',
  op2: 'OPERATOR',
  viewer: 'VIEWER',
};
const PLACEHOLDER = '00000000-0000-4000-8000-0000000000e2';
const routes = routeList as readonly RouteSpec[];

function pathFor(spec: RouteSpec, wh: string): string {
  return spec.path.replace(/:([A-Za-z]+)/g, (_m, name: string) =>
    spec.scope.from === 'path' && spec.scope.field === name ? wh : PLACEHOLDER,
  );
}
function queryFor(spec: RouteSpec, wh: string): string | null {
  const q: Record<string, string> = {};
  if (spec.scope.from === 'query') q[spec.scope.field] = wh;
  if (!spec.query) return '';
  // 补齐常见必填参数；仍不满足 schema 的端点跳过正向/他仓用例（只做 401/403）
  for (const [k, v] of Object.entries({ q: 'SKU-001', template: 'loc-100x50' })) q[k] ??= v;
  const parsed = spec.query.safeParse(q);
  if (!parsed.success) return null;
  return `?${new URLSearchParams(q)}`;
}
const tokenOf = (u: DemoUser) => state().sessions[u].accessToken;
const isSse = (s: RouteSpec) => s.produces === 'text/event-stream';
const onlyIdParams = (s: RouteSpec) =>
  !/:/.test(s.path) || (s.scope.from === 'path' && (s.path.match(/:/g) ?? []).length === 1);

test.describe('RBAC：无 token → 401', () => {
  for (const spec of routes.filter((r) => r.roles !== 'public')) {
    test(`${spec.method} ${spec.path} (${spec.id})`, async () => {
      const r = await call<{ code: string }>(
        spec.method,
        pathFor(spec, WH1) + (queryFor(spec, WH1) ?? ''),
        {
          ...(spec.method === 'GET' || spec.method === 'DELETE' ? {} : { body: {} }),
        },
      );
      expect(r.status, r.text).toBe(401);
      expect(r.body.code).toBe('UNAUTHENTICATED');
    });
  }
});

test.describe('RBAC：角色不符 → 403', () => {
  for (const spec of routes.filter((r) => Array.isArray(r.roles))) {
    const allowed = spec.roles as readonly string[];
    for (const u of DEMO_USERS.filter((x) => x !== 'op2' && !allowed.includes(ROLE_OF[x]))) {
      test(`${u} ✗ ${spec.method} ${spec.path} (${spec.id})`, async () => {
        const r = await call<{ code: string }>(
          spec.method,
          pathFor(spec, WH1) + (queryFor(spec, WH1) ?? ''),
          {
            token: tokenOf(u),
            ...(spec.method === 'GET' || spec.method === 'DELETE' ? {} : { body: {} }),
          },
        );
        expect(r.status, r.text).toBe(403);
        expect(r.body.code).toBe('FORBIDDEN');
      });
    }
  }
});

test.describe('RBAC：允许的角色 GET 本仓 → 非 401/403', () => {
  const gets = routes.filter(
    (r) => r.method === 'GET' && r.roles !== 'public' && !isSse(r) && onlyIdParams(r),
  );
  for (const spec of gets) {
    const q = queryFor(spec, WH1);
    if (q === null) continue;
    const users = DEMO_USERS.filter(
      (u) =>
        u !== 'op2' &&
        (spec.roles === 'any' || (spec.roles as readonly string[]).includes(ROLE_OF[u])),
    );
    for (const u of users) {
      test(`${u} ✓ GET ${spec.path} (${spec.id})`, async () => {
        const r = await call(spec.method, pathFor(spec, WH1) + q, { token: tokenOf(u) });
        expect([401, 403], `${r.status} ${r.text.slice(0, 200)}`).not.toContain(r.status);
        // 501（真实 API 尚未实现）可接受；其余 5xx 一律失败
        expect(r.status === 501 || r.status < 500, `${r.status} ${r.text.slice(0, 200)}`).toBe(
          true,
        );
      });
    }
  }
});

test.describe('越权：仅 WH1 授权的账号 GET WH2 → 404', () => {
  const scoped = routes.filter(
    (r) =>
      r.method === 'GET' &&
      Array.isArray(r.roles) &&
      (r.scope.from === 'path' || r.scope.from === 'query') &&
      onlyIdParams(r),
  );
  for (const spec of scoped) {
    const q = queryFor(spec, WH2);
    if (q === null) continue;
    for (const u of (['op1', 'viewer'] as const).filter((x) =>
      (spec.roles as readonly string[]).includes(ROLE_OF[x]),
    )) {
      test(`${u} → WH2 GET ${spec.path} (${spec.id})`, async () => {
        const r = await call<{ code: string }>('GET', pathFor(spec, WH2) + q, {
          token: tokenOf(u),
        });
        expect(r.status, r.text.slice(0, 200)).toBe(404);
      });
    }
  }
});
