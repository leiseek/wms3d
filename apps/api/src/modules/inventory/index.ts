import { API_PREFIX, routes } from '@wms3d/contracts';
import type { ApiModule } from '../types.ts';
import { checkIdempotencyKey, postTransaction, reverseTransaction } from './commands.ts';
import {
  listBalances,
  listMovements,
  listTransactions,
  locate,
  lowStock,
  movementsCsvStream,
} from './queries.ts';
import { installRawBodyCapture, rawBodyOf } from './raw-body.ts';
import { loadTxns } from './views.ts';
import { ApiError } from '../../lib/problem.ts';

/**
 * inventory 模块（tag 'inventory'，ws-a2）：库存引擎 + 查询。
 * shim（见 docs/contract-requests/ws-a2-1.md）：无数据库时不注册（外壳保持 501 桩，app.test.ts 依赖此行为）。
 */
export const inventoryModule: ApiModule = ({ app, routes: r, services }) => {
  const db = services.db;
  if (!db) return;
  const pool = db.pool;

  services.scopeResolvers.txn = async (id) => {
    const x = await pool.query<{ warehouse_id: string }>(
      `SELECT warehouse_id FROM inv_txns WHERE id = $1`,
      [id],
    );
    return x.rows[0]?.warehouse_id ?? null;
  };

  installRawBodyCapture(app, new Set([`${API_PREFIX}${routes.postTransaction.path}`]));

  r.register(routes.postTransaction, async ({ body, auth, idempotencyKey, req, reply }) => {
    const key = checkIdempotencyKey(idempotencyKey);
    const out = await postTransaction(pool, services.bus, auth, body, rawBodyOf(req), key, {
      ip: req.ip,
      traceId: req.id,
    });
    reply.code(out.created ? 201 : 200);
    return out.result;
  });

  r.register(
    routes.reverseTransaction,
    async ({ params, body, auth, idempotencyKey, req, reply }) => {
      const key = checkIdempotencyKey(idempotencyKey);
      const out = await reverseTransaction(pool, services.bus, auth, params.id, body, key, {
        ip: req.ip,
        traceId: req.id,
      });
      reply.code(out.created ? 201 : 200);
      return out.result;
    },
  );

  r.register(routes.listTransactions, async ({ query, warehouseId }) =>
    listTransactions(pool, warehouseId!, query),
  );
  r.register(routes.getTransaction, async ({ params }) => {
    const [t] = await loadTxns(pool, [params.id]);
    if (!t) throw new ApiError('NOT_FOUND');
    return t;
  });
  r.register(routes.listBalances, async ({ query, warehouseId }) =>
    listBalances(pool, warehouseId!, query),
  );
  r.register(routes.listMovements, async ({ query, warehouseId }) =>
    listMovements(pool, warehouseId!, query),
  );
  r.register(routes.exportMovements, async ({ query, warehouseId, reply }) => {
    const { limit: _l, cursor: _c, ...filters } = query;
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="movements.csv"')
      .send(movementsCsvStream(pool, warehouseId!, filters));
  });
  r.register(routes.locate, async ({ query, warehouseId }) => locate(pool, warehouseId!, query.q));
  r.register(routes.lowStock, async ({ warehouseId }) => ({
    items: await lowStock(pool, warehouseId!),
  }));
};
