import { routes } from '@wms3d/contracts';
import type { ApiModule } from '../types.ts';
import { syncDigest, syncPage } from './service.ts';

/**
 * sync 模块（tag 'sync'，ws-a2）：主数据分页增量 + 摘要。
 * shim（docs/contract-requests/ws-a2-1.md）：无数据库时不注册。
 */
export const syncModule: ApiModule = ({ routes: r, services }) => {
  const db = services.db;
  if (!db) return;
  const pool = db.pool;
  r.register(routes.syncMasterdata, async ({ query, warehouseId }) =>
    syncPage(pool, warehouseId!, query),
  );
  r.register(routes.syncDigest, async ({ warehouseId }) => syncDigest(pool, warehouseId!));
};
