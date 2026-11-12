import type { z } from 'zod';
import {
  API_PREFIX,
  ERROR_TITLES,
  routes,
  type ErrorCode,
  type Problem,
  type RouteResponse,
  type RouteSpec,
  type Routes,
} from '@wms3d/contracts';

/** 服务端返回的 problem+json 错误（或网络/解析错误映射）。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'NETWORK';
  readonly problem: Problem | null;
  constructor(
    status: number,
    code: ErrorCode | 'NETWORK',
    problem: Problem | null,
    message?: string,
  ) {
    super(
      message ??
        problem?.detail ??
        problem?.title ??
        (code === 'NETWORK' ? '网络错误' : ERROR_TITLES[code]),
    );
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.problem = problem;
  }
}

type In<S> = S extends z.ZodType ? z.input<S> : never;
type Part<K extends string, S> = [S] extends [z.ZodType]
  ? undefined extends In<S>
    ? { [P in K]?: In<S> }
    : { [P in K]: In<S> }
  : { [P in K]?: never };

export type CallArgs<R extends RouteSpec> = Part<'params', R['params']> &
  Part<'query', R['query']> &
  (R['consumes'] extends 'multipart/form-data' ? { body: FormData } : Part<'body', R['body']>) & {
    /** 幂等键（Idempotency-Key 头）。库存写接口必填（UUIDv7，见 uuid v7） */
    idempotencyKey?: string;
    /** If-Match: rowVersion */
    ifMatch?: number;
    /** If-None-Match（ETag 路由） */
    ifNoneMatch?: string;
    signal?: AbortSignal;
  };

/** JSON 路由返回解析后的响应体；非 JSON（PDF/CSV/SSE）返回原始 Response；304 返回 null。 */
export type CallResult<R extends RouteSpec> = R['produces'] extends
  'application/pdf' | 'text/csv' | 'text/event-stream' | 'application/octet-stream'
  ? Response
  : RouteResponse<R> | (R['etag'] extends true ? null : never);

export interface ApiClientOptions {
  /** 缺省 ''（同源，经 Vite 代理或同源部署） */
  baseUrl?: string;
  /** 当前 access token（内存中） */
  getAccessToken: () => string | null | undefined;
  /**
   * 401 时调用（single-flight：并发 401 只触发一次）。返回 true 表示已刷新成功、重试原请求；
   * 返回 false 表示需重新登录（客户端随后收到 UNAUTHENTICATED）。
   */
  refresh?: () => Promise<boolean>;
  fetch?: typeof fetch;
  /** web：'include' 以携带 refresh cookie（同源时 'same-origin' 即可） */
  credentials?: RequestCredentials;
}

export function buildPath(
  spec: RouteSpec,
  params: Record<string, unknown> | undefined,
  query: Record<string, unknown> | undefined,
): string {
  const path = spec.path.replace(/:([A-Za-z]+)/g, (_m, k: string) => {
    const v = params?.[k];
    if (v === undefined || v === null) throw new Error(`缺少路径参数 ${k}（${spec.id}）`);
    return encodeURIComponent(String(v));
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== null) qs.set(k, String(v));
  const q = qs.toString();
  return `${API_PREFIX}${path}${q ? `?${q}` : ''}`;
}

async function toError(res: Response): Promise<ApiError> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    try {
      const p = (await res.json()) as Problem;
      if (p && typeof p.code === 'string') return new ApiError(res.status, p.code, p);
    } catch {
      /* fallthrough */
    }
  }
  return new ApiError(
    res.status,
    res.status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED',
    null,
    `HTTP ${res.status}`,
  );
}

export interface ApiClient {
  call<R extends RouteSpec>(spec: R, args: CallArgs<R>): Promise<CallResult<R>>;
  /** 便捷形式：api.r.listBalances({ query: { warehouseId } }) */
  r: { [K in keyof Routes]: (args: CallArgs<Routes[K]>) => Promise<CallResult<Routes[K]>> };
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = opts.baseUrl ?? '';
  let refreshing: Promise<boolean> | null = null;
  const refreshOnce = () => {
    if (!opts.refresh) return Promise.resolve(false);
    refreshing ??= opts.refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  async function call<R extends RouteSpec>(spec: R, args: CallArgs<R>): Promise<CallResult<R>> {
    const a = args as {
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
      idempotencyKey?: string;
      ifMatch?: number;
      ifNoneMatch?: string;
      signal?: AbortSignal;
    };
    const url = base + buildPath(spec, a.params, a.query);
    const send = async (): Promise<Response> => {
      const headers = new Headers({
        accept: [spec.produces ?? 'application/json', ...(spec.alsoProduces ?? [])].join(', '),
      });
      const token = opts.getAccessToken();
      if (token) headers.set('authorization', `Bearer ${token}`);
      if (a.idempotencyKey) headers.set('idempotency-key', a.idempotencyKey);
      if (a.ifMatch !== undefined) headers.set('if-match', String(a.ifMatch));
      if (a.ifNoneMatch) headers.set('if-none-match', a.ifNoneMatch);
      let body: BodyInit | undefined;
      if (a.body instanceof FormData) body = a.body;
      else if (a.body !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(a.body);
      } else if (spec.body && spec.method !== 'GET' && spec.method !== 'DELETE') {
        headers.set('content-type', 'application/json');
        body = '{}';
      }
      const init: RequestInit = {
        method: spec.method,
        headers,
        credentials: opts.credentials ?? 'same-origin',
      };
      if (body !== undefined) init.body = body;
      if (a.signal) init.signal = a.signal;
      try {
        return await f(url, init);
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new ApiError(0, 'NETWORK', null, (e as Error).message);
      }
    };
    let res = await send();
    if (res.status === 401 && spec.roles !== 'public' && (await refreshOnce())) res = await send();
    if (res.status === 304) return null as CallResult<R>;
    if (!res.ok) throw await toError(res);
    if (spec.produces && spec.produces !== 'application/json') return res as CallResult<R>;
    if (res.status === 204) return undefined as CallResult<R>;
    return (await res.json()) as CallResult<R>;
  }

  const r = Object.fromEntries(
    Object.entries(routes).map(([k, spec]) => [
      k,
      (args: unknown) => call(spec as RouteSpec, (args ?? {}) as never),
    ]),
  ) as unknown as ApiClient['r'];
  return { call, r };
}
