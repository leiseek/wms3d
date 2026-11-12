import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';

export interface AppOptions {
  databaseUrl?: string | undefined;
  logger?: boolean;
}

/**
 * M0a 外壳：仅 /api/v1/health 与 /api/v1/ready。
 * 路由元数据、Zod 契约、CORS allowlist、problem+json 在 M0b（R2 之后）加入。
 */
export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get('/api/v1/health', async () => ({ status: 'ok', service: 'wms3d-api' }));

  app.get('/api/v1/ready', async (_req, reply) => {
    if (!opts.databaseUrl) {
      return reply.code(503).send({ status: 'not_ready', reason: 'DATABASE_URL not set' });
    }
    const client = new pg.Client({ connectionString: opts.databaseUrl });
    try {
      await client.connect();
      const r = await client.query<{ v: string }>('select current_database() as v');
      return { status: 'ready', database: r.rows[0]?.v };
    } catch (err) {
      return reply.code(503).send({ status: 'not_ready', reason: (err as Error).message });
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  return app;
}
