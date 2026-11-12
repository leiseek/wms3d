import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { API_PREFIX, buildOpenApi } from '@wms3d/contracts';
import { createDb } from './db/client.ts';
import { corsAllowlist } from './lib/cors.ts';
import { installProblemHandlers } from './lib/problem.ts';
import { RouteRegistry } from './lib/routing.ts';
import { createServices, type AppServices } from './lib/services.ts';
import { createDbVerifier, createDeviceGuard, tableResolver } from './lib/verifier.ts';
import { modules as defaultModules } from './modules/index.ts';
import type { ApiModule } from './modules/types.ts';

export interface AppOptions {
  databaseUrl?: string | undefined;
  logger?: boolean;
  /** 测试可替换模块清单 */
  modules?: ReadonlyArray<readonly [string, ApiModule]>;
  /** 测试可在模块注册前覆写服务（如注入假 verifier） */
  configure?: (services: AppServices) => void;
  env?: NodeJS.ProcessEnv;
}

export interface WmsApp extends FastifyInstance {
  services: AppServices;
  /** 仍返回 501 的契约路由 id */
  stubRoutes: string[];
}

/**
 * API 外壳（M0b，02 §3）：Zod 契约校验/序列化、problem+json、CORS allowlist、OpenAPI（静态，来自 contracts）与 Swagger UI、
 * 认证/角色/仓库作用域 preHandler 骨架、事件总线。业务路由由各模块注册，未实现的返回 501。
 */
export function buildApp(opts: AppOptions = {}): WmsApp {
  const env = opts.env ?? process.env;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 5 * 1024 * 1024,
    genReqId: () => randomUUID(),
    trustProxy: env.TRUST_PROXY === '1',
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null);
  app.decorateRequest('warehouseId', null);
  installProblemHandlers(app);
  // 安全头 + traceId（08 §2/§4）
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Trace-Id', req.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  void app.register(cookie);

  const corsOrigins = corsAllowlist(env);
  void app.register(cors, {
    origin: corsOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-Match',
      'If-None-Match',
      'X-Request-Id',
      'X-Device-Id',
      'X-Trace-Id',
    ],
    exposedHeaders: ['ETag', 'Retry-After', 'Content-Disposition', 'X-Trace-Id'],
    maxAge: 600,
  });
  // CSV 导入 ≤ 5 万行（05 §3）
  void app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  void app.register(swagger, {
    mode: 'static',
    specification: { document: buildOpenApi() as never },
  });
  void app.register(swaggerUi, { routePrefix: `${API_PREFIX}/docs` });
  app.get(`${API_PREFIX}/openapi.json`, { schema: { hide: true } }, async () => buildOpenApi());

  const db = opts.databaseUrl ? createDb(opts.databaseUrl) : null;
  if (db) app.addHook('onClose', async () => db.close());
  const services = createServices(
    {
      databaseUrl: opts.databaseUrl,
      jwtSecret: env.JWT_SECRET,
      corsOrigins,
      nodeEnv: env.NODE_ENV ?? 'development',
      env,
    },
    db,
  );
  if (db) {
    // WS-A1 真实实现装配（txn / count resolver 由 WS-A2 在其模块中注入）
    services.verifyToken = createDbVerifier(db.pool, services.jwt);
    const devices = createDeviceGuard(db.pool);
    services.deviceGuard = devices.guard;
    services.invalidateDevice = devices.invalidate;
    services.scopeResolvers.location = tableResolver(db.pool, 'locations');
    services.scopeResolvers.reprint = tableResolver(db.pool, 'label_reprint_requests');
  }
  opts.configure?.(services);

  const routes = new RouteRegistry(app, services);
  for (const [, mod] of opts.modules ?? defaultModules) mod({ app, routes, services });
  const stubRoutes = routes.registerStubs();

  app.decorate('services', services);
  app.decorate('stubRoutes', stubRoutes);
  return app as unknown as WmsApp;
}
