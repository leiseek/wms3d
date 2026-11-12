import type { z } from 'zod';
import type { Role } from './common.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Workstream = 'ws-a1' | 'ws-a2';

/** 仓库作用域判定（03 §1.2）：失败一律 404。 */
export type Scope =
  | { from: 'none' }
  | { from: 'path' | 'query' | 'body'; field: string }
  | { from: 'resource'; resolver: 'location' | 'txn' | 'count' | 'reprint' };

/**
 * 额外策略（服务层实现，契约只声明）：
 * - skuWrite：ADMIN，或 all_warehouses=true 的 MANAGER（组织级主数据，D25）
 * - reverse：MANAGER+ 任意；OPERATOR 仅本人、同设备、10 分钟内；COUNT_ADJUST 仅 MANAGER+；REVERSAL 不可冲正（02 §6.4）
 * - auditRead：ADMIN 全部；MANAGER 仅授权仓库
 * - draftEdit：ADMIN 与 MANAGER 可编辑草稿；发布仅 ADMIN（08 §1）
 * - adjust：ADJUST 类型仅 MANAGER+；INBOUND force=true 仅 MANAGER+
 * - countExecute：OPERATOR 可提交计数；创建/审核/关闭仅 MANAGER+
 */
export type Policy = 'skuWrite' | 'reverse' | 'auditRead' | 'draftEdit' | 'adjust' | 'countExecute';

export interface RouteSpec {
  readonly id: string;
  readonly method: HttpMethod;
  /** Fastify 风格路径（`:id`），不含 /api/v1 前缀 */
  readonly path: string;
  readonly summary: string;
  readonly tag: string;
  /** 'public' = 无需登录；'any' = 任意已登录用户 */
  readonly roles: readonly Role[] | 'public' | 'any';
  readonly scope: Scope;
  readonly policy?: Policy;
  /** must_change_password 时仍允许（/me、/me/password、/auth/logout） */
  readonly allowWhenPasswordChangeRequired?: boolean;
  readonly idempotency?: 'required' | 'optional';
  /** PUT/PATCH 需 If-Match: <rowVersion> */
  readonly ifMatch?: boolean;
  /** 库存写接口校验 devices.disabled_at（03 §2） */
  readonly checksDevice?: boolean;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly consumes?: 'application/json' | 'multipart/form-data';
  readonly produces?:
    | 'application/json'
    | 'application/pdf'
    | 'text/csv'
    | 'text/event-stream'
    | 'application/octet-stream';
  /** 状态码 → 响应体 schema（null = 无响应体）。错误响应统一为 Problem，不在此列出。 */
  readonly responses: Readonly<Record<number, z.ZodType | null>>;
  /** 可能返回的业务错误码（文档与 mock 用） */
  readonly errors?: readonly string[];
  /** ETag / 304 支持 */
  readonly etag?: boolean;
  readonly owner: Workstream;
}

export function defineRoute<const T extends RouteSpec>(r: T): T {
  return r;
}

type In<S> = S extends z.ZodType ? z.input<S> : undefined;
type Out<S> = S extends z.ZodType ? z.output<S> : undefined;
export type RouteParams<R extends RouteSpec> = In<R['params']>;
export type RouteQuery<R extends RouteSpec> = In<R['query']>;
export type RouteBody<R extends RouteSpec> = In<R['body']>;
export type ParsedParams<R extends RouteSpec> = Out<R['params']>;
export type ParsedQuery<R extends RouteSpec> = Out<R['query']>;
export type ParsedBody<R extends RouteSpec> = Out<R['body']>;
type SuccessCode<R extends RouteSpec> = Extract<keyof R['responses'], 200 | 201>;
export type RouteResponse<R extends RouteSpec> = [SuccessCode<R>] extends [never]
  ? undefined
  : R['responses'][SuccessCode<R>] extends z.ZodType
    ? z.output<R['responses'][SuccessCode<R>]>
    : undefined;
