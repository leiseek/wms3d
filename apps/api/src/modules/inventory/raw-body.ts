import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * 请求哈希需要**解析前的原始请求体**（03 §4.1）：Zod 校验会补默认值、剥离未知字段。
 * 在 preValidation（JSON 已解析、Zod 尚未校验）时深拷贝一份，按请求对象存放。
 */
const raw = new WeakMap<object, Record<string, unknown>>();
let installed = new WeakSet<FastifyInstance>();

export function installRawBodyCapture(app: FastifyInstance, urls: ReadonlySet<string>): void {
  if (installed.has(app)) return;
  installed.add(app);
  app.addHook('preValidation', async (req) => {
    const url = req.routeOptions.url;
    if (url && urls.has(url) && req.body && typeof req.body === 'object')
      raw.set(req.raw, structuredClone(req.body) as Record<string, unknown>);
  });
}

export function rawBodyOf(req: FastifyRequest): Record<string, unknown> {
  return raw.get(req.raw) ?? ((req.body ?? {}) as Record<string, unknown>);
}

/** 测试用：重置安装状态 */
export function _resetRawBodyCapture(): void {
  installed = new WeakSet();
}
