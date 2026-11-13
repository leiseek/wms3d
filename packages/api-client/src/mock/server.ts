import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { SSE_PING_INTERVAL_MS } from '@wms3d/contracts';
import { createMockApi, type MockApi, type MockOptions } from './core.ts';

export interface MockServerOptions extends MockOptions {
  port?: number;
  host?: string;
  logger?: boolean;
}

/**
 * 独立 mock API 服务器（`pnpm mock`）：监听本工作流的 PORT_API，admin/mobile 的 Vite 代理 `/api` 无需改动即可使用。
 * 只依赖 @wms3d/contracts 与 @wms3d/domain，不连数据库。
 */
export function buildMockServer(opts: MockServerOptions = {}): {
  app: FastifyInstance;
  api: MockApi;
} {
  const api = createMockApi(opts);
  const app = Fastify({ logger: opts.logger ?? false });
  void app.register(cors, {
    origin: true,
    credentials: true,
    exposedHeaders: ['ETag', 'Content-Disposition'],
  });
  app.addContentTypeParser('multipart/form-data', (req, payload, done) => {
    // 与 MSW 一致：把 multipart 解析成 FormData 交给 handler（WS-B-1）
    const chunks: Buffer[] = [];
    payload.on('data', (c: Buffer) => chunks.push(c));
    payload.on('end', () => {
      new Response(Buffer.concat(chunks), {
        headers: { 'content-type': String(req.headers['content-type']) },
      })
        .formData()
        .then((f) => done(null, f))
        .catch(() => done(null, undefined));
    });
  });
  app.all('/api/v1/*', async (req, reply) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    const res = await api.handle({ method: req.method, url: req.url, headers, body: req.body });
    reply.code(res.status).headers(res.headers);
    switch (res.body.kind) {
      case 'json':
        return reply.send(res.body.value);
      case 'text':
        return reply.type(res.body.contentType).send(res.body.value);
      case 'none':
        return reply.send();
      case 'sse': {
        const wh = res.body.warehouseId;
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...corsHeaders(req.headers.origin),
        });
        const send = (event: string, data: unknown) =>
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('ping', { t: Date.now() });
        const off = api.subscribe((w, e) => w === wh && send(e.event, e.data));
        const timer = setInterval(() => send('ping', { t: Date.now() }), SSE_PING_INTERVAL_MS);
        req.raw.on('close', () => {
          off();
          clearInterval(timer);
        });
        return;
      }
    }
  });
  return { app, api };
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return origin
    ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }
    : {};
}

export async function startMockServer(
  opts: MockServerOptions = {},
): Promise<{ app: FastifyInstance; api: MockApi; url: string }> {
  const { app, api } = buildMockServer(opts);
  const url = await app.listen({ port: opts.port ?? 4000, host: opts.host ?? '127.0.0.1' });
  return { app, api, url };
}
