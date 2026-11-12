import { routes } from '@wms3d/contracts';
import { auditCtx, writeAudit } from '../../lib/audit.ts';
import { decodeCursor, encodeCursor, poolOf, withTx, type Queryable } from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import { LOCATION_SQL, locationView, loadLocations, type LocationRow } from '../../lib/wh-views.ts';
import type { ApiModule } from '../types.ts';

type Patch = {
  isActive?: boolean | undefined;
  maxQty?: number | null | undefined;
  pickSeq?: number | undefined;
};

async function layoutVersionOf(q: Queryable, warehouseId: string): Promise<number> {
  const r = await q.query<{ v: number | null }>(
    `SELECT published_layout_version AS v FROM warehouses WHERE id = $1`,
    [warehouseId],
  );
  return r.rows[0]?.v ?? 0;
}

/**
 * 加锁（id 升序 FOR UPDATE，02 §6.2 全局锁顺序）→ 停用需无库存 → 更新运行时属性。
 * 返回被拒的 id（有库存不能停用）。与入库的 FOR SHARE 互斥，消除"检查后停用前入库"的悬空库存。
 */
async function applyPatch(
  c: Queryable,
  warehouseId: string,
  ids: string[],
  patch: Patch,
): Promise<{
  ok: string[];
  withStock: { id: string; code: string; onHand: number }[];
  missing: string[];
}> {
  const sorted = [...new Set(ids)].sort();
  const locked = await c.query<{ id: string; code: string }>(
    `SELECT id, code FROM locations WHERE id = ANY($1::uuid[]) AND warehouse_id = $2 ORDER BY id FOR UPDATE`,
    [sorted, warehouseId],
  );
  const found = new Map(locked.rows.map((x) => [x.id, x.code]));
  const missing = sorted.filter((id) => !found.has(id));
  let withStock: { id: string; code: string; onHand: number }[] = [];
  if (patch.isActive === false && found.size) {
    const st = await c.query<{ id: string; on_hand: number }>(
      `SELECT location_id AS id, sum(on_hand)::int AS on_hand FROM stock_balances
        WHERE location_id = ANY($1::uuid[]) GROUP BY location_id HAVING sum(on_hand) > 0`,
      [[...found.keys()]],
    );
    withStock = st.rows.map((x) => ({ id: x.id, code: found.get(x.id)!, onHand: x.on_hand }));
  }
  const bad = new Set(withStock.map((x) => x.id));
  const ok = [...found.keys()].filter((id) => !bad.has(id));
  if (ok.length)
    await c.query(
      `UPDATE locations SET
         is_active = COALESCE($2, is_active),
         max_qty = CASE WHEN $3::boolean THEN $4::int ELSE max_qty END,
         pick_seq = COALESCE($5, pick_seq)
       WHERE id = ANY($1::uuid[])`,
      [
        ok,
        patch.isActive ?? null,
        patch.maxQty !== undefined,
        patch.maxQty ?? null,
        patch.pickSeq ?? null,
      ],
    );
  return { ok, withStock, missing };
}

/** locations 模块（02 §4、03 §5）：仓位列表、运行时属性 PATCH / 批量（发 locations.changed）。 */
export const locationsModule: ApiModule = ({ routes: r, services }) => {
  r.register(routes.listLocations, async ({ warehouseId, query }) => {
    const pool = poolOf(services);
    const after = decodeCursor<string>(query.cursor);
    const like = query.q ? `%${query.q.toUpperCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await pool.query<LocationRow>(
      `${LOCATION_SQL}
        LEFT JOIN zones z ON z.id = l.zone_id
        WHERE l.warehouse_id = $1
          AND ($2::text IS NULL OR l.code > $2)
          AND ($3::text IS NULL OR z.code = $3)
          AND ($4::text IS NULL OR r.code = $4)
          AND ($5::text IS NULL OR l.code LIKE $5)
          AND ($6::text IS NULL OR l.kind = $6)
          AND ($7::boolean IS NULL OR l.is_active = $7)
        ORDER BY l.code LIMIT $8`,
      [
        warehouseId,
        after,
        query.zone ?? null,
        query.rack ?? null,
        like,
        query.kind ?? null,
        query.isActive === undefined ? null : query.isActive === 'true',
        query.limit + 1,
      ],
    );
    const more = rows.rows.length > query.limit;
    const page = rows.rows.slice(0, query.limit);
    return {
      items: page.map(locationView),
      nextCursor: more ? encodeCursor(page[page.length - 1]!.code) : null,
    };
  });

  r.register(routes.patchLocation, async ({ params, body, warehouseId, req }) => {
    const pool = poolOf(services);
    const res = await withTx(pool, async (c) => {
      const before = (await loadLocations(c, [params.id]))[0];
      if (!before || before.warehouseId !== warehouseId)
        throw new ApiError('NOT_FOUND', '仓位不存在');
      const out = await applyPatch(c, warehouseId!, [params.id], body);
      if (out.missing.length) throw new ApiError('NOT_FOUND', '仓位不存在');
      if (out.withStock.length)
        throw new ApiError('LAYOUT_HAS_STOCK', `仓位 ${before.code} 仍有库存，不能停用`, {
          context: { locations: out.withStock },
        });
      const after = (await loadLocations(c, [params.id]))[0]!;
      await writeAudit(c, {
        ...auditCtx(req),
        warehouseId,
        action: 'location.update',
        entity: 'location',
        entityId: params.id,
        before: { isActive: before.isActive, maxQty: before.maxQty, pickSeq: before.pickSeq },
        after: { isActive: after.isActive, maxQty: after.maxQty, pickSeq: after.pickSeq },
      });
      return { after, layoutVersion: await layoutVersionOf(c, warehouseId!) };
    });
    services.bus.publish(warehouseId!, {
      event: 'locations.changed',
      data: { layoutVersion: res.layoutVersion, locationIds: [params.id] },
    });
    return res.after;
  });

  r.register(routes.bulkPatchLocations, async ({ warehouseId, body, req }) => {
    const pool = poolOf(services);
    const res = await withTx(pool, async (c) => {
      const out = await applyPatch(c, warehouseId!, body.ids, body.patch);
      if (out.ok.length)
        await writeAudit(c, {
          ...auditCtx(req),
          warehouseId,
          action: 'location.bulk_update',
          entity: 'location',
          after: { patch: body.patch, updated: out.ok.length, ids: out.ok.slice(0, 200) },
        });
      return { ...out, layoutVersion: await layoutVersionOf(c, warehouseId!) };
    });
    if (res.ok.length)
      services.bus.publish(warehouseId!, {
        event: 'locations.changed',
        data: { layoutVersion: res.layoutVersion, locationIds: res.ok },
      });
    return {
      updated: res.ok.length,
      failed: res.withStock.map((x) => ({ id: x.id, code: x.code })),
    };
  });
};
