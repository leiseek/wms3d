import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  API_PREFIX,
  routeList,
  type ParsedBody,
  type ParsedParams,
  type ParsedQuery,
  type RouteResponse,
  type RouteSpec,
} from '@wms3d/contracts';
import { canAccessWarehouse, type AuthContext } from './auth.ts';
import { ApiError } from './problem.ts';
import type { AppServices } from './services.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** scope 判定得到的仓库 id（scope.from='none' 时为 null） */
    warehouseId: string | null;
  }
}

export interface RouteCtx<R extends RouteSpec> {
  params: ParsedParams<R>;
  query: ParsedQuery<R>;
  body: ParsedBody<R>;
  /** public 路由可能为 null；其余路由 preHandler 已保证非空 */
  auth: R['roles'] extends 'public' ? AuthContext | null : AuthContext;
  warehouseId: string | null;
  idempotencyKey: string | null;
  /** If-Match 解析出的 rowVersion */
  ifMatch: number | null;
  req: FastifyRequest;
  reply: FastifyReply;
  services: AppServices;
}

/** 返回响应体（JSON 路由），或返回 reply（已自行发送：PDF/CSV/SSE/304）。 */
export type RouteHandler<R extends RouteSpec> = (
  ctx: RouteCtx<R>,
) => Promise<RouteResponse<R> | FastifyReply>;

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

function pick(obj: unknown, field: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[field] : undefined;
}

/**
 * 通用守卫（03 §1.2），分两段：
 * - preValidation（校验之前）：认证 → 改密拦截 → 角色 → 头部要求。保证未登录先得 401 而不是 400。
 * - preHandler（校验之后）：仓库作用域（失败一律 404）→ 设备禁用。
 * policy 由服务层实现（契约只声明）。
 */
export function makeGuards(spec: RouteSpec, services: AppServices) {
  const preValidation = async (req: FastifyRequest): Promise<void> => {
    req.auth = null;
    req.warehouseId = null;
    const token = bearer(req);
    if (token) req.auth = await services.verifyToken(token);
    if (spec.roles === 'public') return;
    const auth = req.auth;
    if (!auth) throw new ApiError('UNAUTHENTICATED');
    if (auth.mustChangePassword && !spec.allowWhenPasswordChangeRequired)
      throw new ApiError('PASSWORD_CHANGE_REQUIRED');
    if (spec.roles !== 'any' && !spec.roles.includes(auth.role)) throw new ApiError('FORBIDDEN');
    if (spec.idempotency === 'required' && !req.headers['idempotency-key'])
      throw new ApiError('VALIDATION_FAILED', '缺少 Idempotency-Key 头');
    if (spec.ifMatch && !req.headers['if-match'])
      throw new ApiError('PRECONDITION_FAILED', '缺少 If-Match 头');
  };
  const preHandler = async (req: FastifyRequest): Promise<void> => {
    const auth = req.auth;
    if (spec.roles === 'public' || !auth) return;
    const scope = spec.scope;
    if (scope.from !== 'none') {
      let whId: string | null;
      if (scope.from === 'resource') {
        const resolver = services.scopeResolvers[scope.resolver];
        if (!resolver)
          throw new ApiError('NOT_IMPLEMENTED', `scope resolver '${scope.resolver}' 未注册`);
        const rid = pick(req.params, 'id');
        whId = typeof rid === 'string' ? await resolver(rid) : null;
      } else {
        const src =
          scope.from === 'path' ? req.params : scope.from === 'query' ? req.query : req.body;
        const v = pick(src, scope.field);
        whId = typeof v === 'string' ? v : null;
      }
      if (!whId || !canAccessWarehouse(auth, whId)) throw new ApiError('NOT_FOUND');
      req.warehouseId = whId;
    }
    if (spec.checksDevice && (await services.deviceGuard(auth.deviceId)) === 'disabled')
      throw new ApiError('DEVICE_DISABLED');
  };
  return { preValidation, preHandler };
}

function schemaOf(spec: RouteSpec): FastifySchema {
  const s: FastifySchema = {};
  if (spec.params) s.params = spec.params;
  if (spec.query) s.querystring = spec.query;
  if (spec.body && spec.consumes !== 'multipart/form-data') s.body = spec.body;
  if (spec.produces === undefined || spec.produces === 'application/json') {
    const response: Record<number, z.ZodType> = {};
    for (const [code, schema] of Object.entries(spec.responses))
      if (schema) response[Number(code)] = schema;
    if (Object.keys(response).length) s.response = response;
  }
  return s;
}

function parseIfMatch(v: string | string[] | undefined): number | null {
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/^W\//, '').replace(/"/g, ''));
  return Number.isInteger(n) ? n : null;
}

export class RouteRegistry {
  private readonly done = new Set<string>();
  private readonly app: FastifyInstance;
  private readonly services: AppServices;
  constructor(app: FastifyInstance, services: AppServices) {
    this.app = app;
    this.services = services;
  }

  has(id: string): boolean {
    return this.done.has(id);
  }

  register<R extends RouteSpec>(spec: R, handler: RouteHandler<R>): void {
    if (this.done.has(spec.id)) throw new Error(`路由重复注册：${spec.id}`);
    this.done.add(spec.id);
    const services = this.services;
    const successCode =
      spec.responses[200] !== undefined
        ? 200
        : spec.responses[201] !== undefined
          ? 201
          : spec.responses[204] !== undefined
            ? 204
            : 200;
    this.app.withTypeProvider<ZodTypeProvider>().route({
      method: spec.method,
      url: `${API_PREFIX}${spec.path}`,
      schema: schemaOf(spec),
      ...makeGuards(spec, services),
      handler: async (req, reply) => {
        const ctx = {
          params: req.params,
          query: req.query,
          body: req.body,
          auth: req.auth,
          warehouseId: req.warehouseId,
          idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
          ifMatch: parseIfMatch(req.headers['if-match']),
          req,
          reply,
          services,
        } as unknown as RouteCtx<R>;
        const out = await handler(ctx);
        if (out === reply) return reply;
        if (!reply.sent && reply.statusCode === 200 && successCode !== 200) reply.code(successCode);
        if (successCode === 204) return reply.send();
        return out;
      },
    });
  }

  /** 尚未实现的契约路由：仍做认证/校验，然后返回 501 problem（前端可据此识别）。 */
  registerStubs(): string[] {
    const stubs: string[] = [];
    for (const spec of routeList as readonly RouteSpec[]) {
      if (this.done.has(spec.id)) continue;
      stubs.push(spec.id);
      this.register(spec, async () => {
        throw new ApiError('NOT_IMPLEMENTED', `${spec.id}（${spec.owner}）`);
      });
    }
    return stubs;
  }
}
