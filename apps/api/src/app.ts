import Fastify, { type FastifyInstance } from 'fastify';
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
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null);
  app.decorateRequest('warehouseId', null);
  installProblemHandlers(app);

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
    ],
    exposedHeaders: ['ETag', 'Retry-After', 'Content-Disposition'],
    maxAge: 600,
  });
  void app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
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
    },
    db,
  );
  opts.configure?.(services);

  const routes = new RouteRegistry(app, services);
  for (const [, mod] of opts.modules ?? defaultModules) mod({ app, routes, services });
  const stubRoutes = routes.registerStubs();

  app.decorate('services', services);
  app.decorate('stubRoutes', stubRoutes);
  return app as unknown as WmsApp;
}
