import pg from 'pg';
import { CONTRACT_VERSION, routes } from '@wms3d/contracts';
import type { ApiModule } from '../types.ts';

/** ops 模块（tag 'ops'，归 ws-a1）：health/ready 由 Lead 在 M0b 实现；appVersion 待 A1。 */
export const opsModule: ApiModule = ({ routes: r, services }) => {
  r.register(routes.health, async () => ({
    status: 'ok' as const,
    service: 'wms3d-api',
    contractVersion: CONTRACT_VERSION,
  }));

  r.register(routes.ready, async ({ reply }) => {
    const url = services.config.databaseUrl;
    if (!url) return reply.code(503).send({ status: 'not_ready', reason: 'DATABASE_URL not set' });
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      const res = await client.query<{ v: string }>('select current_database() as v');
      return { status: 'ready' as const, database: res.rows[0]!.v };
    } catch (err) {
      return reply.code(503).send({ status: 'not_ready', reason: (err as Error).message });
    } finally {
      await client.end().catch(() => undefined);
    }
  });
};
