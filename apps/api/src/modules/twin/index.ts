import { routes } from '@wms3d/contracts';
import { ApiError } from '../../lib/problem.ts';
import type { ApiModule } from '../types.ts';
import { computeOccupancy, OccupancyCache, TwinIndexCache } from './service.ts';

const etagMatches = (header: string | string[] | undefined, etag: string) =>
  typeof header === 'string' &&
  header
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .some((t) => t === etag || t === '*');

/**
 * twin 模块（tag 'twin'，ws-a2）：GET /warehouses/:id/twin 与 /twin/occupancy。
 * shim（docs/contract-requests/ws-a2-1.md）：无数据库时不注册。
 */
export const twinModule: ApiModule = ({ app, routes: r, services }) => {
  const db = services.db;
  if (!db) return;
  const pool = db.pool;
  const index = new TwinIndexCache(pool);
  const cache = new OccupancyCache((wh) => computeOccupancy(pool, index, wh));
  const off = services.bus.subscribeAll((wh, e) => {
    if (e.event === 'layout.published') index.invalidate(wh);
    if (
      e.event === 'stock.changed' ||
      e.event === 'locations.changed' ||
      e.event === 'layout.published'
    )
      cache.markDirty(wh);
  });
  app.addHook('onClose', async () => off());

  r.register(routes.getTwin, async ({ warehouseId, req, reply }) => {
    const wh = warehouseId!;
    const v = await index.publishedVersion(wh);
    if (v === null) throw new ApiError('NOT_FOUND', '没有已发布的布局');
    const etag = `"lv-${v}"`;
    reply.header('etag', etag).header('cache-control', 'no-cache');
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return (await index.get(wh, v)).model;
  });

  r.register(routes.getOccupancy, async ({ warehouseId, query, req, reply }) => {
    const snap = await cache.get(warehouseId!);
    if (!snap || snap.body.layoutVersion !== query.layoutVersion)
      throw new ApiError('LAYOUT_STALE', undefined, {
        context: { currentLayoutVersion: snap?.body.layoutVersion ?? null },
      });
    reply.header('etag', snap.etag).header('cache-control', 'no-cache');
    if (etagMatches(req.headers['if-none-match'], snap.etag)) return reply.code(304).send();
    return snap.body;
  });
};
