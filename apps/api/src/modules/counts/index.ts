import { routes } from '@wms3d/contracts';
import type { ApiModule } from '../types.ts';
import {
  closeCount,
  createCount,
  getTask,
  listCounts,
  listLines,
  submitCount,
  transition,
} from './service.ts';

/**
 * counts 模块（tag 'counts'，ws-a2）：盘点任务、提交即对账、单事务关闭。
 * shim（docs/contract-requests/ws-a2-1.md）：无数据库时不注册，外壳保持 501 桩。
 */
export const countsModule: ApiModule = ({ routes: r, services }) => {
  const db = services.db;
  if (!db) return;
  const pool = db.pool;
  services.scopeResolvers.count = async (id) => {
    const x = await pool.query<{ warehouse_id: string }>(
      `SELECT warehouse_id FROM count_tasks WHERE id = $1`,
      [id],
    );
    return x.rows[0]?.warehouse_id ?? null;
  };

  r.register(routes.createCount, async ({ body, auth, idempotencyKey, reply }) => {
    reply.code(201);
    return createCount(pool, auth, body, idempotencyKey);
  });
  r.register(routes.listCounts, async ({ query, warehouseId }) =>
    listCounts(pool, warehouseId!, query),
  );
  r.register(routes.getCount, async ({ params }) => getTask(pool, params.id));
  r.register(routes.listCountLines, async ({ params, query, auth }) =>
    listLines(pool, auth, params.id, query),
  );
  r.register(routes.startCount, async ({ params, auth }) =>
    transition(pool, auth, params.id, ['OPEN'], 'COUNTING'),
  );
  r.register(routes.reviewCount, async ({ params, auth }) =>
    transition(pool, auth, params.id, ['COUNTING'], 'REVIEW'),
  );
  r.register(routes.cancelCount, async ({ params, auth }) =>
    transition(pool, auth, params.id, ['OPEN', 'COUNTING', 'REVIEW'], 'CANCELLED'),
  );
  r.register(routes.submitCount, async ({ params, body, auth }) =>
    submitCount(pool, auth, params.id, body),
  );
  r.register(routes.closeCount, async ({ params, body, auth, req }) =>
    closeCount(pool, services.bus, auth, params.id, body.confirmPendingOutbox, {
      ip: req.ip,
      traceId: req.id,
    }),
  );
};
