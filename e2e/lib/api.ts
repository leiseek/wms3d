/** 极简 HTTP 客户端（e2e 只经 HTTP，09 §1）：会话来自 global-setup 的一次性登录，避免触发 5 次/分钟登录限流。 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { STATE_FILE, type Target } from './env.ts';

export const DEMO_PASSWORD = 'Wms3d#demo';
export const DEMO_USERS = ['admin', 'manager', 'op1', 'op2', 'viewer'] as const;
export type DemoUser = (typeof DEMO_USERS)[number];

export interface SessionInfo {
  username: DemoUser;
  accessToken: string;
  userId: string;
  role: string;
  deviceId: string;
  sessionId: string;
  warehouses: { id: string; code: string }[];
}
export interface E2EState {
  target: Target;
  baseUrl: string;
  db: string | null;
  sessions: Record<DemoUser, SessionInfo>;
}

let cached: E2EState | null = null;
export function state(): E2EState {
  cached ??= JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2EState;
  return cached;
}

/** UUIDv7（03 §4.1 幂等键）：48 位毫秒时间戳 + 随机。 */
export function uuidv7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newDeviceId(prefix = 'e2e'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

export interface Res<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
  bytes: Buffer;
}

export interface ReqOpts {
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  ifMatch?: number;
  raw?: BodyInit;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  opts: ReqOpts = {},
  baseUrl = state().baseUrl,
): Promise<Res<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.ifMatch !== undefined) headers['if-match'] = String(opts.ifMatch);
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const r = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, body });
  const bytes = Buffer.from(await r.arrayBuffer());
  const text = bytes.toString('utf8');
  let parsed: unknown = text;
  if ((r.headers.get('content-type') ?? '').includes('json') && text) parsed = JSON.parse(text);
  return { status: r.status, headers: r.headers, body: parsed as T, text, bytes };
}

/** 绑定会话的便捷客户端。 */
export function as(user: DemoUser) {
  const s = state().sessions[user];
  const req =
    (method: string) =>
    <T = unknown>(path: string, opts: Omit<ReqOpts, 'token'> = {}) =>
      call<T>(method, path, { ...opts, token: s.accessToken });
  return {
    session: s,
    get: req('GET'),
    post: req('POST'),
    put: req('PUT'),
    patch: req('PATCH'),
    del: req('DELETE'),
  };
}

/** 真实 API 尚未实现的端点返回 501 NOT_IMPLEMENTED：调用方据此 test.skip（并在报告中可见），而不是误报通过。 */
export function notImplemented(r: Res): boolean {
  return r.status === 501;
}

export async function login(
  username: string,
  password = DEMO_PASSWORD,
  deviceId = newDeviceId(),
  baseUrl = state().baseUrl,
) {
  return call<{
    accessToken: string;
    user: { id: string; role: string; warehouses: { id: string; code: string }[] };
    session: { id: string };
    code?: string;
  }>(
    'POST',
    '/auth/login',
    {
      body: { username, password, deviceId, client: 'mobile', appVersion: 'e2e' },
    },
    baseUrl,
  );
}
