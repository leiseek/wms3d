import { z } from 'zod';
import {
  API_PREFIX,
  problem,
  routeList,
  type ErrorCode,
  type Problem,
  type Role,
  type RouteSpec,
  type WmsEvent,
} from '@wms3d/contracts';
import { MockStore, type MockStoreOptions } from './store.ts';
import { handlers, type MockAuth } from './handlers.ts';
import { MockError, type MockResponse } from './util.ts';

export { MockError, raw, type MockBody, type MockResponse } from './util.ts';

export interface MockRequest {
  method: string;
  /** 完整 URL 或以 /api/v1 开头的路径（含查询串） */
  url: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

export interface MockOptions extends MockStoreOptions {
  /** 模拟网络延迟（毫秒），缺省 0 */
  latencyMs?: number;
  /** access token 有效期（秒），缺省 900 */
  accessTtlSec?: number;
}

interface CompiledRoute {
  spec: RouteSpec;
  re: RegExp;
  keys: string[];
}

function compile(spec: RouteSpec): CompiledRoute {
  const keys: string[] = [];
  const src = spec.path.replace(/[.]/g, '\\.').replace(/:([A-Za-z]+)/g, (_m, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { spec, re: new RegExp(`^${src}$`), keys };
}

/** 静态路径优先（与 Fastify 一致：/skus/export.csv 先于 /skus/:id） */
const ROUTES = (routeList as readonly RouteSpec[])
  .map(compile)
  .sort((a, b) => a.keys.length - b.keys.length);

function zodErrors(err: z.ZodError, where: string) {
  return err.issues.map((i) => ({
    path: [where, ...i.path.map(String)].join('.'),
    message: i.message,
  }));
}

function queryObject(sp: URLSearchParams): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of sp) o[k] = v;
  return o;
}

/** 事件订阅（SSE 适配器使用） */
type Listener = (warehouseId: string, e: WmsEvent) => void;

export interface MockApi {
  store: MockStore;
  handle(req: MockRequest): Promise<MockResponse>;
  subscribe(fn: Listener): () => void;
  emit(warehouseId: string, e: WmsEvent): void;
  /** 校验 access token（SSE 适配器用来做 exp 关流） */
  authOf(token: string | null): MockAuth | null;
  /** 已有 mock 实现的路由 id */
  implemented: ReadonlySet<string>;
}

export function createMockApi(opts: MockOptions = {}): MockApi {
  const store = new MockStore(opts);
  const listeners = new Set<Listener>();
  const ttl = opts.accessTtlSec ?? 900;

  const tokens = {
    access(a: Omit<MockAuth, 'exp'>): { token: string; expiresIn: number } {
      const exp = Math.floor(store.now().getTime() / 1000) + ttl;
      return { token: `mock.${btoa(JSON.stringify({ ...a, exp }))}`, expiresIn: ttl };
    },
    refresh(a: { userId: string; deviceId: string; sessionId: string }): string {
      return `mockr.${btoa(JSON.stringify(a))}`;
    },
    parseRefresh(
      t: string | undefined,
    ): { userId: string; deviceId: string; sessionId: string } | null {
      if (!t?.startsWith('mockr.')) return null;
      try {
        return JSON.parse(atob(t.slice(6)));
      } catch {
        return null;
      }
    },
  };

  const authOf = (token: string | null): MockAuth | null => {
    if (!token?.startsWith('mock.')) return null;
    try {
      const a = JSON.parse(atob(token.slice(5))) as MockAuth;
      if (a.exp * 1000 < store.now().getTime()) return null;
      const u = store.users.get(a.userId);
      if (!u?.isActive) return null;
      const s = store.sessions.get(a.sessionId);
      if (!s || s.endedAt) return null;
      return { ...a, role: u.role, mustChangePassword: u.mustChangePassword };
    } catch {
      return null;
    }
  };

  const emit = (warehouseId: string, e: WmsEvent) => {
    for (const l of listeners) l(warehouseId, e);
  };

  const canAccess = (auth: MockAuth, whId: string) => {
    const u = store.users.get(auth.userId)!;
    return u.allWarehouses || u.warehouseIds.includes(whId);
  };

  const resolveResource = (resolver: string, id: string): string | null => {
    switch (resolver) {
      case 'location':
        return store.locations.get(id)?.warehouseId ?? null;
      case 'txn':
        return store.txns.find((t) => t.id === id)?.warehouseId ?? null;
      case 'count':
        return store.counts.find((c) => c.id === id)?.warehouseId ?? null;
      case 'reprint':
        return store.reprints.find((r) => r.id === id)?.warehouseId ?? null;
      default:
        return null;
    }
  };

  async function handle(req: MockRequest): Promise<MockResponse> {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const url = new URL(req.url, 'http://mock.local');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {}))
      if (v !== undefined) headers[k.toLowerCase()] = v;
    const fail = (code: ErrorCode, detail?: string, extra?: Partial<Problem>): MockResponse => {
      const p = problem(code, detail, extra);
      return {
        status: p.status,
        headers: { 'content-type': 'application/problem+json' },
        body: { kind: 'json', value: p },
      };
    };
    if (!url.pathname.startsWith(API_PREFIX)) return fail('NOT_FOUND', url.pathname);
    const path = url.pathname.slice(API_PREFIX.length) || '/';
    const method = req.method.toUpperCase();
    let matched: { r: CompiledRoute; params: Record<string, string> } | null = null;
    for (const r of ROUTES) {
      if (r.spec.method !== method) continue;
      const m = r.re.exec(path);
      if (m) {
        matched = {
          r,
          params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])),
        };
        break;
      }
    }
    if (!matched) return fail('NOT_FOUND', `${method} ${url.pathname}`);
    const spec = matched.r.spec;
    try {
      // 认证与角色（先于校验，与真实 API 一致）
      const bearer = /^Bearer\s+(.+)$/i.exec(headers['authorization'] ?? '')?.[1] ?? null;
      const auth = authOf(bearer);
      if (spec.roles !== 'public') {
        if (!auth) throw new MockError('UNAUTHENTICATED');
        if (auth.mustChangePassword && !spec.allowWhenPasswordChangeRequired)
          throw new MockError('PASSWORD_CHANGE_REQUIRED');
        if (spec.roles !== 'any' && !(spec.roles as readonly Role[]).includes(auth.role))
          throw new MockError('FORBIDDEN');
        if (spec.idempotency === 'required' && !headers['idempotency-key'])
          throw new MockError('VALIDATION_FAILED', '缺少 Idempotency-Key 头');
        if (spec.ifMatch && !headers['if-match'])
          throw new MockError('PRECONDITION_FAILED', '缺少 If-Match 头');
      }
      const parse = (schema: z.ZodType | undefined, value: unknown, where: string) => {
        if (!schema) return value;
        const r = schema.safeParse(value);
        if (!r.success)
          throw new MockError('VALIDATION_FAILED', undefined, {
            errors: zodErrors(r.error, where),
          });
        return r.data;
      };
      const params = parse(spec.params, matched.params, 'params') as Record<string, string>;
      const query = parse(spec.query, queryObject(url.searchParams), 'query') as Record<
        string,
        unknown
      >;
      const body =
        spec.consumes === 'multipart/form-data'
          ? req.body
          : parse(spec.body, req.body ?? {}, 'body');
      let warehouseId: string | null = null;
      if (auth && spec.roles !== 'public' && spec.scope.from !== 'none') {
        const s = spec.scope;
        const src =
          s.from === 'path'
            ? params
            : s.from === 'query'
              ? query
              : s.from === 'body'
                ? (body as Record<string, unknown>)
                : null;
        const v =
          s.from === 'resource' ? resolveResource(s.resolver, params['id'] ?? '') : src?.[s.field];
        warehouseId = typeof v === 'string' ? v : null;
        if (!warehouseId || !store.warehouses.has(warehouseId) || !canAccess(auth, warehouseId))
          throw new MockError('NOT_FOUND');
      }
      const h = handlers[spec.id as keyof typeof handlers];
      if (!h) throw new MockError('NOT_IMPLEMENTED', `mock 未实现 ${spec.id}`);
      const out = await (h as (c: unknown) => unknown)({
        store,
        auth,
        params,
        query,
        body,
        headers,
        warehouseId,
        tokens,
        emit,
        idempotencyKey: headers['idempotency-key'] ?? null,
        ifMatch: headers['if-match']
          ? Number(headers['if-match'].replace(/^W\//, '').replace(/"/g, ''))
          : null,
      });
      if (out && typeof out === 'object' && '__mock' in out) {
        const r = (out as { __mock: MockResponse }).__mock;
        if (r.body.kind === 'text') r.headers['content-type'] = r.body.contentType;
        return r;
      }
      const success =
        spec.responses[200] !== undefined ? 200 : spec.responses[201] !== undefined ? 201 : 204;
      if (success === 204) return { status: 204, headers: {}, body: { kind: 'none' } };
      return {
        status: success,
        headers: { 'content-type': 'application/json' },
        body: { kind: 'json', value: out },
      };
    } catch (e) {
      if (e instanceof MockError)
        return fail(e.code, e.message === e.code ? undefined : e.message, e.extra);
      return fail('INTERNAL', (e as Error).message);
    }
  }

  return {
    store,
    handle,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit,
    authOf,
    implemented: new Set(Object.keys(handlers)),
  };
}
