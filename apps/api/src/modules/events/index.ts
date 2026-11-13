import type { ServerResponse } from 'node:http';
import type { FastifyRequest } from 'fastify';
import { routes, SSE_PING_INTERVAL_MS, type WmsEvent } from '@wms3d/contracts';
import { authHitsConnection } from '../../lib/events.ts';
import type { ApiModule } from '../types.ts';

/** access token 有效期上限（03 §2：15 分钟）；令牌不是 JWT 或无 exp 时按此关闭，客户端刷新后重连。 */
export const SSE_MAX_LIFETIME_MS = 15 * 60_000;
/** 同一用户+设备最多同时打开的 SSE 连接数（CR1 #1）；超出则关闭最旧的。 */
export const SSE_MAX_CONNECTIONS_PER_DEVICE = 3;

/**
 * 令牌过期时间（秒）：AuthContext 暂无 exp 字段（见 docs/contract-requests/ws-a2-1.md），
 * 这里从已由 verifier 验证过的 Bearer JWT 载荷读取 exp（不做二次验签）。
 */
export function tokenExpSeconds(req: FastifyRequest): number | null {
  const fromCtx = (req.auth as { exp?: unknown } | null)?.exp;
  if (typeof fromCtx === 'number') return fromCtx;
  const m = /^Bearer\s+([^.\s]+)\.([^.\s]+)\.[^.\s]*$/i.exec(req.headers.authorization ?? '');
  if (!m) return null;
  try {
    const payload = JSON.parse(Buffer.from(m[2]!, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export const sseFrame = (e: WmsEvent): string =>
  `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;

interface SseConn {
  res: ServerResponse;
  sessionId: string;
  userId: string;
  deviceId: string | null;
  warehouseId: string;
  openedAt: number;
}

/**
 * events 模块（tag 'events'，ws-a2）：SSE /events（03 §6）。
 * 连接时由外壳校验仓库授权（失败 404）；订阅 services.bus 中**该仓库**的事件；25s ping；令牌 exp 到达时服务端关流。
 * 登出 / 撤权 / 禁设备经 EventBus.invalidateAuth 立即关流（CR1 #1）。
 * shim（docs/contract-requests/ws-a2-1.md）：无数据库时不注册（与其他 ws-a2 模块一致）。
 */
export const eventsModule: ApiModule = ({ app, routes: r, services }) => {
  if (!services.db) return;
  const open = new Set<SseConn>();
  const close = (c: SseConn) => {
    if (!open.has(c)) return;
    open.delete(c);
    if (!c.res.writableEnded) c.res.end();
  };
  app.addHook('preClose', async () => {
    for (const c of [...open]) close(c);
  });
  services.bus.subscribeAuth((e) => {
    for (const c of [...open]) if (authHitsConnection(e, c)) close(c);
  });

  r.register(routes.events, async ({ req, reply, warehouseId, auth }) => {
    const wh = warehouseId!;
    const exp = tokenExpSeconds(req);
    const lifetime = Math.min(
      SSE_MAX_LIFETIME_MS,
      exp === null ? SSE_MAX_LIFETIME_MS : exp * 1000 - Date.now(),
    );
    reply.hijack();
    const res = reply.raw;
    for (const [k, v] of Object.entries(reply.getHeaders()))
      if (v !== undefined) res.setHeader(k, v);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (lifetime <= 0) {
      res.end();
      return reply;
    }
    const conn: SseConn = {
      res,
      sessionId: auth.sessionId,
      userId: auth.userId,
      deviceId: auth.deviceId,
      warehouseId: wh,
      openedAt: Date.now(),
    };
    const same = [...open].filter((c) => c.userId === auth.userId && c.deviceId === auth.deviceId);
    same.sort((a, b) => a.openedAt - b.openedAt);
    while (same.length >= SSE_MAX_CONNECTIONS_PER_DEVICE) close(same.shift()!);
    open.add(conn);
    res.write(`: connected\nretry: 3000\n\n`);
    const unsubscribe = services.bus.subscribe(wh, (e) => {
      if (e.event !== 'ping' && !res.writableEnded) res.write(sseFrame(e));
    });
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(sseFrame({ event: 'ping', data: { t: Date.now() } }));
    }, SSE_PING_INTERVAL_MS);
    const expiry = setTimeout(() => close(conn), lifetime);
    const cleanup = () => {
      unsubscribe();
      clearInterval(ping);
      clearTimeout(expiry);
      open.delete(conn);
    };
    res.on('close', cleanup);
    res.on('finish', cleanup);
    return reply;
  });
};
