import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { problem, type ErrorCode, type Problem } from '@wms3d/contracts';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** 业务错误：抛出后由统一错误处理器转为 problem+json（03 §3）。 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly extra: Partial<Problem> | undefined;
  constructor(code: ErrorCode, detail?: string, extra?: Partial<Problem>) {
    super(detail ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.extra = extra;
  }
  toProblem(traceId?: string): Problem {
    const detail = this.message === this.code ? undefined : this.message;
    return problem(this.code, detail, { ...this.extra, ...(traceId ? { traceId } : {}) });
  }
}

export function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).type(PROBLEM_CONTENT_TYPE).send(p);
}

export function installProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    const traceId = req.id;
    if (err instanceof ApiError) return sendProblem(reply, err.toProblem(traceId));
    if (hasZodFastifySchemaValidationErrors(err)) {
      const errors = err.validation.map((v) => ({
        path: `${err.validationContext ?? ''}${v.instancePath || ''}`.replace(/\//g, '.') || '.',
        message: v.message ?? 'invalid',
      }));
      return sendProblem(reply, problem('VALIDATION_FAILED', undefined, { errors, traceId }));
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, '响应不符合契约');
      return sendProblem(reply, problem('INTERNAL', '响应不符合契约', { traceId }));
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status === 429) return sendProblem(reply, problem('RATE_LIMITED', undefined, { traceId }));
    if (status >= 400 && status < 500) {
      // fastify 内置错误（JSON 解析失败、body 过大、不支持的 content-type 等）
      return sendProblem(reply, problem('VALIDATION_FAILED', err.message, { traceId }));
    }
    req.log.error({ err }, 'unhandled error');
    return sendProblem(reply, problem('INTERNAL', undefined, { traceId }));
  });
  app.setNotFoundHandler((req, reply) =>
    sendProblem(reply, problem('NOT_FOUND', `${req.method} ${req.url}`, { traceId: req.id })),
  );
}
