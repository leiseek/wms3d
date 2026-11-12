import type { FastifyInstance } from 'fastify';
import type { RouteRegistry } from '../lib/routing.ts';
import type { AppServices } from '../lib/services.ts';

export interface ModuleContext {
  app: FastifyInstance;
  routes: RouteRegistry;
  services: AppServices;
}

/** API 模块：同步注册路由、可替换 services 中的可插拔实现。一个模块对应 contracts 的一个 tag。 */
export type ApiModule = (ctx: ModuleContext) => void;
